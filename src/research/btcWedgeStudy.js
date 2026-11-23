// Research only. Runs on closed CF Benchmarks candles.
const FIVE_MINUTES_MS = 300000;
export const BTC_WEDGE_RULES = Object.freeze({
  minBars: 12, maxBars: 20, minTouchesPerLine: 3,
  maxWidthRatio: 0.80, minWidthRatio: 0.15,
  minBufferUsd: 5, bufferRangeFraction: 0.10,
  minBodyFraction: 0.35, failureBars: 4,
});

function contiguous(bars) {
  return bars.every((bar, i) => bar.complete && bar.end - bar.start === FIVE_MINUTES_MS &&
    (!i || bar.start === bars[i - 1].end));
}

function fit(points) {
  const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const my = points.reduce((sum, p) => sum + p.price, 0) / points.length;
  const slope = points.reduce((sum, p) => sum + (p.x - mx) * (p.price - my), 0) /
    points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
  return { slope, intercept: my - slope * mx };
}

const levelAt = (line, x) => line.intercept + line.slope * x;
const barIndex = (setup, bar) => (bar.end - setup.firstEnd) / FIVE_MINUTES_MS;

function findWedge(bars) {
  const r = BTC_WEDGE_RULES;
  const highs = [], lows = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const { high, low } = bars[i];
    if (high > bars[i - 1].high && high > bars[i + 1].high) highs.push({ x: i, price: high });
    if (low < bars[i - 1].low && low < bars[i + 1].low) lows.push({ x: i, price: low });
  }
  if (Math.min(highs.length, lows.length) < r.minTouchesPerLine) return null;
  const upper = fit(highs), lower = fit(lows);
  if (Math.sign(upper.slope) !== Math.sign(lower.slope) || upper.slope === 0 || lower.slope <= upper.slope) return null;
  const width = upper.intercept - lower.intercept;
  const lastX = bars.length - 1;
  const ratio = (levelAt(upper, lastX) - levelAt(lower, lastX)) / width;
  if (width <= 0 || ratio < r.minWidthRatio || ratio > r.maxWidthRatio ||
      levelAt(upper, lastX + 1) <= levelAt(lower, lastX + 1)) return null;
  const meanRange = bars.reduce((sum, bar) => sum + bar.high - bar.low, 0) / bars.length;
  const buffer = Math.max(r.minBufferUsd, meanRange * r.bufferRangeFraction);
  const upperTouches = highs.filter(p => Math.abs(p.price - levelAt(upper, p.x)) <= buffer);
  const lowerTouches = lows.filter(p => Math.abs(p.price - levelAt(lower, p.x)) <= buffer);
  if (Math.min(upperTouches.length, lowerTouches.length) < r.minTouchesPerLine ||
      bars.some((bar, i) => bar.high > levelAt(upper, i) + buffer ||
        bar.low < levelAt(lower, i) - buffer)) return null;
  const touches = [...upperTouches.map(p => ({ ...p, side: 'upper' })),
    ...lowerTouches.map(p => ({ ...p, side: 'lower' }))].sort((a, b) => a.x - b.x);
  const changes = touches.filter((p, i) => i && p.x > touches[i - 1].x &&
    p.side !== touches[i - 1].side).length;
  if (changes < 4) return null;
  return { pattern: upper.slope < 0 ? 'falling_wedge' : 'rising_wedge',
    firstEnd: bars[0].end, formationEndsAt: bars.at(-1).end,
    bars: bars.length, upper, lower, buffer, widthRatio: ratio,
    upperTouches: upperTouches.length, lowerTouches: lowerTouches.length };
}

function hasMomentum(bar, previous, direction) {
  const body = direction * (bar.close - bar.open);
  return body > 0 && body >= BTC_WEDGE_RULES.minBodyFraction * (bar.high - bar.low) &&
    direction * (bar.close - previous.close) > 0;
}

export function advanceBtcWedge(bars, previous = {}) {
  const bar = bars.at(-1), prior = bars.at(-2);
  if (!bar || bar.end <= (previous.lastEnd ?? 0)) return null;
  const state = { ...previous, lastEnd: bar.end, active: null };
  if (!prior || !contiguous([prior, bar])) return { state };
  const active = previous.active;
  if (active && previous.lastEnd === prior.end &&
      bar.end - active.brokenAt <= BTC_WEDGE_RULES.failureBars * FIVE_MINUTES_MS) {
    const { setup, direction, reclaim } = active;
    const boundary = levelAt(direction > 0 ? setup.upper : setup.lower, barIndex(setup, bar));
    if (reclaim && -direction * (bar.close - reclaim.level) >= setup.buffer &&
        -direction * (bar.close - boundary) >= setup.buffer && hasMomentum(bar, prior, -direction)) {
      return { state, signal: { pattern: setup.pattern,
        kind: direction > 0 ? 'failed_bullish_breakout_bearish_retest' : 'failed_bearish_breakdown_bullish_reversal',
        direction: direction > 0 ? 'down' : 'up', at: bar.end, close: bar.close,
        boundary, brokenAt: active.brokenAt, reclaimAt: reclaim.at, setup } };
    }
    if (direction * (bar.close - boundary) >= setup.buffer) {
      state.active = { ...active, reclaim: null };
    } else if (!reclaim && -direction * (bar.close - boundary) >= setup.buffer) {
      state.active = { ...active, reclaim: { at: bar.end, level: direction > 0 ? bar.low : bar.high } };
    } else {
      state.active = active;
    }
    return { state };
  }
  const r = BTC_WEDGE_RULES;
  for (let size = Math.min(r.maxBars, bars.length - 1); size >= r.minBars; size--) {
    const formation = bars.slice(-size - 1, -1);
    if (!contiguous(formation)) break;
    const setup = findWedge(formation);
    if (!setup) continue;
    const direction = setup.pattern === 'falling_wedge' ? 1 : -1;
    const line = direction > 0 ? setup.upper : setup.lower;
    const boundary = levelAt(line, barIndex(setup, bar));
    if (direction * (bar.close - boundary) < setup.buffer ||
        direction * (prior.close - levelAt(line, barIndex(setup, prior))) >= setup.buffer ||
        !hasMomentum(bar, prior, direction)) continue;
    state.active = { setup, direction, brokenAt: bar.end, reclaim: null };
    return { state, signal: { pattern: setup.pattern,
      kind: direction > 0 ? 'bullish_breakout' : 'bearish_breakdown',
      direction: direction > 0 ? 'up' : 'down', at: bar.end, close: bar.close, boundary, setup } };
  }
  return { state };
}
