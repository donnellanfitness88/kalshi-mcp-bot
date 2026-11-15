import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateShrinkingCushion} from '../../src/engine/shrinkingCushion.js';
const now=1800000000000,target=65000;
function history(start,end,side='yes') {
  return Array.from({length:46},(_,i)=>({sourceTs:now+(i-45)*1000,
    price:target+(side==='yes'?1:-1)*(i<=30?start:start+(end-start)*(i-30)/15)}));
}
const run=(rows,opts={})=>evaluateShrinkingCushion({history:rows,asset:'BTC',ticker:'BTC-T',side:'yes',target,
  minimumDistance:50,secondsRemaining:10,now,...opts});
test('30 percent and stage-dollar shrink while still approaching blocks YES and mirrored NO',()=>{
 for(const side of ['yes','no']) {
  const r=run(history(200,140,side),{side});
  assert.equal(r.allowed,false);assert.equal(r.reason,'SHRINK_RAPID_APPROACH');
  assert.ok(Math.abs(r.shrinkFraction-.3)<1e-9);assert.equal(r.dropUsd,60);
 }
});
test('projection blocks a slower approach when cushion would run out before expiry',()=>{
 const rows=history(100,80);
 assert.equal(run(rows,{secondsRemaining:90}).reason,'SHRINK_PROJECTED_CROSSING');
 assert.equal(run(rows,{secondsRemaining:20}).allowed,true);
});
test('missing, stale and gapped history cannot authorize an add-on',()=>{
 const full=history(200,200);
 for(const rows of [[],full.slice(-10),full.map(p=>({...p,sourceTs:p.sourceTs-3000})),full.filter((_,i)=>i<36||i>40)]) {
  assert.equal(run(rows).allowed,false);
  assert.equal(run(rows).reason,'SHRINK_HISTORY_UNAVAILABLE');
 }
});
test('ten continuous stable seconds clear a latch; nine do not',()=>{
 const rows=history(200,140),first=run(rows);
 const expanded=n=>[...rows,...Array.from({length:n},(_,i)=>({sourceTs:now+(i+1)*1000,price:target+140}))];
 assert.equal(run(expanded(9),{now:now+9000,previous:first.guardState}).allowed,false);
 const stable=run(expanded(10),{now:now+10000,previous:first.guardState});
 assert.equal(stable.allowed,true);assert.equal(stable.guardState.blocked,false);
});
test('a persisted latch stays blocked during continued slow shrink, even after its original trigger ages out',()=>{
 const previous={ticker:'BTC-T',side:'yes',blocked:true,triggeredAt:now-120000,triggerReason:'SHRINK_RAPID_APPROACH'};
 const r=run(history(200,199),{previous,secondsRemaining:1});
 assert.equal(r.allowed,false);assert.equal(r.reason,'SHRINK_STABILIZING');
});
test('a latch from a different ticker or side is not transferred to a new position',()=>{
 const previous={ticker:'OLD',side:'yes',blocked:true};
 assert.equal(run(history(200,199),{previous,secondsRemaining:1}).allowed,true);
 assert.equal(run(history(200,199),{previous:{...previous,ticker:'BTC-T',side:'no'},secondsRemaining:1}).allowed,true);
});
test('recent rapid shrink is detected even if no add-on check ran at the instant of the drop',()=>{
 const rows=[...history(200,140),...Array.from({length:5},(_,i)=>({sourceTs:now+(i+1)*1000,price:target+140}))];
 assert.equal(run(rows,{now:now+5000}).allowed,false);
});
