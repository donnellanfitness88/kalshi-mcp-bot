import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from './state.js';
import { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket, getAllSettlements } from '../kalshi/client.js';
import { buildBuyBody, buildSellBody } from '../kalshi/orders.js';
import { SCALP_CONFIG, evaluateScalpEntry, evaluateScalpExit, evaluateScalpProfit, createScalpPosition } from './scalpStrategy.js';
import { checkRiskGuards, recordTradePnL } from './riskManager.js';

// Journal before sending: an ambiguous response is reconciled, never resubmitted.
const journalPath = path.join(process.env.SCALP_STATE_DIR ?? fileURLToPath(new URL('../../data/', import.meta.url)), 'scalp_execution.json');
function saveJournal(value) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const file = journalPath;
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Reserve more than the standard maximum taker fee (1.75 cents/contract),
// plus rounding. The budget includes this reserve, not only contract cost.
export function reserveFee(count) { return Math.ceil((0.02 * count + 0.01) * 100) / 100; }
export const isManagedTrade = trade => ['SCALP', 'LATE_SETTLEMENT'].includes(trade?.mode);
export function remainingSeconds(s, now = Date.now()) {
  if (Number.isFinite(s.marketCloseTs)) return (s.marketCloseTs - now) / 1000;
  return s.secsLeft - Math.max(0, now - (s.clockUpdatedAt ?? now)) / 1000;
}
export function entryPhase(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'CLOSED';
  if (seconds > SCALP_CONFIG.entryMinSecondsRemaining) return 'SCALP';
  if (seconds <= SCALP_CONFIG.lateEntryMaxSecondsRemaining) return 'LATE_SETTLEMENT';
  return 'BUFFER';
}
export function lateFee(count, price) {
  return Math.ceil((0.07 * count * price * (1 - price) + 1e-9) * 100) / 100;
}
export function scalpSize(price, balance, mode = 'SCALP') {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(balance)) return 0;
  const budget = Math.min(SCALP_CONFIG.maxEntryCostUsd, balance);
  const fee = mode === 'LATE_SETTLEMENT' ? n => lateFee(n, price) : reserveFee;
  let count = Math.max(0, Math.floor(budget / price));
  while (count && count * price + fee(count) > budget + 1e-9) count--;
  return count;
}
function decimal(raw, field) {
  if (!['string', 'number'].includes(typeof raw) || raw === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
    throw new Error(`Missing or invalid ${field}`);
  }
  return Number(raw);
}
// V2 prices refer to the YES book for both bid and ask orders.
export function scalpAck(result, pending) {
  const count = decimal(result?.fill_count, 'fill_count');
  const remaining = decimal(result?.remaining_count, 'remaining_count');
  if (!Number.isSafeInteger(count) || count > Number(pending.body.count) || remaining !== 0) {
    throw new Error('Nonterminal or invalid SCALP response');
  }
  if (!count) return { count: 0, price: 0, fees: 0 };
  const yesPrice = decimal(result.average_fill_price, 'average_fill_price');
  if (yesPrice <= 0 || yesPrice >= 1) throw new Error('Invalid fill price');
  return { count, price: pending.side === 'yes' ? yesPrice : 1 - yesPrice,
    fees: count * decimal(result.average_fee_paid, 'average_fee_paid') };
}

export function createScalpExecutor(deps = {}) {
  const api = { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket, getAllSettlements, ...deps.api };
  const shared = deps.state ?? state;
  const save = deps.save ?? saveJournal;
  const log = deps.log ?? (message => console.log('[SCALP] ' + JSON.stringify(message)));
  let busy = false;
  let pending = null;
  let lastAttempt = 0;
  let lateEntryTickers = [];
  const settlementPolls = new Map();
  const assets = () => ['BTC', 'ETH'].map(asset => shared[asset]);
  const snapshot = () => ({ pending, lateEntryTickers, positions: Object.fromEntries(['BTC', 'ETH'].map(asset =>
    [asset, isManagedTrade(shared[asset].activeTrade) ? shared[asset].activeTrade : null])) });
  const persist = () => save(snapshot());
  const simulated = () => shared.simMode || process.env.DRY_RUN === 'true';
  function restore(saved) {
    if (!saved) return;
    pending = saved.pending ?? null;
    lateEntryTickers = saved.lateEntryTickers ?? [];
    for (const asset of ['BTC', 'ETH']) {
      if (saved.positions?.[asset]) shared[asset].activeTrade = saved.positions[asset];
    }
  }
  function applyFill(p, fill) {
    const s = shared[p.asset];
    if (p.kind === 'entry' && fill.count) {
      s.activeTrade = { ...createScalpPosition({ ticker: p.body.ticker, direction: p.direction,
        confirmedContracts: fill.count, averageFillPrice: fill.price, entryFees: fill.fees,
        estimatedExitFees: reserveFee(fill.count), startedAt: p.startedAt }),
        mode: p.mode ?? 'SCALP', entryOrderId: p.orderId,
        sim: p.sim, realizedNet: 0, originalCost: fill.count * fill.price + fill.fees };
    } else if (p.kind === 'exit' && fill.count) {
      const trade = s.activeTrade;
      if (!trade || fill.count > trade.count) throw new Error('Exit exceeds tracked position');
      const allocatedFees = trade.entryFees * fill.count / trade.count;
      const net = fill.count * (fill.price - trade.entrySidePrice) - allocatedFees - fill.fees;
      trade.realizedNet += net;
      trade.entryFees -= allocatedFees;
      trade.count -= fill.count;
      trade.amount = trade.count * trade.entrySidePrice;
      trade.maxProfit = trade.count * (1 - trade.entrySidePrice);
      if (trade.sim) shared.paperBalance += net;
      if (!trade.count) {
        recordTradePnL(s, trade.realizedNet);
        s.activeTrade = null;
        s.lastExitTime = Date.now();
        log({ event: 'CLOSED', asset: p.asset, pnl: trade.realizedNet, reason: p.reason, sim: trade.sim });
      }
    }
    pending = null;
    persist();
    log({ event: p.kind.toUpperCase() + '_CONFIRMED', asset: p.asset, ...fill, sim: p.sim });
  }
  async function reconcile() {
    if (!pending) return;
    const p = pending;
    let order;
    if (p.orderId) order = await api.getOrder(p.orderId);
    else order = (await api.getOrders({ ticker: p.body.ticker })).find(o => o.client_order_id === p.body.client_order_id);
    if (!order || !['executed', 'canceled'].includes(order.status)) throw new Error('Order remains unverified; no retry');
    p.orderId = order.order_id;
    const count = decimal(order.fill_count_fp, 'fill_count_fp');
    if (!Number.isSafeInteger(count) || count > Number(p.body.count)) throw new Error('Invalid reconciled count');
    if (!count) { applyFill(p, { count: 0, price: 0, fees: 0 }); return; }
    const fills = (await api.getAllFills({ ticker: p.body.ticker })).filter(f => f.order_id === order.order_id);
    const seen = new Set();
    let quantity = 0, gross = 0, fees = 0;
    for (const f of fills) {
      const id = f.fill_id ?? f.trade_id;
      if (!id || seen.has(id)) throw new Error('Missing or duplicate fill identifier');
      seen.add(id);
      if (f.book_side !== p.body.side) throw new Error('Fill book side mismatch');
      const qty = decimal(f.count_fp, 'count_fp');
      const price = decimal(p.side === 'yes' ? f.yes_price_dollars : f.no_price_dollars, 'fill price');
      if (!Number.isSafeInteger(qty) || qty <= 0 || price <= 0 || price >= 1) throw new Error('Invalid fill');
      quantity += qty; gross += qty * price; fees += decimal(f.fee_cost, 'fee_cost');
    }
    if (quantity !== count) throw new Error('Fills not fully available; no retry');
    applyFill(p, { count, price: gross / quantity, fees });
  }
  async function submit(p) {
    pending = p;
    if (p.kind === 'entry' && p.mode === 'LATE_SETTLEMENT') {
      lateEntryTickers = [...new Set([...lateEntryTickers, p.body.ticker])].slice(-500);
    }
    persist(); // If this fails, no request is sent.
    let result;
    if (p.sim) {
      result = { fill_count: p.body.count, remaining_count: '0.00', average_fill_price: p.simYesPrice,
        average_fee_paid: String((p.mode === 'LATE_SETTLEMENT' ? lateFee(Number(p.body.count), p.side === 'yes' ? Number(p.body.price) : 1 - Number(p.body.price)) : reserveFee(Number(p.body.count))) / Number(p.body.count)) };
    } else {
      if (process.env.DRY_RUN === 'true') throw new Error('Live order blocked by DRY_RUN');
      result = await api.placeOrder(p.body);
    }
    pending.orderId = result.order_id;
    if (p.mode === 'LATE_SETTLEMENT' && !pending.orderId) throw new Error('Missing late-entry order id');
    pending.response = result;
    persist();
    applyFill(p, scalpAck(result, p));
  }
  async function accountFlat() {
    const positions = await api.getPositions();
    if (positions.some(p => !['string', 'number'].includes(typeof p.position_fp) ||
        !Number.isFinite(Number(p.position_fp)) || Number(p.position_fp) !== 0)) return false;
    return (await api.getOrders({ status: 'resting' })).length === 0;
  }
  function entrySignal(s, mode) {
    const now = Date.now();
    if (!Number.isFinite(s.lastQuoteMessageTs) || now - s.lastQuoteMessageTs > 2000 ||
        s.lastQuoteMessageTs > now || ![s.yesAsk, s.yesBid].every(Number.isFinite) ||
        s.yesBid <= 0 || s.yesAsk >= 1 || s.yesAsk < s.yesBid) return { shouldEnter: false };
    if (mode === 'SCALP') return evaluateScalpEntry({ priceHistory: s.yesPriceHistory, yesAsk: s.yesAsk, yesBid: s.yesBid });
    if (mode !== 'LATE_SETTLEMENT' || lateEntryTickers.includes(s.ticker)) return { shouldEnter: false };
    const candidates = [{ direction: 'UP', price: s.yesAsk }, { direction: 'DOWN', price: 1 - s.yesBid }]
      .filter(c => c.price >= SCALP_CONFIG.lateEntryMinPrice - 1e-9 && c.price < 1)
      .sort((a, b) => b.price - a.price);
    return candidates.length ? { shouldEnter: true, direction: candidates[0].direction } : { shouldEnter: false };
  }
  async function enter(ctx) {
    const { asset, s } = ctx;
    if (process.env.SCALP_ENABLED !== 'true' || !s.farmArmed || shared.disabledAssets.includes(asset)) return;
    if (assets().some(a => a.activeTrade) || Date.now() - lastAttempt < SCALP_CONFIG.reentryCooldownMs) return;
    if (Date.now() - Math.max(...assets().map(a => a.lastExitTime || 0)) < SCALP_CONFIG.reentryCooldownMs) return;
    const mode = entryPhase(remainingSeconds(s));
    if (!['SCALP', 'LATE_SETTLEMENT'].includes(mode) || !s.ticker) return;
    const ticker = s.ticker;
    const sim = simulated();
    s._simMode = sim;
    if (checkRiskGuards(s, ctx.balance).blocked) return;
    const signal = entrySignal(s, mode);
    if (!signal.shouldEnter) return;
    lastAttempt = Date.now();
    if (!sim && !await accountFlat()) { log({ event: 'ENTRY_BLOCKED', reason: 'ACCOUNT_NOT_FLAT' }); return; }
    const balance = sim ? shared.paperBalance : (await api.getBalance()) / 100;
    // Revalidate the actual close time, ticker and quote after slow account reads.
    if (assets().some(a => a.activeTrade) || s.ticker !== ticker || entryPhase(remainingSeconds(s)) !== mode) return;
    const fresh = entrySignal(s, mode);
    if (!fresh.shouldEnter || fresh.direction !== signal.direction) return;
    const price = fresh.direction === 'UP' ? s.yesAsk : 1 - s.yesBid;
    const count = scalpSize(price, balance, mode);
    if (!count || (mode === 'LATE_SETTLEMENT' && count * (1 - price) <= lateFee(count, price))) return;
    const body = buildBuyBody(ticker, fresh.direction, count * price + 1e-9, s.yesAsk, s.yesBid);
    body.count = count.toFixed(2);
    body.client_order_id = crypto.randomUUID();
    await submit({ kind: 'entry', asset, mode, side: fresh.direction === 'UP' ? 'yes' : 'no',
      direction: fresh.direction, body, sim, simYesPrice: body.price, startedAt: Date.now() });
  }
  async function settle(ctx) {
    const { asset, s } = ctx;
    const trade = s.activeTrade;
    if (Date.now() - (settlementPolls.get(trade.ticker) ?? 0) < 10000) return;
    settlementPolls.set(trade.ticker, Date.now());
    const market = await api.getMarket(trade.ticker); // Original ticker, even after rollover.
    if (market.status !== 'finalized') return;
    let result = market.result;
    if (!['yes', 'no'].includes(result)) throw new Error('Non-binary/void settlement requires reconciliation');
    if (!trade.sim) {
      const records = (await api.getAllSettlements({ ticker: trade.ticker })).filter(row => row.ticker === trade.ticker);
      const record = records.find(row => Date.parse(row.settled_time) >= trade.startedAt);
      if (!record) return; // Market result alone does not prove account settlement.
      if (record.market_result !== result) throw new Error('Settlement result mismatch');
      const position = (await api.getPositions()).find(row => row.ticker === trade.ticker);
      if (position) {
        if (!['string', 'number'].includes(typeof position.position_fp) ||
            String(position.position_fp).trim() === '' || !Number.isFinite(Number(position.position_fp))) {
          throw new Error('Invalid settled position');
        }
        if (Number(position.position_fp) !== 0) return;
      }
      const fills = await api.getAllFills({ ticker: trade.ticker });
      if (!trade.entryOrderId || fills.some(fill => fill.order_id !== trade.entryOrderId &&
          Date.parse(fill.created_time) >= trade.startedAt - 1000)) {
        throw new Error('Other fills affected late holding; settlement reconciliation required');
      }
    }
    // Attribute only this tracked lot. A settlement row can include earlier scalps
    // in the same ticker; its cumulative revenue/fees must not be counted again.
    const payout = result === trade.side ? trade.count : 0;
    const pnl = payout - trade.amount - trade.entryFees;
    if (trade.sim) shared.paperBalance += pnl;
    recordTradePnL(s, pnl);
    s.activeTrade = null;
    s.lastExitTime = Date.now();
    persist();
    log({ event: 'SETTLED', asset, ticker: trade.ticker, mode: trade.mode, result, payout,
      pnl, sim: trade.sim });
  }
  async function exit(ctx) {
    const { asset, s } = ctx;
    const trade = s.activeTrade;
    if (trade?.mode !== 'SCALP') return;
    let ask = s.yesAsk, bid = s.yesBid;
    const heldSeconds = (Date.now() - trade.startedAt) / 1000;
    if (heldSeconds < SCALP_CONFIG.maxHoldSeconds && (s.ticker !== trade.ticker || !s.lastQuoteMessageTs || Date.now() - s.lastQuoteMessageTs > 2000)) {
      const market = await api.getMarket(trade.ticker);
      if (market.status === 'finalized') {
        log({ event: 'SETTLEMENT_RECONCILIATION_REQUIRED', ticker: trade.ticker });
        return; // Never fabricate settlement P&L or clear an unverified holding.
      }
      ask = Number(market.yes_ask_dollars); bid = Number(market.yes_bid_dollars);
    }
    let decision = { shouldExit: heldSeconds >= SCALP_CONFIG.maxHoldSeconds, reason: 'MAX_HOLD_TIME' };
    if ([ask, bid].every(Number.isFinite) && bid >= 0 && ask <= 1 && ask >= bid) {
      const profit = evaluateScalpProfit({ entryPrice: trade.entrySidePrice, exitBid: trade.side === 'yes' ? bid : 1 - ask,
        contracts: trade.count, entryFees: trade.entryFees, exitFees: reserveFee(trade.count) });
      decision = evaluateScalpExit({ heldSeconds, netReturn: profit.netReturn });
      // Include already-realized partial exits so repeated partial sales cannot
      // reset the per-trade $3 loss budget.
      if ((trade.realizedNet ?? 0) + profit.netProfit <= -SCALP_CONFIG.maxLossUsd) {
        decision = { shouldExit: true, reason: 'MAX_DOLLAR_LOSS' };
      }
    }

    if (!decision.shouldExit) return;
    if (!trade.sim) {
      if (process.env.DRY_RUN === 'true') throw new Error('Live SCALP requires live exit; DRY_RUN changed');
      const position = (await api.getPositions()).find(p => p.ticker === trade.ticker);
      const held = Number(position?.position_fp);
      const expected = trade.side === 'yes' ? trade.count : -trade.count;
      if (!Number.isFinite(held) || held !== expected) throw new Error('SCALP position mismatch; reconciliation required');
    }
    const body = buildSellBody(trade.ticker, trade.side, trade.count);
    await submit({ kind: 'exit', asset, side: trade.side, body, sim: trade.sim,
      simYesPrice: String(trade.side === 'yes' ? bid : ask), reason: decision.reason, startedAt: Date.now() });
  }
  async function tick(ctx) {
    if (busy) return;
    busy = true;
    try {
      if (pending) { await reconcile(); return; }
      if (ctx.s.activeTrade?.mode === 'LATE_SETTLEMENT') await settle(ctx);
      else if (ctx.s.activeTrade?.mode === 'SCALP') await exit(ctx);
      else await enter(ctx);
    } catch (error) { log({ event: pending ? 'ORDER_UNCERTAIN' : 'BLOCKED', error: error.message,
      clientOrderId: pending?.body.client_order_id }); }
    finally { busy = false; }
  }
  return { tick, restore, snapshot };
}
export const scalpExecutor = createScalpExecutor();
export function restoreScalpExecution() { scalpExecutor.restore(loadJournal()); }
