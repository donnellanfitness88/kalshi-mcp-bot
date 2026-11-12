
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
