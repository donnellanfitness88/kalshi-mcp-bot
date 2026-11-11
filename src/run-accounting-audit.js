
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
    console.log('Market fill count:', related.length);
    console.log('Buy/sell totals:', summary);
    console.log(
      'Earliest fill:',
      related.map(f => f.created_time || f.ts)
        .sort()[0]
    );
  }
```

Commit and rerun the audit. It may still show a red X, but this time the logs will contain the buy/sell totals for the problematic market.

Send me the **UNMATCHED MARKET** section.

That will help determine whether we're missing purchase records or whether our matching logic needs to account for a different transaction structure. <MemoryCite />
  // The current reconciler does not isolate
  // individual subaccounts.
  const subaccounts = new Set(
    fills.map(f => f.subaccount_number ?? 0)
  );

  if (subaccounts.size > 1) {
    console.log(
      'STATUS: MULTIPLE_SUBACCOUNTS_UNSUPPORTED'
    );
    return;
  }

  // Settlements do not expose subaccount_number
  // in the previously inspected response.
  // Their account scope must be verified separately.
  if (subaccounts.size === 1 &&
      !subaccounts.has(0)) {
    console.log(
      'STATUS: SETTLEMENT_ACCOUNT_SCOPE_UNVERIFIED'
    );
    return;
  }

  const report = auditAccounting(
    fills,
    settlements
  );

  console.log('=== AUDIT SUMMARY ===');
  console.log('Status:', report.status);
  console.log('Matched sales:', report.fillSales);
  console.log(
    'Settlements checked:',
    report.settlementsChecked
  );
  console.log('Quantity checks:', report.checks.length);
  console.log('Issues:', report.issues.length);
  console.log(
    'Unresolved positions:',
    report.unresolved.length
  );

  const issueTypes = {};

  for (const issue of report.issues) {
    issueTypes[issue.reason] =
      (issueTypes[issue.reason] || 0) + 1;
  }

  console.log('Issue categories:', issueTypes);

  console.log(
    'NOTE: Quantity audit only. P&L not verified.'
  );
}

main().catch(error => {
  console.error('AUDIT FAILED:', error.message);
  process.exitCode = 1;
});
