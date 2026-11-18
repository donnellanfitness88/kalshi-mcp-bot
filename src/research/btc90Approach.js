import { benchmarkFeed } from '../prices/cfBenchmarks.js';

const fourHoursMs = 4 * 60 * 60 * 1000;
const references = new Map();
let activeTicker;
let firstSeen;
let lastSecond;
let path;
let recorded;

function askBpsFromOppositeBid(bid) {
  if (!Number.isFinite(bid) || bid <= 0 || bid >= 1) return null;
  return Math.round((1 - bid) * 10000);
}

export function recordBtcApproach(
  ticker, sequence, yesBid, noBid, yesBidSize, noBidSize, now = Date.now()
) {
  if (!ticker?.startsWith('KXBTC15M-')) return;

  if (activeTicker !== ticker) {
    activeTicker = ticker;
    firstSeen = now;
    lastSecond = null;
    path = [];
    recorded = false;
    console.log('[BTC90_START]', JSON.stringify({ ticker, now }));
  }

  // Keep collecting reference checkpoints after the candidate so later
  // windows can look back four hours. A missing checkpoint stays missing.
  const quote = benchmarkFeed.getQuote('BTC');
  if (quote) {
    const second = Math.floor(quote.sourceTs / 1000);
    references.set(second, quote);
    while (references.size && references.keys().next().value < second - 14405) {
      references.delete(references.keys().next().value);
    }
  }

  if (recorded || yesBid + noBid > 1.000000001) return;

  // Buying YES consumes a NO bid. Buying NO consumes a YES bid.
  const row = {
    now,
    sequence,
    yesAskBps: askBpsFromOppositeBid(noBid),
    yesSize: noBidSize,
    noAskBps: askBpsFromOppositeBid(yesBid),
    noSize: yesBidSize,
    reference: quote?.price ?? null,
    referenceTs: quote?.sourceTs ?? null
  };

  const second = Math.floor(now / 1000);
  while (path.length && path[0].now < now - 60000) path.shift();
  if (second !== lastSecond) {
    path.push(row);
    lastSecond = second;
  }

  let side;
  if (row.yesAskBps === 9000 && noBidSize > 0) side = 'yes';
  else if (row.noAskBps === 9000 && yesBidSize > 0) side = 'no';
  else return;

  recorded = true;
  const cutoff = (quote?.sourceTs ?? now) - fourHoursMs;
  const bucket = Math.floor(cutoff / 1000);
  const prior = [
    references.get(bucket),
    references.get(bucket - 1),
    references.get(bucket - 2)
  ].find(p => p && p.sourceTs <= cutoff && cutoff - p.sourceTs <= 2000);

  console.log('[BTC90_CANDIDATE]', JSON.stringify({
    ticker, firstSeen, side, ...row,
    fourHourReference: prior?.price ?? null,
    fourHourReferenceTs: prior?.sourceTs ?? null
  }));

  for (let i = 0; i < path.length; i += 8) {
    console.log('[BTC90_PATH]', JSON.stringify({
      ticker, candidateAt: now, offset: i, samples: path.slice(i, i + 8)
    }));
  }
}
