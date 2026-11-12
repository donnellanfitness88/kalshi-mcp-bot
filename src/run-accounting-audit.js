
/**
 * Kalshi BTC/ETH 15-minute read-only accounting inventory.
 * No order placement, trading configuration changes, or speculative P&L.
 * Run: node src/run-accounting-audit.js
 */
import { getAllFills, getAllSettlements } from './kalshi/client.js';

const SERIES = ['KXBTC15M', 'KXETH15M'];
const round = (x) => Number(x.toFixed(6));
const classify = (ticker) => SERIES.find(s => typeof ticker === 'string' && ticker.startsWith(s + '-')) || null;
const validNumber = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function summarize(series, fills, settlements) {
  const f = fills.filter(x => classify(x.ticker) === series);
  const s = settlements.filter(x => classify(x.ticker) === series);
  const marketSet = new Set([...f, ...s].map(x => x.ticker));
  const fillIds = new Set();
  const issues = [];
  let fees = 0;
  let quantity = 0;
  let notional = 0;
  let knownFeeCount = 0;
  let knownNotionalCount = 0;
  const sides = {};
  for (const x of f) {
    if (!x.fill_id) issues.push({ticker:x.ticker, issue:'MISSING_FILL_ID'});
    else if (fillIds.has(x.fill_id)) issues.push({ticker:x.ticker, issue:'DUPLICATE_FILL_ID'});
    else fillIds.add(x.fill_id);
    const side = x.outcome_side ?? x.side;
    const key = `${x.action ?? 'missing'}:${side ?? 'missing'}`;
    sides[key] = (sides[key] || 0) + 1;
    const qty = validNumber(x.count_fp);
    if (qty === null || qty <= 0) issues.push({ticker:x.ticker, issue:'INVALID_FILL_QUANTITY'});
    else {
      quantity += qty;
      const price = validNumber(side === 'yes' ? x.yes_price_dollars : x.no_price_dollars);
      if (price !== null && price >= 0 && price <= 1) {
        notional += qty * price;
        knownNotionalCount++;
      } else issues.push({ticker:x.ticker, issue:'MISSING_OR_INVALID_PRICE'});
    }
    const fee = validNumber(x.fee_cost);
    if (fee === null || fee < 0) issues.push({ticker:x.ticker, issue:'MISSING_OR_INVALID_FILL_FEE'});
    else { fees += fee; knownFeeCount++; }
  }
  const settlementResults = {};
  for (const x of s) {
    const result = x.market_result ?? 'missing';
    settlementResults[result] = (settlementResults[result] || 0) + 1;
  }
  const settledTickers = new Set(s.map(x => x.ticker));
  const fillTickers = new Set(f.map(x => x.ticker));
  return {
    series,
    fills: f.length,
    settlements: s.length,
    uniqueMarkets: marketSet.size,
    fillMarketsWithoutSettlementRecord: [...fillTickers].filter(x => !settledTickers.has(x)).length,
    settlementMarketsWithoutFillRecord: [...settledTickers].filter(x => !fillTickers.has(x)).length,
    fillPatterns: sides,
    settlementResults,
    totalFilledContractsAcrossTransactions: round(quantity),
    totalExecutedNotionalUsd: knownNotionalCount === f.length ? round(notional) : null,
    observedFillFeesUsd: knownFeeCount === f.length ? round(fees) : null,
    dataQuality: { issues: issues.length, examples: issues.slice(0, 10) },
    pnl: {
      status: 'NOT_VERIFIED',
      realizedNetUsd: null,
      winRate: null,
      reason: 'Fill direction, position closure, settlement cash flows, and fee attribution are not yet reconciled. Notional and fill fees are not net profit.'
    }
  };
}

async function main() {
  console.log('=== KALSHI BTC/ETH READ-ONLY ACCOUNTING REPORT ===');
  const [fills, settlements] = await Promise.all([getAllFills(), getAllSettlements()]);
  if (!Array.isArray(fills) || !Array.isArray(settlements)) throw new Error('Invalid API response arrays');
  const report = {
    generatedAtUtc: new Date().toISOString(),
    scope: 'KXBTC15M and KXETH15M ticker prefixes only; account fills may include manual trading',
    sourceTotals: {fills: fills.length, settlements: settlements.length},
    markets: SERIES.map(s => summarize(s, fills, settlements)),
    exclusions: {
      otherMarketFills: fills.filter(x => !classify(x.ticker)).length,
      otherMarketSettlements: settlements.filter(x => !classify(x.ticker)).length
    },
    auditConclusion: 'HISTORICAL_NET_PNL_UNVERIFIED',
    nextEvidenceNeeded: 'Authoritative position-close and settlement cash-flow interpretation, plus bot order identifiers to distinguish bot trades from manual trades.'
  };
  console.log(JSON.stringify(report, null, 2));
  console.log('STATUS: READ_ONLY_INVENTORY_COMPLETE_PNL_UNVERIFIED');
}
main().catch(error => { console.error('AUDIT FAILED:', error.message); process.exitCode = 1; });
