
import { reconcileFills } from './fill-reconciliation.js';

function number(value, name) {
  const n = Number(value);
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === '' ||
    !Number.isFinite(n) ||
    n < 0
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return n;
}

export function auditAccounting(fills, settlements) {
  if (!Array.isArray(settlements)) {
    throw new Error('Settlements must be an array');
  }

  const fillReport = reconcileFills(fills);
  const settlementTickers = new Set();
  const checks = [];
  const issues = [];

  for (const s of settlements) {
    if (!s.ticker) {
      throw new Error('Settlement missing ticker');
    }

    if (settlementTickers.has(s.ticker)) {
      issues.push({
        ticker: s.ticker,
        reason: 'DUPLICATE_SETTLEMENT_TICKER'
      });
      continue;
    }

    settlementTickers.add(s.ticker);

    for (const side of ['yes', 'no']) {
      const key = `${s.ticker}:${side}`;
      const remaining =
        fillReport.positions.get(key)?.count ?? 0;

      const settled = number(
        s[`${side}_count_fp`],
        `${side}_count_fp`
      );

      const difference = remaining - settled;
      const matches = Math.abs(difference) < 0.000001;

      checks.push({
        ticker: s.ticker,
        side,
        remaining,
        settled,
        matches
      });

      if (!matches) {
        issues.push({
          ticker: s.ticker,
          side,
          reason: 'QUANTITY_MISMATCH',
          difference
        });
      }
    }
  }

  const unresolved = [];

  for (const [key, position] of fillReport.positions) {
    const ticker = key.slice(0, key.lastIndexOf(':'));

    if (
      position.count > 0.000001 &&
      !settlementTickers.has(ticker)
    ) {
      unresolved.push({
        ticker,
        count: position.count,
        status: 'UNRESOLVED'
      });
    }
  }

  return {
    fillSales: fillReport.results.length,
    settlementsChecked: settlementTickers.size,
    checks,
    issues,
    unresolved,
    status: issues.length
      ? 'REVIEW_REQUIRED'
      : unresolved.length
        ? 'INCOMPLETE'
        : 'QUANTITIES_MATCH'
  };
}
