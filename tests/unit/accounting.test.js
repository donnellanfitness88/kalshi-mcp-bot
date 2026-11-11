
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateTradePnL,
  calculateSettlementPnL
} from '../../src/accounting.js';

test('profitable sale after fees', () => {
  const result = calculateTradePnL({
    entryCost: 5,
    exitProceeds: 5.70,
    entryFees: 0.06,
    exitFees: 0.06
  });

  assert.equal(result.pnl, 0.58);
  assert.equal(result.totalFees, 0.12);
  assert.equal(result.win, true);
});

test('losing sale after fees', () => {
  const result = calculateTradePnL({
    entryCost: 5,
    exitProceeds: 4.50,
    entryFees: 0.05,
    exitFees: 0.05
  });

  assert.equal(result.pnl, -0.60);
  assert.equal(result.win, false);
});

test('winning settlement', () => {
  const result = calculateSettlementPnL({
    entryCost: 6,
    settlementProceeds: 10,
    entryFees: 0.10,
    settlementFees: 0
  });

  assert.equal(result.pnl, 3.90);
});

test('losing settlement', () => {
  const result = calculateSettlementPnL({
    entryCost: 6,
    settlementProceeds: 0,
    entryFees: 0.10,
    settlementFees: 0
  });

  assert.equal(result.pnl, -6.10);
});

test('rejects missing fees', () => {
  assert.throws(() => calculateTradePnL({
    entryCost: 5,
    exitProceeds: 6,
    entryFees: 0
  }), /Invalid exitFees/);
});

test('rejects negative amounts', () => {
  assert.throws(() => calculateSettlementPnL({
    entryCost: -5,
    settlementProceeds: 10,
    entryFees: 0,
    settlementFees: 0
  }), /Invalid entryCost/);
});
