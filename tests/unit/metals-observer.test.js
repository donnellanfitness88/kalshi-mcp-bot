import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SCALP_CONFIG} from '../../src/engine/scalpStrategy.js';
import {METALS, METALS_STAGES, metalsStage, activeMetalMarket, metalBook, estimateMetalEntry,
  MetalsObserver, publicMetalRead, fileObserverStore} from '../../src/research/metalsObserver.js';

const base=1800000000000;
const market=(asset='GOLD')=>({ticker:`KX${asset}15M-TEST`,status:'active',
  open_time:new Date(base-721000).toISOString(),close_time:new Date(base+179000).toISOString(),floor_strike:3800});
const book=(side='yes',price=.90,size=1000)=>({orderbook_fp:{
  yes_dollars:[[String(side==='yes'?price-.01:1-price),String(size)]],
  no_dollars:[[String(side==='yes'?1-price:price-.01),String(size)]]}});
function fixture({side='yes',load=null}={}) {
  let now=base,price=.90,persisted=load,failSave=false,result='',latency=0;
  const requests=[],logs=[];
  const store={load:()=>structuredClone(persisted),save:s=>{
    if(failSave)throw new Error('disk full');persisted=structuredClone(s);
  }};
  const read=async route=>{
    requests.push(route);
    const asset=Object.keys(METALS).find(a=>route.includes(METALS[a]))??'GOLD';
    if(route.startsWith('/series/'))return {series:{ticker:`KX${asset}15M`,frequency:'fifteen_min',fee_type:'quadratic',fee_multiplier:1}};
    if(route.startsWith('/markets?'))return {markets:[market(asset)]};
    if(route.includes('/orderbook')) {now+=latency;return book(side,price);}
    return {market:{...market(asset),status:result?'finalized':'closed',result}};
  };
  const observer=new MetalsObserver({read,store,now:()=>now,log:e=>logs.push(e)});
  return {observer,read,store,requests,logs,now:()=>now,saved:()=>persisted,
    time:v=>{now=v;},price:v=>{price=v;},result:v=>{result=v;},latency:v=>{latency=v;},fail:()=>{failSave=true;}};
}
test('observation tiers match the deployed BTC schedule and strict boundaries',()=>{
  assert.deepEqual(METALS_STAGES,SCALP_CONFIG.lateStages);
  for(const [s,id] of [[180,null],[179,'under_180'],[150,'under_180'],[149,'under_150'],
    [120,'under_150'],[119,'under_120'],[60,'under_120'],[59,'under_60'],[45,'under_60'],
    [44,'under_45'],[0,null],[-1,null],[NaN,null]])assert.equal(metalsStage(s)?.id??null,id);
});
test('market discovery rejects future, expired, wrong series and non-15-minute markets',()=>{
  const m=market();assert.equal(activeMetalMarket([m],'GOLD',base),m);
  for(const r of [{...m,open_time:new Date(base+100).toISOString()}, {...m,status:'initialized'},
    {...m,close_time:new Date(base).toISOString()}, {...m,ticker:'KXBTC15M-TEST'},
    {...m,open_time:new Date(base-1000).toISOString()}])assert.equal(activeMetalMarket([r],'GOLD',base),null);
});
test('best asks come from opposite bids and use quantity as size, not price',()=>{
  const b=metalBook({orderbook_fp:{yes_dollars:[['.70','3'],['.96','2.50']],no_dollars:[['.02','44.50']]}});
  assert.deepEqual(b.yes,{price:.98,size:44.5});assert.deepEqual(b.no,{price:.04,size:2.5});
  assert.deepEqual(metalBook({orderbook:{yes:[[96,3]],no:[[2,50]]}}).yes,{price:.98,size:50});
  assert.equal(metalBook({orderbook_fp:{yes_dollars:[['.9','2']],no_dollars:[['.2','4']]}}),null);
  assert.equal(metalBook({orderbook_fp:{yes_dollars:[],no_dollars:[]}}).yes,null);
});
test('sizing respects each fee-inclusive budget, visible whole-contract size and positive payout',()=>{
  for(const stage of METALS_STAGES)for(const side of ['yes','no']) {
    const c=estimateMetalEntry({book:metalBook(book(side,stage.minPrice,1000)),stage,feeMultiplier:1});
    assert.equal(c.side,side);assert.ok(c.estimatedCost<=stage.budget+1e-9);
    assert.ok(c.count>0 && c.count<=1000);assert.ok(c.count-c.estimatedCost>0);
  }
  assert.equal(estimateMetalEntry({book:{yes:{price:.99,size:.9}},stage:METALS_STAGES[4],feeMultiplier:1}),null);
  const c=estimateMetalEntry({book:{yes:{price:.98,size:3.8}},stage:METALS_STAGES[4],feeMultiplier:1});
  assert.equal(c.count,3);
  assert.equal(estimateMetalEntry({book:{yes:{price:.95,size:5}},stage:METALS_STAGES[4],feeMultiplier:1}),null);
  assert.equal(estimateMetalEntry({book:metalBook(book()),stage:METALS_STAGES[0],feeMultiplier:NaN}),null);
});
test('five stages produce at most one theoretical candidate each; restart cannot duplicate',async()=>{
  const f=fixture();
  for(const [s,p]of [[179,.90],[149,.93],[119,.95],[59,.97],[44,.98]]) {
    f.time(base+(179-s)*1000); f.price(p); await f.observer.tick();await f.observer.tick();
  }
  for(const r of Object.values(f.observer.state.markets)) {
    assert.equal(r.candidates.length,5);
    assert.ok(r.candidates.reduce((n,c)=>n+c.estimatedCost,0)<=182+1e-9);
    assert.ok(r.candidates.every(c=>c.proximity==='NOT_EVALUATED' && c.fillAssumed));
  }
  const restored=new MetalsObserver({read:f.read,store:f.store,now:f.now,log:()=>{}});
  await restored.tick();assert.equal(restored.state.markets[market().ticker].candidates.length,5);
  assert.ok(f.requests.every(r=>r.startsWith('/markets')||r.startsWith('/series')));
});
test('side stays locked after the first candidate, including when the opposite side becomes dearer',async()=>{
  const f=fixture();await f.observer.tick();f.time(base+30000);f.price(.93);
  f.observer.read=async route=>route.includes('/orderbook')?book('no',.95):f.read(route);
  await f.observer.tick();assert.equal(f.observer.state.markets[market().ticker].candidates.length,1);
});
test('missed stages are skipped; response latency and expiry cannot authorize an observation candidate',async()=>{
  const f=fixture();f.time(base+135000);f.price(.98);await f.observer.tick();
  assert.deepEqual(f.observer.state.markets[market().ticker].candidates.map(c=>c.stageId),['under_45']);
  const slow=fixture();slow.latency(2100);await slow.observer.tick();
  assert.equal(slow.observer.state.markets[market().ticker].candidates.length,0);
  const expired=fixture();expired.time(base+178000);expired.latency(1500);await expired.observer.tick();
  assert.equal(expired.observer.state.markets[market().ticker].candidates.length,0);
});
test('official settlement estimates count once across polls and restarts',async()=>{
  const f=fixture();await f.observer.tick();f.time(base+200000);f.result('yes');
  for(let i=0;i<5;i++) {await f.observer.tick(); f.time(f.now()+61000);}
  for(const asset of ['GOLD','SILVER']) {
    assert.equal(f.observer.state.totals[asset].candidateMarkets,1);
    assert.equal(f.observer.state.totals[asset].wins,1);
    assert.ok(f.observer.state.totals[asset].hypotheticalNet>0);
  }
  const restored=new MetalsObserver({read:f.read,store:f.store,now:f.now,log:()=>{}});
  await restored.tick();assert.equal(restored.state.totals.GOLD.candidateMarkets,1);
});
test('losing estimates include the whole fee-inclusive cost; void/delayed results stay pending',async()=>{
  const f=fixture();await f.observer.tick();f.time(base+200000);f.result('');await f.observer.tick();
  assert.deepEqual(f.observer.state.totals,{});
  f.result('void');f.time(f.now()+61000);await f.observer.tick();assert.deepEqual(f.observer.state.totals,{});
  f.result('no');
  for(let i=0;i<3;i++){f.time(f.now()+61000);await f.observer.tick();}
  assert.equal(f.observer.state.totals.GOLD.losses,1);
  assert.equal(f.observer.state.totals.GOLD.hypotheticalNet,-f.observer.state.totals.GOLD.estimatedCost);
});
test('no open market is idle, read errors are contained, and ticks cannot overlap',async()=>{
  const f=fixture();let unblock;f.observer.read=route=>route.includes('GOLD')?new Promise(r=>{unblock=r;}):Promise.reject(new Error('offline'));
  const pending=f.observer.tick();await f.observer.tick();unblock({series:{}});await pending;
  assert.equal(f.observer.busy,false);assert.ok(f.logs.some(e=>e.event==='READ_ERROR'));
  const idle=fixture();idle.observer.read=async route=>route.startsWith('/markets?')?{markets:[]}:idle.read(route);
  await idle.observer.tick();assert.equal(Object.keys(idle.observer.state.markets).length,0);
  assert.equal(idle.logs.filter(e=>e.event==='NO_OPEN_MARKET').length,4);
});
test('failed persistence cannot advance in-memory candidates or emit success',async()=>{
  const f=fixture();await f.observer.discover('GOLD');f.fail();
  await assert.rejects(f.observer.observe('GOLD'),/disk full/);
  assert.equal(f.observer.state.markets[market().ticker].candidates.length,0);
  assert.equal(f.logs.filter(e=>e.event==='CANDIDATE').length,0);
});
test('public network adapter blocks order/portfolio paths before any request',async()=>{
  for(const route of ['/portfolio/orders','/portfolio/balance','//evil.example','/orders','/markets',
    '/markets/../../portfolio/orders','/markets/KXBTC15M-TEST','/series/KXETH15M',
    '/markets?series_ticker=KXGOLD15M&status=open&limit=100&redirect=other']) {
    await assert.rejects(publicMetalRead(route),/not allowed/);
  }
});
test('atomic observer files restore history without touching a trading journal',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'metals-'));
  try { const s=fileObserverStore(dir);assert.equal(s.load(),null);s.save({version:1,markets:{},totals:{}});
    assert.equal(s.load().version,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('four wick studies use their own proxy at greater than 90 cents and settle independently',async()=>{
  const f=fixture();
  const history={};
  for(const asset of Object.keys(METALS)) {
    history[asset]=Array.from({length:326},(_,i)=>({price:3800.01,sourceAt:base-65000+i*200}));
  }
  f.observer.proxy={history,snapshot:()=>({status:'FRESH_PROXY',price:3800.01,sourceAt:base})};
  f.price(.93);
  await f.observer.tick();
  for(const row of Object.values(f.saved().markets)) {
    for(const variant of [0,5,10]) {
      assert.equal(row.wickStudy.plans[variant].price,.93);
      assert.equal(row.wickStudy.plans[variant].requiredWickFloor,0);
    }
    assert.equal(row.wickStudy.plans.settlement,undefined);
    assert.equal(row.wickStudy.plans.volatility,undefined);
  }
  f.result('no'); f.time(base+180000);
  for(let i=0;i<4;i++){f.time(base+180000+i*61000);await f.observer.settleOne();}
  const events=f.logs.filter(x=>x.event==='FOUR_WICK_SETTLED');
  assert.equal(new Set(events.map(x=>x.asset)).size,4);
  assert.ok(events.every(x=>x.net[0]<0 && x.totals.incomplete===1));
});
