import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkRiskGuards} from '../../src/engine/riskManager.js';
process.env.DRY_RUN='false';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const state=()=>({_simMode:false,lastLossTime:0,consecutiveLosses:0,
  sessionStartBalance:1000,sessionPnL:0,sessionKillAt:null,
  dailyStartBalance:1000,dailyPnL:0,riskDay:today()});
test('daily cap permits losses above the old 8% threshold until 25%',()=>{
  for(const pnl of [-80,-100,-249.99])assert.equal(checkRiskGuards({...state(),dailyPnL:pnl},1000).blocked,false);
});
test('25% equality and larger daily losses block using the recorded starting balance',()=>{
  for(const pnl of [-250,-300])assert.equal(checkRiskGuards({...state(),dailyPnL:pnl},5000).reason,'DAILYCAP');
});
test('raising the cap retains accumulated P&L and baseline rather than resetting them',()=>{
  const s={...state(),dailyPnL:-100};assert.equal(checkRiskGuards(s,2000).blocked,false);
  assert.equal(s.dailyPnL,-100);assert.equal(s.dailyStartBalance,1000);
});
test('the independent 5% session loss guard remains active',()=>{
  assert.equal(checkRiskGuards({...state(),sessionPnL:-50,dailyPnL:-100},1000).reason,'SESSIONKILL');
});
test('loss cooldown and consecutive-loss brakes remain active',()=>{
  assert.equal(checkRiskGuards({...state(),lastLossTime:Date.now()},1000).reason,'COOLDOWN');
  assert.equal(checkRiskGuards({...state(),consecutiveLosses:3,lastLossTime:Date.now()-60000},1000).reason,'STREAK');
});
test('daily guard still resets at the Eastern calendar-day boundary',()=>{
  const s={...state(),riskDay:'2000-01-01',dailyPnL:-300};
  assert.equal(checkRiskGuards(s,500).blocked,false);assert.equal(s.dailyPnL,0);
  assert.equal(s.dailyStartBalance,500);assert.equal(s.riskDay,today());
});
