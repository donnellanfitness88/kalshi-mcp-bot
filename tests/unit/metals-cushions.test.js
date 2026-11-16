import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MetalsObserver,metalCushionCheck} from '../../src/research/metalsObserver.js';

const base=1800000000000;
const fresh=(price,sourceAt=base)=>({status:'FRESH_PROXY',price,sourceAt});
test('signed metal thresholds include equality and reject the losing side',()=>{
  for(const [asset,target,gap] of [['GOLD',3800,2],['SILVER',47,.07]]) {
    for(const side of ['yes','no']) {
      const sign=side==='yes'?1:-1;
      assert.equal(metalCushionCheck(asset,target,side,fresh(target+sign*gap),base).pass,true);
      assert.equal(metalCushionCheck(asset,target,side,fresh(target+sign*(gap-.001)),base).pass,false);
      assert.equal(metalCushionCheck(asset,target,side,fresh(target-sign*10),base).pass,false);
    }
  }
  assert.equal(metalCushionCheck('EURUSD',1,'yes',fresh(2),base),null);
});
test('missing, stale, future or invalid references and missing targets fail closed',()=>{
  for(const p of [null,{},fresh(NaN),fresh(3803,base-2001),fresh(3803,base+1),
    {...fresh(3803),status:'UNAVAILABLE_OR_STALE'}])
    assert.equal(metalCushionCheck('GOLD',3800,'yes',p,base).pass,false);
  assert.equal(metalCushionCheck('GOLD',3800,'yes',fresh(3802,base-2000),base).pass,true);
  for(const t of [null,NaN,0])assert.equal(metalCushionCheck('GOLD',t,'yes',fresh(3803),base).pass,false);
});
function fixture(asset='GOLD') {
  let at=base,price=asset==='GOLD'?3801:47.06,side='yes',saved=null,result='';
  const target=asset==='GOLD'?3800:47,ticker=`KX${asset}15M-TEST`;
  const market={ticker,open_time:new Date(base-721000).toISOString(),
    close_time:new Date(base+179000).toISOString(),floor_strike:target,status:'active'};
  const logs=[],store={load:()=>structuredClone(saved),save:s=>{saved=structuredClone(s);}};
  const read=async route=>route.includes('/orderbook')?{orderbook_fp:{
    yes_dollars:[[side==='yes'?'.89':'.10','1000']],no_dollars:[[side==='yes'?'.10':'.89','1000']]}}
    :{market:{...market,status:result?'finalized':'closed',result}};
  const proxy={snapshot:()=>fresh(price,at)};
  const make=()=>new MetalsObserver({read,store,proxy,now:()=>at,log:e=>logs.push(e)});
  const observer=make();observer.current[asset]=market;
  observer.state.markets[ticker]={asset,ticker,closeTime:market.close_time,target,
    feeType:'quadratic',feeMultiplier:1,candidates:[],observations:[],side:null,result:null};
  return {observer,make,logs,store,ticker,market,asset,setPrice:p=>{price=p;},
    setSide:s=>{side=s;},setAt:t=>{at=t;},setResult:r=>{result=r;}};
}
test('both metal scenarios retry blocked stages, persist accepted stages, and leave baseline intact',async()=>{
  for(const asset of ['GOLD','SILVER']) {
    const f=fixture(asset);await f.observer.observe(asset);
    let row=f.observer.state.markets[f.ticker];
    assert.equal(row.candidates.length,1);assert.equal(row.cushionTest.candidates.length,0);
    assert.equal(row.cushionTest.blockedChecks,1);
    f.setPrice(asset==='GOLD'?3802:47.07);await f.observer.observe(asset);
    row=f.observer.state.markets[f.ticker];assert.equal(row.cushionTest.candidates.length,1);
    const restored=f.make();restored.current[asset]=f.market;await restored.observe(asset);
    assert.equal(restored.state.markets[f.ticker].cushionTest.candidates.length,1);
    assert.equal(restored.state.markets[f.ticker].candidates.length,1);
  }
});
test('filtered side selection is independent of a rejected baseline side',async()=>{
  const f=fixture();await f.observer.observe('GOLD');f.setSide('no');f.setPrice(3798);
  await f.observer.observe('GOLD');const row=f.observer.state.markets[f.ticker];
  assert.equal(row.side,'yes');assert.equal(row.cushionTest.side,'no');
  assert.equal(row.cushionTest.candidates[0].side,'no');
});
test('settlement records separate net results once; restart does not backfill legacy history',async()=>{
  const f=fixture();await f.observer.observe('GOLD');f.setAt(base+200000);f.setResult('no');
  await f.observer.settleOne();let s=f.observer.state;
  assert.ok(s.totals.GOLD.hypotheticalNet<0);assert.equal(s.cushionTotals.GOLD.hypotheticalNet,0);
  assert.equal(s.cushionTotals.GOLD.sampledMarkets,1);
  await f.make().settleOne();assert.equal(f.logs.filter(x=>x.event==='CUSHION_SETTLED_ESTIMATE').length,1);
  const old=fixture();await old.observer.observe('GOLD');
  const legacy=structuredClone(old.observer.state);delete legacy.markets[old.ticker].cushionTest;
  old.store.save(legacy);old.setAt(base+200000);old.setResult('yes');await old.make().settleOne();
  assert.equal(old.store.load().cushionTotals,undefined);
});
test('filtered accounting includes fees, accepted additions and only the filtered side payout',async()=>{
  const f=fixture();f.setPrice(3802);await f.observer.observe('GOLD');
  f.setAt(base+135000);f.setPrice(3801);await f.observer.observe('GOLD');
  assert.equal(f.observer.state.markets[f.ticker].cushionTest.candidates.length,1);
  f.setAt(base+200000);f.setResult('yes');await f.observer.settleOne();
  const t=f.observer.state.markets[f.ticker].cushionTest;
  assert.equal(t.estimatedCost,1.82);assert.equal(t.hypotheticalPayout,2);
  assert.ok(Math.abs(t.hypotheticalNet-.18)<1e-9);
});
