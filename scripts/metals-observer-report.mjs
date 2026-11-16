import { fileObserverStore, metalsDirectory } from '../src/research/metalsObserver.js';
const state=fileObserverStore().load();
if(!state) {
  console.log('No metals observations saved yet at '+metalsDirectory());
} else {
  console.log('Gold/silver/EURUSD/USDJPY price-time observation — hypothetical results, NOT live trades.');
  console.log('Proximity, shrinking-cushion, account risk and available cash were NOT evaluated.');
  console.table(Object.entries(state.totals).map(([asset,s])=>({asset,...s})));
  console.log('Separate forward-only spot-proxy cushion test: GOLD $2.00, SILVER $0.07 on every purchase.');
  console.log('Missing/stale prices or targets reject entries. Shrinking-cushion, risk and cash remain unevaluated.');
  console.table(Object.entries(state.cushionTotals??{}).map(([asset,s])=>({asset,...s})));
  console.table(Object.values(state.markets).filter(m=>m.result&&m.cushionTest)
    .sort((a,b)=>b.settledAt-a.settledAt).slice(0,20).map(r=>({ticker:r.ticker,
      partialWindow:r.cushionTest.partialWindow,
      stages:r.cushionTest.candidates.length,blockedChecks:r.cushionTest.blockedChecks,
      filteredNet:r.cushionTest.hypotheticalNet.toFixed(4),baselineNet:r.hypotheticalNet.toFixed(4)})));
  console.log('Unsettled sampled markets: '+Object.values(state.markets).filter(m=>!m.result).length);
  console.table(Object.values(state.markets).filter(m=>m.result && m.candidates.length)
    .sort((a,b)=>b.settledAt-a.settledAt).slice(0,20).map(r=>({ticker:r.ticker,side:r.side,result:r.result,
      stages:r.candidates.length,estimatedCost:r.estimatedCost.toFixed(4),hypotheticalNet:r.hypotheticalNet.toFixed(4)})));
}
