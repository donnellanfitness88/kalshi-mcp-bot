import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScalpExecutor, scalpSize, reserveFee, scalpAck, entryPhase, lateFee } from '../../src/engine/scalpExecution.js';
import { evaluateScalpExit } from '../../src/engine/scalpStrategy.js';

process.env.SCALP_ENABLED = 'true';
process.env.DRY_RUN = 'false';
function fixture(direction = 'UP', sim = false) {
  const now = Date.now();
  const asset = () => ({ activeTrade: null, farmArmed: true, lastExitTime: 0, lastLossTime: 0,
    consecutiveLosses: 0, sessionStartBalance: 100, dailyStartBalance: 100,
    sessionPnL: 0, dailyPnL: 0, totalPnL: 0, tradeCount: 0, secsLeft: 300,
    ticker: 'BTC-TEST', yesAsk: 0.60, yesBid: 0.59, lastQuoteMessageTs: now,
    yesPriceHistory: [
      { ts: now - 6000, price: direction === 'UP' ? 0.57 : 0.62 },
      { ts: now - 3000, price: direction === 'UP' ? 0.58 : 0.61 },
      { ts: now, price: 0.595 }
    ] });
  const state = { BTC: asset(), ETH: { ...asset(), ticker: 'ETH-TEST' }, simMode: sim, paperBalance: 50, disabledAssets: [] };
  const requests = [], logs = [];
  let saved;
  const api = { getPositions: async () => [], getOrders: async () => [], getBalance: async () => 10000,
    placeOrder: async body => {
      requests.push(body);
      return { order_id: 'o1', fill_count: body.count, remaining_count: '0.00',
        average_fill_price: body.price, average_fee_paid: '0.0100' };
    } };
  const dynamicApi = Object.fromEntries(['getPositions', 'getOrders', 'getBalance', 'placeOrder', 'getOrder', 'getAllFills', 'getMarket', 'getAllSettlements'].map(key => [key, (...args) => api[key](...args)]));
  const executor = createScalpExecutor({ state, api: dynamicApi, save: value => { saved = structuredClone(value); }, log: value => logs.push(value) });
  const ctx = asset => ({ asset, s: state[asset], balance: 100 });
  return { state, api, executor, requests, logs, ctx, saved: () => saved };
}
test('all entry sizes include fee reserve within $10, including low balances', () => {
  for (const balance of [0, 0.01, 0.5, 3, 10, 100]) {
    for (let cents = 1; cents < 100; cents++) {
      const price = cents / 100, n = scalpSize(price, balance);
      assert.ok(n === 0 || n * price + reserveFee(n) <= Math.min(10, balance) + 1e-9);
    }
  }
});
test('UP and DOWN use confirmed count and YES book price conversion', async () => {
  for (const direction of ['UP', 'DOWN']) {
    const f = fixture(direction);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 1);
    const t = f.state.BTC.activeTrade;
    assert.equal(t.side, direction === 'UP' ? 'yes' : 'no');
    assert.ok(Math.abs(t.entrySidePrice - (direction === 'UP' ? 0.60 : 0.41)) < 1e-9);
    assert.ok(t.amount + t.entryFees <= 10);
    assert.equal(f.requests[0].time_in_force, 'fill_or_kill');
    assert.equal(f.saved().pending, null);
  }
});
test('one position across BTC and ETH, including concurrent entry calls', async () => {
  const f = fixture();
  await Promise.all([f.executor.tick(f.ctx('BTC')), f.executor.tick(f.ctx('ETH'))]);
  await f.executor.tick(f.ctx('ETH'));
  assert.equal(f.requests.length, 1);
});
test('existing or malformed account holdings block entries', async () => {
  for (const position of ['2.00', '-2.00', 'garbage', null]) {
    const f = fixture(); f.api.getPositions = async () => [{ position_fp: position }];
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 0);
  }
});
test('timeout keeps client id pending and does not submit another buy', async () => {
  const f = fixture();
  f.api.placeOrder = async body => { f.requests.push(body); throw new Error('timeout'); };
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('ETH'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.saved().pending.body.client_order_id, f.requests[0].client_order_id);
});
test('pending order recovers actual partial fills without another submission', async () => {
  const f = fixture('DOWN');
  f.api.placeOrder = async body => { f.requests.push(body); throw new Error('timeout'); };
  await f.executor.tick(f.ctx('BTC'));
  const id = f.requests[0].client_order_id;
  f.api.getOrders = async () => [{ order_id: 'o1', client_order_id: id, status: 'canceled', fill_count_fp: '3.00' }];
  f.api.getAllFills = async () => [{ fill_id: 'f1', order_id: 'o1', book_side: 'ask', count_fp: '3.00',
    yes_price_dollars: '0.59', no_price_dollars: '0.41', fee_cost: '0.03' }];
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.BTC.activeTrade.count, 3);
  assert.equal(f.state.BTC.activeTrade.entryFees, 0.03);
});
test('journal failure prevents order transmission', async () => {
  const f = fixture();
  const executor = createScalpExecutor({ state: f.state, api: f.api, save: () => { throw new Error('disk full'); }, log: () => {} });
  await executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 0);
});
test('partial exits retain position and allocate actual fees; final close records net P&L', async () => {
  const f = fixture();
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade, originalCount = t.count;
  t.startedAt = Date.now() - 46000;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  f.api.placeOrder = async body => {
    f.requests.push(body);
    const count = f.requests.length === 2 ? 2 : Number(body.count);
    return { order_id: 'exit', fill_count: String(count), remaining_count: '0', average_fill_price: '0.70', average_fee_paid: '0.01' };
  };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(t.count, originalCount - 2);
  assert.equal(f.state.BTC.tradeCount, 0);
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade, null);
  assert.equal(f.state.BTC.tradeCount, 1);
  assert.ok(Math.abs(f.state.BTC.totalPnL - originalCount * 0.08) < 1e-9);
  assert.equal(f.requests[1].reduce_only, true);
});
test('missing fill response never assumes success', () => {
  assert.throws(() => scalpAck({}, { body: { count: '1' }, side: 'yes' }), /fill_count/);
});
test('simulation performs zero account/order API calls', async () => {
  const f = fixture('UP', true);
  f.api.getPositions = f.api.getBalance = f.api.placeOrder = async () => { throw new Error('API called'); };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.sim, true);
  assert.equal(f.requests.length, 0);
});
test('hold evaluation keeps 5% until 15s, takes 10% immediately, exits at 45s', () => {
  assert.equal(evaluateScalpExit({ heldSeconds: 14, netReturn: 0.05 }).shouldExit, false);
  assert.equal(evaluateScalpExit({ heldSeconds: 15, netReturn: 0.05 }).shouldExit, true);
  assert.equal(evaluateScalpExit({ heldSeconds: 2, netReturn: 0.10 }).shouldExit, true);
  assert.equal(evaluateScalpExit({ heldSeconds: 45, netReturn: -0.20 }).shouldExit, true);
});
test('restored journal reconciles an interrupted buy without sending another order', async () => {
  const f = fixture();
  f.api.placeOrder = async body => { f.requests.push(body); throw new Error('timeout'); };
  await f.executor.tick(f.ctx('BTC'));
  const saved = f.saved();
  const restored = createScalpExecutor({ state: f.state, api: { ...f.api,
    getOrders: async () => [{ order_id: 'recovered', client_order_id: saved.pending.body.client_order_id,
      status: 'canceled', fill_count_fp: '0.00' }] }, save: () => {}, log: () => {} });
  restored.restore(saved);
  await restored.tick(f.ctx('BTC'));
  assert.equal(restored.snapshot().pending, null);
  assert.equal(f.requests.length, 1);
});
test('disabled assets and resting orders cannot enter', async () => {
  for (const disabled of [true, false]) {
    const f = fixture();
    if (disabled) f.state.disabledAssets = ['BTC'];
    else f.api.getOrders = async () => [{ order_id: 'resting' }];
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 0);
  }
});
test('missing exit fill data retains the holding and prevents duplicate sales', async () => {
  const f = fixture();
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  t.startedAt = Date.now() - 46000;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  f.api.placeOrder = async body => { f.requests.push(body); return { order_id: 'uncertain-exit' }; };
  f.api.getOrder = async () => ({ status: 'resting' });
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.BTC.activeTrade, t);
  assert.equal(f.executor.snapshot().pending.kind, 'exit');
});
test('time boundaries: >180 scalp, 180 to >90 buffer, 90 to >0 late', () => {
  for (const [seconds, phase] of [[181,'SCALP'], [180.001,'SCALP'], [180,'BUFFER'], [91,'BUFFER'], [90,'LATE_SETTLEMENT'], [1,'LATE_SETTLEMENT'], [0,'CLOSED'], [-1,'CLOSED'], [NaN,'CLOSED']]) {
    assert.equal(entryPhase(seconds), phase);
  }
});
test('no scalp buys inside 3 minutes, including the 90-second buffer', async () => {
  for (const seconds of [180, 179, 120, 91, 90, 30, 0]) {
    const f = fixture(); f.state.BTC.secsLeft = seconds;
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 0);
  }
});
test('open scalp continues below 180 seconds; $3 net loss exits before 45 seconds', async () => {
  const f = fixture();
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  t.startedAt = Date.now() - 10000;
  f.state.BTC.secsLeft = 170;
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  f.state.BTC.yesBid = 0.40; f.state.BTC.yesAsk = 0.41;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.logs.find(log => log.event === 'CLOSED').reason, 'MAX_DOLLAR_LOSS');
});
test('loss under $3 does not stop a young scalp and profit exits are retained', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  f.state.BTC.yesBid = 0.46; f.state.BTC.yesAsk = 0.47;
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.BTC.activeTrade, t);
});
test('late entries accept YES or NO at 97 cents and track distinct settlement mode', async () => {
  for (const side of ['yes', 'no']) {
    const f = fixture();
    Object.assign(f.state.BTC, { secsLeft: 90, yesAsk: side === 'yes' ? 0.97 : 0.04, yesBid: side === 'yes' ? 0.96 : 0.03 });
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.BTC.activeTrade.mode, 'LATE_SETTLEMENT');
    assert.equal(f.state.BTC.activeTrade.side, side);
    assert.ok(f.state.BTC.activeTrade.amount + f.state.BTC.activeTrade.entryFees <= 10);
  }
});
test('late entries reject 96 cents, stale quotes and an occupied account', async () => {
  for (const reason of ['cheap', 'stale', 'occupied']) {
    const f = fixture();
    Object.assign(f.state.BTC, { secsLeft: 60, yesAsk: reason === 'cheap' ? 0.96 : 0.97, yesBid: 0.95 });
    if (reason === 'stale') f.state.BTC.lastQuoteMessageTs -= 5000;
    if (reason === 'occupied') f.state.ETH.activeTrade = { mode: 'SCALP' };
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 0);
  }
});
test('late sizing includes fees throughout 97-99 cent range', () => {
  for (const price of [0.97, 0.98, 0.99]) {
    const count = scalpSize(price, 10, 'LATE_SETTLEMENT');
    assert.ok(count * price + lateFee(count, price) <= 10 + 1e-9);
    assert.ok(count * (1 - price) > lateFee(count, price));
  }
});
test('entry rechecks actual close time after balance read crosses cutoff', async () => {
  const f = fixture();
  f.state.BTC.marketCloseTs = Date.now() + 181000;
  f.api.getBalance = async () => { f.state.BTC.marketCloseTs = Date.now() + 179000; return 10000; };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 0);
});
test('late entry does not slip past expiration while account is being checked', async () => {
  const f = fixture();
  Object.assign(f.state.BTC, { secsLeft: 30, yesAsk: 0.97, yesBid: 0.96 });
  f.api.getBalance = async () => { f.state.BTC.marketCloseTs = Date.now() - 1; return 10000; };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 0);
});
test('late holding ignores 45-second and $3 scalp exits and survives restart', async () => {
  const f = fixture();
  Object.assign(f.state.BTC, { secsLeft: 90, yesAsk: 0.97, yesBid: 0.96 });
  await f.executor.tick(f.ctx('BTC'));
  f.state.BTC.activeTrade.startedAt -= 60000;
  Object.assign(f.state.BTC, { secsLeft: 20, yesAsk: 0.51, yesBid: 0.50 });
  f.api.getMarket = async () => ({ status: 'open' });
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  const saved = f.executor.snapshot();
  const restored = createScalpExecutor({ state: f.state, api: f.api, save: () => {}, log: () => {} });
  restored.restore(saved);
  await restored.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.mode, 'LATE_SETTLEMENT');
  assert.deepEqual(restored.snapshot().lateEntryTickers, ['BTC-TEST']);
  assert.equal(f.requests.length, 1);
});
test('settlement waits for account record then records win/loss once with original ticker', async () => {
  for (const result of ['yes', 'no']) {
    const f = fixture();
    Object.assign(f.state.BTC, { secsLeft: 60, yesAsk: 0.97, yesBid: 0.96 });
    await f.executor.tick(f.ctx('BTC'));
    const t = f.state.BTC.activeTrade;
    f.state.BTC.ticker = 'NEXT-WINDOW';
    f.api.getMarket = async ticker => { assert.equal(ticker, 'BTC-TEST'); return { status: 'finalized', result }; };
    f.api.getAllSettlements = async () => [];
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade, t);
    // Restore in a new executor to avoid waiting for the next read-only poll.
    f.api.getAllSettlements = async () => [{ ticker: t.ticker, settled_time: new Date(t.startedAt + 100000).toISOString(), market_result: result }];
    f.api.getAllFills = async () => [{ order_id: t.entryOrderId, created_time: new Date(t.startedAt).toISOString() }];
    const restored = createScalpExecutor({ state: f.state, api: f.api, save: () => {}, log: value => f.logs.push(value) });
    restored.restore(f.executor.snapshot());
    await restored.tick(f.ctx('BTC'));
    const expected = (result === 'yes' ? t.count : 0) - t.amount - t.entryFees;
    assert.ok(Math.abs(f.state.BTC.totalPnL - expected) < 1e-9);
    assert.equal(f.state.BTC.activeTrade, null);
    await restored.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.tradeCount, 1);
    assert.equal(f.requests.length, 1);
  }
});
test('unresolved late order blocks another submission and persists ticker reservation', async () => {
  const f = fixture();
  Object.assign(f.state.BTC, { secsLeft: 60, yesAsk: 0.97, yesBid: 0.96 });
  f.api.placeOrder = async body => { f.requests.push(body); throw new Error('timeout'); };
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('ETH'));
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.executor.snapshot().lateEntryTickers, ['BTC-TEST']);
});
