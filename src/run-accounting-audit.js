
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
