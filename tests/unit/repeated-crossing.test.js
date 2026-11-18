import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedCrossingGuard } from '../../src/engine/repeatedCrossingGuard.js';

for (const [asset, buffer] of Object.entries({EURUSD:.0003, USDJPY:.03, GOLD:4, SILVER:.1})) {
  for (const [side, sign] of [['yes',1],['no',-1]]) {
    test(asset + ' ' + side + ' crossing threshold, equality, touches and incomplete history', () => {
      const evaluate = (moves, offset=0) => repeatedCrossingGuard({allowed:true},asset,side,100,
        300000,offset+(moves.length-1)*1000,moves.map((m,i)=>({price:100+sign*m,sourceAt:offset+i*1000})));
      assert.equal(evaluate([1,0,buffer/2]).allowed,true);
      assert.equal(evaluate([1,-1,0,buffer/2]).allowed,false);
      assert.equal(evaluate([1,-1,buffer]).allowed,true);
      assert.equal(evaluate([1,-1,-buffer]).allowed,true); // Only one flip; independent side guards still apply.
      assert.equal(evaluate([1,-1,1,-buffer]).allowed,false);
      assert.equal(evaluate([buffer/2],50000).allowed,false);
      assert.equal(evaluate([buffer],50000).allowed,true);
    });
  }
}
