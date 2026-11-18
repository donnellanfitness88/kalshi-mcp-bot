import test from 'node:test';
import assert from 'node:assert/strict';
import {observeWick,PullbackHistory,wickMetrics,wickOutcome} from '../../src/research/btcWickStudy.js';
const at=100000, close=120000;
const rows=Array.from({length:326},(_,i)=>({sourceTs:at-65000+i*200,price:1040}));
test('held cushion and final-minute proxy use completed seconds',()=>{
  const m=wickMetrics(rows,at,1000,1,close);
  assert.equal(m.requiredRemainingMeanProxy,920);
  assert.equal(m.heldMs,60000);
  assert.equal(wickMetrics(rows.filter(p=>Math.abs(at-12000-p.sourceTs)>1000),at,1000,1,close),null);
});
test('lower wick mirrored on NO; counts elapsed time below and recovery',()=>{
  const history=rows.map(p=>({...p,price:p.sourceTs>=90000 && p.sourceTs<96000?980:960}));
  const m=wickMetrics(history,at,1000,-1,close);
  assert.deepEqual([m.minimum,m.belowMs,m.heldMs,m.recoveries],[20,6000,4000,1]);
});
test('simulated alternatives use available depth and score each window once per variant',()=>{
  const row={ticker:'KXBTC15M-TEST',target:1000,closeTime:new Date(close).toISOString(),feeMultiplier:1};
  const book={yes:{price:.91,size:25}};
  observeWick(row,book,rows,at,new PullbackHistory());
  assert.equal(row.wickStudy.plans[0].count,25);
  assert.equal(row.wickStudy.plans[5].at,at);
  assert.equal(row.wickStudy.plans.volatility,undefined);
  assert.ok(row.wickStudy.plans.settlement);
  row.result='no';
  assert.equal(wickOutcome(row).net[0],-row.wickStudy.plans[0].estimatedCost);
});
