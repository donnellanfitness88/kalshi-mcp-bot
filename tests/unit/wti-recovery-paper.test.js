import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluateShrinkingCushion} from '../../src/engine/shrinkingCushion.js';
import {MetalsObserver} from '../../src/research/metalsObserver.js';

const base=1800000000000;
const ticker='KXWTI15M-TEST';
const close=base+150000;
const target=81;
const market={ticker,status:'active',open_time:new Date(close-900000).toISOString(),
  close_time:new Date(close).toISOString(),floor_strike:target};

function historyAt(end, dip=.0005) {
  const rows=[];
  for(let offset=-90000;offset<=end;offset+=200) {
    const cushion=offset< -15000 ? .20 : offset<=0 ? .20-.01*(offset+15000)/15000
      : .19+.03*offset/20000-(offset===18200?dip:0);
    rows.push({sourceAt:base+offset,price:target+cushion});
  }
  return rows;
}

function evaluate(end, prior, dip, gap=false) {
  const rows=historyAt(end,dip).filter(row=>!gap || row.sourceAt<base+16000 || row.sourceAt>base+17600);
  return evaluateShrinkingCushion({asset:'WTI',ticker,side:'yes',target,
    history:rows.map(row=>({sourceTs:row.sourceAt,price:row.price})),
    minimumDistance:0,observationOnlyNoMinimum:true,secondsRemaining:(close-base-end)/1000,
    now:base+end,previous:prior,requireLongRecovery:true,requireLongAlways:true,
    stabilizationSeconds:5,paperRecoveryPullback:.001});
}

test('bounded recovery requires a trend-only warning and continuous history',()=>{
  const warning=evaluate(0).guardState;
  assert.equal(warning.trendOnlyWarning,true);
  assert.equal(evaluate(20000,warning,.0005).boundedRecovery,true);
  assert.equal(evaluate(20000,warning,.002).allowed,false);
  assert.equal(evaluate(20000,warning,.0005,true).allowed,false);
  assert.equal(evaluate(20000,{...warning,hardRecoveryWarning:true},.0005).allowed,false);
});

test('WTI paper variants remain independent across restart and settle once from the official result',async()=>{
  let now=base-31000, state=null, result=null;
  const log=[];
  const store={load:()=>structuredClone(state),save:value=>{state=structuredClone(value);}};
  const proxy={history:{},snapshot:()=>{
    const point=proxy.history.WTI.at(-1);
    return {status:'FRESH_PROXY',price:point.price,sourceAt:point.sourceAt};
  }};
  const read=async route=>{
    if(route.startsWith('/series/')) return {series:{ticker:'KXWTI15M',frequency:'fifteen_min',
      fee_type:'quadratic',fee_multiplier:1}};
    if(route.startsWith('/markets?')) return {markets:[market]};
    if(route.endsWith('/orderbook?depth=1')) return {orderbook_fp:{
      yes_dollars:[['0.94','66.83']],no_dollars:[['0.05','66.83']]}};
    assert.equal(route,'/markets/'+ticker);
    return {market:{...market,status:result?'finalized':'closed',result}};
  };
  const start=()=>new MetalsObserver({read,store,proxy,now:()=>now,log:event=>log.push(event)});
  let observer=start();
  now=base;
  proxy.history.WTI=historyAt(0);
  await observer.discover('WTI');
  await observer.observe('WTI');
  assert.equal(state.markets[ticker].wtiRecoveryStudy.bounded.blocked.SHRINK_LONG_TREND_RECOVERY,1);

  observer=start();
  now=base+20000;
  proxy.history.WTI=historyAt(20000);
  await observer.discover('WTI');
  await observer.observe('WTI');
  await observer.observe('WTI');
  const candidate=log.filter(event=>event.event==='WTI_RECOVERY_CANDIDATE');
  assert.equal(candidate.length,1);
  assert.equal(candidate[0].model,'bounded');
  assert.equal(candidate[0].boundedRecovery,true);
  assert.equal(candidate[0].displayedSize,66.83);
  assert.equal(candidate[0].count,66);
  assert.equal(candidate[0].budget,100);
  assert.ok(candidate[0].estimatedCost<100);
  assert.equal(state.markets[ticker].wtiRecoveryStudy.strict.blocked.SHRINK_STABILIZING,2);

  now=close;
  await observer.settleOne();
  assert.ok(!log.some(event=>event.event==='WTI_RECOVERY_SETTLED'));
  result='no';
  now+=60000;
  await observer.settleOne();
  now+=60000;
  await start().settleOne();
  const settled=log.filter(event=>event.event==='WTI_RECOVERY_SETTLED');
  assert.equal(settled.length,1);
  assert.equal(settled[0].observationOnly,true);
  assert.equal(settled[0].models.strict.outcome,'no_entry');
  assert.equal(settled[0].models.bounded.outcome,'loss');
  assert.equal(settled[0].models.bounded.netAfterEstimatedFees,-candidate[0].estimatedCost);
});
