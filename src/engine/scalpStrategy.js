
import { getAllFills, getOrders } from '../kalshi/client.js';

/**
 * SCALP strategy — research and testing.
 * No live order placement.
 */


export const SCALP_CONFIG = {
  entryMinMove: 0.02,
  confirmationSeconds: 3,
  maxEntryPullback: 0.01,
  minHoldSeconds: 15,
  maxHoldSeconds: null, // No forced time-based scalp exit.
  maxLossUsd: null, // No per-trade loss exit.
  entryMinSecondsRemaining: 480,
  lateEntryMaxSecondsRemaining: 90,
  lateEntryMinPrice: 0.97,
  minNetProfitPct: 0.05,
  preferredNetProfitPct: 0.10,
  reentryCooldownMs: 0,
  maxEntryCostUsd: 10.00,
  maxConcurrentPositions: 1
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
export function scalpEntryPriceAllowed(price) {
  return Number.isFinite(price) && price > 0 &&
    (price < 0.40 - 1e-9 || (price > 0.60 + 1e-9 && price < 0.97 - 1e-9));
}

// Targets are contract-price points, not percentage returns on the stake.
export function scalpTakeProfitPrice(entryPrice) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    throw new Error('Invalid SCALP entry price');
  }
  const price = Math.round(entryPrice * 1000000) / 1000000;
  if (price >= 0.90) return 0.97;
  if (price >= 0.80) return 0.90;
  return Math.round((price + 0.05) * 1000000) / 1000000;
}
export function evaluateScalpExit({ heldSeconds, entryPrice, exitBid }) {
  if (!Number.isFinite(heldSeconds) || heldSeconds < 0 ||
      !Number.isFinite(exitBid) || exitBid < 0 || exitBid > 1) {
    throw new Error('Invalid SCALP exit inputs');
  }
  const targetPrice = scalpTakeProfitPrice(entryPrice);
  if (Number.isFinite(SCALP_CONFIG.maxHoldSeconds) && heldSeconds >= SCALP_CONFIG.maxHoldSeconds) {
    return { shouldExit: true, reason: 'MAX_HOLD_TIME', targetPrice };
  }
  if (exitBid + 1e-9 >= targetPrice) {
    return { shouldExit: true, reason: 'PRICE_TARGET', targetPrice };
  }
  return { shouldExit: false, reason: 'HOLD', targetPrice };
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

  // Require a 2-cent move over the existing 5-to-10-second observation.
  if (Math.abs(move) + 1e-9 < SCALP_CONFIG.entryMinMove) {
    return reject('WEAK_MOMENTUM');
  }

  const direction = move > 0 ? 'UP' : 'DOWN';
  const sign = direction === 'UP' ? 1 : -1;

  // Measure three elapsed one-second intervals, not three WS messages.
  // Every interval must advance in the direction of the held contract.
  const checkpoints = [];
  for (let secondsAgo = SCALP_CONFIG.confirmationSeconds; secondsAgo >= 0; secondsAgo--) {
    const targetTs = last.ts - secondsAgo * 1000;
    const point = valid.findLast(p => p.ts <= targetTs);
    if (!point || targetTs - point.ts > 500) return reject('INSUFFICIENT_CONFIRMATION_HISTORY');
    checkpoints.push(point);
  }
  const confirmationStart = checkpoints[0].ts;
  const confirmationHistory = valid.filter(p => p.ts >= confirmationStart);
  if (confirmationHistory.some((p, i) => i && p.ts - confirmationHistory[i - 1].ts > 1000)) {
    return reject('GAPPED_CONFIRMATION_HISTORY');
  }
  for (let i = 1; i < checkpoints.length; i++) {
    if (sign * (checkpoints[i].price - checkpoints[i - 1].price) <= 1e-9) {
      return reject('MOMENTUM_NOT_CONFIRMED');
    }
  }

  // Mirror the price series for NO: a falling YES price is a rising NO price.
  // Compare midpoints consistently so spread alone is not counted as a pullback.
  const sidePrices = valid.map(p => direction === 'UP' ? p.price : 1 - p.price);
  const currentSideMid = direction === 'UP' ? midpoint : 1 - midpoint;
  const pullback = Math.max(...sidePrices) - currentSideMid;
  if (pullback > SCALP_CONFIG.maxEntryPullback + 1e-9) {
    return reject('ENTRY_PULLBACK_TOO_LARGE');
  }

  return {
    shouldEnter: true,
    direction,
    reason: 'MOMENTUM_CONFIRMED',
    spreadCents: spread * 100,
    moveCents: move * 100,
    confirmationSeconds: SCALP_CONFIG.confirmationSeconds,
    pullbackCents: Math.max(0, pullback) * 100
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

/**
 * Build a SCALP position from a confirmed fill.
 * Does not submit an order.
 */
export function createScalpPosition({
  ticker,
  direction,
  confirmedContracts,
  averageFillPrice,
  entryFees,
  estimatedExitFees,
  startedAt = Date.now()
}) {
  if (
    !ticker ||
    !['UP', 'DOWN'].includes(direction) ||
    !Number.isInteger(confirmedContracts) ||
    confirmedContracts <= 0 ||
    !Number.isFinite(averageFillPrice) ||
    averageFillPrice <= 0 ||
    averageFillPrice >= 1 ||
    !Number.isFinite(entryFees) ||
    entryFees < 0 ||
    !Number.isFinite(estimatedExitFees) ||
    estimatedExitFees < 0
  ) {
    throw new Error('Invalid SCALP fill data');
  }

  const position = {
    ticker,
    mode: 'SCALP',
    bet: direction,
    side: direction === 'UP' ? 'yes' : 'no',
    count: confirmedContracts,
    entrySidePrice: averageFillPrice,
    
amount: confirmedContracts * averageFillPrice,
maxProfit: confirmedContracts * (1 - averageFillPrice),
entryFees,
estimatedExitFees,
startedAt,
canStopAfter: startedAt,
sim: false

  };

  const validation = validateScalpPosition(position);

  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  return position;
}

/**
 * Retrieve execution records for a SCALP order.
 * Read-only: does not submit or cancel orders.
 */
export async function getScalpOrderFills({
  ticker,
  orderId
}) {
  if (
    typeof ticker !== 'string' ||
    !ticker.trim() ||
    typeof orderId !== 'string' ||
    !orderId.trim()
  ) {
    throw new Error('Invalid SCALP order identifiers');
  }

  const fills = await getAllFills({ ticker });

  const matching = fills.filter(
    fill => fill.order_id === orderId
  );

  return {
    ticker,
    orderId,
    fills: matching,
    fillCount: matching.length,
    rawFields: matching.length
      ? Object.keys(matching[0])
      : []
  };
}

/**
 * Calculate entry execution from normalized fill data.
 *
 * Each record must contain:
 * contracts: number of contracts filled
 * price: execution price in dollars per contract
 * fee: total fee for that fill in dollars
 *
 * The caller must verify the Kalshi API field names
 * and units before constructing these records.
 */
export function calculateScalpExecution(fills) {
  if (!Array.isArray(fills) || fills.length === 0) {
    throw new Error('SCALP has no confirmed fills');
  }

  let contracts = 0;
  let grossCost = 0;
  let entryFees = 0;

  for (const fill of fills) {
    const { contracts: qty, price, fee } = fill;

    if (
      !Number.isInteger(qty) ||
      qty <= 0 ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price >= 1 ||
      !Number.isFinite(fee) ||
      fee < 0
    ) {
      throw new Error('Invalid SCALP execution record');
    }

    contracts += qty;
    grossCost += qty * price;
    entryFees += fee;
  }

  return {
    confirmedContracts: contracts,
    averageFillPrice: grossCost / contracts,
    grossCost,
    entryFees,
    totalEntryCost: grossCost + entryFees
  };
}

/**
 * Convert Kalshi buy fills into normalized SCALP records.
 * Uses fixed-point contract quantities and dollar prices.
 */
export function normalizeKalshiScalpFills(fills, side) {
  if (!Array.isArray(fills) || !fills.length) {
    throw new Error('No Kalshi fills supplied');
  }

  if (!['yes', 'no'].includes(side)) {
    throw new Error('Invalid SCALP side');
  }

  return fills.map(fill => {
    if (fill.action !== 'buy' || fill.side !== side) {
      throw new Error('Unexpected SCALP fill side/action');
    }

    const rawQty = fill.count_fp;
    const rawPrice = side === 'yes'
      ? fill.yes_price_dollars
      : fill.no_price_dollars;
    const rawFee = fill.fee_cost;

    if (
      typeof rawQty !== 'string' ||
      typeof rawPrice !== 'string' ||
      typeof rawFee !== 'string' ||
      !/^\d+(\.\d+)?$/.test(rawQty) ||
      !/^\d+(\.\d+)?$/.test(rawPrice) ||
      !/^\d+(\.\d+)?$/.test(rawFee)
    ) {
      throw new Error('Missing or invalid Kalshi fill fields');
    }

    const contracts = Number(rawQty);
    const price = Number(rawPrice);
    const fee = Number(rawFee);

    if (
      !Number.isSafeInteger(contracts) ||
      contracts <= 0 ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price >= 1 ||
      !Number.isFinite(fee) ||
      fee < 0
    ) {
      throw new Error('Invalid SCALP execution values');
    }

    return { contracts, price, fee };
  });
}

/**
 * Reconcile a SCALP buy order using actual Kalshi fills.
 * Read-only. Does not place orders.
 */
export async function reconcileScalpEntry({
  ticker,
  orderId,
  direction,
  expectedContracts
}) {
  if (!['UP', 'DOWN'].includes(direction)) {
    throw new Error('Invalid SCALP direction');
  }

  if (
    !Number.isSafeInteger(expectedContracts) ||
    expectedContracts <= 0
  ) {
    throw new Error('Invalid expected contract count');
  }

  const side = direction === 'UP' ? 'yes' : 'no';

  const result = await getScalpOrderFills({
    ticker,
    orderId
  });

  const normalized = normalizeKalshiScalpFills(
    result.fills,
    side
  );

  const execution = calculateScalpExecution(normalized);

  if (
    execution.confirmedContracts > expectedContracts
  ) {
    throw new Error(
      'SCALP fills exceed expected contracts'
    );
  }

  return {
    ticker,
    orderId,
    direction,
    ...execution,
    fullyFilled:
      execution.confirmedContracts === expectedContracts
  };
}

/**
 * Read-only order status verification.
 * Does not submit or cancel orders.
 */
export async function verifyScalpOrderStatus({
  ticker,
  orderId
}) {
  if (
    typeof ticker !== 'string' ||
    !ticker.trim() ||
    typeof orderId !== 'string' ||
    !orderId.trim()
  ) {
    throw new Error('Invalid SCALP order identifiers');
  }

  const orders = await getOrders({ ticker });

  const order = orders.find(
    item => item.order_id === orderId
  );

  if (!order) {
    return {
      found: false,
      verified: false,
      reason: 'ORDER_NOT_FOUND'
    };
  }

  const status = order.status;

  return {
    found: true,
    verified: true,
    orderId,
    ticker,
    status,
    terminal: ['executed', 'canceled'].includes(status),
    rawOrder: order
  };
}

/**
 * Check whether a SCALP entry is fully reconciled.
 * Read-only; does not place orders.
 */
export async function checkScalpEntryReadiness({
  ticker,
  orderId,
  direction,
  expectedContracts
}) {
  const order = await verifyScalpOrderStatus({
    ticker,
    orderId
  });

  if (!order.found || !order.verified) {
    return {
      ready: false,
      reason: 'ORDER_NOT_VERIFIED'
    };
  }

  if (!order.terminal) {
    return {
      ready: false,
      reason: 'ORDER_NOT_TERMINAL',
      status: order.status
    };
  }

  let execution;

  try {
    execution = await reconcileScalpEntry({
      ticker,
      orderId,
      direction,
      expectedContracts
    });
  } catch (error) {
    return {
      ready: false,
      reason: 'FILL_RECONCILIATION_FAILED',
      error: error.message
    };
  }

  if (!execution.fullyFilled) {
    return {
      ready: false,
      reason: 'PARTIAL_FILL_REQUIRES_RECONCILIATION',
      execution
    };
  }

  return {
    ready: true,
    reason: 'ENTRY_RECONCILED',
    status: order.status,
    execution
  };
}
