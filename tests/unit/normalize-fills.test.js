
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFill } from '../../src/normalize-fills.js';

function fill(action, side) {
  return {
    fill_id: 'test-1',
    ticker: 'TEST-MARKET',
    created_time: '2026-11-11T12:00:00Z',
    action,
    outcome_side: side,
    count_fp: '10',
    yes_price_dollars: '0.60',
    no_price_dollars: '0.40',
    fee_cost: '0.10'
  };
}

test('buy YES maps to YES direction', () => {
  const result = normalizeFill(fill('buy', 'yes'));
  assert.equal(result.economicSide, 'yes');
  assert.equal(result.economicPrice, 0.60);
});

test('sell NO maps to YES direction', () => {
  const result = normalizeFill(fill('sell', 'no'));
  assert.equal(result.economicSide, 'yes');
  assert.equal(result.economicPrice, 0.60);
});

test('buy NO maps to NO direction', () => {
  const result = normalizeFill(fill('buy', 'no'));
  assert.equal(result.economicSide, 'no');
  assert.equal(result.economicPrice, 0.40);
});

test('sell YES maps to NO direction', () => {
  const result = normalizeFill(fill('sell', 'yes'));
  assert.equal(result.economicSide, 'no');
  assert.equal(result.economicPrice, 0.40);
});

test('does not assume position effect', () => {
  const result = normalizeFill(fill('sell', 'no'));
  assert.equal(result.positionEffect, 'UNVERIFIED');
});

test('rejects invalid prices', () => {
  const invalid = fill('buy', 'yes');
  invalid.no_price_dollars = '0.50';

  assert.throws(
    () => normalizeFill(invalid),
    /Invalid fill prices/
  );
});

test('rejects invalid quantities', () => {
  const invalid = fill('buy', 'yes');
  invalid.count_fp = '-5';

  assert.throws(
    () => normalizeFill(invalid),
    /Invalid fill quantity/
  );
});
