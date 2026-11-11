
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileSettlements
} from '../../src/settlement-reconciliation.js';

function settlement(overrides = {}) {
  return {
    ticker: 'TEST-MARKET',
    market_result: 'yes',
    yes_count_fp: '10.00',
    no_count_fp: '0.00',
    yes_total_cost_dollars: '6.000000',
    no_total_cost_dollars: '0.000000',
    fee_cost: '0.100000',
    revenue: 1000,
    ...overrides
  };
}

test('winning YES settlement', () => {
  const report = reconcileSettlements([
    settlement()
  ]);

  assert.equal(report.totalPnl, 3.9);
  assert.equal(report.results[0].revenue, 10);
});

test('losing YES settlement', () => {
  const report = reconcileSettlements([
    settlement({
      market_result: 'no',
      revenue: 0
    })
  ]);

  assert.equal(report.totalPnl, -6.1);
});

test('winning NO settlement', () => {
  const report = reconcileSettlements([
    settlement({
      market_result: 'no',
      yes_count_fp: '0.00',
      no_count_fp: '10.00',
      yes_total_cost_dollars: '0',
      no_total_cost_dollars: '3',
      fee_cost: '0.05',
      revenue: 1000
    })
  ]);

  assert.equal(report.totalPnl, 6.95);
});

test('mixed YES and NO positions', () => {
  const report = reconcileSettlements([
    settlement({
      yes_count_fp: '14.00',
      no_count_fp: '14.00',
      yes_total_cost_dollars: '10.64',
      no_total_cost_dollars: '1.96',
      fee_cost: '0.2968',
      revenue: 1400
    })
  ]);

  assert.equal(report.totalPnl, 1.1032);
});

test('void settlement uses reported revenue', () => {
  const report = reconcileSettlements([
    settlement({
      market_result: 'void',
      revenue: 600
    })
  ]);

  assert.equal(report.totalPnl, -0.1);
});

test('multiple settlements are summed', () => {
  const report = reconcileSettlements([
    settlement(),
    settlement({
      ticker: 'SECOND-MARKET',
      market_result: 'no',
      revenue: 0
    })
  ]);

  assert.equal(report.results.length, 2);
  assert.equal(report.totalPnl, -2.2);
});

test('rejects duplicate settlements', () => {
  assert.throws(
    () => reconcileSettlements([
      settlement(),
      settlement()
    ]),
    /Duplicate settlement/
  );
});

test('rejects invalid revenue', () => {
  assert.throws(
    () => reconcileSettlements([
      settlement({ revenue: -100 })
    ]),
    /Invalid revenue/
  );
});

test('rejects fractional cents', () => {
  assert.throws(
    () => reconcileSettlements([
      settlement({ revenue: 100.5 })
    ]),
    /Revenue must be integer cents/
  );
});

test('rejects unsupported results', () => {
  assert.throws(
    () => reconcileSettlements([
      settlement({ market_result: 'scalar' })
    ]),
    /Unsupported settlement result/
  );
});
