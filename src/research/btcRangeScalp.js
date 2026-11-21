import { estimateMetalEntry } from './metalsObserver.js';

export const BTC_RANGE_SCALP_RULES = Object.freeze({
  paperBudget: 10,
  minimumPullbackUsd: 20,
  minimumReboundUsd: 10,
  minimumLowerHighUsd: 10,
  smallReboundUsd: 2,
  turnDownUsd: 5,
  nearPriorLowUsd: 5,
  supportBreakUsd: 15,
  supportReboundUsd: 8,
  maxReferenceGapMs: 2000,
  entryQuoteWindowMs: 7000,
  maxBookReadMs: 2000,
  minimumTimeToEnterMs: 60000,
  forceExitBeforeCloseMs: 30000,
  maxHoldMs: 120000,
  netProfitPerContract: .03,
  maxNetLossPerContract: .05,
});

const rules = BTC_RANGE_SCALP_RULES;

export function advanceBtcRangeScalp(study, history, open, close, now) {
  if (study.upExit || study.invalidated) return;
  for (const { sourceTs: at, price } of history) {
    if (!Number.isSafeInteger(at) || at < open || at >= close || at > now ||
        at <= (study.lastAt ?? 0) || !Number.isFinite(price) || price <= 0) continue;
    if (study.lastAt && at - study.lastAt > rules.maxReferenceGapMs) {
      if (study.downSignal) {
        study.invalidated ??= 'REFERENCE_GAP';
        study.lastAt = at;
        return;
      }
      study.peak = study.priorLow = study.reboundHigh = null;
      study.pullbackLow = study.launchLow = null;
    }
    study.lastAt = at;
    if (study.downSignal) {
      if (!study.supportTouch && price >= study.reboundHigh) {
        study.invalidated = 'REBOUND_HIGH_RECLAIMED';
        return;
      }
      if (!study.supportTouch && price <= study.priorLow + rules.nearPriorLowUsd) {
        study.supportTouch = { at, price };
        study.supportLow = price;
      }
      if (!study.supportTouch) continue;
      if (price < study.priorLow - rules.supportBreakUsd) {
        study.invalidated = 'SUPPORT_BROKE';
        return;
      }
      if (study.upSignal) {
        if (price < study.upSignal.supportLow) {
          study.invalidated = 'BOUNCE_LOW_BROKE';
          return;
        }
        continue;
      }
      study.supportLow = Math.min(study.supportLow, price);
      if (price >= study.priorLow && price >= study.supportLow + rules.supportReboundUsd) {
        study.upSignal = { at, price, supportLow: study.supportLow };
      }
      continue;
    }
    if (study.peak == null || price >= study.peak) {
      if (study.pullbackLow != null && price - study.pullbackLow >= rules.minimumPullbackUsd) {
        study.launchLow = study.pullbackLow;
      }
      study.peak = price;
      study.pullbackLow = study.reboundHigh = null;
      continue;
    }
    study.pullbackLow ??= price;
    // A low that launched the rally can be support below a shallower pullback.
    const hasLaunchSupport = study.launchLow != null && study.launchLow < study.pullbackLow;
    const priorLow = hasLaunchSupport ? study.launchLow : study.pullbackLow;
    const minRebound = hasLaunchSupport ? rules.smallReboundUsd : rules.minimumReboundUsd;
    if (price - study.pullbackLow >= minRebound) {
      study.reboundHigh = Math.max(study.reboundHigh ?? price, price);
    }
    if (study.peak - priorLow >= rules.minimumPullbackUsd && study.reboundHigh != null &&
        study.peak - study.reboundHigh >= rules.minimumLowerHighUsd &&
        price <= study.reboundHigh - rules.turnDownUsd && price > priorLow + rules.nearPriorLowUsd) {
      study.priorLow = priorLow;
      study.downSignal = { at, price, peak: study.peak, priorLow, reboundHigh: study.reboundHigh };
    } else if (price < study.pullbackLow) {
      study.pullbackLow = price;
      study.reboundHigh = null;
    }
  }
}

function entrySide(study, now, close) {
  if (study.invalidated || close - now < rules.minimumTimeToEnterMs ||
      now - study.lastAt > rules.maxReferenceGapMs) return null;
  if (study.upSignal && !study.upEntry && (!study.downEntry || study.downExit) &&
      now - study.upSignal.at <= rules.entryQuoteWindowMs) return 'yes';
  if (study.downSignal && !study.supportTouch && !study.downEntry &&
      now - study.downSignal.at <= rules.entryQuoteWindowMs) return 'no';
  return null;
}

export function btcRangeScalpNeedsBook(study, now, close) {
  return Boolean((study.downEntry && !study.downExit) ||
    (study.upEntry && !study.upExit) || entrySide(study, now, close));
}

export function sampleBtcRangeScalp(study, book, feeMultiplier, requestedAt, at, close) {
  if (at >= close || at - requestedAt > rules.maxBookReadMs) return [];
  const changes = [];
  for (const [leg, opposite] of [['down', 'yes'], ['up', 'no']]) {
    const entry = study[leg + 'Entry'];
    if (!entry || study[leg + 'Exit']) continue;
    const bid = book?.[entry.side + 'Bid'];
    // The opposite ask is derived from this bid, including its displayed size.
    const size = book?.[opposite]?.size;
    const validBid = Number.isFinite(bid) && bid > 0 && bid < 1;
    const fee = validBid ? Math.ceil(7 * feeMultiplier * entry.count * bid * (1 - bid) - 1e-9) / 100 : null;
    const net = fee == null ? null : entry.count * bid - fee - entry.estimatedCost;
    const perContract = net == null ? null : net / entry.count;
    study[leg + 'ExitReason'] ??= leg === 'down' && study.supportTouch ? 'PRIOR_LOW_APPROACH' :
      study.invalidated ?? (at - study.lastAt > rules.maxReferenceGapMs ? 'STALE_REFERENCE' :
        close - at <= rules.forceExitBeforeCloseMs ? 'NEAR_CLOSE' :
        at - entry.at >= rules.maxHoldMs ? 'MAX_HOLD' :
        size >= entry.count && leg === 'up' && perContract >= rules.netProfitPerContract - 1e-9 ? 'NET_PROFIT_TARGET' :
        perContract != null && perContract <= -rules.maxNetLossPerContract + 1e-9 ? 'NET_LOSS_LIMIT' : null);
    const reason = study[leg + 'ExitReason'];
    if (!reason) continue;
    if (!Number.isFinite(net) || !Number.isFinite(size) || size < entry.count) {
      if (!study[leg + 'ExitMiss']) {
        const miss = { at, reason, bid: bid ?? null, displayedSize: size ?? null };
        study[leg + 'ExitMiss'] = miss;
        changes.push({ phase: leg + 'ExitMiss', ...miss });
      }
      continue;
    }
    const exit = { at, reason, bid, displayedSize: size, estimatedFee: fee, net };
    study[leg + 'Exit'] = exit;
    changes.push({ phase: leg + 'Exit', ...exit });
  }

  const side = entrySide(study, at, close);
  if (!side) return changes;
  const leg = side === 'yes' ? 'up' : 'down';
  if (requestedAt < study[leg + 'Signal'].at) return changes;
  const entry = estimateMetalEntry({ book, side, feeMultiplier,
    stage: { budget: rules.paperBudget, minPrice: .001 } });
  if (!entry) return changes;
  if (leg === 'up' && entry.count - entry.estimatedCost <
      rules.netProfitPerContract * entry.count - 1e-9) return changes;
  study[leg + 'Entry'] = { ...entry, at, signalAt: study[leg + 'Signal'].at };
  changes.push({ phase: leg + 'Entry', ...study[leg + 'Entry'] });
  return changes;
}

export function btcRangeScalpOutcome(study, result) {
  if (!study) return undefined;
  return Object.fromEntries(['down', 'up'].map(leg => {
    const entry = study[leg + 'Entry'];
    const exit = study[leg + 'Exit'];
    return [leg, { signal: study[leg + 'Signal'] ?? null, entry: entry ?? null,
      exit: exit ?? null, exitMiss: study[leg + 'ExitMiss'] ?? null,
      closedBy: exit ? 'simulated_bid' : entry ? 'settlement_fallback' : 'no_entry',
      estimatedNet: exit?.net ??
        (entry ? (entry.side === result ? entry.count : 0) - entry.estimatedCost : null) }];
  }));
}
