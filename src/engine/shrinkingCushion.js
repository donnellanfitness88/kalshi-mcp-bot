const STABILIZATION_SECONDS = 2;
const TRIGGER_LOOKBACK_SECONDS = 10;

// Add-on protection only. These measurements are trend checks, not forecasts.
export function evaluateShrinkingCushion({ history, asset, ticker, side, target,
  minimumDistance, rapidDropMinimum = minimumDistance, secondsRemaining, previous = null, requireLongRecovery = false, stabilizationSeconds = STABILIZATION_SECONDS, requireStableAlways = false, requireLongAlways = false, observationOnlyNoMinimum = false, paperRecoveryPullback = null, onHistoryFailure = null, projectedLookbackSeconds = TRIGGER_LOOKBACK_SECONDS, maxHistoryGapMs = 1500, now = Date.now() }) {
  const prior = previous?.ticker === ticker && previous.side === side ? previous : null;
  const reject = reason => ({ allowed: false, reason, guardState: prior });
  if (!['yes','no'].includes(side) || !Number.isFinite(target) || target <= 0 ||
      !Number.isFinite(minimumDistance) || (minimumDistance < 0 || minimumDistance === 0 && !observationOnlyNoMinimum) ||
      !Number.isFinite(rapidDropMinimum) || (rapidDropMinimum < 0 || rapidDropMinimum === 0 && !observationOnlyNoMinimum) ||
      !Number.isFinite(secondsRemaining) || secondsRemaining <= 0 || !Array.isArray(history)) {
    return reject('SHRINK_HISTORY_UNAVAILABLE');
  }
  const rows = history.filter(p => Number.isSafeInteger(p.sourceTs) && p.sourceTs <= now &&
    Number.isFinite(p.price) && p.price > 0 && p.sourceTs >= now - 90000)
    .sort((a,b) => a.sourceTs-b.sourceTs);
  const last = rows.at(-1);
  if (!last || now-last.sourceTs > 2000) {
    onHistoryFailure?.({ issue: last ? 'STALE_HISTORY_POINT' : 'NO_VALID_HISTORY',
      sourceTs: last?.sourceTs ?? null, ageMs: last ? now-last.sourceTs : null });
    return reject('SHRINK_HISTORY_UNAVAILABLE');
  }
  const cushion = p => side === 'yes' ? p.price-target : target-p.price;
  const at = time => rows.findLast(p => p.sourceTs <= time && time-p.sourceTs <= 500);
  const complete = (start,end) => {
    const selected = rows.filter(p => p.sourceTs >= start && p.sourceTs <= end);
    return selected.every((p,i) => !i || p.sourceTs-selected[i-1].sourceTs <= maxHistoryGapMs);
  };
  const measure = end => {
    const first=at(end.sourceTs-15000), recent=at(end.sourceTs-3000);
    if (!first || !recent || !complete(first.sourceTs,end.sourceTs)) return null;
    const initial=cushion(first), current=cushion(end), drop=initial-current;
    const seconds=(end.sourceTs-first.sourceTs)/1000;
    const toward=cushion(recent)-current > 1e-9;
    const fraction=initial>0 ? drop/initial : 0;
    const rapid=initial>0 && fraction+1e-9>=.30 && drop+1e-9>=rapidDropMinimum && toward;
    const speed=Math.max(0,drop/seconds);
    // Earlier points have correspondingly more time remaining until this close.
    const remaining=secondsRemaining+(last.sourceTs-end.sourceTs)/1000;
    const projection=toward && speed>0 && current>0 && current/speed<=remaining;
    return { initialCushion:initial, currentCushion:current, dropUsd:drop,
      shrinkFraction:fraction, approaching:toward, approachUsdPerSecond:speed,
      projectedSecondsToTarget:speed>0?Math.max(0,current)/speed:null,
      rapid, projection };
  };
  function diagnoseLookback(lookbackMs, end=last.sourceTs, checkGap=true) {
    if (!onHistoryFailure) return;
    const requiredTs=end-lookbackMs;
    const previous=rows.findLast(point=>point.sourceTs<=requiredTs);
    if (!previous || requiredTs-previous.sourceTs>500) {
      onHistoryFailure({ issue:'MISSING_CHECKPOINT', lookbackMs, requiredTs,
        previousSourceTs:previous?.sourceTs ?? null,
        nextSourceTs:rows.find(point=>point.sourceTs>requiredTs)?.sourceTs ?? null, toleranceMs:500 });
    } else if (checkGap) {
      const span=rows.filter(point=>point.sourceTs>=previous.sourceTs && point.sourceTs<=end);
      const next=span.findIndex((point,i)=>i>0 && point.sourceTs-span[i-1].sourceTs>maxHistoryGapMs);
      if (next>0) onHistoryFailure({ issue:'HISTORY_GAP', lookbackMs,
        fromSourceTs:span[next-1].sourceTs, toSourceTs:span[next].sourceTs,
        gapMs:span[next].sourceTs-span[next-1].sourceTs, maximumGapMs:maxHistoryGapMs });
    }
  }
  const current=measure(last);
  if (!current) {
    if (!at(last.sourceTs-15000)) diagnoseLookback(15000);
    else if (!at(last.sourceTs-3000)) diagnoseLookback(3000, last.sourceTs, false);
    else diagnoseLookback(15000);
    return reject('SHRINK_HISTORY_UNAVAILABLE');
  }
  // Find warnings even when no order check ran at that instant. The journal
  // retains a latched warning until the existing recovery checks clear it.
  let trigger=null;
  for(let ago=0;ago<=Math.max(TRIGGER_LOOKBACK_SECONDS,projectedLookbackSeconds);ago++) {
    const point=at(last.sourceTs-ago*1000);
    const m=point && measure(point);
    const rapid=ago<=TRIGGER_LOOKBACK_SECONDS && m?.rapid;
    const projection=ago<=projectedLookbackSeconds && m?.projection;
    if(rapid || projection){trigger={rapid,at:point.sourceTs};break;}
  }
  const checkpoints=Array.from({length:stabilizationSeconds+1},(_,i)=>at(last.sourceTs-(stabilizationSeconds-i)*1000));
  const stableRows=rows.filter(p=>p.sourceTs>=last.sourceTs-stabilizationSeconds*1000);
  const noIntraSecondDecrease=!(requireStableAlways || stabilizationSeconds>STABILIZATION_SECONDS) || stableRows.every((p,i)=>!i || cushion(p)+1e-9>=cushion(stableRows[i-1]));
  const stabilizationHistoryReady=checkpoints.every(Boolean) &&
    complete(checkpoints[0].sourceTs,last.sourceTs);
  const strictStabilized=noIntraSecondDecrease && stabilizationHistoryReady &&
    checkpoints.every((p,i)=>!i || cushion(p)+1e-9>=cushion(checkpoints[i-1]));
  const tooClose=current.currentCushion+1e-9<minimumDistance;
  // Large stages must not erase a warning on a short pause while either broader
  // trend still erodes the winning-side cushion. Preserve the latch on missing
  // continuous history; smaller stages and observer baselines retain their rules.
  const recoveryWarning=Boolean(trigger || prior?.blocked || requireStableAlways);
  let longRecovery=null;
  if(requireLongRecovery && (recoveryWarning || requireLongAlways)) {
    const first=at(last.sourceTs-60000);
    const available=Boolean(first && complete(first.sourceTs,last.sourceTs));
    if (!available) diagnoseLookback(60000);
    const change15=current.currentCushion-current.initialCushion;
    const change60=available?current.currentCushion-cushion(first):null;
    longRecovery={lookbackSeconds:[15,60],historyAvailable:available,
      cushionChange15:change15,cushionChange60:change60,
      allowed:available && change15>=-1e-9 && change60>=-1e-9};
  }
  const longRecoveryBlocked=Boolean(longRecovery && !longRecovery.allowed);
  // Only the paper study enables this option. Keep hard warnings latched
  // until recovery passes, even if they age out of the trigger lookback.
  const paperRecovery=asset==='WTI' && Number.isFinite(paperRecoveryPullback) && paperRecoveryPullback>=0;
  const hardRecoveryWarning=Boolean(trigger || prior?.hardRecoveryWarning);
  const trendOnlyWarning=!hardRecoveryWarning && Boolean(prior?.trendOnlyWarning ||
    (longRecoveryBlocked && longRecovery.historyAvailable));
  let boundedRecovery=false;
  if(paperRecovery && prior?.blocked && prior.trendOnlyWarning && trendOnlyWarning &&
      !longRecoveryBlocked && stabilizationHistoryReady && !strictStabilized) {
    const initial=cushion(checkpoints[0]);
    let peak=initial, maxPullback=0;
    for(const point of stableRows) {
      const value=cushion(point);
      peak=Math.max(peak,value);
      maxPullback=Math.max(maxPullback,peak-value);
    }
    boundedRecovery=cushion(last)>initial+1e-9 && maxPullback<=paperRecoveryPullback+1e-9;
  }
  const stabilized=strictStabilized || boundedRecovery;
  const blocked=Boolean((recoveryWarning && !stabilized) || longRecoveryBlocked || tooClose);
  const reason=!blocked?'SHRINK_OK':longRecoveryBlocked ?
    (longRecovery.historyAvailable?'SHRINK_LONG_TREND_RECOVERY':'SHRINK_LONG_HISTORY_UNAVAILABLE'):trigger ? (trigger.rapid?'SHRINK_RAPID_APPROACH':'SHRINK_PROJECTED_CROSSING') :
    tooClose?'SHRINK_DISTANCE_TOO_CLOSE':blocked?'SHRINK_STABILIZING':'SHRINK_OK';
  const guardState={asset,ticker,side,blocked,
    triggeredAt:trigger?.at ?? prior?.triggeredAt ?? null,
    triggerReason:trigger ? reason : prior?.triggerReason ?? null,
    ...(paperRecovery?{hardRecoveryWarning:blocked && hardRecoveryWarning,
      trendOnlyWarning:blocked && trendOnlyWarning}:{})};
  return { allowed:!blocked,reason,guardState,...current,stabilized,longRecovery,
    ...(paperRecovery?{boundedRecovery}:{}),
    sourceTs:last.sourceTs,checkedAt:now,lookbackSeconds:15,stabilizationSeconds };
}
