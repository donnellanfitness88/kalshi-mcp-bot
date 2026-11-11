
import { getAllFills } from './kalshi/client.js';

function decimal(value, field) {
  if (typeof value !== 'string' &&
      typeof value !== 'number') {
    throw new Error(`Missing ${field}`);
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return n;
}

function reconcile(fills) {
  const unique = new Map();

  for (const fill of fills) {
    if (!fill.fill_id) {
      throw new Error('Fill missing fill_id');
    }
    unique.set(fill.fill_id, fill);
  }

  const ordered = [...unique.values()].sort(
    (a, b) =>
      Date.parse(a.created_time || a.ts) -
      Date.parse(b.created_time || b.ts)
  );

  const positions = new Map();
  const results = [];

  for (const fill of ordered) {
    const side = fill.side || fill.outcome_side;
    const key = `${fill.ticker}:${side}`;
    const action = fill.action;
    const count = decimal(fill.count_fp, 'count_fp');
    const price = decimal(
      side === 'yes'
        ? fill.yes_price_dollars
        : fill.no_price_dollars,
      'price'
    );
    const fee = decimal(fill.fee_cost, 'fee_cost');

    const p = positions.get(key) || {
      count: 0,
      cost: 0,
      fees: 0,
      realized: 0
    };

    if (action === 'buy') {
      p.count += count;
      p.cost += count * price;
      p.fees += fee;
    } else if (action === 'sell') {
      if (count > p.count + 1e-9) {
        results.push({
          ticker: fill.ticker,
          side,
          status: 'UNMATCHED_SELL'
        });
        continue;
      }

      const fraction = count / p.count;
      const cost = p.cost * fraction;
      const entryFee = p.fees * fraction;
      const proceeds = count * price;

      const pnl = proceeds - cost - entryFee - fee;

      p.count -= count;
      p.cost -= cost;
      p.fees -= entryFee;
      p.realized += pnl;

      results.push({
        ticker: fill.ticker,
        side,
        count,
        pnl: Number(pnl.toFixed(6)),
        status: 'MATCHED_FILL'
      });
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    positions.set(key, p);
  }

  return { results, positions };
}

const fills = await getAllFills();
const report = reconcile(fills);

console.log('=== MATCHED SELL RESULTS ===');

for (const result of report.results) {
  console.log(result);
}

console.log('=== REMAINING POSITIONS ===');

for (const [key, position] of report.positions) {
  if (position.count > 0.000001) {
    console.log(key, {
      count: position.count,
      remainingCost: position.cost,
      remainingEntryFees: position.fees
    });
  }
}
