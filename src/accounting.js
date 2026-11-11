
function money(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

// All monetary inputs are in USD.
// Use confirmed execution amounts, not quoted prices.
export function calculateTradePnL({
  entryCost,
  exitProceeds,
  entryFees,
  exitFees
}) {
  money(entryCost, 'entryCost');
  money(exitProceeds, 'exitProceeds');
  money(entryFees, 'entryFees');
  money(exitFees, 'exitFees');

  const totalFees = entryFees + exitFees;
  const pnl = exitProceeds - entryCost - totalFees;

  return {
    pnl: Number(pnl.toFixed(6)),
    totalFees: Number(totalFees.toFixed(6)),
    win: pnl > 0,
    status: 'VERIFIED_INPUTS'
  };
}

// For positions held through final settlement.
// settlementProceeds must be the actual confirmed payout.
export function calculateSettlementPnL({
  entryCost,
  settlementProceeds,
  entryFees,
  settlementFees
}) {
  money(entryCost, 'entryCost');
  money(settlementProceeds, 'settlementProceeds');
  money(entryFees, 'entryFees');
  money(settlementFees, 'settlementFees');

  const totalFees = entryFees + settlementFees;
  const pnl = settlementProceeds - entryCost - totalFees;

  return {
    pnl: Number(pnl.toFixed(6)),
    totalFees: Number(totalFees.toFixed(6)),
    win: pnl > 0,
    status: 'VERIFIED_INPUTS'
  };
}
