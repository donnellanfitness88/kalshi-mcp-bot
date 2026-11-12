import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScalpExecutor, scalpSize, reserveFee, scalpAck, entryPhase, lateFee } from '../../src/engine/scalpExecution.js';
import { evaluateScalpExit, scalpEntryPriceAllowed, scalpTakeProfitPrice } from '../../src/engine/scalpStrategy.js';

process.env.SCALP_ENABLED = 'true';
process.env.DRY_RUN = 'false';
function fixture(direction = 'UP', sim = false) {
  const now = Date.now();
  const asset = () => ({ activeTrade: null, farmArmed: true, lastExitTime: 0, lastLossTime: 0,
    consecutiveLosses: 0, sessionStartBalance: 100, dailyStartBalance: 100,
    sessionPnL: 0, dailyPnL: 0, totalPnL: 0, tradeCount: 0, secsLeft: 600,
    ticker: 'BTC-TEST', yesAsk: 0.72, yesBid: 0.71, lastQuoteMessageTs: now,
    yesPriceHistory: Array.from({ length: 61 }, (_, i) => ({
      ts: now - 6000 + i * 100,
      price: direction === 'UP' ? 0.685 + 0.03 * i / 60 : 0.745 - 0.03 * i / 60
    })) });
  const state = { BTC: asset(), ETH: { ...asset(), ticker: 'ETH-TEST' }, simMode: sim, paperBalance: 50, disabledAssets: [] };
  const requests = [], logs = [];
  let saved;
  const api = { getPositions: async () => ['BTC', 'ETH'].flatMap(asset => {
    const t = state[asset].activeTrade;
    return t && !t.sim ? [{ ticker: t.ticker, position_fp: String(t.side === 'yes' ? t.count : -t.count) }] : [];
  }), getOrders: async () => [], getBalance: async () => 10000,
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
    assert.ok(Math.abs(t.entrySidePrice - (direction === 'UP' ? 0.72 : 0.29)) < 1e-9);
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
  f.state.BTC.yesBid = scalpTakeProfitPrice(t.entrySidePrice);
  f.state.BTC.yesAsk = f.state.BTC.yesBid + 0.01;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  f.api.placeOrder = async body => {
    f.requests.push(body);
    const count = f.requests.length === 2 ? 2 : Number(body.count);
    return { order_id: 'exit', fill_count: String(count), remaining_count: '0', average_fill_price: '0.82', average_fee_paid: '0.01' };
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
test('price targets exit immediately without a forced holding-time exit', () => {
  assert.equal(evaluateScalpExit({ heldSeconds: 1, entryPrice: 0.70, exitBid: 0.74 }).shouldExit, false);
  assert.equal(evaluateScalpExit({ heldSeconds: 1, entryPrice: 0.70, exitBid: 0.75 }).shouldExit, true);
  assert.equal(evaluateScalpExit({ heldSeconds: 1, entryPrice: 0.80, exitBid: 0.90 }).shouldExit, true);
  assert.equal(evaluateScalpExit({ heldSeconds: 45, entryPrice: 0.70, exitBid: 0.60 }).shouldExit, false);
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
  f.state.BTC.yesBid = scalpTakeProfitPrice(t.entrySidePrice);
  f.state.BTC.yesAsk = f.state.BTC.yesBid + 0.01;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  f.api.placeOrder = async body => { f.requests.push(body); return { order_id: 'uncertain-exit' }; };
  f.api.getOrder = async () => ({ status: 'resting' });
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.BTC.activeTrade, t);
  assert.equal(f.executor.snapshot().pending.kind, 'exit');
});
test('time boundaries: >480 scalp, 480 to >90 buffer, 90 to >0 late', () => {
  for (const [seconds, phase] of [[481,'SCALP'], [480.001,'SCALP'], [480,'BUFFER'], [300,'BUFFER'], [91,'BUFFER'], [90,'LATE_SETTLEMENT'], [1,'LATE_SETTLEMENT'], [0,'CLOSED'], [-1,'CLOSED'], [NaN,'CLOSED']]) {
    assert.equal(entryPhase(seconds), phase);
  }
});
test('no scalp buys inside 8 minutes, including the 90-second buffer', async () => {
  for (const seconds of [480, 479, 300, 180, 120, 91, 90, 30, 0]) {
    const f = fixture(); f.state.BTC.secsLeft = seconds;
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, 0);
  }
});
test('open scalp continues below 480 seconds; $5 net loss exits before 45 seconds', async () => {
  const f = fixture();
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  t.startedAt = Date.now() - 10000;
  f.state.BTC.secsLeft = 170;
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  f.state.BTC.yesBid = 0.30; f.state.BTC.yesAsk = 0.31;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 2);
  assert.equal(f.logs.find(log => log.event === 'CLOSED').reason, 'MAX_DOLLAR_LOSS');
});
test('loss under $5 does not stop a young scalp and profit exits are retained', async () => {
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
  f.state.BTC.marketCloseTs = Date.now() + 481000;
  f.api.getBalance = async () => { f.state.BTC.marketCloseTs = Date.now() + 479000; return 10000; };
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
test('late holding ignores 45-second and $5 scalp exits and survives restart', async () => {
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
    f.api.getPositions = async () => [];
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
function manualFill(trade, count = trade.count, price = 0.50, fee = 0.05) {
  return { fill_id: 'manual-f1', order_id: 'manual-o1', ticker: trade.ticker,
    created_time: new Date(trade.startedAt + 1000).toISOString(),
    book_side: trade.side === 'yes' ? 'ask' : 'bid', count_fp: String(count),
    yes_price_dollars: String(trade.side === 'yes' ? price : 1 - price),
    no_price_dollars: String(trade.side === 'no' ? price : 1 - price), fee_cost: String(fee) };
}
function manualOrder(trade, count) {
  return { order_id: 'manual-o1', ticker: trade.ticker, status: 'executed', fill_count_fp: String(count) };
}
test('verified full manual sale clears YES or NO holding with actual net P&L; sends no sell', async () => {
  for (const direction of ['UP','DOWN']) {
    const f = fixture(direction); await f.executor.tick(f.ctx('BTC'));
    const t = f.state.BTC.activeTrade, expected = t.count * (0.50 - t.entrySidePrice) - t.entryFees - 0.05;
    f.api.getPositions = async () => [];
    f.api.getAllFills = async () => [manualFill(t)];
    f.api.getOrder = async () => manualOrder(t, t.count);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade, null);
    assert.equal(f.state.BTC.tradeCount, 1);
    assert.ok(Math.abs(f.state.BTC.totalPnL - expected) < 1e-9);
    assert.equal(f.requests.length, 1);
    assert.equal(f.logs.at(-1).event, 'MANUAL_CLOSE_RECONCILED');
    const restored = createScalpExecutor({ state: f.state, api: f.api, save: () => {}, log: () => {} });
    restored.restore(f.saved());
    await restored.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.tradeCount, 1);
  }
});
test('partial manual sale preserves remaining position, fees and previously realized P&L', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade, n = t.count, fees = t.entryFees;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(n - 3) }];
  f.api.getAllFills = async () => [manualFill(t, 3)];
  f.api.getOrder = async () => manualOrder(t, 3);
  await f.executor.tick(f.ctx('BTC'));
  const remaining = f.state.BTC.activeTrade;
  assert.equal(remaining.count, n - 3);
  assert.ok(Math.abs(remaining.entryFees - fees * (n - 3) / n) < 1e-9);
  assert.equal(f.state.BTC.tradeCount, 0);
  assert.ok(Math.abs(remaining.realizedNet - (3 * (0.50 - t.entrySidePrice) - fees * 3 / n - 0.05)) < 1e-9);
  const restored = createScalpExecutor({ state: f.state, api: f.api, save: () => {}, log: () => {} });
  restored.restore(f.saved());
  await restored.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.count, n - 3);
  assert.equal(f.requests.length, 1);
});
test('zero account position without closing fills never clears the trade', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  f.api.getPositions = async () => [];
  f.api.getAllFills = async () => [];
  f.api.getMarket = async () => ({ status: 'open' });
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade, t);
  assert.equal(f.state.BTC.tradeCount, 0);
});
test('nonterminal manual order or missing fee keeps holding blocked', async () => {
  for (const reason of ['resting','fee']) {
    const f = fixture(); await f.executor.tick(f.ctx('BTC'));
    const t = f.state.BTC.activeTrade;
    f.api.getPositions = async () => [];
    f.api.getAllFills = async () => [{ ...manualFill(t), ...(reason === 'fee' ? { fee_cost: null } : {}) }];
    f.api.getOrder = async () => ({ ...manualOrder(t, t.count), ...(reason === 'resting' ? { status: 'resting' } : {}) });
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade, t);
    assert.equal(f.state.BTC.tradeCount, 0);
    assert.equal(f.requests.length, 1);
  }
});
test('manual reconciliation does not mutate live accounting when journal write fails', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  f.api.getPositions = async () => [];
  f.api.getAllFills = async () => [manualFill(t)];
  f.api.getOrder = async () => manualOrder(t, t.count);
  const executor = createScalpExecutor({ state: f.state, api: f.api, save: () => { throw new Error('disk full'); }, log: () => {} });
  await executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade, t);
  assert.equal(f.state.BTC.tradeCount, 0);
});
test('manual close of a late holding reconciles without waiting for settlement', async () => {
  const f = fixture();
  Object.assign(f.state.BTC, { secsLeft: 60, yesAsk: 0.97, yesBid: 0.96 });
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  assert.equal(t.mode, 'LATE_SETTLEMENT');
  f.api.getPositions = async () => [];
  f.api.getAllFills = async () => [manualFill(t, t.count, 0.98)];
  f.api.getOrder = async () => manualOrder(t, t.count);
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade, null);
  assert.equal(f.state.BTC.tradeCount, 1);
  assert.equal(f.requests.length, 1);
});
test('an increased or opposite holding is not mistaken for a manual sale', async () => {
  for (const position of ['-2', '100', null]) {
    const f = fixture(); await f.executor.tick(f.ctx('BTC'));
    const t = f.state.BTC.activeTrade;
    f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: position }];
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade, t);
    assert.equal(f.state.BTC.tradeCount, 0);
  }
});
test('entry-price exclusion includes 30 and 65 cents; late-only prices rejected for scalps', () => {
  for (const price of [0.30,0.496,0.65,0.97,0.99,0,NaN]) assert.equal(scalpEntryPriceAllowed(price), false);
  for (const price of [0.11,0.299,0.651,0.70,0.80,0.90,0.969]) assert.equal(scalpEntryPriceAllowed(price), true);
});
function setEntryBook(f, side, price) {
  const s = f.state.BTC, now = Date.now();
  s.yesAsk = side === 'yes' ? price : 1 - price + 0.01;
  s.yesBid = side === 'yes' ? price - 0.01 : 1 - price;
  const mid = (s.yesAsk + s.yesBid) / 2;
  s.lastQuoteMessageTs = now;
  s.yesPriceHistory = Array.from({length:61}, (_, i) => ({ts: now-6000+i*100,
    price: mid + (side === 'yes' ? -1 : 1) * 0.03 * (1-i/60)}));
}
test('live entry path blocks the purchased YES or NO contract in the excluded band', async () => {
  for (const side of ['yes','no']) for (const price of [0.30,0.496,0.65]) {
    const f = fixture(); setEntryBook(f, side, price);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,0);
  }
});
test('live entry path permits both sides outside the band', async () => {
  for (const side of ['yes','no']) for (const price of [0.11,0.70,0.80,0.90]) {
    const f = fixture(); setEntryBook(f, side, price);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,1);
    assert.equal(f.state.BTC.activeTrade.side,side);
  }
});
test('tiered targets match 70→75, 80→90 and 90→97 without a minimum hold', () => {
  for (const [entry,target] of [[0.11,0.16],[0.70,0.75],[0.80,0.90],[0.90,0.97]]) {
    assert.equal(scalpTakeProfitPrice(entry),target);
    assert.equal(evaluateScalpExit({heldSeconds:1,entryPrice:entry,exitBid:target-0.001}).shouldExit,false);
    assert.equal(evaluateScalpExit({heldSeconds:1,entryPrice:entry,exitBid:target}).reason,'PRICE_TARGET');
  }
});
test('profit exits set an executable-side limit on YES and NO orders', async () => {
  for (const side of ['yes','no']) {
    const f=fixture(); setEntryBook(f,side,0.70);
    await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade;
    const target=scalpTakeProfitPrice(t.entrySidePrice);
    Object.assign(f.state.BTC, side==='yes' ? {yesBid:target,yesAsk:target+0.01} : {yesAsk:1-target,yesBid:1-target-0.01});
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,2);
    assert.equal(f.requests[1].price,(side==='yes'?target:1-target).toFixed(4));
    assert.equal(f.requests[1].reduce_only,true);
  }
});
test('$5 loss trigger permits a smaller loss and exits when threshold is crossed', async () => {
  const f=fixture(); await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade;
  const threshold=t.entrySidePrice-(5-t.entryFees-reserveFee(t.count))/t.count;
  Object.assign(f.state.BTC,{yesBid:threshold+0.001,yesAsk:threshold+0.011});
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1);
  Object.assign(f.state.BTC,{yesBid:threshold-0.001,yesAsk:threshold+0.009});
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,2);
  assert.equal(f.logs.find(log=>log.event==='CLOSED').reason,'MAX_DOLLAR_LOSS');
});
test('scalp can remain open past 45 seconds and into late-entry period without overlap', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const trade = f.state.BTC.activeTrade;
  trade.startedAt = Date.now() - 120000;
  f.state.BTC.secsLeft = 60;
  Object.assign(f.state.ETH, { secsLeft: 60, yesAsk: 0.97, yesBid: 0.96 });
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('ETH'));
  assert.equal(f.state.BTC.activeTrade, trade);
  assert.equal(f.requests.length, 1);
});
test('long-held scalp still refreshes stale quotes instead of using the disabled timer', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const trade = f.state.BTC.activeTrade;
  trade.startedAt = Date.now() - 120000;
  f.state.BTC.lastQuoteMessageTs = Date.now() - 5000;
  let reads = 0;
  f.api.getMarket = async ticker => { reads++; assert.equal(ticker, trade.ticker);
    return { status: 'open', yes_ask_dollars: '0.72', yes_bid_dollars: '0.71' }; };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(reads, 1);
  assert.equal(f.requests.length, 1);
});
test('scalp held across rollover reconciles settlement using its original ticker', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const trade = f.state.BTC.activeTrade;
  const pnl = trade.count - trade.amount - trade.entryFees;
  trade.startedAt = Date.now() - 100000;
  f.state.BTC.ticker = 'NEW-MARKET';
  f.api.getPositions = async () => [];
  f.api.getMarket = async ticker => { assert.equal(ticker, trade.ticker); return {status:'finalized',result:'yes'}; };
  f.api.getAllFills = async () => [{ order_id:trade.entryOrderId, ticker:trade.ticker, created_time:new Date(trade.startedAt).toISOString() }];
  f.api.getAllSettlements = async () => [{ticker:trade.ticker,settled_time:new Date().toISOString(),market_result:'yes'}];
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade,null);
  assert.ok(Math.abs(f.state.BTC.totalPnL-pnl)<1e-9);
  assert.equal(f.requests.length,1);
});
