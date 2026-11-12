import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScalpEntry } from '../../src/engine/scalpStrategy.js';
const now = 100000;
function history(knots, mirror = false) {
  const rows = [];
  for (let ms = 0; ms <= 6000; ms += 100) {
    let i = knots.findIndex(k => k[0] * 1000 >= ms);
    if (i <= 0) i = 1;
    const [a, b] = [knots[i - 1], knots[i]];
    const price = a[1] + (b[1] - a[1]) * (ms / 1000 - a[0]) / (b[0] - a[0]);
    rows.push({ ts: now - 6000 + ms, price: mirror ? 1 - price : price });
  }
  return rows;
}
function evaluate(rows) {
  const mid = rows.at(-1).price;
  return evaluateScalpEntry({ priceHistory: rows, yesAsk: mid + 0.005, yesBid: mid - 0.005, now });
}
test('sustained YES and mirrored NO advances qualify', () => {
  for (const mirror of [false, true]) {
    const r = evaluate(history([[0,0.36],[6,0.40]], mirror));
    assert.equal(r.shouldEnter, true);
    assert.equal(r.direction, mirror ? 'DOWN' : 'UP');
    assert.equal(r.confirmationSeconds, 3);
  }
});
test('1-cent moves rejected, exact 2-cent moves accepted symmetrically', () => {
  for (const mirror of [false, true]) {
    assert.equal(evaluate(history([[0,0.38],[6,0.39]], mirror)).reason, 'WEAK_MOMENTUM');
    assert.equal(evaluate(history([[0,0.38],[6,0.40]], mirror)).shouldEnter, true);
  }
});
test('brief bounce after recent reversal fails three-second confirmation', () => {
  for (const mirror of [false, true]) {
    const rows = history([[0,0.35],[3,0.40],[4,0.39],[5,0.385],[6,0.39]], mirror);
    assert.equal(evaluate(rows).reason, 'MOMENTUM_NOT_CONFIRMED');
  }
});
test('flat final second fails despite earlier movement', () => {
  const r = evaluate(history([[0,0.35],[3,0.38],[4,0.39],[5,0.40],[6,0.40]]));
  assert.equal(r.reason, 'MOMENTUM_NOT_CONFIRMED');
});
test('more than 1 cent below selected contract high rejects YES and NO', () => {
  for (const mirror of [false, true]) {
    assert.equal(evaluate(history([[0,0.35],[2,0.43],[3,0.38],[4,0.382],[5,0.386],[6,0.39]], mirror)).reason, 'ENTRY_PULLBACK_TOO_LARGE');
  }
});
test('exactly 1-cent pullback remains eligible on both sides', () => {
  for (const mirror of [false, true]) {
    const r = evaluate(history([[0,0.35],[2,0.40],[3,0.38],[4,0.382],[5,0.386],[6,0.39]], mirror));
    assert.equal(r.shouldEnter, true);
    assert.ok(Math.abs(r.pullbackCents - 1) < 1e-8);
  }
});
test('three messages cannot stand in for three seconds of confirmation', () => {
  const rows = [{ts:now-6000,price:0.36},{ts:now-100,price:0.39},{ts:now,price:0.40}];
  assert.equal(evaluate(rows).shouldEnter, false);
});
test('stale and wide-spread books remain rejected', () => {
  const rows = history([[0,0.36],[6,0.40]]);
  assert.equal(evaluateScalpEntry({priceHistory: rows, yesAsk:0.42, yesBid:0.38, now}).reason, 'SPREAD_TOO_WIDE');
  assert.equal(evaluateScalpEntry({priceHistory: rows, yesAsk:0.405, yesBid:0.395, now:now+2100}).reason, 'STALE_OR_SHORT_HISTORY');
});
