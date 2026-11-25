import { advanceBtcStructureScalp } from '../research/btcRangeScalp.js';
import { CRYPTO_WICK_TIERS, isCryptoWick, cryptoWickEnabled, cryptoWickTier } from './cryptoWickTiers.js';
import { contractQuantity, quantityUnits, addQuantity, subtractQuantity } from '../kalshi/quantity.js';
import crypto from 'node:crypto';
import { MANAGED_ASSETS, isPythLateMarket, fourMarketsEnabled, exchangeForAsset, LIVE_LATE_MARKETS,
  isPilotWick, pilotWickEnabled, PILOT_WICK_MARKETS, PILOT_WICK_BUDGET, PILOT_WICK_CUTOFF_SECONDS,
  FALLING_NINETY_BUDGET, fallingNinetyEnabled, PYTH_LIVE_MAX_HISTORY_GAP_MS } from './lateMarkets.js';
import { wickMetrics } from '../research/btcWickStudy.js';
import { metalBook, metalShrinkingCheck } from '../research/metalsObserver.js';
import { startSession, startDay } from './riskManager.js';
import { benchmarkFeed } from '../prices/cfBenchmarks.js';
import { evaluateShrinkingCushion } from './shrinkingCushion.js';
import { repeatedCrossingGuard } from './repeatedCrossingGuard.js';
import { entryCrossingBuffer } from './silverEntryBuffer.js';
import { evaluateLateProximity } from './lateProximity.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from './state.js';
import { definiteOrderRejection, historicalOrderRejection } from './orderRejections.js';
import { reconcileManualExit, remainingHeldContracts } from './manualExitReconciliation.js';
import { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket, getMarketOrderbook, getAllSettlements } from '../kalshi/client.js';
import { buildBuyBody, buildDirectionalLateBuyBody, buildSellBody } from '../kalshi/orders.js';
import { SCALP_CONFIG, lateStagesFor, lateBudgetFor, scalpEntryPriceAllowed, evaluateScalpEntry, evaluateScalpExit, evaluateScalpProfit, createScalpPosition } from './scalpStrategy.js';
import { checkRiskGuards, recordTradePnL } from './riskManager.js';

// Journal before sending: an ambiguous response is reconciled, never resubmitted.
const btcChartBudget = 10;
const btcSettlementRecoveryTicker = 'KXBTC15M-26NOV230045-45';
const btcChartTrade = 'btc_wick_rejection';
const btcBearishRetestTrade = 'btc_confirmed_bearish_retest';
const btcBullishPullbackTrade = 'btc_confirmed_bullish_pullback';
const btcBearishCandleTrade = 'btc_confirmed_bearish_candle_5s';
const isBtcRetestTrade = strategy =>
  strategy === btcBearishRetestTrade || strategy === btcBullishPullbackTrade ||
  strategy === btcBearishCandleTrade;
function btcRetestStrategy(signal) {
  if (signal.side === 'yes') return btcBullishPullbackTrade;
  return signal.candleConfirmed ? btcBearishCandleTrade : btcBearishRetestTrade;
}
const btcChartTargetPerContract = 0.03;
const btcChartHoldMs = 120000;
const btcChartLegacyHoldMs = 240000;
const btcChartConfirmationMs = 5000;
const btcChartSetupWindowMs = 90000;
const btcChartMaxReferenceGapMs = 1500;
const btcChartMinEntryPrice = 0.05;
const wickStage = Object.freeze({id:'wick_5s',minPrice:0.90});
const fallingNinetyStage = Object.freeze({id:'falling_90_cushion_trend',budget:FALLING_NINETY_BUDGET});
const wickAsset = asset => asset==='BTC' || isPythLateMarket(asset) || isCryptoWick(asset);
const wickBudgetFor = asset => {
  if (isPilotWick(asset)) return PILOT_WICK_BUDGET;
  if (isPythLateMarket(asset)) return 300;
  return isCryptoWick(asset) ? CRYPTO_WICK_TIERS[0].budget : 200;
};
const hasIndependentRisk = asset => isPythLateMarket(asset) || isCryptoWick(asset);
const totalBudget = asset => (isCryptoWick(asset) || isPilotWick(asset) ? 0 : lateBudgetFor(asset)) + (wickAsset(asset) ? wickBudgetFor(asset) : 0);
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
function btcChartStructure(signal, history, close, now) {
  const points = history.filter(point => Number.isSafeInteger(point.sourceTs) &&
    point.sourceTs >= signal.confirmedAt && point.sourceTs <= now &&
    Number.isFinite(point.price) && point.price > 0);
  const latest = points.at(-1);
  if (!latest || now - latest.sourceTs > btcChartMaxReferenceGapMs) return null;

  const candidates = [];
  for (const [leg, side, sign] of [['up', 'yes', 1], ['down', 'no', -1]]) {
    const study = {};
    advanceBtcStructureScalp(study, leg, points, signal.confirmedAt, close, now);
    const structure = study[leg + 'Signal'];
    if (!structure || study.invalidated || latest.sourceTs - structure.at < btcChartConfirmationMs) continue;
    if (side === signal.side && sign * (latest.price - signal.swingLevel) <= 0) continue;
    const afterBreak = points.filter(point => point.sourceTs >= structure.at);
    if (!afterBreak.every((point, index) =>
      point.sourceTs - (afterBreak[index - 1]?.sourceTs ?? structure.at) <= btcChartMaxReferenceGapMs &&
      sign * (point.price - structure.breakLevel) > 0)) continue;
    candidates.push({ ...structure, side });
  }
  return candidates.sort((a, b) => b.at - a.at)[0] ?? null;
}

function btcChartStructureStop(trade, history, now) {
  const structure = trade.chartSignal.structure;
  if (!structure) return null;
  const sign = trade.side === 'yes' ? 1 : -1;
  return history.find(point => Number.isSafeInteger(point.sourceTs) &&
    point.sourceTs >= (trade.chartSignal.entrySubmittedAt ?? structure.at) && point.sourceTs <= now &&
    Number.isFinite(point.price) && point.price > 0 &&
    sign * (point.price - structure.retestPrice) <= 0) ?? null;
}

function completedMinuteStart(now) {
  return Math.floor(now / 60000) * 60000 - 60000;
}

let btcMinuteRangeCache;
async function getBtcMinuteRange(now) {
  const start = completedMinuteStart(now);
  if (btcMinuteRangeCache?.start === start &&
      (btcMinuteRangeCache.range !== null || now < btcMinuteRangeCache.retryAt)) {
    return btcMinuteRangeCache;
  }

  let range = null;
  const query = new URLSearchParams({
    start: new Date(start).toISOString(),
    end: new Date(start + 60000).toISOString(),
    granularity: '60'
  });
  try {
    const response = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?' + query, {
      signal: AbortSignal.timeout(2000)
    });
    const candles = response.ok ? await response.json() : null;
    const candle = Array.isArray(candles) ? candles.find(row => Array.isArray(row) && row[0] === start / 1000) : null;
    if (candle && Number.isFinite(candle[1]) && Number.isFinite(candle[2]) && candle[2] > candle[1]) {
      range = candle[2] - candle[1];
    }
  } catch {
    // Retry after a short delay if the completed candle is unavailable.
  }
  btcMinuteRangeCache = { start, range, retryAt: Date.now() + 3000 };
  return btcMinuteRangeCache;
}

function btcWickVolatilityCheck(candle, distance, secondsRemaining, now) {
  const minimumRatio = 1.20;
  if (candle?.start !== completedMinuteStart(now) || !Number.isFinite(candle?.range) ||
      candle.range <= 0 || !Number.isFinite(distance) || !Number.isFinite(secondsRemaining) || secondsRemaining <= 0) {
    return { allowed: false, reason: 'BTC_WICK_VOLATILITY_UNAVAILABLE' };
  }
  const scaledRange = candle.range * Math.sqrt(secondsRemaining / 60);
  const ratio = distance / scaledRange;
  return {
    allowed: ratio >= minimumRatio,
    reason: ratio >= minimumRatio ? 'BTC_WICK_VOLATILITY_OK' : 'BTC_WICK_VOLATILITY_CUSHION',
    range: candle.range, scaledRange, ratio, minimumRatio, distance, secondsRemaining,
    candleStart: candle.start
  };
}

export function entryPhase(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'CLOSED';
  if (seconds > SCALP_CONFIG.entryMinSecondsRemaining) return 'SCALP';
  if (seconds < SCALP_CONFIG.lateEntryMaxSecondsRemaining) return 'LATE_SETTLEMENT';
  return 'BUFFER';
}
// Only the current time tier is eligible; missed earlier tiers are not backfilled.
export function lateStage(seconds, asset = 'BTC', ledger = null) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const fifthStage = ledger?.records?.under_45;
  const fifthSpent = fifthStage?.spent;
  const extraReady = asset !== 'ETH' && Number.isFinite(fifthSpent) && fifthSpent >= 50 &&
    fifthStage.ladderCap === undefined;
  return lateStagesFor(asset).filter(stage=>stage.id!=='under_45_extra'||extraReady)
    .findLast(stage => seconds < stage.maxSeconds) ?? null;
}
export function productionLateStage(seconds, asset, ledger) {
  if (isPilotWick(asset)) return null;
  if ((asset === 'BTC' || isPythLateMarket(asset)) && seconds >= 60) return null;
  return lateStage(seconds, asset, ledger);
}

const usesLadderCushionCap = asset => asset === 'GOLD' || asset === 'EURUSD';

function reducedLadderCap(asset, stageId, ledger, cushion) {
  if (!usesLadderCushionCap(asset) || stageId !== 'under_45') return undefined;
  const existingCap = ledger?.records?.[stageId]?.ladderCap;
  if (existingCap !== undefined) return existingCap;

  const previousStageId = ledger?.attempted?.findLast(id =>
    id !== wickStage.id && id !== stageId && ledger.records?.[id]?.spent > 0);
  const previousCushion = ledger?.records?.[previousStageId]?.fillCushion;
  if (Number.isFinite(previousCushion) && Number.isFinite(cushion) &&
      previousCushion - cushion > 1e-9) return 50;
  return undefined;
}

export function lateStageSize(price, balance, budget, feeMultiplier = 1) {
  if (![price,balance,budget].every(Number.isFinite) || price <= 0 || price >= 1) return 0;
  const available = Math.max(0, Math.min(balance, budget));
  let count = Math.floor(available / price);
  while (count && count * price + lateFee(count, price, feeMultiplier) > available + 1e-9) count--;
  return count;
}
export function lateFee(count, price, feeMultiplier = 1) {
  return Math.ceil((0.07 * feeMultiplier * count * price * (1 - price) + 1e-9) * 100) / 100;
}
export function scalpEntryBudget(price) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  return SCALP_CONFIG.maxEntryCostUsd;
}
export function scalpSize(price, balance, mode = 'SCALP') {
  if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(balance)) return 0;
  const budget = Math.min(mode === 'SCALP' ? scalpEntryBudget(price) : SCALP_CONFIG.maxEntryCostUsd, balance);
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
function counted(raw, field) {
  try { return contractQuantity(raw); }
  catch { throw new Error(`Invalid ${field}: ${String(raw)}`); }
}
// V2 prices refer to the YES book for both bid and ask orders.
export function scalpAck(result, pending) {
  const count = counted(result?.fill_count, 'fill_count');
  const remaining = counted(result?.remaining_count, 'remaining_count');
  if (quantityUnits(count) > quantityUnits(pending.body.count) || remaining !== 0) {
    throw new Error('Nonterminal or invalid SCALP response');
  }
  if (!count) return { count: 0, price: 0, fees: 0 };
  const yesPrice = decimal(result.average_fill_price, 'average_fill_price');
  if (yesPrice <= 0 || yesPrice >= 1) throw new Error('Invalid fill price');
  return { count, price: pending.side === 'yes' ? yesPrice : 1 - yesPrice,
    fees: count * decimal(result.average_fee_paid, 'average_fee_paid') };
}

export function createScalpExecutor(deps = {}) {
  const selectLateStage = deps.selectLateStage ?? lateStage;
  const api = { getBalance, getPositions, getOrders, getOrder, getAllFills, placeOrder, getMarket, getMarketOrderbook, getAllSettlements, ...deps.api };
  const shared = deps.state ?? state;
  const save = deps.save ?? saveJournal;
  const log = deps.log ?? (message => console.log('[SCALP] ' + JSON.stringify(message)));
  const retryNow = deps.now ?? Date.now;
  const getReferenceQuote = deps.getReferenceQuote ?? (asset => benchmarkFeed.getQuote(asset));
  const getReferenceHistory = deps.getReferenceHistory ?? (asset => benchmarkFeed.getHistory(asset));
  const getBtcReferenceDiagnostics = deps.getBtcReferenceDiagnostics ?? (() => benchmarkFeed.getBtcDiagnostics?.() ?? null);
  let shrinkingGuards = {};
  function shrinkingCheck(ctx, distance, stageBudget, wick = false) {
    const key = wick ? 'wick:'+ctx.asset+':'+distance.side : ctx.asset;
    const requireLongRecovery=wick || stageBudget>=25;
    const extraOptions=wick ? {stabilizationSeconds:5,requireLongAlways:isPythLateMarket(ctx.asset)} : stageBudget===900?{stabilizationSeconds:5,requireLongAlways:true}:{};
    const pilot = PILOT_WICK_MARKETS[ctx.asset];
    const pythLate = isPythLateMarket(ctx.asset);
    const maxHistoryGapMs = pythLate ? PYTH_LIVE_MAX_HISTORY_GAP_MS : undefined;
    let referenceHistory;
    const onHistoryFailure = ctx.asset === 'BTC' || pythLate ? detail => { referenceHistory = detail; } : null;
    const referenceFailure = guard => ({...guard,referenceHistory,
      ...(pilot?{referenceFeed:ctx.proxy?.getDiagnostics?.(ctx.asset)??null}:{})});
    // Every late purchase must pass, including the first purchase.
    const check = isPythLateMarket(ctx.asset) ? metalShrinkingCheck({
      asset:ctx.asset,ticker:ctx.s.ticker,side:distance.side,target:distance.target,
      proxy:ctx.proxy?.snapshot(ctx.asset,distance.target,distance.side),
      history:ctx.proxy?.history?.[ctx.asset],previous:shrinkingGuards[key],
      secondsRemaining:remainingSeconds(ctx.s),requireLongRecovery,...extraOptions,
      projectedLookbackSeconds:wick && ctx.asset==='WTI' ? 20 : undefined,maxHistoryGapMs,onHistoryFailure,at:Date.now()
    }) : evaluateShrinkingCushion({ history:getReferenceHistory(ctx.asset),
      asset:ctx.asset,ticker:ctx.s.ticker,side:distance.side,target:distance.target,
      minimumDistance:distance.minimumDistance, rapidDropMinimum:ctx.asset === 'BTC' && !wick ? 50 : distance.minimumDistance,
      secondsRemaining:remainingSeconds(ctx.s),
      previous:shrinkingGuards[key],requireLongRecovery,...extraOptions,onHistoryFailure,now:Date.now() });
    if (check.guardState && JSON.stringify(check.guardState)!==JSON.stringify(shrinkingGuards[key])) {
      const next={...shrinkingGuards,[key]:check.guardState};
      save({...snapshot(),shrinkingGuards:next}); // Persist a latch before any late purchase can proceed.
      shrinkingGuards=next;
    }
    const now = Date.now();
    const projected = entryCrossingBuffer(check, ctx.asset, remainingSeconds(ctx.s, now), now);
    const checked = projected?.allowed && isPythLateMarket(ctx.asset)
      ? repeatedCrossingGuard(projected, ctx.asset, distance.side, distance.target,
          ctx.s.marketCloseTs, now, ctx.proxy?.history?.[ctx.asset], pilot?.repeatedCrossingCushion)
      : projected;
    if (!wick && checked?.allowed && ctx.asset === 'USDJPY') {
      const records = lateStages[ctx.s.ticker]?.records ?? {};
      const hasLadderFill = Object.entries(records).some(
        ([stageId, record]) => stageId !== wickStage.id && record.spent > 0
      );
      if (hasLadderFill && (!Number.isFinite(checked.dropUsd) || checked.dropUsd >= -1e-9)) {
        return {...checked, allowed: false, reason: 'USDJPY_LADDER_ADD_CUSHION_NOT_WIDENING'};
      }
    }
    if (!wick || !checked?.allowed) return referenceHistory ? referenceFailure(checked) : checked;
    if (pilot && !checked.crossingHistoryComplete) {
      return {...checked, allowed: false, reason: 'PILOT_WICK_CROSSING_HISTORY_INCOMPLETE'};
    }
    if (pilot && !(checked.currentCushion + 1e-9 >= pilot.minimumCushion)) {
      return {...checked, allowed: false, reason: 'PILOT_WICK_CUSHION_TOO_SMALL',
        minimumCushion: pilot.minimumCushion};
    }
    if (ctx.asset === 'EURUSD' && checked.guardState?.triggeredAt != null) {
      const change15 = checked.longRecovery?.cushionChange15;
      if (!Number.isFinite(change15) || change15 <= 1e-9) {
        return {...checked, allowed: false, reason: 'EURUSD_WICK_CUSHION_NOT_WIDENING'};
      }
    }
    if (ctx.asset === 'USDJPY') {
      const change60 = checked.longRecovery?.cushionChange60;
      if (!Number.isFinite(change60) || change60 <= 1e-9) {
        return {...checked, allowed: false, reason: 'USDJPY_WICK_CUSHION_NOT_WIDENING'};
      }
    }
    if (ctx.asset === 'SILVER') {
      const silverWickMinimum = 0.05;
      if (!Number.isFinite(checked.currentCushion) || checked.currentCushion + 1e-9 < silverWickMinimum) {
        return {...checked, allowed: false, reason: 'SILVER_WICK_CUSHION_TOO_SMALL',
          silverWickMinimum};
      }
      const minimumCushionChange60 = 0.003; // 0.30 cents per ounce.
      const change60 = checked.longRecovery?.cushionChange60;
      if (remainingSeconds(ctx.s, now)>120 &&
          (!Number.isFinite(change60) || change60+1e-9<minimumCushionChange60)) {
        return {...checked, allowed: false, reason: 'SILVER_EARLY_WICK_CUSHION_NOT_WIDENING',
          minimumCushionChange60};
      }
    }
    const rows = isPythLateMarket(ctx.asset)
      ? ctx.proxy.history[ctx.asset].map(p=>({sourceTs:Math.trunc(p.sourceAt),price:p.price}))
      : getReferenceHistory(ctx.asset);
    const floor = checked.crossingWickMinimum ?? distance.minimumDistance;
    const metrics = wickMetrics(rows, now, distance.target, distance.side==='yes'?1:-1, ctx.s.marketCloseTs, floor, onHistoryFailure, maxHistoryGapMs);
    if (!(metrics?.heldMs >= 5000)) {
      const blocked={...checked,allowed:false,reason:'WICK_HOLD_UNCONFIRMED'};
      if(referenceHistory) return referenceFailure(blocked);
      return ctx.asset==='BTC'?{...blocked,referenceHistory:
        {issue:'HOLD_BELOW_REQUIRED',heldMs:metrics?.heldMs ?? null,requiredHoldMs:5000,floor}}:blocked;
    }
    const result = {...checked, wickHeldMs:metrics.heldMs};
    if (pilot && checked.targetCrossings > 0 && metrics.heldMs < 15000) {
      return {...result, allowed: false, reason: 'PILOT_WICK_CROSSING_HOLD'};
    }
    if (ctx.asset === 'EURUSD' && checked.targetCrossings === 1 &&
        checked.crossingHistoryComplete && metrics.heldMs < 15000) {
      return {...result, allowed: false, reason: 'EURUSD_WICK_FIRST_CROSSING_HOLD'};
    }
    if (ctx.asset === 'USDJPY' && distance.side === 'no') {
      const strikeHeldMs = (floor === 0 ? metrics :
        wickMetrics(rows, now, distance.target, -1, ctx.s.marketCloseTs, 0, null, maxHistoryGapMs))?.heldMs ?? null;
      result.strikeHeldMs = strikeHeldMs;
      result.usdJpyDownWickBudget = strikeHeldMs >= 60000 ? wickBudgetFor(ctx.asset) : 50;
    }
    return result;
  }
  const targetCache = new Map();
  async function proximity(ctx, signal) {
    const ticker = ctx.s.ticker, cached = targetCache.get(ctx.asset);
    let target = cached?.ticker === ticker ? cached.target : null;
    if (!Number.isFinite(target)) {
      if (cached?.ticker === ticker && Date.now() - cached.checkedAt < 5000) {
        return evaluateLateProximity({ asset: ctx.asset, ticker, stageId: signal.stage.id,
          side: signal.direction === 'UP' ? 'yes' : 'no', target: null });
      }
      targetCache.set(ctx.asset, { ticker, target: null, checkedAt: Date.now() });
      const market = await api.getMarket(ticker);
      const raw = market.floor_strike;
      if (market.ticker === ticker && market.strike_type === 'greater_or_equal' &&
          ['string', 'number'].includes(typeof raw) && String(raw).trim() !== '' &&
          Number.isFinite(Number(raw)) && Number(raw) > 0) {
        target = Number(raw);
        targetCache.set(ctx.asset, { ticker, target, market, checkedAt: Date.now() });
      }
    }
    if (isCryptoWick(ctx.asset)) {
      const metadata = targetCache.get(ctx.asset)?.market;
      const valid = metadata?.exchange_index === exchangeForAsset(ctx.asset) &&
        ticker.startsWith('KX' + ctx.asset + '15M-') && ['open', 'active'].includes(metadata.status) &&
        Date.parse(metadata.close_time) === ctx.s.marketCloseTs &&
        Date.parse(metadata.close_time) - Date.parse(metadata.open_time) === 900000 &&
        ctx.s.lateFeeType === 'quadratic' && Number.isFinite(ctx.s.lateFeeMultiplier) &&
        ctx.s.lateFeeMultiplier >= 0 && Number.isFinite(target);
      return { allowed: valid, reason: valid ? 'CRYPTO_WICK_TARGET_OK' : 'INVALID_CRYPTO_WICK_MARKET',
        side: signal.direction === 'UP' ? 'yes' : 'no', target };
    }
    if (isPythLateMarket(ctx.asset)) {
      const metadata=targetCache.get(ctx.asset)?.market;
      const expected=LIVE_LATE_MARKETS[ctx.asset];
      if (!metadata || metadata.exchange_index!==expected.exchangeIndex ||
          !ticker.startsWith(expected.series+'-') || !['open','active'].includes(metadata.status) ||
          Date.parse(metadata.close_time)!==ctx.s.marketCloseTs ||
          Date.parse(metadata.close_time)-Date.parse(metadata.open_time)!==900000 ||
          ctx.s.lateFeeType!=='quadratic' || !Number.isFinite(ctx.s.lateFeeMultiplier) || ctx.s.lateFeeMultiplier<0)
        return {allowed:false,reason:'INVALID_LIVE_MARKET_METADATA'};
      return {allowed:Number.isFinite(target),reason:Number.isFinite(target)?'PROXY_GUARD_REQUIRED':'MISSING_TARGET',
        side:signal.direction==='UP'?'yes':'no',target,minimumDistance:0,exchangeIndex:expected.exchangeIndex};
    }
    return evaluateLateProximity({ asset: ctx.asset, ticker, stageId: signal.stage.id,
      side: signal.direction === 'UP' ? 'yes' : 'no', target,
      quote: getReferenceQuote(ctx.asset), now: Date.now() });
  }
  // New early/low-price entries are disabled; existing holdings still receive exits.
  const earlyScalpsEnabled = deps.earlyScalpsEnabled ?? false;
  const entryBlockLogs = new Map();
  function entryBlocked(asset, reason, details = {}) {
    const key = `${asset}:${reason}`;
    if (retryNow() - (entryBlockLogs.get(key) ?? -Infinity) < 60000) return;
    entryBlockLogs.set(key, retryNow());
    const referenceDiagnostic = asset === 'BTC' && (details.shrinkingGuard?.referenceHistory ||
      reason === 'PROXIMITY_REFERENCE_STALE' || reason === 'SHRINK_HISTORY_UNAVAILABLE' ||
      reason === 'SHRINK_LONG_HISTORY_UNAVAILABLE');
    log({ event: 'ENTRY_BLOCKED', asset, reason, ...details, ...(referenceDiagnostic?{
      ticker: shared[asset]?.ticker, referenceFeed: getBtcReferenceDiagnostics()
    }:{}) });
  }
  const lateChecks = new Map();
  let tickQueue = Promise.resolve();
  let pending = null;
  let lastAttempt = 0;
  let nextReconcileAt = 0;
  let lateEntryTickers = [];
  let btcChartAttemptedTickers = [];
  let btcChartSignal = null;
  let btcRetestSignal = null;
  let btcBearishRetestAttempted = [];

  function queueBtcBearishRetest(signal) {
    queueBtcRetest(signal, 'no');
  }

  function queueBtcBullishPullback(signal) {
    queueBtcRetest(signal, 'yes');
  }

  function btcRetestEntryEnabled(side, signal) {
    if (side === 'yes') return process.env.BTC_BULLISH_PULLBACK_LIVE_ENABLED === 'true';
    if (signal.candleConfirmed) return process.env.BTC_BEARISH_CANDLE_LIVE_ENABLED === 'true';
    return process.env.BTC_BEARISH_RETEST_LIVE_ENABLED === 'true';
  }

  function queueBtcRetest(signal, side) {
    if (!btcRetestEntryEnabled(side, signal)) return;
    if (!btcRetestSignal || signal.signalAt > btcRetestSignal.signalAt) {
      btcRetestSignal = { ...signal, side };
    }
  }

  function queueBtcWickSignal(signal) {
    if (!btcChartSignal || signal.confirmedAt > btcChartSignal.confirmedAt) {
      btcChartSignal = signal;
    }
  }
  let lateStages = {};
  let btcSettlementRecovery = null;
  const settlementPolls = new Map();
  const manualPolls = new Map();
  const assetNames = () => MANAGED_ASSETS.filter(asset=>shared[asset]);
  const assets = () => assetNames().map(asset => shared[asset]);
  const riskFields=['riskDay','sessionStartBalance','sessionPnL','dailyStartBalance','dailyPnL',
    'usdJpyDailyReset','eurUsdDailyReset','totalPnL','tradeCount','consecutiveLosses','lastLossTime','sessionKillAt','lastExitTime'];
  const snapshot = () => ({ pending, lateEntryTickers, lateStages, shrinkingGuards, btcChartAttemptedTickers, btcBearishRetestAttempted,
    btcSettlementRecovery,
    // Retain new markets' risk counters across deployments as well as holdings.
    marketRisk:Object.fromEntries(assetNames().filter(hasIndependentRisk).map(asset=>[asset,
      Object.fromEntries(riskFields.map(k=>[k,shared[asset][k]]))])),
    positions: Object.fromEntries(assetNames().map(asset =>
    [asset, isManagedTrade(shared[asset].activeTrade) ? shared[asset].activeTrade : null])) });
  const persist = () => save(snapshot());
  const simulated = () => shared.simMode || process.env.DRY_RUN === 'true';
  function restore(saved) {
    if (!saved) return;
    pending = saved.pending ?? null;
    btcSettlementRecovery = saved.btcSettlementRecovery ?? null;
    shrinkingGuards = structuredClone(saved.shrinkingGuards ?? {});
    lateEntryTickers = saved.lateEntryTickers ?? [];
    btcChartAttemptedTickers = saved.btcChartAttemptedTickers ?? [];
    btcBearishRetestAttempted = saved.btcBearishRetestAttempted ?? [];
    lateStages = structuredClone(saved.lateStages ?? {});
    for (const asset of assetNames()) {
      if (hasIndependentRisk(asset) && saved.marketRisk?.[asset]) Object.assign(shared[asset],saved.marketRisk[asset]);
      if (saved.positions?.[asset]) shared[asset].activeTrade = saved.positions[asset];
    }
  }
  function applyFill(p, fill) {
    const s = shared[p.asset];
    if (p.kind === 'entry' && fill.count) {
      const old = s.activeTrade;
      if (old && (p.mode !== 'LATE_SETTLEMENT' || old.mode !== p.mode ||
          old.ticker !== p.body.ticker || old.side !== p.side || old.sim !== p.sim)) {
        throw new Error('Entry conflicts with tracked holding');
      }
      const cost = fill.count * fill.price + fill.fees;
      const ledger = lateStages[p.body.ticker];
      const maximumCost=p.stageId===fallingNinetyStage.id?fallingNinetyStage.budget:totalBudget(p.asset);
      if (p.stageId && (!ledger || cost > p.stageBudget + 1e-9 ||
          ledger.spent + cost > maximumCost + 1e-9)) {
        throw new Error('Late fill exceeds reserved budget; reconciliation required');
      }
      let next;
      if (old) {
        const count = addQuantity(old.count, fill.count);
        const amount = old.amount + fill.count * fill.price;
        next = { ...old, count, amount, entrySidePrice: amount / count,
          entryFees: old.entryFees + fill.fees, maxProfit: count - amount,
          estimatedExitFees: reserveFee(count), originalCost: old.originalCost + cost,
          entryOrderIds: [...new Set([...(old.entryOrderIds ?? [old.entryOrderId]), p.orderId].filter(Boolean))] };
      } else {
        next = { ...createScalpPosition({ ticker: p.body.ticker, direction: p.direction,
          confirmedContracts: fill.count, averageFillPrice: fill.price, entryFees: fill.fees,
          estimatedExitFees: reserveFee(fill.count), startedAt: p.startedAt }),
          mode: p.mode ?? 'SCALP', entryOrderId: p.orderId, entryOrderIds: p.orderId ? [p.orderId] : [],
          ...(p.chartSignal ? { chartSignal: p.chartSignal, strategy: btcChartTrade } : {}),
          ...(p.retestSignal ? { strategy: btcRetestStrategy(p.retestSignal) } : {}),
          ...(p.stageId===fallingNinetyStage.id ? { strategy:fallingNinetyStage.id } : {}),
          sim: p.sim, entrySecondsRemaining: p.entrySecondsRemaining, realizedNet: 0, originalCost: cost };
      }
      const stageRecord = ledger?.records?.[p.stageId];
      const stageLimit = p.ladderCap ?? stageRecord?.ladderCap ?? (p.stageId === wickStage.id
        ? wickBudgetFor(p.asset) : p.stageId===fallingNinetyStage.id ? fallingNinetyStage.budget
          : lateStagesFor(p.asset).find(stage => stage.id === p.stageId)?.budget);
      const fillCushion = p.shrinkingGuard?.currentCushion;
      const recordCushion = usesLadderCushionCap(p.asset) && p.stageId !== wickStage.id &&
        Number.isFinite(fillCushion);
      if (p.stageId && stageRecord && stageRecord.spent + cost > stageLimit + 1e-9) {
        throw new Error('Late fill exceeds remaining stage budget');
      }
      const nextStages = p.stageId ? { ...lateStages, [p.body.ticker]: { ...ledger,
        spent: ledger.spent + cost,
        ...(stageRecord ? { records: { ...ledger.records, [p.stageId]: {
          ...stageRecord, spent: stageRecord.spent + cost,
          ...(recordCushion ? { fillCushion } : {}),
          ...(p.ladderCap !== undefined ? { ladderCap: p.ladderCap } : {})
        } } } : {})
      } } : lateStages;
      // Save aggregate and clear pending together, before changing memory. A failed
      // write can then reconcile this order again without adding its fills twice.
      const saved = snapshot();
      saved.positions[p.asset] = next; saved.pending = null; saved.lateStages = nextStages;
      save(saved);
      s.activeTrade = next; lateStages = nextStages; pending = null;
      log({ event: 'ENTRY_CONFIRMED', asset: p.asset, ...fill, sim: p.sim, mode: p.mode,
        side: p.side, stage: p.stageId, strategy: next.strategy, chartConfirmation: p.chartConfirmation,
        retestSignal: p.retestSignal,
        ticker: p.body.ticker, proximity: p.proximity, shrinkingGuard: p.shrinkingGuard,
        fallingNinety: p.fallingNinety, ladderCap: p.ladderCap, totalContracts: next.count, totalCost: next.originalCost });
      return;
    } else if (p.kind === 'entry' && p.stageId && !fill.count) {
      const saved = snapshot(); saved.pending = null;
      save(saved); pending = null;
      log({ event: 'LATE_ZERO_FILL', asset: p.asset, stage: p.stageId,
        ticker: p.body.ticker, retryAfterMs: p.stageId===fallingNinetyStage.id?null:SCALP_CONFIG.lateRetryMs });
      return;
    } else if (p.kind === 'exit' && fill.count) {
      const trade = s.activeTrade;
      if (!trade || fill.count > trade.count) throw new Error('Exit exceeds tracked position');
      const allocatedFees = trade.entryFees * fill.count / trade.count;
      const net = fill.count * (fill.price - trade.entrySidePrice) - allocatedFees - fill.fees;
      const count = subtractQuantity(trade.count, fill.count);
      const next = { ...trade, count, amount: count * trade.entrySidePrice,
        entryFees: trade.entryFees - allocatedFees, maxProfit: count * (1 - trade.entrySidePrice),
        realizedNet: trade.realizedNet + net,
        accountedExitOrderIds: [...new Set([...(trade.accountedExitOrderIds ?? []), p.orderId].filter(Boolean))] };
      const saved = snapshot();
      saved.positions[p.asset] = count ? next : null;
      saved.pending = null;
      save(saved);
      s.activeTrade = saved.positions[p.asset];
      pending = null;
      if (trade.sim) shared.paperBalance += net;
      if (!count) {
        recordTradePnL(s, next.realizedNet);
        s.lastExitTime = Date.now();
        log({ event: 'CLOSED', asset: p.asset, pnl: next.realizedNet, reason: p.reason,
          strategy: trade.strategy, sim: trade.sim });
      }
      log({ event: 'EXIT_CONFIRMED', asset: p.asset, ...fill, strategy: trade.strategy, sim: p.sim });
      return;
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
    if (p.kind === 'entry' && !p.stageId) {
      const position = (await api.getPositions()).find(row => row.ticker === p.body.ticker);
      if (position && (!['string','number'].includes(typeof position.position_fp) ||
          String(position.position_fp).trim() === '' || !Number.isFinite(Number(position.position_fp)) ||
          Number(position.position_fp) !== 0)) {
        throw new Error('Position exists on rejected entry ticker; reconciliation required');
      }
      if (shared[p.asset].activeTrade) throw new Error('Tracked holding conflicts with rejected entry');
    }
    if (p.kind === 'entry' && p.stageId && !await accountMatches(p.asset, shared[p.asset].activeTrade, p.sim)) {
      throw new Error('Rejected late entry conflicts with account holdings');
    }
    // Check again after account reads; a matching exchange record takes priority
    // over migration evidence. API errors leave pending intact for later reads.
    const confirmation = await api.getOrders({ ticker: p.body.ticker });
    if (confirmation.some(order => order.client_order_id === p.body.client_order_id || order.status === 'resting')) {
      throw new Error('Order state changed during rejected-order recovery');
    }
    const snapshotAfter = snapshot();
    snapshotAfter.pending = null;
    if (p.stageId && lateStages[p.body.ticker]?.records?.[p.stageId]) {
      const ledger = lateStages[p.body.ticker];
      snapshotAfter.lateStages = { ...lateStages, [p.body.ticker]: { ...ledger,
        records: { ...ledger.records, [p.stageId]: { ...ledger.records[p.stageId], blocked: true } }
      } };
    }
    save(snapshotAfter); // Clear durably before releasing the in-memory lock.
    lateStages = snapshotAfter.lateStages;
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
    if (p.orderId) order = await api.getOrder(p.orderId, exchangeForAsset(p.asset));
    else order = (await api.getOrders({ ticker: p.body.ticker })).find(o => o.client_order_id === p.body.client_order_id);
    if (!order || !['executed', 'canceled'].includes(order.status)) throw new Error('Order remains unverified; no retry');
    if (!order.order_id || (p.orderId && order.order_id !== p.orderId) ||
        (order.client_order_id && order.client_order_id !== p.body.client_order_id) ||
        (order.ticker && order.ticker !== p.body.ticker) ||
        (order.book_side && order.book_side !== p.body.side)) {
      throw new Error('Reconciled order identity mismatch');
    }
    p.orderId = order.order_id;
    const count = counted(order.fill_count_fp, 'fill_count_fp');
    if (quantityUnits(count) > quantityUnits(p.body.count)) {
      throw new Error(`Invalid reconciled count: filled=${order.fill_count_fp}, requested=${p.body.count}, order=${order.order_id}`);
    }
    if (!count) { applyFill(p, { count: 0, price: 0, fees: 0 }); return; }
    const fills = (await api.getAllFills({ ticker: p.body.ticker })).filter(f => f.order_id === order.order_id);
    const seen = new Set();
    let quantity = 0, gross = 0, fees = 0;
    for (const f of fills) {
      const id = f.fill_id ?? f.trade_id;
      if (!id || seen.has(id)) throw new Error('Missing or duplicate fill identifier');
      seen.add(id);
      if (f.book_side !== p.body.side) throw new Error('Fill book side mismatch');
      const qty = counted(f.count_fp, 'count_fp');
      const price = decimal(p.side === 'yes' ? f.yes_price_dollars : f.no_price_dollars, 'fill price');
      if (qty <= 0 || price <= 0 || price >= 1) throw new Error('Invalid fill');
      quantity = addQuantity(quantity, qty); gross += qty * price; fees += decimal(f.fee_cost, 'fee_cost');
    }
    if (quantity !== count) throw new Error('Fills not fully available; no retry');
    applyFill(p, { count, price: gross / quantity, fees });
  }
  async function submit(p) {
    pending = p;
    if (p.kind === 'entry' && p.chartSignal) {
      btcChartAttemptedTickers = [...btcChartAttemptedTickers, p.body.ticker].slice(-500);
    }
    if (p.kind === 'entry' && p.retestSignal) {
      btcBearishRetestAttempted = [...btcBearishRetestAttempted, p.body.ticker].slice(-500);
    }
    if (p.kind === 'entry' && p.mode === 'LATE_SETTLEMENT' && !p.retestSignal) {
      lateEntryTickers = [...new Set([...lateEntryTickers, p.body.ticker])].slice(-500);
      if (p.stageId) {
        const ledger = lateStages[p.body.ticker] ?? { attempted: [], side: p.side, spent: 0 };
        const previous = ledger.records?.[p.stageId];
        if (ledger.closed || ledger.side !== p.side || previous?.blocked ||
            (ledger.attempted.includes(p.stageId) && !previous)) {
          pending = null;
          throw new Error('Late stage is closed or side changed');
        }
        lateStages = { ...lateStages, [p.body.ticker]: {
          ...ledger, attempted: [...new Set([...ledger.attempted, p.stageId])],
          records: { ...ledger.records, [p.stageId]: {
            ...previous, spent: previous?.spent ?? 0, attempts: (previous?.attempts ?? 0) + 1,
            lastAttemptAt: retryNow(),
            ...(p.shrinkingGuard?.usdJpyDownWickBudget === 50 ? { freshUsdJpyDownWick: true } : {})
          } }
        } };
      }
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
    if (p.mode === 'LATE_SETTLEMENT' && !p.sim && !pending.orderId) throw new Error('Missing late-entry order id');
    pending.response = result;
    persist();
    applyFill(p, scalpAck(result, p));
  }
  // Late entries reconcile their own asset. Exclusive scalp entries still
  // check all managed markets, and pending bot orders still serialize execution.
  function scopedAccountRows(rows, asset) {
    if (!Array.isArray(rows)) throw new Error('Invalid account response');
    const scopedAssets = asset ? [asset] : assetNames();
    const prefixes = (asset ? [asset] : MANAGED_ASSETS).map(name => (LIVE_LATE_MARKETS[name]?.series ?? 'KX' + name + '15M') + '-');
    const known = new Set(scopedAssets.flatMap(name => {
      const entry = shared[name];
      return [entry?.ticker, entry?.activeTrade?.ticker];
    }).filter(Boolean));
    if (pending?.body?.ticker && (!asset || pending.asset === asset)) known.add(pending.body.ticker);
    return rows.flatMap(row => {
      const ticker = row?.ticker ?? row?.market_ticker;
      if (typeof ticker !== 'string' || !ticker.trim() || ticker !== ticker.trim() ||
          (row.ticker != null && row.market_ticker != null && row.ticker !== row.market_ticker)) {
        throw new Error('Account row has missing or conflicting market identity');
      }
      if (!known.has(ticker) && !prefixes.some(prefix => ticker.startsWith(prefix))) return [];
      return [{ ...row, ticker }];
    });
  }
  async function accountFlat() {
    const positions = scopedAccountRows(await api.getPositions());
    if (positions.some(p => !['string', 'number'].includes(typeof p.position_fp) ||
        String(p.position_fp).trim() === '' || !Number.isFinite(Number(p.position_fp)) || Number(p.position_fp) !== 0)) return false;
    return scopedAccountRows(await api.getOrders({ status: 'resting' })).length === 0;
  }
  // Late settlement positions may coexist across coins; scalps remain exclusive.
  function compatibleHoldings(s, mode, sim) {
    const held = s.activeTrade;
    if (held && (mode !== 'LATE_SETTLEMENT' || held.mode !== mode ||
        held.ticker !== s.ticker || held.sim !== sim)) return false;
    return assets().every(a => {
      const other = a.activeTrade;
      if (!other || a === s) return true;
      if (mode !== 'LATE_SETTLEMENT' || other.sim !== sim) return false;
      if (other.mode === 'LATE_SETTLEMENT') return true;
      // Legacy early holdings lack the timestamp field. Their price band
      // distinguishes them from final-minute scalps, which enter above 70c.
      return other.mode === 'SCALP' && (other.entrySecondsRemaining > 480 ||
        (other.entrySecondsRemaining == null && other.entrySidePrice <= .70));
    });
  }
  async function accountMatches(asset, trade, sim) {
    if (sim) return true;
    const assetState = shared[asset];
    if (!assetState || (assetState.activeTrade ?? null) !== (trade ?? null)) return false;
    const positions = scopedAccountRows(await api.getPositions(), asset);
    if (trade && (!isManagedTrade(trade) || trade.sim !== sim ||
        remainingHeldContracts(positions, trade) !== trade.count)) return false;
    if (positions.some(p => !['string','number'].includes(typeof p.position_fp) ||
        String(p.position_fp).trim() === '' || !Number.isFinite(Number(p.position_fp)) ||
        (Number(p.position_fp) !== 0 && trade?.ticker !== p.ticker))) return false;
    return scopedAccountRows(await api.getOrders({ status: 'resting' }), asset).length === 0;
  }
  const executablePrice=(s,direction,asset)=>isPythLateMarket(asset)
    ? s.lateBook?.[direction==='UP'?'yes':'no']?.price
    : direction==='UP'?s.yesAsk:1-s.yesBid;
  function entrySignal(s, mode) {
    const now = Date.now(), asset=assetNames().find(asset=>shared[asset]===s);
    if (!Number.isFinite(s.lastQuoteMessageTs) || now - s.lastQuoteMessageTs > 2000 ||
        s.lastQuoteMessageTs > now) return { shouldEnter: false };
    if (!isPythLateMarket(asset) && (![s.yesAsk, s.yesBid].every(Number.isFinite) ||
        s.yesBid <= 0 || s.yesAsk >= 1 || s.yesAsk < s.yesBid)) return { shouldEnter: false };
    if (mode === 'SCALP') {
      return { shouldEnter: false, reason: 'ALL_SCALP_ENTRIES_DISABLED' };
    }
    if (mode !== 'LATE_SETTLEMENT') return { shouldEnter: false };
    const ledger = lateStages[s.ticker];
    // A confirmed $50 fee-inclusive fifth-stage fill unlocks the separate $900
    // budget. Unfilled fifth-stage spending is not added to that budget.
    const stage = selectLateStage(remainingSeconds(s), asset, ledger);
    // Old journals reserved the entire ticker. Never infer missing stage history.
    const record = ledger?.records?.[stage?.id];
    if (!stage || ledger?.closed || (lateEntryTickers.includes(s.ticker) && !ledger) ||
        record?.blocked || (ledger?.attempted.includes(stage.id) && !record)) return { shouldEnter: false };
    if (record && retryNow() - record.lastAttemptAt < SCALP_CONFIG.lateRetryMs) {
      return { shouldEnter: false, reason: 'LATE_RETRY_WAIT' };
    }
    const trade = s.activeTrade;
    const side = trade?.side ?? ledger?.side;
    const candidates = [{ direction: 'UP', side: 'yes', price: executablePrice(s,'UP',asset) },
      { direction: 'DOWN', side: 'no', price: executablePrice(s,'DOWN',asset) }]
      .filter(c => (!side || c.side === side) && Number.isFinite(c.price) && c.price >= stage.minPrice - 1e-9 && c.price < 1 &&
        (!isPythLateMarket(asset) || (Number.isFinite(s.lateBook?.[c.side]?.size) && s.lateBook[c.side].size>=1)))
      .sort((a, b) => b.price - a.price);
    return candidates.length ? { shouldEnter: true, direction: candidates[0].direction, stage } : { shouldEnter: false };
  }
  function selectedEntryMode(s) {
    const phase = entryPhase(remainingSeconds(s));
    // Preserve settlement priority, but permit a confirmed higher-priced scalp
    // below 97 cents when no settlement entry qualifies in the last 90 seconds.
    if (phase === 'LATE_SETTLEMENT') {
      // Once a staged sequence starts, a failed or cooling-down stage must not
      // fall through into a scalp or change sides, even after a zero fill.
      if (lateStages[s.ticker] && !lateStages[s.ticker].closed) return phase;
      const signal = entrySignal(s, phase);
      if (!signal.shouldEnter && signal.reason !== 'LATE_RETRY_WAIT') return 'SCALP';
    }
    return phase;
  }
  async function enter(ctx, wick = false) {
    const { asset, s } = ctx;
    if (process.env.SCALP_ENABLED !== 'true' || !s.farmArmed || shared.disabledAssets.includes(asset)) return;
    const pythLate = isPythLateMarket(asset);
    const pilot = isPilotWick(asset);
    if (pilot && (!wick || !pilotWickEnabled() || s.activeTrade?.strategy===fallingNinetyStage.id)) return;
    const cryptoWick = isCryptoWick(asset);
    if (cryptoWick && (!wick || !cryptoWickEnabled())) return;
    const originalTicker = s.ticker;
    const wickRecord = lateStages[originalTicker]?.records?.[wickStage.id];
    if (!wick && asset === 'USDJPY' && wickRecord?.freshUsdJpyDownWick && wickRecord.spent > 0) return;
    const wickWindowOpen = () => {
      const seconds = remainingSeconds(s);
      return seconds > (pilot ? PILOT_WICK_CUTOFF_SECONDS : 0) && seconds < 180;
    };
    if (wick && (!wickAsset(asset) || !wickWindowOpen() || !originalTicker ||
        lateStages[originalTicker]?.attempted.includes(wickStage.id))) return;
    if (pythLate) {
      if (!fourMarketsEnabled() || !ctx.refreshQuote || !ctx.proxy ||
          remainingSeconds(s)<=0 || remainingSeconds(s)>=180) return;
      if (!wick) await (ctx.refreshInitialQuote ?? ctx.refreshQuote)();
    }
    const held = s.activeTrade;
    if (Date.now() - lastAttempt < SCALP_CONFIG.reentryCooldownMs) return;
    if (Date.now() - Math.max(...assets().map(a => a.lastExitTime || 0)) < SCALP_CONFIG.reentryCooldownMs) return;
    const mode = wick ? 'LATE_SETTLEMENT' : selectedEntryMode(s);
    let wickBook, bookAt;
    async function readWickBook(initial = false) {
      bookAt = Date.now();
      if (pythLate) {
        if (initial && ctx.refreshInitialQuote) await ctx.refreshInitialQuote();
        else await ctx.refreshQuote(initial ? 'INITIAL' : 'FINAL');
        bookAt = s.lastQuoteMessageTs;
        wickBook = s.lateBook;
      } else {
        wickBook = metalBook(await api.getMarketOrderbook(originalTicker,1));
      }
    }
    function readSignal() {
      if (!wick) return entrySignal(s, mode);
      const ledger = lateStages[originalTicker];
      if (s.ticker!==originalTicker || !wickWindowOpen() || !Number.isFinite(bookAt) ||
          Date.now()-bookAt>2000 || bookAt>Date.now() ||
          ledger?.closed || ledger?.attempted.includes(wickStage.id) ||
          (!ledger && lateEntryTickers.includes(originalTicker))) return {shouldEnter:false};
      const heldSide = s.activeTrade?.side ?? ledger?.side;
      const insideFinalTwoMinutes = remainingSeconds(s) < 120;
      for (const side of ['yes','no']) {
        const q = wickBook?.[side];
        if ((!heldSide || side===heldSide) && Number.isFinite(q?.price) &&
            q.price>=wickStage.minPrice && q.price<1 &&
            (insideFinalTwoMinutes || q.price<=0.979) &&
            Number.isFinite(q.size) && q.size>=1)
          return {shouldEnter:true,direction:side==='yes'?'UP':'DOWN',stage:{...wickStage,budget:wickBudgetFor(asset)}};
      }
      return {shouldEnter:false};
    }
    const priceFor = direction => wick ? wickBook?.[direction==='UP'?'yes':'no']?.price : executablePrice(s,direction,asset);
    if (!['SCALP', 'LATE_SETTLEMENT'].includes(mode) || !s.ticker || (held && mode !== 'LATE_SETTLEMENT')) return;
    const ticker = s.ticker;
    const sim = simulated();
    if (!compatibleHoldings(s, mode, sim)) return;
    s._simMode = sim;
    const risk = hasIndependentRisk(asset) ? {blocked:false} :
      checkRiskGuards(s, ctx.balance, false, { skipLossCooldown: mode === 'SCALP' });
    if (risk.blocked) { entryBlocked(asset, risk.reason); return; }
    if (wick) await readWickBook(true);
    const signal = readSignal();
    if (!signal.shouldEnter) return;
    const initialPrice = pythLate ? priceFor(signal.direction) : null;
    if (mode === 'LATE_SETTLEMENT') {
      const key = `${s.ticker}:${signal.stage.id}`;
      if (retryNow() - (lateChecks.get(key) ?? -Infinity) < SCALP_CONFIG.lateRetryMs) return;
      lateChecks.set(key, retryNow());
    }
    const checkCryptoTier = distance => cryptoWickTier({
      history: ctx.getReferenceHistory?.() ?? [], asset, ticker, side: distance.side,
      target: distance.target, close: s.marketCloseTs, now: Date.now(), guards: shrinkingGuards,
    });
    let initialTier;
    if (mode === 'LATE_SETTLEMENT') {
      const check = await proximity(ctx, signal);
      if (!check.allowed) { entryBlocked(asset, check.reason, { proximity: check }); return; }
      initialTier = cryptoWick ? checkCryptoTier(check) : null;
      if (cryptoWick && !initialTier?.allowed) {
        entryBlocked(asset, initialTier?.reason ?? 'CRYPTO_WICK_TIER_UNCONFIRMED',
          initialTier ? { shrinkingGuard: initialTier } : undefined);
        return;
      }
      const shrink = cryptoWick ? initialTier : shrinkingCheck(ctx,check,signal.stage.budget,wick);
      if (shrink && !shrink.allowed) { entryBlocked(asset,shrink.reason,{shrinkingGuard:shrink}); return; }
    }
    lastAttempt = Date.now();
    if (!sim && !(mode === 'LATE_SETTLEMENT' ? await accountMatches(asset, held, sim) : await accountFlat())) { entryBlocked(asset, 'CRYPTO_ACCOUNT_MISMATCH'); return; }
    const balance = sim ? shared.paperBalance : (await api.getBalance(exchangeForAsset(asset))) / 100;
    if (!Number.isFinite(balance) || balance<=0) { entryBlocked(asset,'INSUFFICIENT_EXCHANGE_BALANCE'); return; }
    if (cryptoWick) {
      const day = new Date().toISOString().slice(0, 10);
      if (s.sessionStartBalance === null) startSession(s,balance);
      if (s.dailyStartBalance === null || s.riskDay !== day) { startDay(s,balance); s.riskDay = day; }
      persist();
      const liveRisk = checkRiskGuards(s,balance);
      if (liveRisk.blocked) { entryBlocked(asset,liveRisk.reason); return; }
    }
    if (pythLate) {
      if (s.sessionStartBalance===null) startSession(s,balance);
      if (s.dailyStartBalance===null) startDay(s,balance);
      // Release only the USD/JPY session hold recorded after the Nov 23 9 p.m. PT settlement.
      if (!sim && asset === 'USDJPY' &&
          s.sessionKillAt >= Date.parse('2026-11-24T05:00:00Z') &&
          s.sessionKillAt < Date.parse('2026-11-24T05:12:06Z')) {
        log({ event: 'USDJPY_SESSION_HOLD_RELEASED', asset, sessionKillAt: s.sessionKillAt,
          previousSessionPnL: s.sessionPnL, dailyPnL: s.dailyPnL });
        s.sessionKillAt = null;
        s.sessionPnL = 0;
      }
      let liveRisk = checkRiskGuards(s, balance, false, {
        skipLossGuards: !sim && asset === 'EURUSD'
      });
      const resetDay='2026-11-17';
      if (!sim && asset==='USDJPY' && s.riskDay===resetDay &&
          s.usdJpyDailyReset?.day!==resetDay && liveRisk.reason==='DAILYCAP') {
        s.usdJpyDailyReset={day:resetDay,previousDailyPnL:s.dailyPnL,previousBaseline:s.dailyStartBalance};
        startDay(s,balance);
        liveRisk=checkRiskGuards(s,balance);
      }
      persist();
      if (liveRisk.blocked) { entryBlocked(asset,liveRisk.reason); return; }
    }
    // For Pyth markets, use the initial signal until account checks finish. Take
    // one new executable book just before submission and compare it to that signal.
    if (wick && !pythLate) await readWickBook();
    if (s.activeTrade !== held || !compatibleHoldings(s, mode, sim) || s.ticker !== ticker ||
        (!pythLate && !wick && selectedEntryMode(s) !== mode)) return;
    const fresh = pythLate ? signal : readSignal();
    if (!fresh.shouldEnter || fresh.direction !== signal.direction || fresh.stage?.id !== signal.stage?.id) return;
    const price = pythLate ? initialPrice : priceFor(fresh.direction);
    const stageSpent = lateStages[ticker]?.records?.[fresh.stage?.id]?.spent ?? 0;
    let stageBudget = mode === 'LATE_SETTLEMENT' ? Math.min(fresh.stage.budget - stageSpent,
      (wick ? totalBudget(asset) : lateBudgetFor(asset)+(lateStages[ticker]?.records?.wick_5s?.spent ?? 0)) - (lateStages[ticker]?.spent ?? 0)) : null;
    const feeMultiplier=hasIndependentRisk(asset)?s.lateFeeMultiplier:1;
    let count = mode === 'LATE_SETTLEMENT' ? lateStageSize(price, balance, stageBudget,feeMultiplier) : scalpSize(price, balance, mode);
    if (mode === 'LATE_SETTLEMENT' && !await accountMatches(asset, held, sim)) {
      entryBlocked(asset, 'CRYPTO_ACCOUNT_MISMATCH'); return;
    }
    const btcWickRange = wick && asset === 'BTC' ? deps.getBtcMinuteRange : null;
    const btcCandle = btcWickRange ? await btcWickRange(Date.now()) : null;
    // The final account check may cross a time tier or receive a changed quote.
    if (wick) await readWickBook();
    else if (pythLate) await ctx.refreshQuote('FINAL');
    const distanceCheck = mode === 'LATE_SETTLEMENT' ? await proximity(ctx, fresh) : null;
    if (distanceCheck && !distanceCheck.allowed) {
      entryBlocked(asset, distanceCheck.reason, { proximity: distanceCheck }); return;
    }
    const shrinkCheck = cryptoWick ? checkCryptoTier(distanceCheck) :
      distanceCheck ? shrinkingCheck(ctx,distanceCheck,fresh.stage.budget,wick) : null;
    if (cryptoWick && !shrinkCheck?.allowed) {
      entryBlocked(asset, shrinkCheck?.reason ?? 'CRYPTO_WICK_TIER_UNCONFIRMED',
        shrinkCheck ? { shrinkingGuard: shrinkCheck } : undefined);
      return;
    }
    if (cryptoWick) {
      stageBudget = Math.min(stageBudget, initialTier.budget, shrinkCheck.budget);
      count = lateStageSize(price, balance, stageBudget, feeMultiplier);
    }
    if (shrinkCheck && !shrinkCheck.allowed) {
      entryBlocked(asset,shrinkCheck.reason,{shrinkingGuard:shrinkCheck}); return;
    }
    if (shrinkCheck?.usdJpyDownWickBudget != null) {
      stageBudget = Math.min(stageBudget, shrinkCheck.usdJpyDownWickBudget);
      count = lateStageSize(price, balance, stageBudget, feeMultiplier);
    }
    const ladderCap = reducedLadderCap(asset, fresh.stage?.id, lateStages[ticker], shrinkCheck?.currentCushion);
    if (ladderCap !== undefined) {
      stageBudget = Math.min(stageBudget, ladderCap - stageSpent);
      count = lateStageSize(price, balance, stageBudget, feeMultiplier);
    }
    const final = readSignal();
    if (s.ticker !== ticker || s.activeTrade !== held || !compatibleHoldings(s, mode, sim) || !final.shouldEnter ||
        final.direction !== fresh.direction || final.stage?.id !== fresh.stage?.id ||
        priceFor(final.direction) !== price) return;
    const now = Date.now();
    const volatilityGuard = btcWickRange
      ? btcWickVolatilityCheck(btcCandle, distanceCheck?.distance, remainingSeconds(s, now), now)
      : null;
    if (volatilityGuard && !volatilityGuard.allowed) {
      entryBlocked(asset, volatilityGuard.reason, { volatilityGuard });
      return;
    }
    if (!wick && pythLate) count=Math.min(count,Math.floor(final.direction==='UP'?s.yesAskSize:s.noAskSize));
    if (wick) count=Math.min(count,Math.floor(wickBook[final.direction==='UP'?'yes':'no'].size));
    if (!Number.isSafeInteger(count) || count<=0 || (mode === 'LATE_SETTLEMENT' && count * (1 - price) <= lateFee(count, price,feeMultiplier))) return;
    const body = (wick || pythLate) ? buildDirectionalLateBuyBody(ticker,fresh.direction,count,price) :
      buildBuyBody(ticker, fresh.direction, count * price + 1e-9, s.yesAsk, s.yesBid);
    body.count = count.toFixed(2);
    if (hasIndependentRisk(asset)) body.exchange_index=exchangeForAsset(asset);
    if (mode === 'LATE_SETTLEMENT') body.time_in_force = 'immediate_or_cancel';
    body.client_order_id = crypto.randomUUID();
    await submit({ kind: 'entry', asset, mode, side: fresh.direction === 'UP' ? 'yes' : 'no',
      stageId: fresh.stage?.id, stageBudget, ladderCap, proximity: distanceCheck, shrinkingGuard: volatilityGuard ? { ...shrinkCheck, volatilityGuard } : shrinkCheck, entrySecondsRemaining: remainingSeconds(s), direction: fresh.direction, body, sim, simYesPrice: body.price, startedAt: Date.now() });
  }
  async function enterFallingNinety(ctx) {
    const {asset,s}=ctx;
    if (!isPilotWick(asset) || !fourMarketsEnabled() || !fallingNinetyEnabled() ||
        process.env.SCALP_ENABLED!=='true' || !s.farmArmed || simulated() ||
        shared.disabledAssets.includes(asset) || !ctx.refreshQuote) return;
    const signal=ctx.getFallingNinetySignal?.();
    if (signal?.direction!=='falling' || !['yes','no'].includes(signal.side)) return;
    const {side,ticker,target}=signal;
    const direction=side==='yes'?'UP':'DOWN';
    const eligible=()=>{
      const now=Date.now(), age=now-signal.at, ledger=lateStages[ticker];
      // A fresh executable quote is required below. The observer sample only
      // supplies the recent direction of the ask.
      return Number.isFinite(age) && age>=0 && age<=10000 && ctx.getFallingNinetySignal()===signal &&
        s.ticker===ticker && remainingSeconds(s,now)>0 && !s.activeTrade &&
        !ledger?.closed && !ledger?.spent && !ledger?.attempted.includes(fallingNinetyStage.id) &&
        (!ledger || ledger.side===side) && compatibleHoldings(s,'LATE_SETTLEMENT',false);
    };
    const reference=()=>{
      const p=ctx.proxy?.snapshot(asset,target,side);
      if (p?.status!=='FRESH_PROXY' || !Number.isFinite(p.estimatedCushion) ||
          p.estimatedCushion+1e-9<PILOT_WICK_MARKETS[asset].minimumCushion ||
          ![15,60].every(k=>Number.isFinite(p.movement?.[k]?.cushionChange) &&
            p.movement[k].cushionChange>=-1e-9)) return null;
      return p;
    };
    if (!eligible()) return;
    const distance=await proximity(ctx,{stage:fallingNinetyStage,direction});
    if (!distance.allowed || distance.target!==target || !reference() ||
        !await accountMatches(asset,null,false)) return;
    const balance=(await api.getBalance(exchangeForAsset(asset)))/100;
    if (!Number.isFinite(balance) || balance<=0 || !eligible()) return;
    if (s.sessionStartBalance===null) startSession(s,balance);
    if (s.dailyStartBalance===null) startDay(s,balance);
    persist();
    const risk=checkRiskGuards(s,balance);
    if (risk.blocked) { entryBlocked(asset,risk.reason,{strategy:fallingNinetyStage.id}); return; }
    await ctx.refreshQuote('FINAL');
    const quote=s.lateBook?.[side], checked=reference(), bookAge=Date.now()-s.lastQuoteMessageTs;
    if (!eligible() || !checked || !Number.isFinite(bookAge) || bookAge<0 || bookAge>2000 ||
        quote?.price!==.90 || !Number.isFinite(quote.size)) return;
    const budget=fallingNinetyStage.budget, feeMultiplier=s.lateFeeMultiplier;
    const count=Math.min(Math.floor(quote.size),lateStageSize(quote.price,balance,budget,feeMultiplier));
    if (!Number.isSafeInteger(count) || count<1 || count*(1-quote.price)<=lateFee(count,quote.price,feeMultiplier)) return;
    const body=buildDirectionalLateBuyBody(ticker,direction,count,quote.price);
    body.count=count.toFixed(2);
    body.exchange_index=exchangeForAsset(asset);
    body.time_in_force='immediate_or_cancel';
    body.client_order_id=crypto.randomUUID();
    await submit({kind:'entry',asset,mode:'LATE_SETTLEMENT',side,direction,body,sim:false,
      stageId:fallingNinetyStage.id,stageBudget:budget,proximity:distance,
      fallingNinety:{signalAt:signal.at,displayedSize:quote.size,cushion:checked.estimatedCushion,
        cushionChange15:checked.movement[15].cushionChange,cushionChange60:checked.movement[60].cushionChange},
      entrySecondsRemaining:remainingSeconds(s),startedAt:Date.now()});
  }

  async function enterBtcRetest(ctx) {
    const { asset, s } = ctx;
    const signal = btcRetestSignal;
    if (asset !== 'BTC' || !signal || !Number.isFinite(signal.feeMultiplier) ||
        signal.feeMultiplier <= 0) return;
    const { side } = signal;
    const direction = side === 'yes' ? 'UP' : 'DOWN';
    const eligible = () => {
      const now = Date.now();
      const age = now - signal.signalAt;
      if (!btcRetestEntryEnabled(side, signal) ||
          age < 0 || age > signal.maxQuoteDelayMs || btcRetestSignal !== signal || s.ticker !== signal.ticker ||
          s.marketCloseTs !== signal.close || signal.close <= now || s.activeTrade ||
          btcBearishRetestAttempted.includes(signal.ticker) ||
          process.env.SCALP_ENABLED !== 'true' || simulated() || !s.farmArmed ||
          shared.disabledAssets.includes(asset) || !compatibleHoldings(s, 'LATE_SETTLEMENT', false)) return false;
      const point = getReferenceHistory(asset).at(-1);
      return point?.sourceTs >= signal.signalAt && point.sourceTs <= now &&
        now - point.sourceTs <= 2000 && Number.isFinite(point.price) &&
        (side === 'yes' ? point.price > signal.breakLevel : point.price < signal.breakLevel);
    };
    if (!eligible() || checkRiskGuards(s, ctx.balance).blocked ||
        !await accountMatches(asset, null, false)) return;
    const balance = (await api.getBalance(exchangeForAsset(asset))) / 100;
    if (!Number.isFinite(balance) || balance <= 0 || checkRiskGuards(s, balance).blocked || !eligible()) return;
    const requestedAt = Date.now();
    const quote = metalBook(await api.getMarketOrderbook(signal.ticker, 1))?.[side];
    if (!eligible() || Date.now() - requestedAt > 2000 || !quote ||
        !Number.isFinite(quote.price) || quote.price < .001 || quote.price >= 1 ||
        quote.price > signal.maxAsk || !Number.isFinite(quote.size)) return;
    const count = Math.min(Math.floor(quote.size),
      lateStageSize(quote.price, balance, signal.budget, signal.feeMultiplier));
    if (count < 1 || count * (1 - quote.price) <= lateFee(count, quote.price, signal.feeMultiplier)) return;
    const body = buildDirectionalLateBuyBody(signal.ticker, direction, count, quote.price);
    await submit({ kind: 'entry', asset, mode: 'LATE_SETTLEMENT', side, direction,
      body, retestSignal: signal, sim: false, entrySecondsRemaining: remainingSeconds(s),
      startedAt: Date.now() });
  }

  async function enterBtcChart(ctx) {
    if (process.env.BTC_WICK_REJECTION_LIVE_ENABLED !== 'true') return;
    const { asset, s } = ctx;
    const signal = btcChartSignal;
    if (asset !== 'BTC' || !signal || s.ticker !== signal.ticker ||
        s.activeTrade || btcChartAttemptedTickers.includes(signal.ticker)) return;
    const eligible = () => {
      const now = Date.now();
      return btcChartSignal === signal && s.ticker === signal.ticker && !s.activeTrade && remainingSeconds(s, now) > 60 &&
        now >= signal.confirmedAt + 1000 && now <= signal.confirmedAt + btcChartSetupWindowMs &&
        process.env.SCALP_ENABLED === 'true' && !simulated() && s.farmArmed &&
        !shared.disabledAssets.includes(asset) && compatibleHoldings(s, 'SCALP', false);
    };
    if (!eligible()) return;
    const localRisk = checkRiskGuards(s, ctx.balance);
    if (localRisk.blocked) {
      entryBlocked(asset, localRisk.reason, { strategy: btcChartTrade });
      return;
    }
    if (!Number.isFinite(signal.feeMultiplier) || signal.feeMultiplier <= 0) return;
    const structureFor = () => {
      const now = Date.now();
      return btcChartStructure(signal, getReferenceHistory(asset),
        now + remainingSeconds(s, now) * 1000, now);
    };
    const structure = structureFor();
    if (!structure || !await accountFlat()) return;
    const balance = (await api.getBalance(exchangeForAsset(asset))) / 100;
    if (!Number.isFinite(balance) || balance <= 0 || !eligible()) return;
    const requestedAt = Date.now();
    const book = metalBook(await api.getMarketOrderbook(signal.ticker, 1));
    if (!eligible() || Date.now() - requestedAt > 2000) return;
    const latest = structureFor();
    if (latest?.side !== structure.side || latest.at !== structure.at) return;
    const quote = book?.[structure.side];
    const bid = book?.[structure.side + 'Bid'];
    if (!quote || !Number.isFinite(quote.price) || quote.price < btcChartMinEntryPrice ||
        quote.price >= 1 || !Number.isFinite(quote.size) ||
        !Number.isFinite(bid) || bid <= 0 || bid > quote.price) return;
    const risk = checkRiskGuards(s, balance);
    if (risk.blocked) {
      entryBlocked(asset, risk.reason, { strategy: btcChartTrade });
      return;
    }
    const budget = Math.min(balance, btcChartBudget);
    const worstFeePerContract = Math.max(0.02, 0.0175 * signal.feeMultiplier);
    const count = Math.min(Math.floor(quote.size),
      Math.floor((budget - 0.01) / (quote.price + worstFeePerContract)));
    if (count < 1 ||
        count * (1 - quote.price) - lateFee(count, quote.price, signal.feeMultiplier) <
          btcChartTargetPerContract * count) return;
    const direction = structure.side === 'yes' ? 'UP' : 'DOWN';
    const body = buildDirectionalLateBuyBody(signal.ticker, direction, count, quote.price);
    const startedAt = Date.now();
    await submit({ kind: 'entry', asset, mode: 'SCALP', side: structure.side, direction, body,
      chartSignal: { ...signal, side: structure.side, wickSide: signal.side, structure,
        entrySubmittedAt: startedAt, holdMs: btcChartHoldMs },
      chartConfirmation: { wickSide: signal.side, ...structure, bid, ask: quote.price },
      sim: false, entrySecondsRemaining: remainingSeconds(s), startedAt });
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
      const order = await api.getOrder(item.orderId, exchangeForAsset(asset));
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
    if (!held && trade.mode === 'LATE_SETTLEMENT' && lateStages[trade.ticker]) {
      saved.lateStages = { ...lateStages, [trade.ticker]: { ...lateStages[trade.ticker], closed: true } };
    }
    if (!held && hasIndependentRisk(asset)) {
      const nextRisk={...s};recordTradePnL(nextRisk,next.realizedNet);nextRisk.lastExitTime=Date.now();
      saved.marketRisk[asset]=Object.fromEntries(riskFields.map(k=>[k,nextRisk[k]]));
    }
    save(saved);
    lateStages = saved.lateStages;
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
      const positions = (await api.getPositions()).filter(row => row.ticker === trade.ticker);
      for (const position of positions) {
        if (!['string', 'number'].includes(typeof position.position_fp) ||
            String(position.position_fp).trim() === '' || !Number.isFinite(Number(position.position_fp))) {
          throw new Error('Invalid settled position');
        }
        if (Number(position.position_fp) !== 0) return;
      }
      const fills = await api.getAllFills({ ticker: trade.ticker });
      const entryOrderIds = trade.entryOrderIds ?? [trade.entryOrderId];
      const otherFills = fills.filter(fill => !entryOrderIds.includes(fill.order_id) &&
          !(trade.manualExitFillIds ?? []).includes(fill.fill_id ?? fill.trade_id) &&
          !(trade.accountedExitOrderIds ?? []).includes(fill.order_id) &&
          Date.parse(fill.created_time) >= trade.startedAt - 1000);
      if (!trade.entryOrderId || otherFills.length) {
        // This account settlement is final and flat. Preserve the mixed fills
        // for review without assigning exchange-level P&L to the bot lot.
        if (asset !== 'BTC' || trade.ticker !== btcSettlementRecoveryTicker ||
            trade.mode !== 'LATE_SETTLEMENT' || !trade.entryOrderId ||
            !fills.some(fill => entryOrderIds.includes(fill.order_id))) {
          throw new Error('Other fills affected late holding; settlement reconciliation required');
        }
        const resting = await api.getOrders({ ticker: trade.ticker, status: 'resting' });
        if (resting.length) return;
        const archivedAt = Date.now();
        const recovery = { ticker: trade.ticker, archivedAt, result,
          trade: structuredClone(trade), settlement: record, otherFills };
        const saved = snapshot();
        saved.positions[asset] = null;
        saved.btcSettlementRecovery = recovery;
        if (lateStages[trade.ticker]) saved.lateStages = {
          ...lateStages, [trade.ticker]: { ...lateStages[trade.ticker], closed: true }
        };
        save(saved);
        btcSettlementRecovery = recovery;
        lateStages = saved.lateStages;
        s.activeTrade = null;
        s.lastExitTime = archivedAt;
        log({ event: 'BTC_SETTLEMENT_RECONCILED', asset, ticker: trade.ticker, result,
          otherFillCount: otherFills.length, pnl: null, sim: false });
        return;
      }
    }
    // Attribute only this tracked lot. A settlement row can include earlier scalps
    // in the same ticker; its cumulative revenue/fees must not be counted again.
    const payout = result === trade.side ? trade.count : 0;
    const pnl = (trade.realizedNet ?? 0) + payout - trade.amount - trade.entryFees;
    const saved = snapshot();
    saved.positions[asset] = null;
    if (lateStages[trade.ticker]) saved.lateStages = {
      ...lateStages, [trade.ticker]: { ...lateStages[trade.ticker], closed: true }
    };
    if (hasIndependentRisk(asset)) {
      const nextRisk={...s}; recordTradePnL(nextRisk,pnl); nextRisk.lastExitTime=Date.now();
      saved.marketRisk[asset]=Object.fromEntries(riskFields.map(k=>[k,nextRisk[k]]));
    }
    save(saved);
    lateStages = saved.lateStages;
    if (trade.sim) shared.paperBalance += pnl;
    recordTradePnL(s, pnl);
    s.activeTrade = null;
    s.lastExitTime = Date.now();
    log({ event: 'SETTLED', asset, ticker: trade.ticker, mode: trade.mode, result, payout,
      pnl, sim: trade.sim, strategy: trade.strategy });
  }
  async function exitBtcChart(ctx) {
    const { asset, s } = ctx;
    const trade = s.activeTrade;
    if (s.ticker !== trade.ticker || remainingSeconds(s) <= 0) {
      await settle(ctx);
      return;
    }
    if (process.env.DRY_RUN === 'true') return;
    if (!trade.chartSignal.stopTriggeredAt) {
      const stop = btcChartStructureStop(trade, getReferenceHistory(ctx.asset), Date.now());
      if (stop) {
        trade.chartSignal.stopTriggeredAt = stop.sourceTs;
        persist();
      }
    }
    const positions = await api.getPositions();
    if (remainingHeldContracts(positions, trade) !== trade.count) {
      await reconcileExternal(ctx, positions);
      return;
    }
    const requestedAt = Date.now();
    const book = metalBook(await api.getMarketOrderbook(trade.ticker, 1));
    if (Date.now() - requestedAt > 2000 || s.ticker !== trade.ticker ||
        s.activeTrade !== trade || remainingSeconds(s) <= 0) return;
    const bid = book?.[trade.side + 'Bid'];
    if (!Number.isFinite(bid) || bid <= 0 || bid >= 1) return;
    const holdMs = trade.chartSignal.holdMs ?? btcChartLegacyHoldMs;
    const stopExit = Boolean(trade.chartSignal.stopTriggeredAt);
    const timerStart = trade.chartSignal.entrySubmittedAt ?? trade.chartSignal.confirmedAt;
    const timeExit = Date.now() - timerStart >= holdMs;
    const net = trade.count * bid - lateFee(trade.count, bid, trade.chartSignal.feeMultiplier)
      - trade.amount - trade.entryFees;
    if (!stopExit && !timeExit && net < btcChartTargetPerContract * trade.count) return;
    const body = buildSellBody(trade.ticker, trade.side, trade.count);
    body.price = (trade.side === 'yes' ? bid : 1 - bid).toFixed(4);
    await submit({ kind: 'exit', asset, side: trade.side, body, sim: false,
      reason: stopExit ? 'BTC_CHART_STRUCTURE_STOP' : timeExit ? 'BTC_CHART_TIME_EXIT' :
        'BTC_CHART_PROFIT_EXIT', startedAt: Date.now() });
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
      decision = evaluateScalpExit({ heldSeconds, side: trade.side, entryPrice: trade.entrySidePrice, exitBid: trade.side === 'yes' ? bid : 1 - ask,
        accounting: { contracts: trade.count, entryFees: trade.entryFees, exitFees: reserveFee(trade.count),
          originalCost: trade.originalCost ?? trade.amount + trade.entryFees, realizedNet: trade.realizedNet ?? 0 } });
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
  async function runTick(ctx, queuedAt) {
    try {
      const queueWaitMs = Date.now() - queuedAt;
      if (queueWaitMs >= 100) {
        log({ event: 'EXECUTOR_QUEUE_WAIT', asset: ctx.asset, ticker: ctx.s.ticker, queueWaitMs });
      }
      if (pending) {
        if (Date.now() < nextReconcileAt) return;
        nextReconcileAt = Date.now() + 3000;
        await reconcile(); return;
      }
      if (ctx.asset === 'BTC' && ctx.s.activeTrade?.ticker === btcSettlementRecoveryTicker &&
          ctx.s.activeTrade.mode === 'LATE_SETTLEMENT' && !ctx.s.activeTrade.sim) {
        await settle(ctx);
        return;
      }
      if (isManagedTrade(ctx.s.activeTrade) && !ctx.s.activeTrade.sim &&
          Date.now() - (manualPolls.get(ctx.asset) ?? 0) >= 5000) {
        manualPolls.set(ctx.asset, Date.now());
        if (await reconcileExternal(ctx)) return;
      }
      if (ctx.s.activeTrade?.mode === 'LATE_SETTLEMENT') {
        await settle(ctx);
        if (ctx.s.activeTrade?.mode === 'LATE_SETTLEMENT' &&
            !isBtcRetestTrade(ctx.s.activeTrade.strategy)) await enter(ctx);
      }
      else if (ctx.s.activeTrade?.strategy === btcChartTrade) await exitBtcChart(ctx);
      else if (ctx.s.activeTrade?.mode === 'SCALP') await exit(ctx);
      else {
        await enterBtcRetest(ctx);
        if (!pending && !ctx.s.activeTrade) await enterBtcChart(ctx);
        if (!pending && !ctx.s.activeTrade) await enter(ctx);
      }
      if (deps.liveWick && !pending && !isBtcRetestTrade(ctx.s.activeTrade?.strategy) &&
          (!ctx.s.activeTrade || ctx.s.activeTrade.mode==='LATE_SETTLEMENT'))
        await enter(ctx,true);
      if (!pending && !ctx.s.activeTrade) await enterFallingNinety(ctx);
    } catch (error) { log({ event: pending ? 'ORDER_UNCERTAIN' : 'BLOCKED', asset: ctx.asset, ticker: ctx.s.activeTrade?.ticker ?? ctx.s.ticker, error: error.message,
      clientOrderId: pending?.body.client_order_id,
      ...(pending ? { orderId: pending.orderId, requested: pending.body.count,
        responseFillCount: pending.response?.fill_count,
        responseRemainingCount: pending.response?.remaining_count } : {}) }); }
  }
  function tick(ctx) {
    // The clock and both market runners await each tick. Serialize their work
    // so an in-flight account check cannot silently discard another market.
    const queuedAt = Date.now();
    const run = tickQueue.then(() => runTick(ctx, queuedAt));
    tickQueue = run.catch(() => {});
    return run;
  }
  return { tick, restore, snapshot, queueBtcWickSignal, queueBtcBearishRetest, queueBtcBullishPullback };
}
export const scalpExecutor = createScalpExecutor({ selectLateStage: productionLateStage, liveWick: true, getBtcMinuteRange });
export function restoreScalpExecution() { scalpExecutor.restore(loadJournal()); }

