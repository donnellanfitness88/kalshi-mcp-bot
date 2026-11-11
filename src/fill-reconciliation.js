
import { getAllFills } from './kalshi/client.js';

function decimal(value, field) {
  if (
    (typeof value !== 'string' &&
      typeof value !== 'number') ||
    value === '' ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return Number(value);
}

export function reconcileFills(fills) {
  if (!Array.isArray(fills)) {
    throw new Error('Fills must be an array');
  }

  const unique = new Map();

  for (const fill of fills) {
    if (!fill.fill_id) {
      throw new Error('Fill missing fill_id');
    }
    if (unique.has(fill.fill_id)) {
      throw new Error(`Duplicate fill_id: ${fill.fill_id}`);
    }
    unique.set(fill.fill_id, fill);
  }

  const ordered = [...unique.values()].map(fill => {
    const timestamp = Date.parse(
      fill.created_time || fill.ts
    );

    if (!Number.isFinite(timestamp)) {
      throw new Error('Invalid fill timestamp');
    }

    return { fill, timestamp };
  }).sort((a, b) => a.timestamp - b.timestamp);

  const positions = new Map();
  const results = [];

  for (const { fill } of ordered) {
    const side = fill.outcome_side || fill.side;

    if (!['yes', 'no'].includes(side)) {
      throw new Error('Invalid contract side');
    }
    if (!fill.ticker) {
      throw new Error('Missing ticker');
    }

    const action = fill.action;
    const count = decimal(fill.count_fp, 'count_fp');

    if (count <= 0) {
      throw new Error('Invalid contract quantity');
    }

    const price = decimal(
      side === 'yes'
        ? fill.yes_price_dollars
        : fill.no_price_dollars,
      'price'
    );

    const fee = decimal(fill.fee_cost, 'fee_cost');
    const key = `${fill.ticker}:${side}`;

    const p = positions.get(key) || {
      count: 0,
      cost: 0,
      fees: 0
    };

    if (action === 'buy') {
      p.count += count;
      p.cost += count * price;
      p.fees += fee;
    } else if (action === 'sell') {
      if (count > p.count + 1e-9) {
        throw new Error(`Unmatched sell: ${key}`);
      }

      const fraction = count / p.count;
      const cost = p.cost * fraction;
      const entryFee = p.fees * fraction;
      const proceeds = count * price;

      const pnl = proceeds - cost - entryFee - fee;

      p.count -= count;
      p.cost -= cost;
      p.fees -= entryFee;

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

export async function runFillReport() {
  const fills = await getAllFills();
  return reconcileFills(fills);
}
