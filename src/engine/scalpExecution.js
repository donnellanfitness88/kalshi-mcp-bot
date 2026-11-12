import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from './state.js';
import { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket } from '../kalshi/client.js';
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
export function scalpSize(price, balance) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(balance)) return 0;
  const budget = Math.min(SCALP_CONFIG.maxEntryCostUsd, balance);
  let count = Math.max(0, Math.floor(budget / (price + 0.02)));
  while (count && count * price + reserveFee(count) > budget + 1e-9) count--;
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
  const api = { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket, ...deps.api };
  const shared = deps.state ?? state;
  const save = deps.save ?? saveJournal;
  const log = deps.log ?? (message => console.log('[SCALP] ' + JSON.stringify(message)));
  let busy = false;
  let pending = null;
  let lastAttempt = 0;
  const assets = () => ['BTC', 'ETH'].map(asset => shared[asset]);
  const snapshot = () => ({ pending, positions: Object.fromEntries(['BTC', 'ETH'].map(asset =>
    [asset, shared[asset].activeTrade?.mode === 'SCALP' ? shared[asset].activeTrade : null])) });
  const persist = () => save(snapshot());
  const simulated = () => shared.simMode || process.env.DRY_RUN === 'true';
  function restore(saved) {
    if (!saved) return;
    pending = saved.pending;
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
    persist(); // If this fails, no request is sent.
    let result;
    if (p.sim) {
      result = { fill_count: p.body.count, remaining_count: '0.00', average_fill_price: p.simYesPrice,
        average_fee_paid: String(reserveFee(Number(p.body.count)) / Number(p.body.count)) };
    } else {
      if (process.env.DRY_RUN === 'true') throw new Error('Live order blocked by DRY_RUN');
      result = await api.placeOrder(p.body);
    }
    pending.orderId = result.order_id;
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
  async function enter(ctx) {
    const { asset, s } = ctx;
    if (process.env.SCALP_ENABLED !== 'true' || !s.farmArmed || shared.disabledAssets.includes(asset)) return;
    if (assets().some(a => a.activeTrade) || Date.now() - lastAttempt < SCALP_CONFIG.reentryCooldownMs) return;
    if (Date.now() - Math.max(...assets().map(a => a.lastExitTime || 0)) < SCALP_CONFIG.reentryCooldownMs) return;
    if (s.secsLeft <= 60 || !s.ticker) return;
    const sim = simulated();
    s._simMode = sim;
    if (checkRiskGuards(s, ctx.balance).blocked) return;
    const signal = evaluateScalpEntry({ priceHistory: s.yesPriceHistory, yesAsk: s.yesAsk, yesBid: s.yesBid });
    if (!signal.shouldEnter) return;
    lastAttempt = Date.now();
    if (!sim && !await accountFlat()) { log({ event: 'ENTRY_BLOCKED', reason: 'ACCOUNT_NOT_FLAT' }); return; }
    const balance = sim ? shared.paperBalance : (await api.getBalance()) / 100;
    // Revalidate after account reads; the WebSocket can update during awaits.
    if (assets().some(a => a.activeTrade) || s.secsLeft <= 60) return;
    const fresh = evaluateScalpEntry({ priceHistory: s.yesPriceHistory, yesAsk: s.yesAsk, yesBid: s.yesBid });
    if (!fresh.shouldEnter || fresh.direction !== signal.direction) return;
    const price = signal.direction === 'UP' ? s.yesAsk : 1 - s.yesBid;
    const count = scalpSize(price, balance);
    if (!count) return;
    const body = buildBuyBody(s.ticker, signal.direction, count * price + 1e-9, s.yesAsk, s.yesBid);
    body.count = count.toFixed(2);
    body.client_order_id = crypto.randomUUID();
    await submit({ kind: 'entry', asset, side: signal.direction === 'UP' ? 'yes' : 'no',
      direction: signal.direction, body, sim, simYesPrice: body.price, startedAt: Date.now() });
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
    }
    if (s.secsLeft <= 30 && s.ticker === trade.ticker) decision = { shouldExit: true, reason: 'MARKET_CLOSING' };
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
      if (ctx.s.activeTrade?.mode === 'SCALP') await exit(ctx);
      else await enter(ctx);
    } catch (error) { log({ event: pending ? 'ORDER_UNCERTAIN' : 'BLOCKED', error: error.message,
      clientOrderId: pending?.body.client_order_id }); }
    finally { busy = false; }
  }
  return { tick, restore, snapshot };
}
export const scalpExecutor = createScalpExecutor();
export function restoreScalpExecution() { scalpExecutor.restore(loadJournal()); }
