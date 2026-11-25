import { estimateMetalEntry } from './metalsObserver.js';
import { evaluateShrinkingCushion } from '../engine/shrinkingCushion.js';

const SECOND = 1000;
const delays = [0, 5, 10];
const variants = [...delays, "volatility", "settlement"];

// Use only completed seconds. Keep a bounded research cache independent of the live feed.
export class PullbackHistory {
  constructor() { this.seconds = new Map(); }
  ingest(history, now) {
    const current = Math.floor(now / SECOND);
    for (const p of history) {
      const key = Math.floor(p.sourceTs / SECOND);
      if (key < current && p.sourceTs <= now) this.seconds.set(key, p.price);
    }
    for (const key of this.seconds.keys()) {
      if (key >= current - 14400) break;
      this.seconds.delete(key);
    }
  }
  compare(now, remaining, sign, cushion) {
    const span = Math.ceil(remaining);
    const end = Math.floor(now / SECOND);
    const moves = [];
    // Non-overlapping, same-horizon paths over the preceding four hours.
    for (let stop = end; stop - span >= end - 14400; stop -= span) {
      const start = this.seconds.get(stop - span - 1);
      if (start == null) continue;
      let adverse = 0;
      for (let i = stop - span; i < stop; i++) {
        const price = this.seconds.get(i);
        if (price == null) { adverse = null; break; }
        adverse = Math.max(adverse, sign * (start - price));
      }
      if (adverse != null) moves.push(adverse);
    }
    return { horizonSeconds:span, samples:moves.length,
      fractionReachingCushion:moves.length ? moves.filter(x=>x>=cushion).length/moves.length : null };
  }
}

export function wickMetrics(rows, now, target, sign, close, floor=30, onHistoryFailure=null, maxHistoryGapMs=1500) {
  const end = rows.at(-1)?.sourceTs;
  if (!Number.isFinite(end) || end > now || now-end > 2000) {
    onHistoryFailure?.({ issue:!Number.isFinite(end)?'NO_VALID_HISTORY':end>now?'FUTURE_HISTORY_POINT':'STALE_HISTORY_POINT',
      sourceTs:end ?? null, ageMs:Number.isFinite(end)?now-end:null });
    return null;
  }
  const begin = end-60000;
  const first = rows.findLastIndex(p=>p.sourceTs<=begin);
  if (first<0 || begin-rows[first].sourceTs>500) {
    onHistoryFailure?.({ issue:'MISSING_CHECKPOINT', lookbackMs:60000, requiredTs:begin,
      previousSourceTs:rows[first]?.sourceTs ?? null, nextSourceTs:rows[first+1]?.sourceTs ?? null,
      toleranceMs:500 });
    return null;
  }
  const points=rows.slice(first);
  const margin=p=>sign*(p.price-target);
  const clears=p=>floor===0 ? margin(p)>0 : margin(p)>=floor;
  let belowMs=0, recoveries=0, stableSince=begin, minimum=Infinity;
  for (let i=0; i<points.length; i++) {
    const p=points[i], next=points[i+1];
    if (next && next.sourceTs-p.sourceTs>maxHistoryGapMs) {
      onHistoryFailure?.({ issue:'HISTORY_GAP', lookbackMs:60000, fromSourceTs:p.sourceTs,
        toSourceTs:next.sourceTs, gapMs:next.sourceTs-p.sourceTs, maximumGapMs:maxHistoryGapMs });
      return null;
    }
    minimum=Math.min(minimum,margin(p));
    if (!clears(p) && next) {
      belowMs+=next.sourceTs-Math.max(begin,p.sourceTs);
      if (clears(next)) { recoveries++; stableSince=next.sourceTs; }
    }
  }
  const heldMs=clears(points.at(-1)) ? end-stableSince : 0;
  // Research proxy: last observed index value in each completed settlement second.
  const start=close-60000;
  const elapsed=Math.floor((now-start)/SECOND);
  let remainingMean=null;
  if (elapsed>0 && elapsed<60) {
    const buckets=new Map();
    for (const p of points) {
      const i=Math.floor((p.sourceTs-start)/SECOND);
      if (i>=0 && i<elapsed) buckets.set(i,p.price);
    }
    if (buckets.size===elapsed) {
      const sum=[...buckets.values()].reduce((a,b)=>a+b,0);
      remainingMean=(60*target-sum)/(60-elapsed);
    }
  }
  return { minimum, belowMs, recoveries, heldMs, elapsedSettlementSeconds:Math.max(0,elapsed),
    requiredRemainingMeanProxy:remainingMean };
}

export function observeWick(row, book, history, at, pullbacks, options={}) {
  const close=Date.parse(row.closeTime), remaining=(close-at)/SECOND;
  if (!(remaining>0 && remaining<180 && row.target>0)) return;
  const study=row.wickStudy??={plans:{},guards:{},checks:0,missingHistory:0};
  study.maxGapMs=Math.max(study.maxGapMs??0, at-(study.lastCheck??(close-180000)));
  study.lastCheck=at;
  study.checks++;
  const base=study.plans[0];
  if (variants.every(d=>study.plans[d])) return;
  for (const side of base?[base.side]:['yes','no']) {
    const sign=side==='yes'?1:-1;
    const guard=options.guard ? options.guard(side,study.guards[side]) : evaluateShrinkingCushion({history,asset:'BTC',ticker:row.ticker,side,target:row.target,
      minimumDistance:30,secondsRemaining:remaining,now:at,previous:study.guards[side],
      requireLongRecovery:true,stabilizationSeconds:5});
    study.guards[side]=guard.guardState;
    if (!guard.allowed) continue;
    const plan=estimateMetalEntry({book,side,stage:{budget:options.budget??900,minPrice:.90},feeMultiplier:row.feeMultiplier});
    if (!plan) continue;
    const wick=wickMetrics(history,at,row.target,sign,close,guard.crossingBufferRequired ? guard.crossingMinimum : options.floor);
    if (!wick) study.missingHistory++;
    const pullback=pullbacks.compare(at,remaining,sign,guard.currentCushion);
    if (pullback.samples<20) study.volatilityWarmupChecks=(study.volatilityWarmupChecks??0)+1;
    const reference=history.at(-1)?.price;
    const flipGap=wick?.requiredRemainingMeanProxy==null ? null :
      sign*(reference-wick.requiredRemainingMeanProxy);
    // Frozen exploratory screens. Test each independently against the immediate baseline.
    for (const delay of variants) {
      if (study.plans[delay]) continue;
      if (typeof delay==='number' && delay && (!wick || wick.heldMs<delay*SECOND)) continue;
      if (delay==='volatility' && (pullback.samples<20 || pullback.fractionReachingCushion>.10)) continue;
      if (delay==='settlement' && !(flipGap!=null && flipGap>=(options.flipMinimum?.(guard)??30))) continue;
      study.plans[delay]={...plan,at,remaining,cushion:guard.currentCushion,wick,
        flipGap,requiredWickFloor:guard.crossingBufferRequired ? guard.crossingMinimum : options.floor??30,pullbacks:pullback};
    }
    break;
  }
}

export function wickOutcome(row) {
  const net={};
  for (const d of variants) {
    const p=row.wickStudy?.plans[d];
    net[d]=p?(p.side===row.result?p.count:0)-p.estimatedCost:0;
  }
  return {study:row.wickStudy??null,net,delta5:net[5]-net[0],delta10:net[10]-net[0],
    partial:row.startedAt>Date.parse(row.closeTime)-180000,
    model:'sampled public book; independent alternatives; displayed size; estimated fees; account eligibility unknown'};
}

export function updateWickTotals(totals,row) {
  const outcome=wickOutcome(row), study=row.wickStudy;
  if (!study || outcome.partial || study.maxGapMs>15000 ||
      Date.parse(row.closeTime)-study.lastCheck>15000) {
    totals.incomplete=(totals.incomplete??0)+1;
    return;
  }
  totals.windows=(totals.windows??0)+1;
  for (const variant of variants) {
    const stats=totals[variant]??={net:0,delta:0,entries:0,worst:0,skippedWins:0,skippedLosses:0};
    const value=outcome.net[variant];
    stats.net+=value;
    stats.delta+=value-outcome.net[0];
    stats.worst=Math.min(stats.worst,value);
    stats.netPerWindow=stats.net/totals.windows;
    if (study.plans[variant]) stats.entries++;
    else if (outcome.net[0]>0) stats.skippedWins++;
    else if (outcome.net[0]<0) stats.skippedLosses++;
  }
}
