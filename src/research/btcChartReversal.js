import { estimateMetalEntry } from './metalsObserver.js';

const barMs = 300000;
const maxGap = 1500;
const swingLookback = 6;
const paperBudget = 20;

export class FiveMinuteBars {
  constructor() {
    this.closed = [];
    this.current = null;
    this.lastTs = -Infinity;
  }

  ingest(history, now) {
    for (const { sourceTs, price } of history) {
      if (!Number.isFinite(sourceTs) || sourceTs <= this.lastTs || sourceTs > now ||
          !Number.isFinite(price) || price <= 0) continue;
      const start = Math.floor(sourceTs / barMs) * barMs;
      if (this.current?.start !== start) {
        const bar = this.current;
        if (bar) {
          bar.complete = bar.complete && bar.start + barMs - this.lastTs <= maxGap;
          this.closed.push(bar);
          this.closed = this.closed.slice(-24);
        }
        this.current = { start, end: start + barMs, open: price, high: price,
          low: price, close: price, complete: sourceTs - start <= maxGap };
      } else {
        const bar = this.current;
        bar.complete = bar.complete && sourceTs - this.lastTs <= maxGap;
        bar.high = Math.max(bar.high, price);
        bar.low = Math.min(bar.low, price);
        bar.close = price;
      }
      this.lastTs = sourceTs;
    }
    return this.closed;
  }
}

export function chartReversal(bars) {
  if (bars.length < swingLookback + 5) return null;
  const setup = bars.slice(-(swingLookback + 5));
  if (setup.some((bar, i) => !bar.complete || (i && bar.start !== setup[i - 1].end))) return null;
  const confirm = setup.at(-1);
  // Freeze the rule: rejection up to two bars before confirmation, or on it.
  for (let offset = 0; offset <= 2; offset++) {
    const rejectionIndex = setup.length - 1 - offset;
    const rejection = setup[rejectionIndex];
    const prior = setup.slice(rejectionIndex - swingLookback, rejectionIndex);
    const swingHigh = Math.max(...prior.map(bar => bar.high));
    const swingLow = Math.min(...prior.map(bar => bar.low));
    const bearish = rejection.high > swingHigh && rejection.close < swingHigh;
    const bullish = rejection.low < swingLow && rejection.close > swingLow;
    if (bearish === bullish) continue;
    const side = bearish ? 'no' : 'yes';
    const drive = setup.slice(rejectionIndex - 3, rejectionIndex).findLast(bar =>
      bearish ? bar.close > bar.open : bar.close < bar.open);
    if (!drive) continue;
    const previous = setup.at(-2);
    if (bearish ? !(previous.close >= drive.open && confirm.close < drive.open) :
        !(previous.close <= drive.open && confirm.close > drive.open)) continue;
    for (let j = rejectionIndex - 1; j >= 2; j--) {
      const first = setup[j - 2], third = setup[j];
      const edge = bearish ? first.high : first.low;
      if (bearish ? third.low <= edge : third.high >= edge) continue;
      const crossed = setup.slice(j + 1, -1).some(bar =>
        bearish ? bar.close < edge : bar.close > edge);
      if (crossed || (bearish ? confirm.close >= edge : confirm.close <= edge)) continue;
      return { side, confirmedAt: confirm.end, rejectionAt: rejection.end,
        swingLevel: bearish ? swingHigh : swingLow, gapEdge: edge,
        cisdLevel: drive.open, referenceClose: confirm.close };
    }
  }
  return null;
}

export function captureChartEntry(row, book, at, requestedAt) {
  const chart = row.chartReversal;
  if (!chart || chart.entry || !book || requestedAt < chart.confirmedAt ||
      at - requestedAt > 2000 || at - chart.confirmedAt > 30000 ||
      at >= Date.parse(row.closeTime)) return false;
  const plan = estimateMetalEntry({ book, side: chart.side,
    stage: { budget: paperBudget, minPrice: .001 }, feeMultiplier: row.feeMultiplier });
  if (!plan) return false;
  chart.entry = { ...plan, at, secondsRemaining: (Date.parse(row.closeTime) - at) / 1000 };
  return true;
}

export function chartOutcome(row) {
  const chart = row.chartReversal;
  if (!chart) return null;
  const entry = chart.entry;
  return { ...chart, result: row.result, estimatedNet: entry ?
    (entry.side === row.result ? entry.count : 0) - entry.estimatedCost : null };
}
