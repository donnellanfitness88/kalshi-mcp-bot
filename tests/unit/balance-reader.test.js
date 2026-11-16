import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBalanceReader} from '../../src/kalshi/balanceReader.js';

const limited=reset=>Object.assign(new Error('rate limited'),{httpStatus:429,rateLimitResetMs:reset});
function fixture(read) {
  let clock=0;const sleeps=[],logs=[];
  const balance=createBalanceReader({read,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},log:s=>logs.push(s)});
  return {balance,sleeps,logs,now:()=>clock};
}
test('concurrent callers share one network request and successful response',async()=>{
  let finish,calls=0;
  const f=fixture(()=>{calls++;return new Promise(r=>{finish=r;});});
  const a=f.balance(),b=f.balance();assert.equal(a,b);assert.equal(calls,1);
  finish(12345);assert.deepEqual(await Promise.all([a,b]),[12345,12345]);
});
test('later callers fetch fresh balances rather than returning a completed-response cache',async()=>{
  let calls=0;const f=fixture(async()=>++calls*100);
  assert.equal(await f.balance(),100);assert.equal(await f.balance(),200);
  assert.equal(calls,2);assert.deepEqual(f.sleeps,[1100]);
});
test('429 retries are shared, spaced and bounded, then recover with a fresh balance',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls<=2)throw limited();return 500;});
  assert.deepEqual(await Promise.all([f.balance(),f.balance(),f.balance()]),[500,500,500]);
  assert.equal(calls,3);assert.deepEqual(f.sleeps,[1100,2200]);assert.equal(f.logs.length,2);
});
test('exhaustion propagates the original error, with no stale value and cooldown for the next caller',async()=>{
  let fail=false,calls=0;const error=limited();
  const f=fixture(async()=>{calls++;if(fail)throw error;return 700;});
  await f.balance();fail=true;
  await assert.rejects(f.balance(),e=>e===error);assert.equal(calls,4);
  assert.deepEqual(f.sleeps,[1100,1100,2200]);
  fail=false;assert.equal(await f.balance(),700);assert.equal(calls,5);
  assert.equal(f.sleeps.at(-1),4400);
});
test('server reset delay is considered and oversized delays are bounded',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls===1)throw limited(1800);return 10;});
  assert.equal(await f.balance(),10);assert.deepEqual(f.sleeps,[1800]);
  let n=0;const capped=fixture(async()=>{if(++n===1)throw limited(60000);return 10;});
  await capped.balance();assert.deepEqual(capped.sleeps,[5000]);
});
test('non-429 errors are not retried; the next request still observes spacing',async()=>{
  for(const error of [Object.assign(new Error('auth'),{httpStatus:401}),Object.assign(new Error('server'),{httpStatus:500}),new Error('timeout')]) {
    let calls=0;const f=fixture(async()=>{if(++calls===1)throw error;return 0;});
    await assert.rejects(f.balance(),e=>e===error);assert.equal(calls,1);
    assert.equal(await f.balance(),0);assert.deepEqual(f.sleeps,[1100]);
  }
});
test('malformed balances fail closed without retrying or reusing a previous value',async()=>{
  for(const value of [undefined,null,'100',NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1]) {
    let calls=0;const f=fixture(async()=>{calls++;return value;});
    await assert.rejects(f.balance(),/Invalid Kalshi balance/);assert.equal(calls,1);
  }
  assert.equal(await fixture(async()=>0).balance(),0);
});
test('new callers during a backoff share the existing retry rather than bypassing it',async()=>{
  let clock=0,release,calls=0;
  const f=createBalanceReader({now:()=>clock,log:()=>{},sleep:ms=>new Promise(r=>{release=()=>{clock+=ms;r();};}),
    read:async()=>{if(++calls===1)throw limited();return 90;}});
  const a=f();await Promise.resolve();await Promise.resolve();
  const b=f();assert.equal(a,b);assert.equal(calls,1);
  release();assert.deepEqual(await Promise.all([a,b]),[90,90]);assert.equal(calls,2);
});
