// Add-on protection only. These measurements are trend checks, not forecasts.
export function evaluateShrinkingCushion({ history, asset, ticker, side, target,
  minimumDistance, secondsRemaining, previous = null, now = Date.now() }) {
  const prior = previous?.ticker === ticker && previous.side === side ? previous : null;
  const reject = reason => ({ allowed: false, reason, guardState: prior });
  if (!['yes','no'].includes(side) || !Number.isFinite(target) || target <= 0 ||
      !Number.isFinite(minimumDistance) || minimumDistance <= 0 ||
      !Number.isFinite(secondsRemaining) || secondsRemaining <= 0 || !Array.isArray(history)) {
    return reject('SHRINK_HISTORY_UNAVAILABLE');
  }
  const rows = history.filter(p => Number.isSafeInteger(p.sourceTs) && p.sourceTs <= now &&
    Number.isFinite(p.price) && p.price > 0 && p.sourceTs >= now - 60000)
    .sort((a,b) => a.sourceTs-b.sourceTs);
  const last = rows.at(-1);
  if (!last || now-last.sourceTs > 2000) return reject('SHRINK_HISTORY_UNAVAILABLE');
  const cushion = p => side === 'yes' ? p.price-target : target-p.price;
  const at = time => rows.findLast(p => p.sourceTs <= time && time-p.sourceTs <= 500);
  const complete = (start,end) => {
    const selected = rows.filter(p => p.sourceTs >= start && p.sourceTs <= end);
    return selected.every((p,i) => !i || p.sourceTs-selected[i-1].sourceTs <= 1500);
  };
  const measure = end => {
    const first=at(end.sourceTs-15000), recent=at(end.sourceTs-3000);
    if (!first || !recent || !complete(first.sourceTs,end.sourceTs)) return null;
    const initial=cushion(first), current=cushion(end), drop=initial-current;
    const seconds=(end.sourceTs-first.sourceTs)/1000;
    const toward=cushion(recent)-current > 1e-9;
    const fraction=initial>0 ? drop/initial : 0;
    const rapid=initial>0 && fraction+1e-9>=.30 && drop+1e-9>=minimumDistance && toward;
    const speed=Math.max(0,drop/seconds);
    // Earlier points have correspondingly more time remaining until this close.
    const remaining=secondsRemaining+(last.sourceTs-end.sourceTs)/1000;
    const projection=toward && speed>0 && current>0 && current/speed<=remaining;
    return { initialCushion:initial, currentCushion:current, dropUsd:drop,
      shrinkFraction:fraction, approaching:toward, approachUsdPerSecond:speed,
      projectedSecondsToTarget:speed>0?Math.max(0,current)/speed:null,
      rapid, projection };
  };
  const current=measure(last);
  if (!current) return reject('SHRINK_HISTORY_UNAVAILABLE');
  // Detect a trigger in the last ten seconds even if no order check ran at that
  // instant. A previously latched trigger survives longer through the journal.
  let trigger=null;
  for(let ago=0;ago<=10;ago++) {
    const point=at(last.sourceTs-ago*1000);
    const m=point && measure(point);
    if(m?.rapid || m?.projection){trigger={...m,at:point.sourceTs};break;}
  }
  const checkpoints=Array.from({length:11},(_,i)=>at(last.sourceTs-(10-i)*1000));
  const stabilized=checkpoints.every(Boolean) &&
    complete(checkpoints[0].sourceTs,last.sourceTs) &&
    checkpoints.every((p,i)=>!i || cushion(p)+1e-9>=cushion(checkpoints[i-1]));
  const tooClose=current.currentCushion+1e-9<minimumDistance;
  const blocked=Boolean(((trigger || prior?.blocked) && !stabilized) || tooClose);
  const reason=!blocked?'SHRINK_OK':trigger ? (trigger.rapid?'SHRINK_RAPID_APPROACH':'SHRINK_PROJECTED_CROSSING') :
    tooClose?'SHRINK_DISTANCE_TOO_CLOSE':blocked?'SHRINK_STABILIZING':'SHRINK_OK';
  const guardState={asset,ticker,side,blocked,
    triggeredAt:trigger?.at ?? prior?.triggeredAt ?? null,
    triggerReason:trigger ? reason : prior?.triggerReason ?? null};
  return { allowed:!blocked,reason,guardState,...current,stabilized,
    sourceTs:last.sourceTs,checkedAt:now,lookbackSeconds:15,stabilizationSeconds:10 };
}
