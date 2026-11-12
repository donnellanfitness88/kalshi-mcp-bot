
/**
 * SCALP strategy — research and testing.
 * No live order placement.
 */

export const SCALP_CONFIG = {
  minHoldSeconds: 15,
  maxHoldSeconds: 45,
  minNetProfitPct: 0.05,
  preferredNetProfitPct: 0.10,
  reentryCooldownMs: 8_000
};

export function evaluateScalpProfit({
  entryPrice,
  exitBid,
  contracts,
  entryFees,
  exitFees,
  slippagePerContract = 0
}) {
  const values = [
    entryPrice,
    exitBid,
    contracts,
    entryFees,
    exitFees,
    slippagePerContract
  ];

  if (
    values.some(v => !Number.isFinite(v)) ||
    entryPrice <= 0 ||
    entryPrice >= 1 ||
    exitBid < 0 ||
    exitBid > 1 ||
    !Number.isInteger(contracts) ||
    contracts <= 0 ||
    entryFees < 0 ||
    exitFees < 0 ||
    slippagePerContract < 0
  ) {
    throw new Error('Invalid SCALP inputs');
  }

  const entryCost = entryPrice * contracts;
  const totalCost = entryCost + entryFees;

  const exitProceeds =
    (exitBid - slippagePerContract) * contracts
    - exitFees;

  const netProfit = exitProceeds - totalCost;
  const netReturn = netProfit / totalCost;

  return {
    netProfit,
    netReturn,
    minimumTargetReached:
      netReturn >= SCALP_CONFIG.minNetProfitPct,
    preferredTargetReached:
      netReturn >= SCALP_CONFIG.preferredNetProfitPct
  };
}

/**
 * Evaluate the holding window.
 * Returns a signal for simulation, not an order.
 */
export function evaluateScalpExit({
  heldSeconds,
  netReturn,
  momentumStrong = false
}) {
  if (
    !Number.isFinite(heldSeconds) ||
    !Number.isFinite(netReturn) ||
    heldSeconds < 0
  ) {
    throw new Error('Invalid SCALP exit inputs');
  }

  if (heldSeconds >= SCALP_CONFIG.maxHoldSeconds) {
    return {
      shouldExit: true,
      reason: 'MAX_HOLD_TIME'
    };
  }

  if (
    netReturn >= SCALP_CONFIG.preferredNetProfitPct
  ) {
    return {
      shouldExit: true,
      reason: 'PREFERRED_PROFIT'
    };
  }

  if (
    heldSeconds >= SCALP_CONFIG.minHoldSeconds &&
    netReturn >= SCALP_CONFIG.minNetProfitPct &&
    !momentumStrong
  ) {
    return {
      shouldExit: true,
      reason: 'MIN_PROFIT'
    };
  }

  return {
    shouldExit: false,
    reason: 'HOLD'
  };
}

/**
 * SCALP entry evaluator — research only.
 *
 * priceHistory: chronological snapshots:
 * [{ ts: timestampMs, price: yesMidPrice }, ...]
 *
 * yesAsk / yesBid: current YES orderbook prices.
 * Returns a signal, never places an order.
 */
export function evaluateScalpEntry({
  priceHistory,
  yesAsk,
  yesBid,
  now = Date.now()
}) {
  const reject = reason => ({
    shouldEnter: false,
    direction: null,
    reason
  });

  if (
    !Array.isArray(priceHistory) ||
    priceHistory.length < 3 ||
    !Number.isFinite(now) ||
    !Number.isFinite(yesAsk) ||
    !Number.isFinite(yesBid) ||
    yesBid < 0 ||
    yesAsk > 1 ||
    yesAsk <= yesBid
  ) {
    return reject('INVALID_DATA');
  }

  const spread = yesAsk - yesBid;

  // Initial research threshold: maximum 2 cents.
  if (spread > 0.02 + 1e-9) {
    return reject('SPREAD_TOO_WIDE');
  }

  const valid = priceHistory.filter(p =>
    Number.isFinite(p.ts) &&
    Number.isFinite(p.price) &&
    p.price >= 0 &&
    p.price <= 1 &&
    p.ts <= now &&
    p.ts >= now - 10_000
  );

  if (valid.length < 3) {
    return reject('INSUFFICIENT_HISTORY');
  }

  valid.sort((a, b) => a.ts - b.ts);

  const first = valid[0];
  const last = valid[valid.length - 1];

  if (
    now - last.ts > 2_000 ||
    last.ts - first.ts < 5_000
  ) {
    return reject('STALE_OR_SHORT_HISTORY');
  }

  const midpoint = (yesAsk + yesBid) / 2;

  // Reject disagreement between latest history
  // and current orderbook.
  if (Math.abs(last.price - midpoint) > 0.01) {
    return reject('PRICE_MISMATCH');
  }

  const move = last.price - first.price;

  // Require at least 1 cent of movement
  // during the recent observation window.
  if (Math.abs(move) < 0.01) {
    return reject('WEAK_MOMENTUM');
  }

  const direction = move > 0 ? 'UP' : 'DOWN';

  // Require recent movement to confirm direction.
  const recent = valid.slice(-3);
  const recentMove =
    recent[recent.length - 1].price -
    recent[0].price;

  if (
    recentMove === 0 ||
    Math.sign(recentMove) !== Math.sign(move)
  ) {
    return reject('MOMENTUM_NOT_CONFIRMED');
  }

  return {
    shouldEnter: true,
    direction,
    reason: 'MOMENTUM_CONFIRMED',
    spreadCents: spread * 100,
    moveCents: move * 100
  };
}

/**
 * Validate a SCALP position before evaluating
 * profit targets or submitting an exit.
 */
export function validateScalpPosition(trade) {
  if (!trade || trade.mode !== 'SCALP') {
    return { valid: false, reason: 'NOT_SCALP' };
  }

  if (
    !trade.ticker ||
    !['yes', 'no'].includes(trade.side) ||
    !Number.isInteger(trade.count) ||
    trade.count <= 0
  ) {
    return { valid: false, reason: 'INVALID_POSITION' };
  }

  if (
    !Number.isFinite(trade.entrySidePrice) ||
    trade.entrySidePrice <= 0 ||
    trade.entrySidePrice >= 1 ||
    !Number.isFinite(trade.startedAt) ||
    trade.startedAt <= 0
  ) {
    return { valid: false, reason: 'INVALID_ENTRY' };
  }

  if (
    !Number.isFinite(trade.entryFees) ||
    !Number.isFinite(trade.estimatedExitFees) ||
    trade.entryFees < 0 ||
    trade.estimatedExitFees < 0
  ) {
    return { valid: false, reason: 'INVALID_FEES' };
  }

  return { valid: true, reason: 'POSITION_VALID' };
}
