
export function normalizeFill(fill) {
  if (!fill || typeof fill !== 'object') {
    throw new Error('Invalid fill');
  }

  const action = fill.action;
  const side = fill.outcome_side || fill.side;
  const quantity = Number(fill.count_fp);

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error('Invalid fill quantity');
  }

  if (!['buy', 'sell'].includes(action)) {
    throw new Error('Invalid fill action');
  }

  if (!['yes', 'no'].includes(side)) {
    throw new Error('Invalid fill side');
  }

  const economicSide =
    (action === 'buy' && side === 'yes') ||
    (action === 'sell' && side === 'no')
      ? 'yes'
      : 'no';

  const yesPrice = Number(
    fill.yes_price_dollars
  );

  const noPrice = Number(
    fill.no_price_dollars
  );

  const fee = Number(fill.fee_cost);

  if (
    !Number.isFinite(yesPrice) ||
    !Number.isFinite(noPrice) ||
    yesPrice < 0 ||
    yesPrice > 1 ||
    noPrice < 0 ||
    noPrice > 1 ||
    Math.abs(yesPrice + noPrice - 1) > 0.0001
  ) {
    throw new Error('Invalid fill prices');
  }

  if (!Number.isFinite(fee) || fee < 0) {
    throw new Error('Invalid fill fee');
  }

  return {
    fillId: fill.fill_id,
    ticker: fill.ticker,
    timestamp: fill.created_time || fill.ts,
    originalAction: action,
    originalSide: side,
    bookSide: fill.book_side,
    economicSide,
    quantity,
    economicPrice:
      economicSide === 'yes'
        ? yesPrice
        : noPrice,
    fee,
    // Do not infer whether this opens or
    // closes an existing position.
    positionEffect: 'UNVERIFIED'
  };
}
