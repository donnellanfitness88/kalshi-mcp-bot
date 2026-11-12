
/**
 * Read-only BTC/ETH settlement reconciliation diagnostics.
 * Does not place orders or change trading settings.
 * Outputs candidate P&L only, never labels it verified.
 */
import { getAllFills, getAllSettlements } from './kalshi/client.js';

const SERIES = ['KXBTC15M', 'KXETH15M'];

const num = v =>
  v === null || v === undefined || v === ''
    ? null
    : Number.isFinite(Number(v))
      ? Number(v)
      : null;

const round = v => Math.round(v * 1e6) / 1e6;

const seriesOf = t =>
  SERIES.find(s =>
    typeof t === 'string' && t.startsWith(s + '-')
  );

const EPS = 0.0001;

function reconcile(ticker, fills, settlement) {
  const problems = [];
  const seen = new Set();

  let cash = 0;
  let fillFees = 0;
  let yes = 0;
  let no = 0;

  const orderIds = new Set();

  const counts = {
    buyYes: 0,
    buyNo: 0,
    sellYes: 0,
    sellNo: 0
  };

  for (const f of fills) {
    if (!f.fill_id || seen.has(f.fill_id)) {
      problems.push('MISSING_OR_DUPLICATE_FILL_ID');
    }

    if (f.fill_id) seen.add(f.fill_id);
    if (f.order_id) orderIds.add(f.order_id);

    const side = f.outcome_side ?? f.side;
    const action = f.action;
    const q = num(f.count_fp);

    const p = num(
      side === 'yes'
        ? f.yes_price_dollars
        : f.no_price_dollars
    );

    const fee = num(f.fee_cost);

    if (
      !['yes', 'no'].includes(side) ||
      !['buy', 'sell'].includes(action) ||
      q === null ||
      q <= 0 ||
      p === null ||
      p < 0 ||
      p > 1 ||
      fee === null ||
      fee < 0
    ) {
      problems.push('INVALID_FILL_FIELD');
      continue;
    }

    const sign = action === 'buy' ? 1 : -1;

    cash -= sign * q * p;

    if (side === 'yes') {
      yes += sign * q;
    } else {
      no += sign * q;
    }

    fillFees += fee;

    counts[
      action + (side === 'yes' ? 'Yes' : 'No')
    ]++;
  }

  if (!settlement) {
    problems.push('MISSING_SETTLEMENT');
  }

  const result = settlement?.market_result;

  if (
    settlement &&
    !['yes', 'no', 'void'].includes(result)
  ) {
    problems.push('UNSUPPORTED_RESULT');
  }

  const settledYes = num(settlement?.yes_count_fp);
  const settledNo = num(settlement?.no_count_fp);

  if (
    settlement &&
    (settledYes === null || settledNo === null)
  ) {
    problems.push('SETTLEMENT_COUNTS_MISSING');
  }

  const countsMatch =
    settledYes !== null &&
    settledNo !== null &&
    Math.abs(yes - settledYes) < EPS &&
    Math.abs(no - settledNo) < EPS;

  if (settlement && !countsMatch) {
    problems.push('FILL_SETTLEMENT_POSITION_MISMATCH');
  }

  const payoutFromNetPosition =
    result === 'yes'
      ? yes
      : result === 'no'
        ? no
        : null;

  const candidate =
    payoutFromNetPosition === null
      ? null
      : cash + payoutFromNetPosition - fillFees;

  const revenue = num(settlement?.revenue);
  const settlementFee = num(settlement?.fee_cost);

  const yesCost = num(
    settlement?.yes_total_cost_dollars
  );

  const noCost = num(
    settlement?.no_total_cost_dollars
  );

  return {
    ticker,
    fills: fills.length,
    ordersWithId: orderIds.size,
    fillPatterns: counts,
    result,

    netPositionFromFills: {
      yes: round(yes),
      no: round(no)
    },

    settlementPosition: {
      yes: settledYes,
      no: settledNo
    },

    countsMatch,

    settlementFields: {
      revenueRaw: revenue,
      feeCostRaw: settlementFee,
      yesTotalCostDollars: yesCost,
      noTotalCostDollars: noCost
    },

    fillFeesUsd: round(fillFees),

    candidateNetUsd:
      candidate === null ? null : round(candidate),

    problems: [...new Set(problems)]
  };
}

async function main() {
  console.log(
    '=== KALSHI BTC/ETH RECONCILIATION DIAGNOSTICS ==='
  );

  const [fills, settlements] = await Promise.all([
    getAllFills(),
    getAllSettlements()
  ]);

  const output = [];

  for (const series of SERIES) {
    const selected = fills.filter(
      f => seriesOf(f.ticker) === series
    );

    const settled = settlements.filter(
      s => seriesOf(s.ticker) === series
    );

    const byTicker = new Map();

    for (const f of selected) {
      if (!byTicker.has(f.ticker)) {
        byTicker.set(f.ticker, []);
      }

      byTicker.get(f.ticker).push(f);
    }

    const settlementByTicker = new Map();

    for (const s of settled) {
      if (settlementByTicker.has(s.ticker)) {
        throw new Error(
          'Duplicate settlement for ' + s.ticker
        );
      }

      settlementByTicker.set(s.ticker, s);
    }

    const tickers = new Set([
      ...byTicker.keys(),
      ...settlementByTicker.keys()
    ]);

    const rows = [...tickers].map(t =>
      reconcile(
        t,
        byTicker.get(t) || [],
        settlementByTicker.get(t)
      )
    );

    const reasons = {};

    for (const row of rows) {
      for (const reason of row.problems) {
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
    }

    const matched = rows.filter(
      r => r.countsMatch && r.problems.length === 0
    );

    output.push({
      series,
      fills: selected.length,
      settlementRecords: settled.length,
      markets: rows.length,

      exactPositionMatches: matched.length,

      mismatchReasons: reasons,

      knownFillFeesUsd: round(
        rows.reduce(
          (a, r) => a + r.fillFeesUsd,
          0
        )
      ),

      candidatePnlForMatchedMarketsUsd: round(
        matched.reduce(
          (a, r) => a + (r.candidateNetUsd || 0),
          0
        )
      ),

      candidatePnlStatus:
        'DIAGNOSTIC_ONLY_NOT_VERIFIED',

      examples: rows
        .filter(r => r.problems.length)
        .slice(0, 5),

      matchedExamples: matched.slice(0, 2)
    });
  }

  console.log(
    JSON.stringify(
      {
        generatedAtUtc: new Date().toISOString(),

        sourceTotals: {
          fills: fills.length,
          settlements: settlements.length
        },

        markets: output,

        netPnlVerified: false,
        winRateVerified: false,

        warning:
          'Do not interpret candidate P&L as actual account profit. Short-side settlement semantics, settlement fees, and bot/manual attribution remain unverified.'
      },
      null,
      2
    )
  );

  console.log(
    'STATUS: RECONCILIATION_DIAGNOSTICS_COMPLETE_PNL_UNVERIFIED'
  );
}

main().catch(e => {
  console.error('AUDIT FAILED:', e.message);
  process.exitCode = 1;
});
