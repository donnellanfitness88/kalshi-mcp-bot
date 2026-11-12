
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
