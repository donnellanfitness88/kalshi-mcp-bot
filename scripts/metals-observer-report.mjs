import { fileObserverStore, metalsDirectory } from '../src/research/metalsObserver.js';
const state=fileObserverStore().load();
if(!state) {
  console.log('No metals observations saved yet at '+metalsDirectory());
} else {
  console.log('Gold/silver price-time observation — hypothetical results, NOT live trades.');
  console.log('Proximity, shrinking-cushion, account risk and available cash were NOT evaluated.');
  console.table(Object.entries(state.totals).map(([asset,s])=>({asset,...s})));
  console.log('Unsettled sampled markets: '+Object.values(state.markets).filter(m=>!m.result).length);
  console.table(Object.values(state.markets).filter(m=>m.result && m.candidates.length)
    .sort((a,b)=>b.settledAt-a.settledAt).slice(0,20).map(r=>({ticker:r.ticker,side:r.side,result:r.result,
      stages:r.candidates.length,estimatedCost:r.estimatedCost.toFixed(4),hypotheticalNet:r.hypotheticalNet.toFixed(4)})));
}
