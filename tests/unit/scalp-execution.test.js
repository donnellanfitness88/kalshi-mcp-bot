import { test } from 'node:test';
import { buildSellBody } from '../../src/kalshi/orders.js';
import { quantityUnits, contractQuantity, addQuantity, subtractQuantity } from '../../src/kalshi/quantity.js';
import { remainingHeldContracts, reconcileManualExit } from '../../src/engine/manualExitReconciliation.js';
import assert from 'node:assert/strict';
import { createScalpExecutor, scalpEntryBudget, scalpSize, reserveFee, scalpAck, entryPhase, lateFee, lateStage, lateStageSize } from '../../src/engine/scalpExecution.js';
import { checkRiskGuards } from '../../src/engine/riskManager.js';
import { evaluateScalpExit, scalpEntryPriceAllowed, scalpTakeProfitPrice } from '../../src/engine/scalpStrategy.js';

process.env.SCALP_ENABLED = 'true';
process.env.DRY_RUN = 'false';
function fixture(direction = 'UP', sim = false) {
  const now = Date.now();
  let retryClock = now;
  const asset = () => ({ activeTrade: null, farmArmed: true, lastExitTime: 0, lastLossTime: 0,
    consecutiveLosses: 0, sessionStartBalance: 100, dailyStartBalance: 100,
    sessionPnL: 0, dailyPnL: 0, totalPnL: 0, tradeCount: 0, secsLeft: 600,
    ticker: 'BTC-TEST', yesAsk: direction === 'UP' ? 0.21 : 0.81, yesBid: direction === 'UP' ? 0.20 : 0.80, lastQuoteMessageTs: now,
    yesPriceHistory: Array.from({ length: 61 }, (_, i) => ({
      ts: now - 6000 + i * 100,
      price: direction === 'UP' ? 0.175 + 0.03 * i / 60 : 0.835 - 0.03 * i / 60
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
  const executor = createScalpExecutor({ state, api: dynamicApi, now: () => retryClock, save: value => { saved = structuredClone(value); }, log: value => logs.push(value) });
  const ctx = asset => ({ asset, s: state[asset], balance: 100 });
  return { advanceRetry: (ms=3001) => { retryClock += ms; }, retryNow: () => retryClock, state, api, executor, requests, logs, ctx, saved: () => saved };
}
function targetFor(t) {
  return scalpTakeProfitPrice(t.entrySidePrice,t.side,{contracts:t.count,entryFees:t.entryFees,
    exitFees:reserveFee(t.count),originalCost:t.originalCost,realizedNet:t.realizedNet??0});
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
    assert.ok(Math.abs(t.entrySidePrice - (direction === 'UP' ? 0.21 : 0.20)) < 1e-9);
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
  const f = fixture(); setEntryBook(f,'yes',.11);
  f.api.placeOrder = async body => { f.requests.push(body); throw new Error('timeout'); };
  await f.executor.tick(f.ctx('BTC'));
  const id = f.requests[0].client_order_id;
  f.api.getOrders = async () => [{ order_id: 'o1', client_order_id: id, status: 'canceled', fill_count_fp: '3.00' }];
  f.api.getAllFills = async () => [{ fill_id: 'f1', order_id: 'o1', book_side: 'bid', count_fp: '3.00',
    yes_price_dollars: '0.11', no_price_dollars: '0.89', fee_cost: '0.03' }];
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
  const f = fixture(); setEntryBook(f,'yes',.11);
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade, originalCount = t.count;
  t.startedAt = Date.now() - 46000;
  f.state.BTC.yesBid = targetFor(t);
  f.state.BTC.yesAsk = f.state.BTC.yesBid + 0.01;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  f.api.placeOrder = async body => {
    f.requests.push(body);
    const count = f.requests.length === 2 ? 2 : Number(body.count);
    return { order_id: 'exit', fill_count: String(count), remaining_count: '0', average_fill_price: '0.26', average_fee_paid: '0.01' };
  };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(t.count, originalCount - 2);
  assert.equal(f.state.BTC.tradeCount, 0);
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade, null);
  assert.equal(f.state.BTC.tradeCount, 1);
  assert.ok(Math.abs(f.state.BTC.totalPnL - originalCount * 0.13) < 1e-9);
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
  f.state.BTC.yesBid = targetFor(t);
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
test('time boundaries: early scalp, middle buffer, final higher scalp and settlement', () => {
  for (const [seconds, phase] of [[481,'SCALP'], [480.001,'SCALP'], [480,'BUFFER'], [300,'BUFFER'], [180,'BUFFER'], [120,'LATE_SETTLEMENT'], [119,'LATE_SETTLEMENT'], [91,'LATE_SETTLEMENT'], [90,'LATE_SETTLEMENT'], [1,'LATE_SETTLEMENT'], [0,'CLOSED'], [-1,'CLOSED'], [NaN,'CLOSED']]) {
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
test('open scalp stays held below 480 seconds while losing', async () => {
  const f = fixture();
  await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  t.startedAt = Date.now() - 10000;
  f.state.BTC.secsLeft = 170;
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  f.state.BTC.yesBid = 0.10; f.state.BTC.yesAsk = 0.11;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(t.count) }];
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.BTC.activeTrade, t);
});
test('loss under $5 does not stop a young scalp and profit exits are retained', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade;
  f.state.BTC.yesBid = 0.10; f.state.BTC.yesAsk = 0.11;
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
    assert.ok(f.state.BTC.activeTrade.amount + f.state.BTC.activeTrade.entryFees <= 25);
  }
});
test('late entries reject prices below the current tier, stale quotes and an occupied account', async () => {
  for (const reason of ['cheap', 'stale', 'occupied']) {
    const f = fixture();
    Object.assign(f.state.BTC, { secsLeft: 59, yesAsk: reason === 'cheap' ? 0.96 : 0.97, yesBid: 0.95 });
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
    f.state.BTC.farmArmed = false;
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
    f.state.BTC.farmArmed = false;
    await restored.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.tradeCount, 1);
  }
});
test('partial manual sale preserves remaining position, fees and previously realized P&L', async () => {
  const f = fixture(); setEntryBook(f,'yes',.11); await f.executor.tick(f.ctx('BTC'));
  const t = f.state.BTC.activeTrade, n = t.count, fees = t.entryFees;
  f.api.getPositions = async () => [{ ticker: t.ticker, position_fp: String(n - 3) }];
  f.api.getAllFills = async () => [manualFill(t, 3, .13)];
  f.api.getOrder = async () => manualOrder(t, 3);
  await f.executor.tick(f.ctx('BTC'));
  const remaining = f.state.BTC.activeTrade;
  assert.equal(remaining.count, n - 3);
  assert.ok(Math.abs(remaining.entryFees - fees * (n - 3) / n) < 1e-9);
  assert.equal(f.state.BTC.tradeCount, 0);
  assert.ok(Math.abs(remaining.realizedNet - (3 * (0.13 - t.entrySidePrice) - fees * 3 / n - 0.05)) < 1e-9);
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
test('early price bands include 55 and 70 cents and reject expensive entries', () => {
  for (const price of [0.11,0.30,0.399,0.40,0.496,0.549,0.701,0.78,0.80,0.97,0.99,0,NaN]) assert.equal(scalpEntryPriceAllowed(price), false);
  for (const price of [0.16,0.20,0.21,0.25]) assert.equal(scalpEntryPriceAllowed(price), true);
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
  for (const side of ['yes','no']) for (const price of [0.15,0.155,0.251,0.30,0.39,0.40,0.55,0.60,0.69,0.70,0.701,0.78,0.80]) {
    const f = fixture(); setEntryBook(f, side, price);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,0);
  }
});
test('live entry path permits both sides outside the band', async () => {
  for (const side of ['yes','no']) for (const price of [0.16,0.20,0.21,0.25]) {
    const f = fixture(); setEntryBook(f, side, price);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,1);
    assert.equal(f.state.BTC.activeTrade.side,side);
  }
});
test('tiered targets match 70→75, 80→90 and 90→97 without a minimum hold', () => {
  for (const [entry,target] of [[0.21,0.26],[0.61,0.66],[0.70,0.75],[0.80,0.90],[0.90,0.97]]) {
    assert.equal(scalpTakeProfitPrice(entry),target);
    assert.equal(evaluateScalpExit({heldSeconds:1,entryPrice:entry,exitBid:target-0.001}).shouldExit,false);
    assert.equal(evaluateScalpExit({heldSeconds:1,entryPrice:entry,exitBid:target}).reason,'PRICE_TARGET');
  }
});
test('profit exits set an executable-side limit on YES and NO orders', async () => {
  for (const side of ['yes','no']) {
    const f=fixture(); setEntryBook(f,side,0.21);
    await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade;
    const target=targetFor(t);
    Object.assign(f.state.BTC, side==='yes' ? {yesBid:target,yesAsk:target+0.01} : {yesAsk:1-target,yesBid:1-target-0.01});
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,2);
    assert.equal(f.requests[1].price,(side==='yes'?target:1-target).toFixed(4));
    assert.equal(f.requests[1].reduce_only,true);
  }
});
test('losses greater than $5 do not trigger a sale when the stop is disabled', async () => {
  const f=fixture(); await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade;
  Object.assign(f.state.BTC,{yesBid:0.10,yesAsk:0.11});
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1);
  assert.equal(f.state.BTC.activeTrade,t);
});

test('early scalp can coexist with opposite-coin late entry past 45 seconds', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const trade = f.state.BTC.activeTrade;
  trade.startedAt = Date.now() - 120000;
  f.state.BTC.secsLeft = 60;
  Object.assign(f.state.ETH, { secsLeft: 60, yesAsk: 0.97, yesBid: 0.96 });
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('ETH'));
  assert.equal(f.state.BTC.activeTrade, trade);
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.ETH.activeTrade.mode, 'LATE_SETTLEMENT');
});
test('long-held scalp still refreshes stale quotes instead of using the disabled timer', async () => {
  const f = fixture(); await f.executor.tick(f.ctx('BTC'));
  const trade = f.state.BTC.activeTrade;
  trade.startedAt = Date.now() - 120000;
  f.state.BTC.lastQuoteMessageTs = Date.now() - 5000;
  let reads = 0;
  f.api.getMarket = async ticker => { reads++; assert.equal(ticker, trade.ticker);
    return { status: 'open', yes_ask_dollars: '0.20', yes_bid_dollars: '0.19' }; };
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
test('scalp can buy immediately after a completed profit exit when a dip qualifies again', async () => {
  const f=fixture(); await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade, target=targetFor(t);
  Object.assign(f.state.BTC,{yesBid:target,yesAsk:target+0.01});
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade,null);
  setEntryBook(f,'yes',0.21);
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,3);
  assert.equal(f.state.BTC.activeTrade.entrySidePrice,0.21);
});
test('fixed loss cooldown can be skipped for scalps while ordinary callers retain it', () => {
  const f=fixture(), s=f.state.BTC;
  Object.assign(s,{lastLossTime:Date.now(),consecutiveLosses:1});
  assert.equal(checkRiskGuards(s,100).reason,'COOLDOWN');
  assert.equal(checkRiskGuards(s,100,false,{skipLossCooldown:true}).blocked,false);
});
test('skipping fixed scalp cooldown does not bypass streak or account loss limits', () => {
  for (const [change,reason] of [
    [{consecutiveLosses:3,lastLossTime:Date.now()},'STREAK'],
    [{dailyPnL:-9},'DAILYCAP'],
    [{sessionPnL:-6},'SESSIONKILL']
  ]) {
    const f=fixture(),s=f.state.BTC;
    Object.assign(s,change,{_simMode:false});
    assert.equal(checkRiskGuards(s,100,false,{skipLossCooldown:true}).reason,reason);
  }
});
function insufficientBalanceError() {
  return Object.assign(new Error('insufficient balance'), { httpStatus:400, kalshiCode:'insufficient_balance',
    requestMethod:'POST', requestPath:'/portfolio/events/orders' });
}
test('explicit insufficient-balance rejection clears pending without recording a fill or P&L', async () => {
  const f=fixture();
  f.api.placeOrder=async body=>{f.requests.push(body);throw insufficientBalanceError();};
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.executor.snapshot().pending,null);
  assert.equal(f.state.BTC.activeTrade,null);
  assert.equal(f.state.BTC.tradeCount,0);
  assert.equal(f.state.BTC.totalPnL,0);
  assert.equal(f.logs.at(-1).event,'REJECTED_ORDER_RECONCILED');
  assert.equal(f.requests.length,1);
});
test('exact historically rejected request can recover after restart without resubmission', async () => {
  const f=fixture();
  f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC'));
  const saved=f.saved();
  saved.pending.body.client_order_id='777a5890-567c-4d8d-a124-f85bd8b834c5';
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(saved);
  await restored.tick(f.ctx('BTC'));
  assert.equal(restored.snapshot().pending,null);
  assert.equal(f.requests.length,1);
  assert.equal(f.state.BTC.tradeCount,0);
});
test('flat account never clears an unrelated timed-out request', async () => {
  const f=fixture();
  f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC'));
  await f.executor.tick(f.ctx('ETH'));
  assert.ok(f.executor.snapshot().pending);
  assert.equal(f.requests.length,1);
});
test('a matching exchange order takes priority over historical rejection evidence', async () => {
  const f=fixture();
  f.api.placeOrder=async()=>{throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC'));
  const saved=f.saved();
  saved.pending.body.client_order_id='777a5890-567c-4d8d-a124-f85bd8b834c5';
  f.api.getOrders=async()=>[{client_order_id:saved.pending.body.client_order_id,status:'resting'}];
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(saved);
  await restored.tick(f.ctx('BTC'));
  assert.ok(restored.snapshot().pending);
});
test('rejection recovery retains lock if position is nonzero or account lookup fails', async () => {
  for(const reason of ['position','api']) {
    const f=fixture();
    f.api.placeOrder=async()=>{throw insufficientBalanceError();};
    let reads=0;
    f.api.getPositions=async()=>{
      reads++;
      if(reads===1)return [];
      if(reason==='api')throw new Error('429');
      return [{ticker:'BTC-TEST',position_fp:'1'}];
    };
    await f.executor.tick(f.ctx('BTC'));
    assert.ok(f.executor.snapshot().pending);
    assert.equal(f.state.BTC.tradeCount,0);
  }
});
test('HTTP 429, server errors and duplicate-client-id conflicts remain uncertain', async () => {
  for(const status of [429,500,409]) {
    const f=fixture();
    f.api.placeOrder=async()=>{throw Object.assign(insufficientBalanceError(),{httpStatus:status});};
    await f.executor.tick(f.ctx('BTC'));
    assert.ok(f.executor.snapshot().pending);
  }
});
test('journal failure during rejected-order recovery does not release in-memory pending lock', async () => {
  const f=fixture();
  f.api.placeOrder=async()=>{throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC'));
  const saved=f.saved();
  saved.pending.body.client_order_id='777a5890-567c-4d8d-a124-f85bd8b834c5';
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{throw new Error('disk full');},log:()=>{}});
  restored.restore(saved);
  await restored.tick(f.ctx('BTC'));
  assert.ok(restored.snapshot().pending);
});

test('higher-priced scalps unlock strictly below two minutes on either side', async () => {
  for (const side of ['yes','no']) for (const seconds of [600,480,121,120,119,91,90,30,0]) {
    const f=fixture(); setEntryBook(f,side,0.80); f.state.BTC.secsLeft=seconds;
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length, seconds > 0 && seconds < 120 ? 1 : 0, `${side} ${seconds}`);
    if (f.requests.length) assert.equal(f.state.BTC.activeTrade.mode,'SCALP');
  }
});
test('account reads cannot carry an early entry into the buffer', async () => {
  const f=fixture(); setEntryBook(f,'yes',0.21);
  f.api.getBalance=async()=> { f.state.BTC.secsLeft=480; return 10000; };
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,0);
});

test('cheap YES waits for fifty percent net profit rather than a fixed twenty-cent exit', async () => {
  for (const price of [0.04,0.08,0.11,0.149]) {
    const f=fixture(); setEntryBook(f,'yes',price);
    await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade,target=targetFor(t);
    assert.ok(t); assert.ok(target>price*1.5);
    Object.assign(f.state.BTC,{yesBid:target-.01,yesAsk:target});
    await f.executor.tick(f.ctx('BTC'));assert.equal(f.requests.length,1);
    Object.assign(f.state.BTC,{yesBid:target,yesAsk:target+.01});
    await f.executor.tick(f.ctx('BTC'));assert.equal(f.requests.length,2);
    assert.equal(f.requests[1].price,target.toFixed(4));assert.equal(f.requests[1].reduce_only,true);
    assert.ok(f.state.BTC.totalPnL+1e-9 >= .5*t.originalCost);
  }
});
test('falling YES permits a lower-priced NO scalp with a net profit target',async()=>{
  const f=fixture('DOWN');await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade,target=targetFor(t);
  assert.equal(t.side,'no');assert.ok(Math.abs(t.entrySidePrice-.20)<1e-9);
  Object.assign(f.state.BTC,{yesAsk:1-target,yesBid:1-target-.01});
  await f.executor.tick(f.ctx('BTC'));assert.equal(f.requests.length,2);
  assert.equal(f.requests[1].price,(1-target).toFixed(4));
});
test('cheap NO is blocked and a cheap YES without rising momentum cannot enter', async () => {
  const f=fixture(); setEntryBook(f,'no',0.11);
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,0);
  setEntryBook(f,'yes',0.11);
  f.state.BTC.yesPriceHistory=f.state.BTC.yesPriceHistory.map(p=>({...p,price:0.105}));
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,0);
});

function stagedFixture(side='yes', sim=false) {
  const f=fixture('UP',sim);
  let order=0;
  f.api.getMarket=async()=>({status:'open'});
  f.api.placeOrder=async body=>{
    f.requests.push(body);
    return {order_id:`staged-${++order}`,fill_count:body.count,remaining_count:'0',
      average_fill_price:body.price,average_fee_paid:'0.01'};
  };
  f.stage=(seconds,price)=>{
    setEntryBook(f,side,price); f.state.BTC.secsLeft=seconds;
  };
  return f;
}
test('strict stage boundaries and each stage budget include fees',()=>{
  for (const [secs,id] of [[181,null],[180,null],[179,'under_180'],[120,'under_180'],
      [119,'under_120'],[60,'under_120'],[59,'under_60'],[0,null],[NaN,null]]) {
    assert.equal(lateStage(secs)?.id??null,id);
  }
  for (const budget of [1,10,20,0.5]) for (const price of [.90,.95,.97,.99]) {
    const count=lateStageSize(price,100,budget);
    assert.ok(count*price+(count?lateFee(count,price):0)<=budget+1e-9);
  }
});
test('three late stages aggregate YES or NO once each without replacing the holding',async()=>{
  for (const side of ['yes','no']) {
    const f=stagedFixture(side);
    for (const [secs,price] of [[179,.90],[119,.95],[59,.97]]) {
      f.stage(secs,price);
      await f.executor.tick(f.ctx('BTC'));
      await f.executor.tick(f.ctx('BTC'));
    }
    assert.equal(f.requests.length,3);
    const t=f.state.BTC.activeTrade;
    assert.equal(t.side,side); assert.equal(t.mode,'LATE_SETTLEMENT');
    assert.equal(t.count,79);
    assert.ok(Math.abs(t.amount-75.97)<1e-9);
    assert.ok(Math.abs(t.entryFees-.79)<1e-9);
    assert.ok(Math.abs(t.entrySidePrice-75.97/79)<1e-9);
    assert.deepEqual(t.entryOrderIds,['staged-1','staged-2','staged-3']);
    assert.equal(f.executor.snapshot().lateStages['BTC-TEST'].attempted.length,3);
    assert.ok(f.executor.snapshot().lateStages['BTC-TEST'].spent<=77);
    assert.ok(Math.abs(t.originalCost-76.76)<1e-9);
    await f.executor.tick(f.ctx('ETH')); assert.equal(f.requests.length,3);
  }
});
test('no late addition below threshold, on the opposite side, or on a new ticker',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  f.stage(119,.93); await f.executor.tick(f.ctx('BTC'));
  setEntryBook(f,'no',.97); await f.executor.tick(f.ctx('BTC'));
  f.state.BTC.ticker='NEXT'; f.stage(59,.97); await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1);
});
test('late stage thresholds are revalidated after balance and account reads',async()=>{
  for (const change of ['time','price','position','resting']) {
    const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
    f.stage(119,.95);
    f.api.getBalance=async()=>{
      if(change==='time')f.state.BTC.secsLeft=59;
      if(change==='price')setEntryBook(f,'yes',.93);
      if(change==='position')f.api.getPositions=async()=>[];
      if(change==='resting')f.api.getOrders=async()=>[{status:'resting'}];
      return 10000;
    };
    await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,1,change);
  }
});
test('late stage reservations and cumulative cost survive restart; no missed-stage catchup',async()=>{
  const f=stagedFixture(); f.stage(119,.95); await f.executor.tick(f.ctx('BTC'));
  const saved=structuredClone(f.executor.snapshot());
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(saved); await restored.tick(f.ctx('BTC')); assert.equal(f.requests.length,1);
  f.stage(59,.97); await restored.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
  assert.equal(f.state.BTC.activeTrade.count,77);
  assert.deepEqual(restored.snapshot().lateStages['BTC-TEST'].attempted,['under_120','under_60']);
});
test('unknown add-on order stays pending across ticks and restart',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC'));
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(structuredClone(f.executor.snapshot()));
  await restored.tick(f.ctx('BTC')); f.stage(59,.97); await restored.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,2); assert.equal(f.state.BTC.activeTrade.count,2);
  assert.equal(restored.snapshot().pending.stageId,'under_120');
});
test('no late additions to a legacy holding without staged journal evidence',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  const saved=structuredClone(f.executor.snapshot()); delete saved.lateStages;
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(saved); f.stage(59,.97); await restored.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1);
});
test('combined staged position settles once using all entry orders and actual fees',async()=>{
  for(const side of ['yes','no']) for(const result of ['yes','no']) {
    const f=stagedFixture(side);
    for(const [secs,price]of[[179,.90],[119,.95],[59,.97]]){
      f.stage(secs,price); await f.executor.tick(f.ctx('BTC'));
    }
    const t=f.state.BTC.activeTrade;
    f.state.BTC.ticker='NEXT'; f.state.BTC.secsLeft=600;
    f.api.getPositions=async()=>[];
    f.api.getMarket=async()=>({status:'finalized',result});
    f.api.getAllSettlements=async()=>[{ticker:t.ticker,settled_time:new Date(t.startedAt+10000).toISOString(),market_result:result}];
    f.api.getAllFills=async()=>t.entryOrderIds.map(order_id=>({order_id,created_time:new Date(t.startedAt).toISOString()}));
    const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
    restored.restore(structuredClone(f.executor.snapshot()));
    await restored.tick(f.ctx('BTC')); await restored.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade,null); assert.equal(f.state.BTC.tradeCount,1);
    assert.ok(Math.abs(f.state.BTC.totalPnL-((side===result?79:0)-76.76))<1e-9);
  }
});
test('manual full close recognizes all staged entry IDs and disables further additions',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  f.stage(119,.95); await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade;
  f.api.getPositions=async()=>[];
  f.api.getAllFills=async()=>[
    ...t.entryOrderIds.map(order_id=>({order_id,ticker:t.ticker,created_time:new Date(t.startedAt).toISOString(),book_side:'bid'})),
    manualFill(t,t.count,.98,.03)];
  f.api.getOrder=async()=>manualOrder(t,t.count);
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(structuredClone(f.executor.snapshot())); await restored.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade,null);
  assert.ok(restored.snapshot().lateStages[t.ticker].closed);
  f.stage(59,.97); await restored.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
});

test('late add-on rejected for insufficient balance releases only pending and consumes that stage',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  const old=f.state.BTC.activeTrade;
  f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);throw Object.assign(new Error('insufficient_balance'),{
    httpStatus:400,kalshiCode:'insufficient_balance',requestMethod:'POST',requestPath:'/portfolio/events/orders'});};
  await f.executor.tick(f.ctx('BTC')); await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,2); assert.equal(f.executor.snapshot().pending,null);
  assert.equal(f.state.BTC.activeTrade,old); assert.equal(f.state.BTC.tradeCount,0);
  assert.ok(Math.abs(f.executor.snapshot().lateStages['BTC-TEST'].spent-1.82)<1e-9);
});
test('zero-fill late add-on waits before retrying without replacing the original position',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  const old=f.state.BTC.activeTrade;
  f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);return {order_id:'empty',fill_count:'0',remaining_count:'0'};};
  await f.executor.tick(f.ctx('BTC')); await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,2); assert.equal(f.state.BTC.activeTrade,old);
  assert.ok(Math.abs(f.executor.snapshot().lateStages['BTC-TEST'].spent-1.82)<1e-9);
});
test('timed-out add-on reconciles partial fills into the existing position exactly once',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC'));
  const pending=f.executor.snapshot().pending;
  f.api.getOrders=async()=>[{order_id:'addon',client_order_id:pending.body.client_order_id,status:'canceled',fill_count_fp:'2'}];
  f.api.getAllFills=async()=>[{fill_id:'add-f',order_id:'addon',book_side:pending.body.side,count_fp:'2',yes_price_dollars:'.95',no_price_dollars:'.06',fee_cost:'.02'}];
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.count,4);
  assert.ok(Math.abs(f.state.BTC.activeTrade.amount-3.70)<1e-9);
  assert.ok(Math.abs(f.state.BTC.activeTrade.entryFees-.04)<1e-9);
  assert.equal(f.executor.snapshot().pending,null);
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
});
test('failed aggregate journal write leaves original holding intact and recovery does not double count',async()=>{
  const f=stagedFixture(); f.stage(179,.90); await f.executor.tick(f.ctx('BTC'));
  let saved=structuredClone(f.executor.snapshot()), fail=true;
  const executor=createScalpExecutor({state:f.state,api:{...f.api,getOrder:(...args)=>f.api.getOrder(...args),getAllFills:(...args)=>f.api.getAllFills(...args)},log:()=>{},save:value=>{
    if(fail && value.positions.BTC?.count===28)throw new Error('disk full');
    saved=structuredClone(value);
  }});
  executor.restore(saved); f.stage(119,.95); await executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.count,2); assert.equal(saved.pending.orderId,'staged-2');
  fail=false;
  f.api.getOrder=async()=>({order_id:'staged-2',status:'executed',fill_count_fp:'26'});
  f.api.getAllFills=async()=>[{fill_id:'recover',order_id:'staged-2',book_side:'bid',count_fp:'26',yes_price_dollars:'.95',no_price_dollars:'.05',fee_cost:'.26'}];
  await executor.tick(f.ctx('BTC')); await executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.count,28); assert.equal(f.requests.length,2);
  assert.ok(Math.abs(saved.lateStages['BTC-TEST'].spent-26.78)<1e-9);
});
test('partial manual sale retains stage spend cap and remaining cost before adding',async()=>{
  const f=stagedFixture(); f.stage(119,.95); await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade;
  f.api.getPositions=async()=>[{ticker:t.ticker,position_fp:'24'}];
  f.api.getAllFills=async()=>[manualFill(t,2,.95,.02)];
  f.api.getOrder=async()=>manualOrder(t,2);
  const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
  restored.restore(structuredClone(f.executor.snapshot())); await restored.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.count,24);
  f.api.getPositions=async()=>[{ticker:t.ticker,position_fp:String(f.state.BTC.activeTrade.count)}];
  f.stage(59,.97); await restored.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade.count,75);
  assert.ok(Math.abs(restored.snapshot().lateStages[t.ticker].spent-74.94)<1e-9);
});
test('scalp holdings cannot receive late stages; simulation and live holdings never mix',async()=>{
  const f=stagedFixture(); setEntryBook(f,'yes',.21); f.state.BTC.secsLeft=600;
  await f.executor.tick(f.ctx('BTC')); f.stage(179,.10); await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1); assert.equal(f.state.BTC.activeTrade.mode,'SCALP');
  const g=stagedFixture('yes',true); g.stage(179,.90); await g.executor.tick(g.ctx('BTC'));
  assert.equal(g.state.BTC.activeTrade.sim,true);
  g.state.simMode=false; g.stage(119,.95); await g.executor.tick(g.ctx('BTC'));
  assert.equal(g.requests.length,0); assert.equal(g.state.BTC.activeTrade.count,2);
});

test('late entries use IOC; zero fills retry with a fresh client ID after three seconds',async()=>{
  const f=stagedFixture(); f.stage(119,.95);
  let attempts=0;
  f.api.placeOrder=async body=>{
    f.requests.push(body); attempts++;
    assert.equal(body.time_in_force,'immediate_or_cancel');
    return {order_id:`retry-${attempts}`,fill_count:attempts===1?'0':body.count,remaining_count:'0',
      average_fill_price:body.price,average_fee_paid:'.01'};
  };
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.state.BTC.activeTrade,null);
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,1);
  f.advanceRetry(2999); await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,1);
  f.advanceRetry(2); await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
  assert.notEqual(f.requests[0].client_order_id,f.requests[1].client_order_id);
  assert.equal(f.state.BTC.activeTrade.count,26);
  assert.ok(Math.abs(f.executor.snapshot().lateStages['BTC-TEST'].records.under_120.spent-24.96)<1e-9);
});
test('partial YES and NO fills retry only remaining budget and keep every entry ID',async()=>{
  for(const side of ['yes','no']) {
    const f=stagedFixture(side); f.stage(119,.95);
    let attempts=0;
    f.api.placeOrder=async body=>{
      f.requests.push(body); attempts++;
      return {order_id:`partial-${attempts}`,fill_count:attempts===1?'4':body.count,remaining_count:'0',
        average_fill_price:body.price,average_fee_paid:'.01'};
    };
    await f.executor.tick(f.ctx('BTC')); assert.equal(f.state.BTC.activeTrade.count,4);
    await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,1);
    f.advanceRetry(); await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests[1].count,'22.00'); assert.equal(f.state.BTC.activeTrade.count,26);
    assert.equal(f.state.BTC.activeTrade.side,side);
    assert.deepEqual(f.state.BTC.activeTrade.entryOrderIds,['partial-1','partial-2']);
    f.advanceRetry(); await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
    assert.ok(Math.abs(f.executor.snapshot().lateStages['BTC-TEST'].spent-24.96)<1e-9);
  }
});
test('retry waits and per-stage remaining budget survive restart',async()=>{
  const f=stagedFixture(); f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);return {order_id:'first-partial',fill_count:'4',remaining_count:'0',average_fill_price:body.price,average_fee_paid:'.01'};};
  await f.executor.tick(f.ctx('BTC'));
  const restored=createScalpExecutor({state:f.state,api:f.api,now:f.retryNow,save:()=>{},log:()=>{}});
  restored.restore(structuredClone(f.executor.snapshot()));
  await restored.tick(f.ctx('BTC')); assert.equal(f.requests.length,1);
  f.advanceRetry(); await restored.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
  assert.equal(f.requests[1].count,'22.00');
  assert.ok(restored.snapshot().lateStages['BTC-TEST'].records.under_120.spent<25);
});
test('zero-fill retries stop below threshold, on stale quotes, or after their time tier',async()=>{
  for(const change of ['price','stale','time','side','cash']) {
    const f=stagedFixture(); f.stage(119,.95);
    f.api.placeOrder=async body=>{f.requests.push(body);return {order_id:'empty',fill_count:'0',remaining_count:'0'};};
    await f.executor.tick(f.ctx('BTC')); f.advanceRetry();
    if(change==='price')f.stage(119,.93);
    if(change==='stale')f.state.BTC.lastQuoteMessageTs-=5000;
    if(change==='time')f.state.BTC.secsLeft=59;
    if(change==='side')setEntryBook(f,'no',.97);
    if(change==='cash')f.api.getBalance=async()=>50;
    await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,1,change);
  }
});
test('an uncertain partial order never retries even after the wait has passed',async()=>{
  const f=stagedFixture(); f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC')); f.advanceRetry(10000);
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,1);
  assert.ok(f.executor.snapshot().pending);
});
test('reconciled zero fill releases a retry only after terminal confirmation',async()=>{
  const f=stagedFixture(); f.stage(119,.95);
  f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
  await f.executor.tick(f.ctx('BTC')); f.advanceRetry();
  const p=f.executor.snapshot().pending;
  f.api.getOrders=async()=>[{client_order_id:p.body.client_order_id,order_id:'empty',status:'canceled',fill_count_fp:'0'}];
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.executor.snapshot().pending,null);
  f.api.getOrders=async()=>[];
  await f.executor.tick(f.ctx('BTC')); assert.equal(f.requests.length,2);
});

test('all scalp prices use a one-dollar cap including fees and available balance',()=>{
  for(const [price,budget]of[[.01,1],[.08,1],[.0999,1],[.10,1],[.11,1],[.1199,1],[.12,1],[.149,1],[.55,1],[.70,1]]) {
    assert.equal(scalpEntryBudget(price),budget);
    for(const balance of [.05,.75,1,2,10,100]) {
      const n=scalpSize(price,balance);
      assert.ok(n===0 || n*price+reserveFee(n)<=Math.min(budget,balance)+1e-9);
      assert.ok((n+1)*price+reserveFee(n+1)>Math.min(budget,balance)-1e-9);
    }
  }
  for(const price of [NaN,0,-1,1,Infinity])assert.equal(scalpEntryBudget(price),0);
});
test('live and simulated cheap YES buys use one dollar with a fee-aware net target',async()=>{
  for(const sim of [false,true]) for(const [price,budget]of[[.08,1],[.10,1],[.11,1],[.12,1]]) {
    const f=fixture('UP',sim); setEntryBook(f,'yes',price);
    await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade;
    assert.ok(t); assert.equal(t.count,scalpSize(price,100));
    assert.ok(t.amount+reserveFee(t.count)<=budget+1e-9);
    assert.ok(targetFor(t)>t.entrySidePrice*1.5);
  }
});
test('scalp sizing uses the revalidated quote when it crosses a cheap-price boundary',async()=>{
  const f=fixture(); setEntryBook(f,'yes',.12);
  f.api.getBalance=async()=>{setEntryBook(f,'yes',.08); return 10000;};
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1);
  const t=f.state.BTC.activeTrade;
  assert.ok(t.amount+reserveFee(t.count)<=1+1e-9);
});
test('late stage sizing supports the new two, twenty-five and fifty dollar budgets',()=>{
  for(const [price,budget]of[[.90,2],[.95,25],[.97,50]]) {
    const n=lateStageSize(price,100,budget);
    assert.ok(n*price+lateFee(n,price)<=budget+1e-9);
    assert.ok((n+1)*price+lateFee(n+1,price)>budget);
  }
});

test('live scalp entries at low and standard eligible prices never reserve more than one dollar',async()=>{
  for(const side of ['yes','no'])for(const price of [.08,.11,.12,.16,.20,.21,.25]){
    if(side==='no' && price<.16)continue;
    const f=fixture();setEntryBook(f,side,price);
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.requests.length,1);
    const n=Number(f.requests[0].count);
    assert.ok(n*price+reserveFee(n)<=1+1e-9);
    assert.equal(f.requests[0].time_in_force,'fill_or_kill');
  }
});
test('middle late stage requires 95 cents; 94 cents cannot start the late strategy',async()=>{
  const f=stagedFixture();f.stage(119,.94);
  f.state.BTC.yesPriceHistory=[]; // Isolate settlement entry from scalp momentum.
  await f.executor.tick(f.ctx('BTC'));assert.equal(f.requests.length,0);
  f.stage(119,.95);await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,1);assert.equal(f.state.BTC.activeTrade.mode,'LATE_SETTLEMENT');
  assert.equal(f.requests[0].count,'26.00');
});
test('larger late stages never spend beyond remaining exchange cash',async()=>{
  const f=stagedFixture();let cash=40,order=0;
  f.api.getBalance=async()=>Math.floor((cash+1e-9)*100);
  f.api.placeOrder=async body=>{
    f.requests.push(body);
    const count=Number(body.count),price=Number(body.price),fees=count*.01;
    assert.ok(count*price+fees<=cash+1e-9);
    cash-=count*price+fees;
    return {order_id:`cash-${++order}`,fill_count:body.count,remaining_count:'0',average_fill_price:body.price,average_fee_paid:'.01'};
  };
  for(const [seconds,price]of[[179,.90],[119,.95],[59,.97]]){
    f.stage(seconds,price);await f.executor.tick(f.ctx('BTC'));
  }
  assert.equal(f.requests.length,3);
  assert.ok(Number(f.requests[2].count)<50);
  assert.ok(f.executor.snapshot().lateStages['BTC-TEST'].spent<=40+1e-9);
});

test('fixed-point contract quantities preserve hundredths and reject ambiguous values',()=>{
  for(const [raw,units]of[['0',0],['0.01',1],['1.55',155],['25.50',2550],[2.55,255]]){
    assert.equal(quantityUnits(raw),units);assert.equal(contractQuantity(raw),units/100);
  }
  assert.equal(contractQuantity('-1.55',true),-1.55);
  for(const raw of [null,undefined,'',' ',true,'1e2','1.555','-0.01',NaN,Infinity,0.001,'900719925474099100']){
    assert.throws(()=>quantityUnits(raw));
  }
  assert.equal(addQuantity(.1,.2),.3);assert.equal(subtractQuantity(.3,.2),.1);
});
test('acknowledgements accept fractional partial fills but never overfills or nonterminal responses',()=>{
  const p={body:{count:'2.00'},side:'yes'};
  const ack=scalpAck({fill_count:'1.55',remaining_count:'0.00',average_fill_price:'.97',average_fee_paid:'.002'},p);
  assert.equal(ack.count,1.55);assert.equal(ack.price,.97);assert.ok(Math.abs(ack.fees-.0031)<1e-12);
  assert.throws(()=>scalpAck({fill_count:'2.01',remaining_count:'0'},p));
  assert.throws(()=>scalpAck({fill_count:'1.55',remaining_count:'.45'},p));
});
test('fractional late fill appends to the holding, preserves spend, and sells exact fractional quantity',async()=>{
  for(const side of ['yes','no']){
    const f=stagedFixture(side);f.stage(179,.90);await f.executor.tick(f.ctx('BTC'));
    f.stage(119,.95);
    f.api.placeOrder=async body=>{f.requests.push(body);return {order_id:'fractional',fill_count:'2.55',remaining_count:'0',average_fill_price:body.price,average_fee_paid:'.002'};};
    await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade;
    assert.equal(t.count,4.55);assert.ok(Math.abs(t.amount-(1.8+2.55*.95))<1e-9);
    assert.ok(Math.abs(t.entryFees-(.02+2.55*.002))<1e-9);
    assert.equal(buildSellBody(t.ticker,t.side,t.count).count,'4.55');
    assert.equal(buildSellBody(t.ticker,t.side,.55).count,'0.55');
    assert.throws(()=>buildSellBody(t.ticker,t.side,.001));
  }
});
test('persisted uncertain fractional late fill reconciles all fills and settles without another buy',async()=>{
  for(const side of ['yes','no']){
    const f=stagedFixture(side);f.stage(119,.95);
    f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
    await f.executor.tick(f.ctx('BTC'));
    const saved=structuredClone(f.executor.snapshot()),p=saved.pending;
    saved.pending.orderId='fractional-order';
    f.api.getOrder=async()=>({order_id:'fractional-order',status:'canceled',fill_count_fp:'1.55'});
    f.api.getAllFills=async()=>[.10,.20,1.25].map((qty,i)=>({fill_id:`f-${i}`,order_id:'fractional-order',book_side:p.body.side,
      count_fp:qty.toFixed(2),yes_price_dollars:side==='yes'?'.95':'.05',no_price_dollars:side==='no'?'.95':'.05',fee_cost:'.001'}));
    const restored=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
    restored.restore(saved);await restored.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade.count,1.55);assert.equal(restored.snapshot().pending,null);
    assert.equal(f.requests.length,1);
    const t=f.state.BTC.activeTrade;
    f.state.BTC.secsLeft=0;
    f.api.getPositions=async()=>[];
    f.api.getAllSettlements=async()=>[{ticker:t.ticker,settled_time:new Date(t.startedAt+1000).toISOString(),market_result:side}];
    f.api.getMarket=async()=>({status:'finalized',result:side});
    const settling=createScalpExecutor({state:f.state,api:f.api,save:()=>{},log:()=>{}});
    settling.restore(structuredClone(restored.snapshot()));await settling.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade,null);assert.equal(f.state.BTC.tradeCount,1);
    assert.ok(Math.abs(f.state.BTC.totalPnL-(1.55-1.55*.95-.003))<1e-9);
    assert.equal(f.requests.length,1);
  }
});
test('fractional scalp exit and manual reductions preserve fractional remainders',async()=>{
  const f=fixture();setEntryBook(f,'yes',.11);await f.executor.tick(f.ctx('BTC'));
  const t=f.state.BTC.activeTrade;
  const target=targetFor(t);f.state.BTC.yesAsk=target+.01;f.state.BTC.yesBid=target;
  f.api.placeOrder=async body=>{f.requests.push(body);return {order_id:`exit-${f.requests.length}`,fill_count:f.requests.length===2?'0.55':body.count,
    remaining_count:'0',average_fill_price:String(target),average_fee_paid:'.01'};};
  await f.executor.tick(f.ctx('BTC'));assert.equal(t.count,6.45);
  const body=buildSellBody(t.ticker,t.side,t.count);assert.equal(body.count,'6.45');
  const held=remainingHeldContracts([{ticker:t.ticker,position_fp:'6.20'}],t);
  assert.equal(held,6.2);
  const reduction=reconcileManualExit(t,held,[manualFill(t,.25,.20,.001)]);
  assert.equal(reduction.sold,.25);
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade,null);assert.equal(f.state.BTC.tradeCount,1);
});
test('overfilled order counts and missing fractional fills keep the pending lock',async()=>{
  for(const reason of ['overfill','missing']){
    const f=stagedFixture();f.stage(179,.90);
    f.api.placeOrder=async body=>{f.requests.push(body);throw new Error('timeout');};
    await f.executor.tick(f.ctx('BTC'));
    const p=f.executor.snapshot().pending;
    f.api.getOrders=async()=>[{order_id:'bad',client_order_id:p.body.client_order_id,status:'canceled',fill_count_fp:reason==='overfill'?'2.01':'1.55'}];
    f.api.getAllFills=async()=>[{fill_id:'short',order_id:'bad',book_side:p.body.side,count_fp:'1.50',yes_price_dollars:'.90',no_price_dollars:'.10',fee_cost:'.001'}];
    await f.executor.tick(f.ctx('BTC'));
    assert.ok(f.executor.snapshot().pending);assert.equal(f.state.BTC.activeTrade,null);assert.equal(f.requests.length,1);
  }
});

test('early scalp entry boundaries focus on 16 through 25 cents and keep the cheap YES exception',()=>{
  for(const side of ['yes','no']) {
    for(const price of [.16,.18,.20,.21,.25])assert.equal(scalpEntryPriceAllowed(price,600,side),true);
    for(const price of [.15,.155,.2501,.31,.55,.61,.69,.70])assert.equal(scalpEntryPriceAllowed(price,600,side),false);
  }
  assert.equal(scalpEntryPriceAllowed(.04,600,'yes'),true);
  assert.equal(scalpEntryPriceAllowed(.04,600,'no'),false);
});
test('low scalp target is fifty percent of total invested dollars after both sides of fees',()=>{
  for(const entry of [.04,.08,.16,.18,.20]) {
    const contracts=4,entryFees=.04,exitFees=.09,originalCost=contracts*entry+entryFees;
    const accounting={contracts,entryFees,exitFees,originalCost,realizedNet:0};
    const target=scalpTakeProfitPrice(entry,'yes',accounting);
    const net=contracts*(target-entry)-entryFees-exitFees;
    assert.ok(net+1e-9>=.5*originalCost);
    assert.ok(contracts*(target-.01-entry)-entryFees-exitFees<.5*originalCost);
    assert.equal(evaluateScalpExit({heldSeconds:1,entryPrice:entry,side:'yes',exitBid:target,accounting}).shouldExit,true);
    assert.equal(evaluateScalpExit({heldSeconds:1,entryPrice:entry,side:'yes',exitBid:target-.01,accounting}).shouldExit,false);
    assert.equal(scalpTakeProfitPrice(entry,'no',accounting),target);
  }
  assert.throws(()=>scalpTakeProfitPrice(.16),/accounting/);
  assert.equal(scalpTakeProfitPrice(.21),.26);
});
test('16 through 20 cent YES and NO entries exit with at least fifty percent net profit',async()=>{
  for(const side of ['yes','no'])for(const price of [.16,.18,.20]) {
    const f=fixture();setEntryBook(f,side,price);await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade,originalCost=t.originalCost,target=targetFor(t);
    Object.assign(f.state.BTC,side==='yes'?{yesBid:target,yesAsk:target+.01}:{yesAsk:1-target,yesBid:1-target-.01});
    await f.executor.tick(f.ctx('BTC'));
    assert.equal(f.state.BTC.activeTrade,null);
    assert.ok(f.state.BTC.totalPnL+1e-9>=.5*originalCost);
    assert.equal(f.requests[1].price,(side==='yes'?target:1-target).toFixed(4));
  }
});
test('partial exits retain the original net profit goal rather than resetting it on the remainder',()=>{
  const accounting={contracts:3,entryFees:.03,exitFees:.07,originalCost:.84,realizedNet:.15};
  const target=scalpTakeProfitPrice(.20,'yes',accounting);
  const net=accounting.realizedNet+3*(target-.20)-accounting.entryFees-accounting.exitFees;
  assert.ok(net+1e-9>=.50*accounting.originalCost);
  assert.ok(net-.03<.50*accounting.originalCost);
});

function lateOther(f, asset, seconds=179, price=.90, side='yes') {
  Object.assign(f.state[asset], {secsLeft:seconds, yesAsk:side==='yes'?price:1-price+.01,
    yesBid:side==='yes'?price-.01:1-price,lastQuoteMessageTs:Date.now()});
}
test('either coin early scalp permits the other coin late stages and survives journal restore',async()=>{
  for(const scalpAsset of ['BTC','ETH']) for(const side of ['yes','no']) {
    const f=stagedFixture(); const lateAsset=scalpAsset==='BTC'?'ETH':'BTC';
    await f.executor.tick(f.ctx(scalpAsset)); const scalp=f.state[scalpAsset].activeTrade;
    for(const [seconds,price] of [[179,.90],[119,.95],[59,.97]]) {
      f.advanceRetry(); lateOther(f,lateAsset,seconds,price,side);
      await f.executor.tick(f.ctx(lateAsset));
    }
    assert.equal(f.requests.length,4);
    assert.equal(f.state[scalpAsset].activeTrade,scalp);
    assert.equal(f.state[lateAsset].activeTrade.count,79);
    assert.equal(f.state[lateAsset].activeTrade.side,side);
    assert.ok(f.executor.snapshot().lateStages[f.state[lateAsset].ticker].spent<=77);
    const saved=structuredClone(f.executor.snapshot());
    f.state.BTC.activeTrade=null;f.state.ETH.activeTrade=null;
    f.executor.restore(saved);
    assert.equal(f.state[scalpAsset].activeTrade.mode,'SCALP');
    assert.equal(f.state[lateAsset].activeTrade.mode,'LATE_SETTLEMENT');
    assert.ok(f.state[scalpAsset].activeTrade.originalCost<=1);
  }
});
test('opposite-coin late entry rejects unexpected, mismatched or resting account exposure',async()=>{
  for(const issue of ['unexpected','missing','reversed','increased','malformed','resting']) {
    const f=stagedFixture();await f.executor.tick(f.ctx('BTC'));
    const t=f.state.BTC.activeTrade;
    f.api.getPositions=async()=>issue==='missing'?[]:[{ticker:t.ticker,position_fp:
      issue==='reversed'?String(-t.count):issue==='increased'?String(t.count+1):issue==='malformed'?'':String(t.count)},
      ...(issue==='unexpected'?[{ticker:'UNKNOWN',position_fp:'1'}]:[])];
    if(issue==='resting')f.api.getOrders=async()=>[{ticker:t.ticker,status:'resting'}];
    lateOther(f,'ETH');await f.executor.tick(f.ctx('ETH'));
    assert.equal(f.requests.length,1,issue);
  }
});
test('late scalp and mixed simulation holdings do not qualify for cross-coin exception',async()=>{
  for(const issue of ['lateScalp','mixedSim']){
    const f=stagedFixture(); await f.executor.tick(f.ctx('BTC'));
    if(issue==='lateScalp')f.state.BTC.activeTrade.entrySecondsRemaining=100;
    else f.state.BTC.activeTrade.sim=true;
    lateOther(f,'ETH');await f.executor.tick(f.ctx('ETH'));
    assert.equal(f.requests.length,1);
  }
});
test('early scalp profit exit preserves opposite late holding and its stage ledger',async()=>{
  const f=stagedFixture();await f.executor.tick(f.ctx('BTC'));
  lateOther(f,'ETH');await f.executor.tick(f.ctx('ETH'));
  const late=f.state.ETH.activeTrade;const ledger=structuredClone(f.executor.snapshot().lateStages);
  const t=f.state.BTC.activeTrade;
  Object.assign(f.state.BTC,{yesBid:targetFor(t),yesAsk:targetFor(t)+.01,lastQuoteMessageTs:Date.now()});
  await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.state.BTC.activeTrade,null);
  assert.equal(f.state.ETH.activeTrade,late);
  assert.deepEqual(f.executor.snapshot().lateStages,ledger);
  // A new scalp cannot start alongside the existing late holding.
  setEntryBook(f,'yes',.21);await f.executor.tick(f.ctx('BTC'));
  assert.equal(f.requests.length,3);
});
test('legacy early scalp qualifies without rewriting its holding',async()=>{
  const f=stagedFixture();await f.executor.tick(f.ctx('BTC'));
  delete f.state.BTC.activeTrade.entrySecondsRemaining;
  lateOther(f,'ETH');await f.executor.tick(f.ctx('ETH'));
  assert.equal(f.requests.length,2);
});
