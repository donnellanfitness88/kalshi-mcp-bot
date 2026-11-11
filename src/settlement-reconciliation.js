
function amount(value, field) {
  if (
    (typeof value !== 'string' &&
      typeof value !== 'number') ||
    String(value).trim() === '' ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error(`Invalid ${field}`);
  }

  return Number(value);
}

export function reconcileSettlements(settlements) {
  if (!Array.isArray(settlements)) {
    throw new Error('Settlements must be an array');
  }

  const seen = new Set();
  const results = [];

  for (const s of settlements) {
    if (!s.ticker) {
      throw new Error('Settlement missing ticker');
    }

    const subaccount = s.subaccount_number ?? 'default';
    const key = `${subaccount}:${s.ticker}`;

    if (seen.has(key)) {
      throw new Error(`Duplicate settlement: ${key}`);
    }
    seen.add(key);

    const yesCount = amount(
      s.yes_count_fp, 'yes_count_fp'
    );
    const noCount = amount(
      s.no_count_fp, 'no_count_fp'
    );

    const yesCost = amount(
      s.yes_total_cost_dollars,
      'yes_total_cost_dollars'
    );
    const noCost = amount(
      s.no_total_cost_dollars,
      'no_total_cost_dollars'
    );

    const fees = amount(s.fee_cost, 'fee_cost');
    const revenueCents = amount(s.revenue, 'revenue');

    if (!Number.isInteger(revenueCents)) {
      throw new Error('Revenue must be integer cents');
    }

    if (
      !['yes', 'no', 'void'].includes(s.market_result)
    ) {
      throw new Error(
        `Unsupported settlement result: ${s.market_result}`
      );
    }

    const revenue = revenueCents / 100;
    const cost = yesCost + noCost;
    const pnl = revenue - cost - fees;

    results.push({
      ticker: s.ticker,
      marketResult: s.market_result,
      yesCount,
      noCount,
      revenue: Number(revenue.toFixed(6)),
      cost: Number(cost.toFixed(6)),
      fees: Number(fees.toFixed(6)),
      pnl: Number(pnl.toFixed(6)),
      status: 'SETTLEMENT_CALCULATED'
    });
  }

  return {
    results,
    totalPnl: Number(
      results.reduce((sum, r) => sum + r.pnl, 0)
        .toFixed(6)
    )
  };
}
