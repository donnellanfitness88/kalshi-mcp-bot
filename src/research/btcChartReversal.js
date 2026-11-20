import { estimateMetalEntry } from './metalsObserver.js';

const barMs = 300000;
const maxGap = 1500;
const swingLookback = 6;
const paperBudget = 20;

export class FiveMinuteBars {
  constructor(savedBars = []) {
    this.closed = savedBars.slice(-24).map(bar => ({ ...bar }));
    this.current = null;
    // The feed can replay its in-memory ticks. Completed candles are immutable.
    this.lastTs = (this.closed.at(-1)?.end ?? -Infinity) - 1;
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

const scalpEntryCap = .31;
const scalpExitTarget = .60;
const scalpDelayMs = 1000;
const scalpEntryMs = 30000;
const scalpHoldMs = 240000;

export function wickRejectionSignal(bars) {
  if (bars.length < 7) return null;
  const window = bars.slice(-7);
  if (window.some((bar, i) => !bar.complete || (i && bar.start !== window[i - 1].end))) return null;
  const candle = window.at(-1);
  const prior = window.slice(0, -1);
  const high = Math.max(...prior.map(bar => bar.high));
  const low = Math.min(...prior.map(bar => bar.low));
  const bearish = candle.high > high && candle.close < high;
  const bullish = candle.low < low && candle.close > low;
  if (bearish === bullish) return null;
  return { confirmedAt: candle.end, side: bearish ? 'no' : 'yes',
    swingLevel: bearish ? high : low, referenceClose: candle.close };
}

export function wickScalpNeedsBook(scalp, now) {
  return !scalp.exit && (scalp.entry || now - scalp.confirmedAt <= scalpEntryMs);
}

export function observeWickRejectionScalp(scalp, book, bidSize, at, requestedAt, feeMultiplier) {
  if (scalp.exit || !book) return;
  if (!scalp.entry) {
    const ask = book[scalp.side]?.price;
    const age = at - scalp.confirmedAt;
    if (requestedAt < scalp.confirmedAt + scalpDelayMs || age > scalpEntryMs ||
        !(ask > 0 && ask <= scalpEntryCap)) return;
    const entry = estimateMetalEntry({ book, side: scalp.side,
      stage: { budget: paperBudget, minPrice: .001 }, feeMultiplier });
    if (entry) scalp.entry = { ...entry, at };
    return;
  }
  const bid = book[scalp.side + 'Bid'];
  const size = bidSize(scalp.side);
  const pending = scalp.pendingExit;
  if (pending) {
    if (requestedAt < pending.at + scalpDelayMs) return;
    const outcome = !Number.isFinite(bid) || bid <= 0 ? 'missing_bid' :
      bid < pending.limit ? 'bid_below_limit' :
      !Number.isFinite(size) || size < scalp.entry.count ? 'insufficient_size' : 'filled';
    (scalp.exitAttempts ??= []).push({ ...pending, checkedAt: at, delayMs: at - pending.at,
      observedBid: bid ?? null, observedSize: size ?? null, outcome });
    scalp.pendingExit = null;
    if (outcome === 'filled') {
      const count = scalp.entry.count;
      const estimatedFee = Math.ceil(7 * feeMultiplier * count * bid * (1 - bid) - 1e-9) / 100;
      scalp.exit = { at, bid, estimatedFee, reason: pending.reason,
        net: count * bid - estimatedFee - scalp.entry.estimatedCost };
    }
    return;
  }
  const timeExit = at - scalp.confirmedAt >= scalpHoldMs;
  if (Number.isFinite(bid) && bid > 0 && size >= scalp.entry.count && (timeExit || bid >= scalpExitTarget)) {
    scalp.pendingExit = { at, limit: timeExit ? bid : scalpExitTarget,
      reason: timeExit ? 'time' : 'target' };
  }
}

export function wickRejectionScalpOutcomes(row) {
  return Object.values(row.wickRejectionScalps ?? {}).map(scalp => {
    const entry = scalp.entry;
    return { ...scalp, result: row.result,
      closedBy: scalp.exit ? 'simulated_bid' : entry ? 'settlement' : 'no_entry',
      estimatedNet: !entry ? null : scalp.exit?.net ??
        (entry.side === row.result ? entry.count : 0) - entry.estimatedCost };
  });
}
