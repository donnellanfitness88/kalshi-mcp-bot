import { BENCHMARK_MAX_AGE_MS } from '../prices/cfBenchmarks.js';

export const LATE_MIN_DISTANCE_USD = {
  BTC: { under_180: 30, under_150: 30, under_120: 30, under_60: 30, under_45: 30, under_45_extra: 30 },
  ETH: { under_180: 1, under_120: 0.75, under_60: 0.50 }
};

export function evaluateLateProximity({ asset, ticker, stageId, side, target, quote, now = Date.now() }) {
  const minimumDistance = LATE_MIN_DISTANCE_USD[asset]?.[stageId];
  const detail = { asset, ticker, stageId, side, target, minimumDistance, checkedAt: now };
  const reject = reason => ({ ...detail, allowed: false, reason });
  if (!Number.isFinite(minimumDistance) || !['yes', 'no'].includes(side) ||
      !Number.isFinite(target) || target <= 0) return reject('PROXIMITY_TARGET_UNAVAILABLE');
  if (!quote || quote.source !== 'CF_BENCHMARKS' || !Number.isFinite(quote.price) || quote.price <= 0 ||
      !Number.isSafeInteger(quote.sourceTs) || !Number.isSafeInteger(quote.receivedAt) ||
      quote.sourceTs > now || quote.receivedAt > now ||
      now - quote.sourceTs > BENCHMARK_MAX_AGE_MS || now - quote.receivedAt > BENCHMARK_MAX_AGE_MS) {
    return reject('PROXIMITY_REFERENCE_STALE');
  }
  const distance = side === 'yes' ? quote.price - target : target - quote.price;
  return { ...detail, referencePrice: quote.price, source: quote.source,
    sourceTs: quote.sourceTs, referenceAgeMs: now - quote.sourceTs,
    distance, allowed: distance + 1e-9 >= minimumDistance,
    reason: distance + 1e-9 >= minimumDistance ? 'PROXIMITY_OK' : 'PROXIMITY_TOO_CLOSE' };
}
