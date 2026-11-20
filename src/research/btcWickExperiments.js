import { estimateMetalEntry } from './metalsObserver.js';

const paperBudget = 20;
const fee = (count, price, multiplier) =>
  Math.ceil(7 * multiplier * count * price * (1 - price) - 1e-9) / 100;

// Sample the last available reference update in each completed second.
export function settlementDistance(history, at, close, target, side) {
  const start = close - 60000;
  const elapsed = Math.floor((at - start) / 1000);
  if (elapsed < 15 || elapsed >= 60) return null;
  const seconds = new Map();
  for (const point of history) {
    const second = Math.floor((point.sourceTs - start) / 1000);
    if (second >= 0 && second < elapsed) seconds.set(second, point.price);
  }
  const last = history.at(-1);
  if (seconds.size !== elapsed || !last || at - last.sourceTs > 2000) return null;
  const signed = side === 'yes' ? 1 : -1;
  const locked = [...seconds.values()].reduce((sum, price) => sum + price - target, 0);
  const flipAverage = target - locked / (60 - elapsed);
  return { elapsed, flipAverage, adverseMove: signed * (last.price - flipAverage) };
}

export function observeSettlementDefense(row, history) {
  if (row.defense) return;
  const entry = row.defenseStudy?.wickStudy?.plans?.[5];
  if (!entry) return;
  const measurement = settlementDistance(history, entry.at, Date.parse(row.closeTime), row.target, entry.side);
  const range = history.length ? Math.max(...history.map(p => p.price)) -
    Math.min(...history.map(p => p.price)) : null;
  const remaining = 60 - (measurement?.elapsed ?? 60);
  const stress = range == null ? null : range * Math.sqrt(remaining / 60);
  const verdict = !measurement || !(stress > 0) ? 'unavailable' :
    measurement.adverseMove >= stress ? 'pass' : 'block';
  row.defense = { side: entry.side, at: entry.at, verdict, measurement, stress };
}

function spikeSignal(history, trades, at) {
  const last = history.at(-1);
  if (!last || at - last.sourceTs > 2000) return null;
  const point = seconds => history.findLast(p => p.sourceTs <= last.sourceTs - seconds * 1000 &&
    p.sourceTs >= last.sourceTs - seconds * 1000 - 500);
  const one = point(1), three = point(3), six = point(6);
  if (!one || !three || !six) return null;
  const move = last.price - three.price;
  const sign = Math.sign(move);
  if (Math.abs(move) < 5 || Math.abs(move) <= Math.abs(three.price - six.price) ||
      sign * (last.price - one.price) < 0) return null;
  const volumes = { yes: 0, no: 0 };
  let count = 0;
  for (const trade of trades) {
    const time = Date.parse(trade.created_time), size = Number(trade.count_fp ?? trade.count);
    if (time < at - 8000 || time > at || !Number.isFinite(time) || !(size > 0) ||
        !['yes', 'no'].includes(trade.taker_side)) continue;
    volumes[trade.taker_side] += size;
    count++;
  }
  const side = sign > 0 ? 'yes' : 'no', other = side === 'yes' ? 'no' : 'yes';
  return count >= 3 && volumes[side] >= 2 * volumes[other] && volumes[side] > 0 ? side : null;
}

export function observePaperSpike(row, book, history, trades, at) {
  const spike = row.spike ??= {};
  if (spike.exit) return;
  const side = spike.entry?.side ?? spike.signal?.side;
  if (spike.entry) {
    const bid = side === 'yes' ? book?.yesBid : book?.noBid;
    const size = side === 'yes' ? book?.yesBidSize : book?.noBidSize;
    const age = at - spike.entry.at;
    const usableBid = Number.isFinite(bid) && Number.isFinite(size) && size >= spike.entry.count;
    const netAtBid = () => bid * spike.entry.count -
      fee(spike.entry.count, bid, row.feeMultiplier) - spike.entry.estimatedCost;
    const pending = spike.pendingExit;
    if (pending) {
      if (at - pending.at < 1000) return;
      const filled = usableBid && bid >= pending.limit;
      const outcome = !Number.isFinite(bid) ? 'missing_bid' :
        bid < pending.limit ? 'bid_below_limit' :
        !usableBid ? 'insufficient_size' : 'filled';
      (spike.exitAttempts ??= []).push({ ...pending, checkedAt: at,
        delayMs: at - pending.at, observedBid: bid ?? null,
        observedSize: size ?? null, outcome });
      spike.pendingExit = null;
      if (filled) spike.exit = { at, bid, net: netAtBid(), reason: pending.reason };
      return;
    }
    if (age < 4000 || !usableBid) return;
    const net = netAtBid();
    const perContract = net / spike.entry.count;
    if (age < 15000 && perContract < .03 && perContract > -.03) return;
    spike.pendingExit = { at, limit: bid, reason: age >= 15000 ? 'time' : net > 0 ? 'target' : 'stop' };
    return;
  }
  if (spike.signal) {
    const age = at - spike.signal.at;
    if (age < 4000) return;
    const ask = book?.[side]?.price;
    const bid = side === 'yes' ? book?.yesBid : book?.noBid;
    const size = side === 'yes' ? book?.yesBidSize : book?.noBidSize;
    if (age <= 8000 && ask <= .85 && ask >= .15 &&
        Number.isFinite(bid) && ask - bid <= .03 &&
        bid >= spike.signal.bid && size >= spike.signal.size) {
      const fill = estimateMetalEntry({ book, side, stage: { budget: paperBudget, minPrice: .15 },
        feeMultiplier: row.feeMultiplier });
      if (fill && size >= fill.count) spike.entry = { at, ...fill };
    }
    if (!spike.entry) spike.signal = null;
    return;
  }
  if ((Date.parse(row.closeTime) - at) < 35000 || !book) return;
  const direction = spikeSignal(history, trades, at);
  if (!direction) return;
  const bid = direction === 'yes' ? book.yesBid : book.noBid;
  const size = direction === 'yes' ? book.yesBidSize : book.noBidSize;
  if (Number.isFinite(bid) && size > 0) spike.signal = { side: direction, at, bid, size };
}

export function experimentOutcome(row) {
  const baseline = row.defenseStudy?.wickStudy?.plans?.[5];
  const wickNet = baseline ? (baseline.side === row.result ? baseline.count : 0) -
    baseline.estimatedCost : 0;
  const defense = row.defense ? { ...row.defense, baselineNet: wickNet,
    deltaIfBlocked: row.defense.verdict === 'block' ? -wickNet : 0 } : null;
  const spike = row.spike;
  const position = spike?.entry;
  const spikeNet = !position ? null : spike.exit?.net ??
    (position.side === row.result ? position.count : 0) - position.estimatedCost;
  return { defense, spike: position ? { ...spike, net: spikeNet,
    closedBy: spike.exit ? 'simulated_bid' : 'settlement' } : null };
}
