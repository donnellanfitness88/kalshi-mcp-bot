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
test('two continuous stable seconds clear a latch; one does not',()=>{
 const rows=history(200,140),first=run(rows);
 const expanded=n=>[...rows,...Array.from({length:n},(_,i)=>({sourceTs:now+(i+1)*1000,price:target+140}))];
 assert.equal(run(expanded(1),{now:now+1000,previous:first.guardState}).allowed,false);
 const stable=run(expanded(2),{now:now+2000,previous:first.guardState});
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
 const rows=[...history(200,140),...Array.from({length:1},(_,i)=>({sourceTs:now+(i+1)*1000,price:target+140}))];
 assert.equal(run(rows,{now:now+1000}).allowed,false);
});


test('two-second recovery works for YES and NO and still requires the distance minimum',()=>{
 for(const side of ['yes','no']) {
  const sign=side==='yes'?1:-1, rows=history(200,140,side),first=run(rows,{side});
  const recover=[...rows,{sourceTs:now+1000,price:target+sign*140},
    {sourceTs:now+2000,price:target+sign*141}];
  const result=run(recover,{side,now:now+2000,previous:first.guardState});
  assert.equal(result.allowed,true);assert.equal(result.stabilizationSeconds,2);
  assert.equal(run(recover,{side,now:now+2000,previous:first.guardState,minimumDistance:150}).allowed,false);
 }
});
test('a decrease interrupts recovery; two full elapsed seconds are required again',()=>{
 const rows=history(200,140),first=run(rows);
 const recovery=[...rows,{sourceTs:now+1000,price:target+141},{sourceTs:now+2000,price:target+140}];
 assert.equal(run(recovery,{now:now+2000,previous:first.guardState}).allowed,false);
 recovery.push({sourceTs:now+3000,price:target+140});
 assert.equal(run(recovery,{now:now+3000,previous:first.guardState}).allowed,false);
 recovery.push({sourceTs:now+4000,price:target+141});
 assert.equal(run(recovery,{now:now+4000,previous:first.guardState}).allowed,true);
});
test('three quick feed messages do not substitute for two seconds of recovery',()=>{
 const rows=history(200,140),first=run(rows);
 const short=[...rows,...[200,400,600].map(dt=>({sourceTs:now+dt,price:target+140}))];
 assert.equal(run(short,{now:now+600,previous:first.guardState}).allowed,false);
});


test('lower proximity does not lower the separately preserved rapid-drop threshold',()=>{
 const r=run(history(100,60),{minimumDistance:30,rapidDropMinimum:50,secondsRemaining:1});
 assert.equal(r.rapid,false);assert.equal(r.allowed,true);
 assert.equal(run(history(200,140),{minimumDistance:30,rapidDropMinimum:50}).rapid,true);
});

function longHistory(fn,side='yes',length=61) {
  return Array.from({length},(_,i)=>({sourceTs:now+(i-length+1)*1000,
    price:target+(side==='yes'?1:-1)*fn(i-length+61)}));
}
const warning={ticker:'BTC-T',side:'yes',blocked:true,triggeredAt:now-30000,triggerReason:'SHRINK_RAPID_APPROACH'};
test('large-stage recovery retains a warning despite two stable seconds when the 60-second trend is adverse',()=>{
  for(const side of ['yes','no']) {
    const rows=longHistory(i=>i<=45?200-i*100/45:i<58?100+(i-45)*50/13:150,side);
    const opts={side,previous:{...warning,side},requireLongRecovery:true};
    const r=run(rows,opts);
    assert.equal(r.stabilized,true);assert.equal(r.allowed,false);
    assert.equal(r.reason,'SHRINK_LONG_TREND_RECOVERY');
    assert.ok(r.longRecovery.cushionChange15>0);assert.equal(r.longRecovery.cushionChange60,-50);
    assert.equal(r.guardState.blocked,true);
    const again=run(rows,{...opts,previous:JSON.parse(JSON.stringify(r.guardState))});
    assert.equal(again.allowed,false);
    assert.equal(run(rows,{...opts,requireLongRecovery:false}).allowed,true);
  }
});
test('large-stage recovery also requires a non-adverse 15-second trend and continuous 60-second data',()=>{
  const rows=longHistory(i=>i<=45?100+i*100/45:i<58?200-(i-45)*50/13:150);
  const r=run(rows,{previous:warning,requireLongRecovery:true});
  assert.equal(r.stabilized,true);assert.equal(r.allowed,false);
  assert.ok(r.longRecovery.cushionChange60>0);assert.ok(r.longRecovery.cushionChange15<0);
  for(const missing of [rows.slice(-40),rows.filter((_,i)=>i<10||i>15)]) {
    const m=run(missing,{previous:warning,requireLongRecovery:true});
    assert.equal(m.reason,'SHRINK_LONG_HISTORY_UNAVAILABLE');assert.equal(m.guardState.blocked,true);
  }
});
test('large-stage warning clears when both broader trends and two-second recovery agree',()=>{
  for(const side of ['yes','no']) {
    const rows=longHistory(()=>150,side);
    const r=run(rows,{side,previous:{...warning,side},requireLongRecovery:true});
    assert.equal(r.allowed,true);assert.equal(r.guardState.blocked,false);
    assert.equal(r.longRecovery.cushionChange15,0);assert.equal(r.longRecovery.cushionChange60,0);
    assert.equal(run(longHistory(i=>100+i,side),{side,previous:{...warning,side},requireLongRecovery:true}).allowed,true);
  }
});
test('long recovery does not invent a warning, transfer another ticker latch, or weaken distance checks',()=>{
  const rows=history(200,200);
  assert.equal(run(rows,{requireLongRecovery:true}).allowed,true);
  assert.equal(run(rows,{requireLongRecovery:true,previous:{...warning,ticker:'OLD'}}).allowed,true);
  assert.equal(run(longHistory(()=>49),{requireLongRecovery:true,previous:warning}).allowed,false);
});
