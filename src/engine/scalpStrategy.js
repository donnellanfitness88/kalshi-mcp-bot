
import { getAllFills, getOrders } from '../kalshi/client.js';

/**
 * SCALP strategy — research and testing.
 * No live order placement.
 */


export const SCALP_CONFIG = {
  minHoldSeconds: 15,
  maxHoldSeconds: 45,
  maxLossUsd: 3.00,
  entryMinSecondsRemaining: 180,
  lateEntryMaxSecondsRemaining: 90,
  lateEntryMinPrice: 0.97,
  minNetProfitPct: 0.05,
  preferredNetProfitPct: 0.10,
  reentryCooldownMs: 8_000,
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
