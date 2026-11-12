import { normalizeFill } from './normalize-fills.js';
import {
  getAllFills,
  getAllSettlements
} from './kalshi/client.js';

import {
  auditAccounting
} from './combined-accounting.js';

function printCounts(label, items) {
  console.log(`${label}: ${items.length}`);
}

async function main() {
  console.log('=== KALSHI READ-ONLY AUDIT ===');

  const fills = await getAllFills();
  const settlements = await getAllSettlements();

  printCounts('Total fills', fills);
  printCounts('Total settlements', settlements);

  const patterns = {};

  for (const f of fills) {
    const key = [
      f.action ?? 'missing',
      f.outcome_side ?? f.side ?? 'missing',
      f.book_side ?? 'missing'
    ].join(' / ');

    patterns[key] ??= {
      fills: 0,
      contracts: 0
    };

    patterns[key].fills++;
    patterns[key].contracts += Number(f.count_fp || 0);
  }

  console.log('=== FILL PATTERNS ===');
  console.log(JSON.stringify(patterns, null, 2));

  const exposure = {
    yes: { fills: 0, contracts: 0 },
    no: { fills: 0, contracts: 0 },
    unknown: { fills: 0, contracts: 0 }
  };

  for (const f of fills) {
    const side = f.outcome_side || f.side;

    let direction = 'unknown';

    if (
      (f.action === 'buy' && side === 'yes') ||
      (f.action === 'sell' && side === 'no')
    ) {
      direction = 'yes';
    }

    if (
      (f.action === 'buy' && side === 'no') ||
      (f.action === 'sell' && side === 'yes')
    ) {
      direction = 'no';
    }

    exposure[direction].fills++;
    exposure[direction].contracts +=
      Number(f.count_fp || 0);
  }

  console.log('=== ECONOMIC DIRECTION ===');
  console.log(JSON.stringify(exposure, null, 2));

  const target = fills.find(f =>
    f.ticker?.startsWith(
      'KXMVECROSSCATEGORY0-SHARD1-S202651C95801F1E-DB7CBCC8ECC'
    )
  );

  if (target) {
    const related = fills.filter(
      f => f.ticker === target.ticker
    );

    const summary = {};

    for (const f of related) {
      const key =
        `${f.action}:${f.outcome_side || f.side}`;

      summary[key] ??= {
        fills: 0,
        contracts: 0
      };

      summary[key].fills++;
      summary[key].contracts += Number(f.count_fp);
    }

    console.log('=== UNMATCHED MARKET ===');
    
    for (const f of related) {
      console.log('FILL DETAIL:', {
        time: f.created_time || f.ts,
        action: f.action,
        side: f.outcome_side || f.side,
        book_side: f.book_side,
        quantity: f.count_fp,
        yes_price: f.yes_price_dollars,
        no_price: f.no_price_dollars,
        fee: f.fee_cost
      });
    }

    console.log('Market fill count:', related.length);
    console.log('Buy/sell totals:', summary);
    console.log(
      'Earliest fill:',
      related.map(f => f.created_time || f.ts)
        .sort()[0]
    );
  }

  // Check subaccount scope before reconciliation.
  const subaccounts = new Set(
    fills.map(f => f.subaccount_number ?? 0)
  );

  if (subaccounts.size > 1) {
    console.log(
      'STATUS: MULTIPLE_SUBACCOUNTS_UNSUPPORTED'
    );
    return;
  }

  if (
    subaccounts.size === 1 &&
    !subaccounts.has(0)
  ) {
    console.log(
      'STATUS: SETTLEMENT_ACCOUNT_SCOPE_UNVERIFIED'
    );
    return;
  }

  const report = auditAccounting(fills, settlements);

  console.log('=== AUDIT SUMMARY ===');
  console.log('Status:', report.status);
  console.log('Matched sales:', report.fillSales);
  console.log('Settlements checked:', report.settlementsChecked);
  console.log('Quantity checks:', report.checks.length);
  console.log('Issues:', report.issues.length);
  console.log('Unresolved positions:', report.unresolved.length);
}

main().catch(error => {
  console.error('AUDIT FAILED:', error.message);
  process.exitCode = 1;
});
