
import {
  getFillPage,
  getSettlementPage
} from './client.js';

function describe(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'number' || type === 'string') {
    return `${type}: ${value}`;
  }

  return type;
}

async function inspect() {
  const fills = await getFillPage({ limit: 1 });
  const settlements = await getSettlementPage({ limit: 1 });

  const fill = fills.fills[0];
  const settlement = settlements.settlements[0];

  console.log('=== FILL MONETARY FIELDS ===');

  if (fill) {
    for (const key of [
      'count_fp',
      'yes_price_dollars',
      'no_price_dollars',
      'fee_cost'
    ]) {
      console.log(`${key}: ${describe(fill[key])}`);
    }
  } else {
    console.log('No fills available');
  }

  console.log('=== SETTLEMENT MONETARY FIELDS ===');

  if (settlement) {
    for (const key of [
      'yes_count_fp',
      'no_count_fp',
      'yes_total_cost_dollars',
      'no_total_cost_dollars',
      'revenue',
      'fee_cost',
      'value'
    ]) {
      console.log(`${key}: ${describe(settlement[key])}`);
    }
  } else {
    console.log('No settlements available');
  }
}

await inspect();
