// Additional SILVER/EURUSD purchase gates, independent of the existing guard's latch.
// This extrapolates the existing 15-second approach speed; it is not a forecast.
export const SILVER_ENTRY_TIME_BUFFER_SECONDS = 20;
export const EURUSD_ENTRY_TIME_BUFFER_SECONDS = 15;
export function entryCrossingBuffer(check,asset,secondsRemaining,now=Date.now()) {
  const buffer=asset==='SILVER'?SILVER_ENTRY_TIME_BUFFER_SECONDS:
    asset==='EURUSD'?EURUSD_ENTRY_TIME_BUFFER_SECONDS:null;
  if(buffer===null || !check?.allowed)return check;
  const reject=reason=>({...check,allowed:false,reason,
    entryTimeBufferSeconds:buffer});
  if(!Number.isFinite(secondsRemaining)||secondsRemaining<=0 ||
      !Number.isFinite(check.sourceTs)||now<check.sourceTs||now-check.sourceTs>2000 ||
      !Number.isFinite(check.approachUsdPerSecond)||check.approachUsdPerSecond<0)
    return reject(asset+'_BUFFER_DATA_UNAVAILABLE');
  if(check.approachUsdPerSecond===0) {
    if(check.projectedSecondsToTarget!==null)return reject(asset+'_BUFFER_DATA_UNAVAILABLE');
    return {...check,entryTimeBufferSeconds:buffer,
      projectedCrossingSecondsFromNow:null,projectedMarginSeconds:null};
  }
  if(!Number.isFinite(check.projectedSecondsToTarget)||check.projectedSecondsToTarget<0)
    return reject(asset+'_BUFFER_DATA_UNAVAILABLE');
  // The projection starts at the source quote, not the later order check.
  const projectedCrossingSecondsFromNow=Math.max(0,check.projectedSecondsToTarget-(now-check.sourceTs)/1000);
  const projectedMarginSeconds=projectedCrossingSecondsFromNow-secondsRemaining;
  return {...check,allowed:projectedMarginSeconds>buffer,
    reason:projectedMarginSeconds>buffer?check.reason:asset+'_CROSSING_TIME_BUFFER',
    entryTimeBufferSeconds:buffer,
    projectedCrossingSecondsFromNow,projectedMarginSeconds};
}

// Compatibility for existing callers and regression tests.
export const silverEntryBuffer=entryCrossingBuffer;
