import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MetalsObserver,metalShrinkingCheck,METALS}
  from '../../src/research/metalsObserver.js';
import {evaluateShrinkingCushion}
  from '../../src/engine/shrinkingCushion.js';

const base=1800000000000;
const specs=[
  ['GOLD',3800,.2],['SILVER',47,.005],
  ['EURUSD',1.1,.0001],['USDJPY',159,.01]
];
const rows=(target,gap,side='yes',end=gap)=>
  Array.from({length:46},(_,i)=>({
    sourceAt:base+(i-45)*1000,
    price:target+(side==='yes'?1:-1)*
      (i<=30?gap:gap+(end-gap)*(i-30)/15)
  }));
function check(asset,target,history,side='yes',options={}) {
  const last=history.at(-1);
  return metalShrinkingCheck({
    asset,ticker:asset+'-TEST',target,side,history,
    at:base,secondsRemaining:1,
    proxy:{status:'FRESH_PROXY',price:last?.price,sourceAt:last?.sourceAt},
    ...options
  });
}
test('all four accept small winning cushions without fixed floors',()=>{
  for(const [a,t,d] of specs)for(const side of ['yes','no'])
    assert.equal(check(a,t,rows(t,d,side),side).allowed,true);
});
test('rapid shrink blocks; recovery requires two elapsed seconds',()=>{
  for(const [a,t,d] of specs)for(const side of ['yes','no']) {
    const h=rows(t,d,side,d*.6),first=check(a,t,h,side);
    assert.equal(first.reason,'SHRINK_RAPID_APPROACH');
    assert.equal(first.allowed,false);
    h.push({sourceAt:base+1000,price:h.at(-1).price});
    assert.equal(check(a,t,h,side,{
      at:base+1000,previous:first.guardState
    }).allowed,false);
    h.push({sourceAt:base+2000,price:h.at(-1).price});
    assert.equal(check(a,t,h,side,{
      at:base+2000,previous:first.guardState
    }).allowed,true);
  }
});
test('projection, missing history, stale data and losing references reject',()=>{
  for(const [a,t,d] of specs) {
    assert.equal(check(a,t,rows(t,d,'yes',d*.8),'yes',{
      secondsRemaining:90
    }).allowed,false);
    assert.equal(check(a,t,rows(t,d),'yes',{
      at:base+2001
    }).allowed,false);
    assert.equal(check(a,t,rows(t,d).slice(-10)).allowed,false);
    assert.equal(check(a,t,rows(t,d).filter(
      (_,i)=>i<36||i>40
    )).allowed,false);
    assert.equal(check(a,t,rows(t,-d)).allowed,false);
    assert.equal(check(a,t,rows(t,0)).allowed,false);
    assert.equal(check(a,null,rows(t,d)).allowed,false);
  }
});
test('live callers cannot use zero thresholds without explicit research mode',()=>{
  assert.equal(evaluateShrinkingCushion({
    history:rows(65000,10).map(p=>({
      sourceTs:p.sourceAt,price:p.price
    })),
    asset:'BTC',ticker:'T',target:65000,side:'yes',
    minimumDistance:0,rapidDropMinimum:0,
    secondsRemaining:1,now:base
  }).allowed,false);
});
test('all tiers retry blocked entries and restore without duplicates',async()=>{
  for(const [asset,target,gap] of specs) {
    let at=base,saved=null,result='',h=[];
    const ticker=METALS[asset]+'-TEST',close=base+179000;
    const market={ticker,close_time:new Date(close).toISOString()};
    const store={
      load:()=>structuredClone(saved),
      save:s=>{saved=structuredClone(s);}
    };
    const proxy={
      history:{},
      snapshot:()=>({
        status:'FRESH_PROXY',price:h.at(-1)?.price,
        sourceAt:h.at(-1)?.sourceAt
      })
    };
    const read=async route=>route.includes('/orderbook')?
      {orderbook_fp:{
        yes_dollars:[['.979','1000']],no_dollars:[['.02','1000']]
      }}:{market:{ticker,status:'finalized',result}};
    const make=()=>new MetalsObserver({
      read,store,proxy,now:()=>at,log:()=>{}
    });
    let o=make();o.current[asset]=market;
    o.state.markets[ticker]={
      asset,ticker,closeTime:market.close_time,target,
      feeType:'quadratic',feeMultiplier:1,
      candidates:[],observations:[],side:null,result:null
    };
    for(const seconds of [179,149,119,59,44]) {
      at=close-seconds*1000;h=[];proxy.history[asset]=h;
      await o.observe(asset);
      const before=o.state.markets[ticker].shrinkTest.candidates.length;
      h=rows(target,gap).map(p=>({
        ...p,sourceAt:p.sourceAt+at-base
      }));
      proxy.history[asset]=h;await o.observe(asset);
      assert.equal(
        o.state.markets[ticker].shrinkTest.candidates.length,before+1
      );
      o=make();o.current[asset]=market;await o.observe(asset);
      assert.equal(
        o.state.markets[ticker].shrinkTest.candidates.length,before+1
      );
    }
    const row=o.state.markets[ticker];
    assert.equal(row.shrinkTest.candidates.length,5);
    assert.equal(row.cushionTest,undefined);
    assert.ok(row.shrinkTest.candidates.reduce(
      (n,c)=>n+c.estimatedCost,0
    )<=182);
    at=close+60000;result='yes';await o.settleOne();
    assert.equal(o.state.shrinkTotals[asset].sampledMarkets,1);
    assert.ok(o.state.shrinkTotals[asset].hypotheticalNet>0);
    at+=61000;const restored=make();await restored.settleOne();
    assert.equal(restored.state.shrinkTotals[asset].sampledMarkets,1);
  }
});
