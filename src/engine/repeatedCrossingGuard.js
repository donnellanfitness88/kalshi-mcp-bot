const minimum = { EURUSD: 0.00030, USDJPY: 0.030, GOLD: 4, SILVER: 0.10 };

export function repeatedCrossingGuard(check, asset, side, target, close, now, history) {
  const buffer = minimum[asset];
  if (!check?.allowed || buffer === undefined) return check;
  const start = close - 180000;
  const latest = history?.at(-1);
  if (!Number.isFinite(close) || now < start || now >= close || !Number.isFinite(target) ||
      target <= 0 || !['yes', 'no'].includes(side) || !Number.isFinite(latest?.sourceAt) ||
      latest.sourceAt > now || now - latest.sourceAt > 2000 || !Number.isFinite(latest.price)) {
    return { ...check, allowed: false, reason: 'CROSSING_DATA_UNAVAILABLE' };
  }

  let crossings = 0;
  let previousSign = 0;
  let previousTime;
  let complete = true;
  // Source updates are ordered and deduplicated at ingestion. A pre-window
  // sample establishes coverage only; both sides of a flip must be in-window.
  for (const point of history) {
    if (point.sourceAt < start) {
      previousTime = point.sourceAt;
      continue;
    }
    if (point.sourceAt > (previousTime === undefined ? start : Math.max(start, previousTime)) + 2500 ||
        (previousTime === undefined && point.sourceAt !== start))
      complete = false;
    previousTime = point.sourceAt;
    const sign = Math.sign(point.price - target);
    if (sign === 0) continue;
    if (previousSign && previousSign !== sign) crossings++;
    previousSign = sign;
  }
  const cushion = (side === 'yes' ? 1 : -1) * (latest.price - target);
  const required = crossings >= 2 || !complete;
  const tolerance = 4 * Number.EPSILON * Math.max(target, latest.price);
  const allowed = !required || cushion + tolerance >= buffer;
  return { ...check, allowed, reason: allowed ? check.reason : 'REPEATED_CROSSING_BUFFER',
    targetCrossings: crossings, crossingHistoryComplete: complete, crossingBufferRequired: required,
    crossingMinimum: buffer, crossingSignedCushion: cushion };
}
