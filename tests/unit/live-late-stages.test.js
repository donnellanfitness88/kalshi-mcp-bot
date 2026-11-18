import test from 'node:test';
import assert from 'node:assert/strict';
import { productionLateStage } from '../../src/engine/scalpExecution.js';

for (const asset of ['BTC', 'GOLD', 'SILVER', 'EURUSD', 'USDJPY']) {
  test(asset + ' starts in the last minute and gates the extra stage on confirmed spend', () => {
    for (const seconds of [179, 149, 119, 60, 0]) {
      assert.equal(productionLateStage(seconds, asset), null);
    }
    assert.equal(productionLateStage(59.9, asset).id, 'under_60');
    assert.equal(productionLateStage(45, asset).id, 'under_60');
    assert.equal(productionLateStage(44.9, asset).id, 'under_45');
    for (const [spent, expected] of [[49.99, 'under_45'], [50, 'under_45_extra']]) {
      const ledger = { records: { under_45: { spent } } };
      assert.equal(productionLateStage(44, asset, ledger).id, expected);
    }
  });
}
