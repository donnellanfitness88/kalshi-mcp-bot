import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from './state.js';
import { definiteOrderRejection, historicalOrderRejection } from './orderRejections.js';
import { reconcileManualExit, remainingHeldContracts } from './manualExitReconciliation.js';
import { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket, getAllSettlements } from '../kalshi/client.js';
import { buildBuyBody, buildSellBody } from '../kalshi/orders.js';
import { SCALP_CONFIG, scalpEntryPriceAllowed, evaluateScalpEntry, evaluateScalpExit, evaluateScalpProfit, createScalpPosition } from './scalpStrategy.js';
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
  if (seconds < SCALP_CONFIG.highPriceEntryMaxSecondsRemaining) return 'SCALP';
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
  const manualPolls = new Map();
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
      if (p.orderId) trade.accountedExitOrderIds = [...new Set([...(trade.accountedExitOrderIds ?? []), p.orderId])];
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
  async function recoverRejectedOrder(p, proof) {
    if (p.orderId || p.response || proof?.httpStatus !== 400 || proof?.code !== 'insufficient_balance') {
      throw new Error('Rejected-order recovery has conflicting execution evidence');
    }
    const orders = await api.getOrders({ ticker: p.body.ticker });
    if (orders.some(order => order.client_order_id === p.body.client_order_id)) {
      throw new Error('Rejected request has an order record; reconcile that order instead');
    }
    if (orders.some(order => order.status === 'resting')) {
      throw new Error('Resting order on rejected ticker; retaining pending record');
    }
    if (p.kind === 'entry') {
      const position = (await api.getPositions()).find(row => row.ticker === p.body.ticker);
      if (position && (!['string','number'].includes(typeof position.position_fp) ||
          String(position.position_fp).trim() === '' || !Number.isFinite(Number(position.position_fp)) ||
          Number(position.position_fp) !== 0)) {
        throw new Error('Position exists on rejected entry ticker; reconciliation required');
      }
      if (shared[p.asset].activeTrade) throw new Error('Tracked holding conflicts with rejected entry');
    }
    // Check again after account reads; a matching exchange record takes priority
    // over migration evidence. API errors leave pending intact for later reads.
    const confirmation = await api.getOrders({ ticker: p.body.ticker });
    if (confirmation.some(order => order.client_order_id === p.body.client_order_id || order.status === 'resting')) {
      throw new Error('Order state changed during rejected-order recovery');
    }
    const snapshotAfter = snapshot();
    snapshotAfter.pending = null;
    save(snapshotAfter); // Clear durably before releasing the in-memory lock.
    pending = null;
    log({ event: 'REJECTED_ORDER_RECONCILED', asset: p.asset, ticker: p.body.ticker,
      kind: p.kind, clientOrderId: p.body.client_order_id, rejection: proof, pnlChanged: false });
  }
  async function reconcile() {
    if (!pending) return;
    const p = pending;
    const proof = p.rejection ?? historicalOrderRejection(p.body.client_order_id);
    if (proof && !p.orderId && !p.response) {
      await recoverRejectedOrder(p, proof);
      return;
    }
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
      try { result = await api.placeOrder(p.body); }
      catch (error) {
        const proof = definiteOrderRejection(error);
        if (!proof) throw error;
        p.rejection = proof;
        persist();
        await recoverRejectedOrder(p, proof);
        return;
      }
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
    if (mode === 'SCALP') {
      const signal = evaluateScalpEntry({ priceHistory: s.yesPriceHistory, yesAsk: s.yesAsk, yesBid: s.yesBid });
      if (!signal.shouldEnter) return signal;
      const price = signal.direction === 'UP' ? s.yesAsk : 1 - s.yesBid;
      if (!scalpEntryPriceAllowed(price, remainingSeconds(s))) return { shouldEnter: false, reason: 'ENTRY_PRICE_BAND' };
      return signal;
    }
    if (mode !== 'LATE_SETTLEMENT' || lateEntryTickers.includes(s.ticker)) return { shouldEnter: false };
    const candidates = [{ direction: 'UP', price: s.yesAsk }, { direction: 'DOWN', price: 1 - s.yesBid }]
      .filter(c => c.price >= SCALP_CONFIG.lateEntryMinPrice - 1e-9 && c.price < 1)
      .sort((a, b) => b.price - a.price);
    return candidates.length ? { shouldEnter: true, direction: candidates[0].direction } : { shouldEnter: false };
  }
  function selectedEntryMode(s) {
    const phase = entryPhase(remainingSeconds(s));
    // Preserve settlement priority, but permit a confirmed higher-priced scalp
    // below 97 cents when no settlement entry qualifies in the last 90 seconds.
    if (phase === 'LATE_SETTLEMENT' && !entrySignal(s, phase).shouldEnter) return 'SCALP';
    return phase;
  }
  async function enter(ctx) {
    const { asset, s } = ctx;
    if (process.env.SCALP_ENABLED !== 'true' || !s.farmArmed || shared.disabledAssets.includes(asset)) return;
    if (assets().some(a => a.activeTrade) || Date.now() - lastAttempt < SCALP_CONFIG.reentryCooldownMs) return;
    if (Date.now() - Math.max(...assets().map(a => a.lastExitTime || 0)) < SCALP_CONFIG.reentryCooldownMs) return;
    const mode = selectedEntryMode(s);
    if (!['SCALP', 'LATE_SETTLEMENT'].includes(mode) || !s.ticker) return;
    const ticker = s.ticker;
    const sim = simulated();
    s._simMode = sim;
    if (checkRiskGuards(s, ctx.balance, false, { skipLossCooldown: mode === 'SCALP' }).blocked) return;
    const signal = entrySignal(s, mode);
    if (!signal.shouldEnter) return;
    lastAttempt = Date.now();
    if (!sim && !await accountFlat()) { log({ event: 'ENTRY_BLOCKED', reason: 'ACCOUNT_NOT_FLAT' }); return; }
    const balance = sim ? shared.paperBalance : (await api.getBalance()) / 100;
    // Revalidate the actual close time, ticker and quote after slow account reads.
    if (assets().some(a => a.activeTrade) || s.ticker !== ticker || selectedEntryMode(s) !== mode) return;
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
  async function reconcileExternal(ctx, suppliedPositions) {
    const { asset, s } = ctx;
    const trade = s.activeTrade;
    if (!trade || trade.sim) return false;
    const positions = suppliedPositions ?? await api.getPositions();
    const held = remainingHeldContracts(positions, trade);
    if (held === trade.count) return false;
    const fills = await api.getAllFills({ ticker: trade.ticker });
    let reduction;
    try { reduction = reconcileManualExit(trade, held, fills); }
    catch (error) {
      // Zero can mean settlement, not a manual sale. Let the settlement path
      // verify the account record; never invent closing fills to make it fit.
      if (held === 0 && error.message.startsWith('Manual fills do not match') &&
          (await api.getMarket(trade.ticker)).status === 'finalized') return false;
      throw error;
    }
    for (const item of reduction.orders) {
      const order = await api.getOrder(item.orderId);
      if (!order || order.ticker !== trade.ticker || !['executed', 'canceled'].includes(order.status) ||
          decimal(order.fill_count_fp, 'manual order fill count') !== item.count) {
        throw new Error('Manual closing order not fully reconciled');
      }
    }
    // Re-read after fill/order lookups: do not apply a stale position snapshot.
    if (remainingHeldContracts(await api.getPositions(), trade) !== held) {
      throw new Error('Position changed during manual reconciliation');
    }
    const next = { ...trade,
      count: held, amount: held * trade.entrySidePrice, maxProfit: held * (1 - trade.entrySidePrice),
      entryFees: trade.entryFees - reduction.allocatedEntryFees,
      realizedNet: (trade.realizedNet ?? 0) + reduction.net,
      manualExitFillIds: [...(trade.manualExitFillIds ?? []), ...reduction.fillIds]
    };
    // Persist the replacement before mutating live state. A disk failure leaves
    // the old state intact, so a later retry cannot count the manual sale twice.
    const saved = snapshot();
    saved.positions[asset] = held ? next : null;
    save(saved);
    s.activeTrade = held ? next : null;
    if (!held) {
      recordTradePnL(s, next.realizedNet);
      s.lastExitTime = Date.now();
    }
    log({ event: held ? 'MANUAL_PARTIAL_EXIT_RECONCILED' : 'MANUAL_CLOSE_RECONCILED',
      asset, ticker: trade.ticker, sold: reduction.sold, remaining: held,
      saleProceeds: reduction.proceeds, saleFees: reduction.fees,
      realizedNet: next.realizedNet, mode: trade.mode, sim: false });
    return true;
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
          !(trade.manualExitFillIds ?? []).includes(fill.fill_id ?? fill.trade_id) &&
          !(trade.accountedExitOrderIds ?? []).includes(fill.order_id) &&
          Date.parse(fill.created_time) >= trade.startedAt - 1000)) {
        throw new Error('Other fills affected late holding; settlement reconciliation required');
      }
    }
    // Attribute only this tracked lot. A settlement row can include earlier scalps
    // in the same ticker; its cumulative revenue/fees must not be counted again.
    const payout = result === trade.side ? trade.count : 0;
    const pnl = (trade.realizedNet ?? 0) + payout - trade.amount - trade.entryFees;
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
    const maxHoldReached = Number.isFinite(SCALP_CONFIG.maxHoldSeconds) && heldSeconds >= SCALP_CONFIG.maxHoldSeconds;
    if (!maxHoldReached && (s.ticker !== trade.ticker || !s.lastQuoteMessageTs || Date.now() - s.lastQuoteMessageTs > 2000)) {
      const market = await api.getMarket(trade.ticker);
      if (market.status === 'finalized') {
        await settle(ctx);
        return; // Wait for actual account settlement; do not sell finalized contracts.
      }
      ask = Number(market.yes_ask_dollars); bid = Number(market.yes_bid_dollars);
    }
    let decision = { shouldExit: maxHoldReached, reason: maxHoldReached ? 'MAX_HOLD_TIME' : 'HOLD' };
    if ([ask, bid].every(Number.isFinite) && bid >= 0 && ask <= 1 && ask >= bid) {
      const profit = evaluateScalpProfit({ entryPrice: trade.entrySidePrice, exitBid: trade.side === 'yes' ? bid : 1 - ask,
        contracts: trade.count, entryFees: trade.entryFees, exitFees: reserveFee(trade.count) });
      decision = evaluateScalpExit({ heldSeconds, entryPrice: trade.entrySidePrice, exitBid: trade.side === 'yes' ? bid : 1 - ask });
      // Include already-realized partial exits so repeated partial sales cannot
      // reset a configured per-trade loss budget (currently disabled).
      if (Number.isFinite(SCALP_CONFIG.maxLossUsd) && (trade.realizedNet ?? 0) + profit.netProfit <= -SCALP_CONFIG.maxLossUsd) {
        decision = { shouldExit: true, reason: 'MAX_DOLLAR_LOSS' };
      }
    }

    if (!decision.shouldExit) return;
    if (!trade.sim) {
      if (process.env.DRY_RUN === 'true') throw new Error('Live SCALP requires live exit; DRY_RUN changed');
      const positions = await api.getPositions();
      const held = remainingHeldContracts(positions, trade);
      if (held !== trade.count) {
        await reconcileExternal(ctx, positions);
        return; // Next tick uses the updated remaining count.
      }
    }
    const body = buildSellBody(trade.ticker, trade.side, trade.count);
    if (decision.reason === 'PRICE_TARGET') {
      // A profit exit must not cross all the way down the book below its target.
      body.price = (trade.side === 'yes' ? decision.targetPrice : 1 - decision.targetPrice).toFixed(4);
    }
    await submit({ kind: 'exit', asset, side: trade.side, body, sim: trade.sim,
      simYesPrice: String(trade.side === 'yes' ? bid : ask), reason: decision.reason, startedAt: Date.now() });
  }
  async function tick(ctx) {
    if (busy) return;
    busy = true;
    try {
      if (pending) { await reconcile(); return; }
      if (isManagedTrade(ctx.s.activeTrade) && !ctx.s.activeTrade.sim &&
          Date.now() - (manualPolls.get(ctx.asset) ?? 0) >= 5000) {
        manualPolls.set(ctx.asset, Date.now());
        if (await reconcileExternal(ctx)) return;
      }
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
