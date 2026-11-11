
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileFills } from '../../src/fill-reconciliation.js';

function fill(id, action, count, price, fee = '0') {
  return {
    fill_id: id,
    ticker: 'TEST-MARKET',
    outcome_side: 'yes',
    action,
    count_fp: String(count),
    yes_price_dollars: String(price),
    no_price_dollars: String(1 - Number(price)),
    fee_cost: String(fee),
    created_time: new Date(
      Date.UTC(2026, 0, 1, 0, 0, Number(id))
    ).toISOString()
  };
}

test('profitable sale includes both fees', () => {
  const report = reconcileFills([
    fill('1', 'buy', 10, 0.40, 0.10),
    fill('2', 'sell', 10, 0.60, 0.10)
  ]);

  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].pnl, 1.80);
  assert.equal(report.positions.get('TEST-MARKET:yes').count, 0);
});

test('losing sale calculates negative P&L', () => {
  const report = reconcileFills([
    fill('1', 'buy', 10, 0.60, 0.10),
    fill('2', 'sell', 10, 0.40, 0.10)
  ]);

  assert.equal(report.results[0].pnl, -2.20);
});

test('partial sale allocates entry cost and fees', () => {
  const report = reconcileFills([
    fill('1', 'buy', 10, 0.40, 0.10),
    fill('2', 'sell', 4, 0.60, 0.04)
  ]);

  assert.equal(report.results[0].pnl, 0.72);

  const position = report.positions.get('TEST-MARKET:yes');
  assert.equal(position.count, 6);
  assert.ok(Math.abs(position.cost - 2.4) < 1e-9);
  assert.ok(Math.abs(position.fees - 0.06) < 1e-9);
});

test('sorts fills chronologically', () => {
  const report = reconcileFills([
    fill('2', 'sell', 10, 0.60),
    fill('1', 'buy', 10, 0.40)
  ]);

  assert.equal(report.results[0].pnl, 2);
});

test('rejects duplicate fill IDs', () => {
  assert.throws(() => reconcileFills([
    fill('1', 'buy', 10, 0.40),
    fill('1', 'buy', 10, 0.40)
  ]), /Duplicate fill_id/);
});

test('rejects unmatched sells', () => {
  assert.throws(() => reconcileFills([
    fill('1', 'sell', 10, 0.60)
  ]), /Unmatched sell/);
});

test('rejects missing fees', () => {
  const transaction = fill('1', 'buy', 10, 0.40);
  delete transaction.fee_cost;

  assert.throws(
    () => reconcileFills([transaction]),
    /Invalid fee_cost/
  );
});

test('rejects invalid timestamps', () => {
  const transaction = fill('1', 'buy', 10, 0.40);
  transaction.created_time = 'invalid';

  assert.throws(
    () => reconcileFills([transaction]),
    /Invalid fill timestamp/
  );
});

test('rejects invalid contract sides', () => {
  const transaction = fill('1', 'buy', 10, 0.40);
  transaction.outcome_side = 'unknown';

  assert.throws(
    () => reconcileFills([transaction]),
    /Invalid contract side/
  );
});

test('rejects zero contract quantities', () => {
  assert.throws(
    () => reconcileFills([
      fill('1', 'buy', 0, 0.40)
    ]),
    /Invalid contract quantity/
  );
});
