
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditAccounting
} from '../../src/combined-accounting.js';

function fill(id, action, count) {
  return {
    fill_id: String(id),
    ticker: 'TEST-BTC',
    outcome_side: 'yes',
    action,
    count_fp: String(count),
    yes_price_dollars: '0.40',
    no_price_dollars: '0.60',
    fee_cost: '0.01',
    created_time: new Date(
      Date.UTC(2026, 0, 1, 0, 0, id)
    ).toISOString()
  };
}

function settlement(yesCount, noCount = 0) {
  return {
    ticker: 'TEST-BTC',
    yes_count_fp: String(yesCount),
    no_count_fp: String(noCount)
  };
}

test('all contracts sold before settlement', () => {
  const report = auditAccounting([
    fill(1, 'buy', 10),
    fill(2, 'sell', 10)
  ], [settlement(0)]);

  assert.equal(report.status, 'QUANTITIES_MATCH');
  assert.equal(report.issues.length, 0);
});

test('partial sale matches remaining settlement', () => {
  const report = auditAccounting([
    fill(1, 'buy', 20),
    fill(2, 'sell', 8)
  ], [settlement(12)]);

  assert.equal(report.status, 'QUANTITIES_MATCH');
  assert.equal(report.checks[0].remaining, 12);
});

test('detects settlement quantity mismatch', () => {
  const report = auditAccounting([
    fill(1, 'buy', 20),
    fill(2, 'sell', 8)
  ], [settlement(10)]);

  assert.equal(report.status, 'REVIEW_REQUIRED');
  assert.equal(report.issues[0].reason, 'QUANTITY_MISMATCH');
  assert.equal(report.issues[0].difference, 2);
});

test('flags positions without settlement', () => {
  const report = auditAccounting([
    fill(1, 'buy', 10)
  ], []);

  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.unresolved.length, 1);
});

test('rejects duplicate settlement tickers', () => {
  const report = auditAccounting([
    fill(1, 'buy', 10)
  ], [
    settlement(10),
    settlement(10)
  ]);

  assert.equal(report.status, 'REVIEW_REQUIRED');
  assert.equal(
    report.issues[0].reason,
    'DUPLICATE_SETTLEMENT_TICKER'
  );
});

test('rejects invalid settlement quantities', () => {
  assert.throws(
    () => auditAccounting(
      [fill(1, 'buy', 10)],
      [settlement(-1)]
    ),
    /Invalid yes_count_fp/
  );
});

test('empty account is consistent', () => {
  const report = auditAccounting([], []);

  assert.equal(report.status, 'QUANTITIES_MATCH');
  assert.equal(report.fillSales, 0);
  assert.equal(report.settlementsChecked, 0);
});
