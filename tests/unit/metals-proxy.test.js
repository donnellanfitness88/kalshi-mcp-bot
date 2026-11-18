import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {MetalsProxy} from '../../src/research/metalsProxy.js';
import {MetalsObserver,metalShrinkingCheck} from '../../src/research/metalsObserver.js';
const base=1800000000000;
function message(at,price=3801,extra={}) {return {type:'streamUpdated',subscriptionId:1,parsed:{priceFeeds:[{
  priceFeedId:346,price:String(Math.round(price*100000)),exponent:-5,confidence:1000,
  feedUpdateTimestamp:at*1000,marketSession:'regular',...extra}]}};}
test('spot proxy has signed YES/NO cushions and never claims official reference',()=>{
  const p=new MetalsProxy({now:()=>base});p.ingest(message(base));
  const s=p.snapshot('GOLD',3800,'yes');assert.equal(s.estimatedCushion,1);
  assert.equal(p.snapshot('GOLD',3800,'no').estimatedCushion,-1);
  assert.equal(s.officialReferencePrice,null);assert.equal(s.proxyIndexDifference,null);
  assert.equal(s.confidence,.01);assert.equal(s.referenceType,'SPOT_PROXY_NOT_SETTLEMENT');
  assert.equal(p.snapshot('GOLD',null,'yes').estimatedCushion,null);
});
test('stale, carried-forward, closed, future and malformed observations are unusable',()=>{
  for(const [at,extra] of [[base-2001,{}],[base+1,{}],[base,{marketSession:'closed'}],
    [base,{price:null}],[base,{exponent:null}],[base,{feedUpdateTimestamp:null}],
    [base,{price:'9007199254740992'}],[base,{priceFeedId:3712}]]) {
    const p=new MetalsProxy({now:()=>base});p.ingest(message(at,3801,extra));
    assert.equal(p.snapshot('GOLD',3800,'yes').status,'UNAVAILABLE_OR_STALE');
  }
  let now=base;const p=new MetalsProxy({now:()=>now});p.ingest(message(base));now+=2001;
  assert.equal(p.snapshot('GOLD',3800,'yes').estimatedCushion,null);
});
test('redundant and older source timestamps cannot replace current prices',()=>{
  const p=new MetalsProxy({now:()=>base});p.ingest(message(base));p.ingest(message(base,9999));
  p.ingest(message(base-1000,2));assert.equal(p.snapshot('GOLD',3800,'yes').price,3801);
});
test('15/30/60-second movements require complete elapsed history and reject gaps',()=>{
  let now=base;const p=new MetalsProxy({now:()=>now});
  for(let s=0;s<=60;s++){now=base+s*1000;p.ingest(message(now,3800+s));}
  const m=p.snapshot('GOLD',3800,'no').movement;
  for(const s of [15,30,60]){assert.equal(m[s].priceChange,s);assert.equal(m[s].range,s);assert.equal(m[s].cushionChange,-s);}
  now+=10000;p.ingest(message(now,3861));assert.equal(p.snapshot('GOLD',3800,'yes').movement[15],null);
});
test('source history stays bounded, and silver uses its own feed',()=>{
  let now=base;const p=new MetalsProxy({now:()=>now});
  for(let i=0;i<2000;i++){now=base+i*200;p.ingest(message(now,3801));}
  assert.equal(p.history.GOLD.length,1551);
  assert.equal(now-p.history.GOLD[0].sourceAt,310000);
  assert.equal(p.snapshot('SILVER',50,'yes').price,null);
  p.ingest(message(now,51,{priceFeedId:345}));assert.equal(p.snapshot('SILVER',50,'yes').estimatedCushion,1);
});
test('without a key no network is opened; all endpoints use headers and secrets are not logged',()=>{
  const opened=[],logs=[];
  class Socket extends EventEmitter {constructor(url,options){super();this.url=url;this.options=options;opened.push(this);}
    send(body){(this.bodies??=[]).push(JSON.parse(body));}terminate(){this.emit('close');}close(){this.emit('close');}}
  const p=new MetalsProxy({Socket,log:e=>logs.push(e)});p.start('');assert.equal(opened.length,0);
  p.start('private-test-key');assert.equal(opened.length,3);
  for(const s of opened){assert.equal(s.options.headers.Authorization,'Bearer private-test-key');s.emit('open');
    assert.deepEqual(s.bodies[0].priceFeedIds,[346,345]);assert.ok(s.bodies[0].properties.includes('feedUpdateTimestamp'));
    assert.deepEqual(s.bodies[1].priceFeedIds,[327,340]);}
  p.stop();assert.ok(!JSON.stringify(logs).includes('private-test-key'));
});
test('proxy measurements persist with hypothetical entries but never gate or alter sizing',async()=>{
  const market={ticker:'KXGOLD15M-TEST',status:'open',open_time:new Date(base-721000).toISOString(),
    close_time:new Date(base+179000).toISOString(),floor_strike:3800};
  const run=async(proxy)=>{
    const o=new MetalsObserver({now:()=>base,proxy,store:{load:()=>null,save:()=>{}},log:()=>{},
      read:async route=>route.startsWith('/series/')?{series:{ticker:'KXGOLD15M',frequency:'fifteen_min',fee_type:'quadratic',fee_multiplier:1}}:
        route.startsWith('/markets?')?{markets:[market]}:{orderbook_fp:{yes_dollars:[['.89','20']],no_dollars:[['.10','20']]}}});
    await o.discover('GOLD');await o.observe('GOLD');return o.state.markets[market.ticker].candidates[0];
  };
  const p=new MetalsProxy({now:()=>base});p.ingest(message(base,3790));
  const plain=await run(null), observed=await run(p);
  assert.equal(observed.estimatedCost,plain.estimatedCost);assert.equal(observed.count,plain.count);
  assert.equal(observed.proxy.estimatedCushion,-10);assert.equal(observed.distance,null);
  assert.equal(observed.proximity,'NOT_EVALUATED');assert.equal(observed.proxySide,'yes');
});

const timingAssets=[['GOLD',346,3800,.2],['SILVER',345,47,.005],
  ['EURUSD',327,1.1,.0001],['USDJPY',340,159,.01]];
function denseFixture(asset,id,target,side,cushionAt=()=>.2) {
  let now=base;
  const p=new MetalsProxy({now:()=>now}),sign=side==='yes'?1:-1;
  const feed=(at,cushion)=>{
    now=at;
    p.ingest({type:'streamUpdated',subscriptionId:['EURUSD','USDJPY'].includes(asset)?2:1,
      parsed:{priceFeeds:[{priceFeedId:id,price:String(Math.round((target+sign*cushion)*1e8)),
        exponent:-8,confidence:0,feedUpdateTimestamp:at*1000,marketSession:'regular'}]}});
  };
  for(let dt=0;dt<=45400;dt+=200)feed(base+dt,cushionAt(dt));
  const check=(previous=null,history=p.history[asset])=>metalShrinkingCheck({
    asset,ticker:asset+'-TIMING',side,target,proxy:p.snapshot(asset,target,side),
    history,at:now,secondsRemaining:1,previous});
  return {p,feed,check};
}
test('200ms updates preserve the exact checkpoints that one-second bucketing lost on all feeds',()=>{
  for(const [asset,id,target,gap] of timingAssets)for(const side of ['yes','no']) {
    const f=denseFixture(asset,id,target,side,()=>gap),h=f.p.history[asset];
    assert.equal(h.length,228);
    assert.ok(h.some(p=>p.sourceAt===base+30400));
    // Reproduce the previous implementation: its nearest prior point is 600ms early.
    const buckets=new Map(h.map(p=>[Math.floor(p.sourceAt/1000),p]));
    assert.equal(f.check(null,[...buckets.values()]).reason,'SHRINK_HISTORY_UNAVAILABLE');
    assert.equal(f.check().allowed,true);
    assert.equal(f.check().reason,'SHRINK_OK');
    f.feed(base+45400,gap*2); // A redundant timestamp must still be ignored.
    assert.equal(f.p.history[asset].length,228);
  }
});
test('retaining fast samples still blocks rapid shrink and requires two full seconds to recover',()=>{
  for(const [asset,id,target,gap] of timingAssets)for(const side of ['yes','no']) {
    const f=denseFixture(asset,id,target,side,dt=>
      dt<=30400?gap:gap*(1-.4*(dt-30400)/15000));
    const first=f.check();
    assert.equal(first.allowed,false);assert.equal(first.reason,'SHRINK_RAPID_APPROACH');
    for(let dt=200;dt<=1000;dt+=200)f.feed(base+45400+dt,gap*.6);
    assert.equal(f.check(first.guardState).allowed,false);
    for(let dt=1200;dt<=2000;dt+=200)f.feed(base+45400+dt,gap*.6);
    assert.equal(f.check(first.guardState).allowed,true);
  }
});
test('retaining fast samples does not authorize genuine history gaps or stale references',()=>{
  for(const [asset,id,target,gap] of timingAssets) {
    const f=denseFixture(asset,id,target,'yes',()=>gap),h=f.p.history[asset];
    assert.equal(f.check(null,h.filter(p=>p.sourceAt<base+40000||p.sourceAt>base+43000)).allowed,false);
    const late=metalShrinkingCheck({asset,ticker:'T',side:'yes',target,
      proxy:f.p.snapshot(asset,target,'yes'),history:h,at:base+45400+2001,secondsRemaining:1});
    assert.equal(late.allowed,false);assert.equal(late.reason,'MISSING_OR_STALE_PROXY');
  }
});
