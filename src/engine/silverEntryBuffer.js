// Additional SILVER purchase gate, independent of the existing guard's latch.
// This extrapolates the existing 15-second approach speed; it is not a forecast.
export const SILVER_ENTRY_TIME_BUFFER_SECONDS = 20;
export function silverEntryBuffer(check,asset,secondsRemaining,now=Date.now()) {
  if(asset!=='SILVER' || !check?.allowed)return check;
  const reject=reason=>({...check,allowed:false,reason,
    entryTimeBufferSeconds:SILVER_ENTRY_TIME_BUFFER_SECONDS});
  if(!Number.isFinite(secondsRemaining)||secondsRemaining<=0 ||
      !Number.isFinite(check.sourceTs)||now<check.sourceTs||now-check.sourceTs>2000 ||
      !Number.isFinite(check.approachUsdPerSecond)||check.approachUsdPerSecond<0)
    return reject('SILVER_BUFFER_DATA_UNAVAILABLE');
  if(check.approachUsdPerSecond===0) {
    if(check.projectedSecondsToTarget!==null)return reject('SILVER_BUFFER_DATA_UNAVAILABLE');
    return {...check,entryTimeBufferSeconds:SILVER_ENTRY_TIME_BUFFER_SECONDS,
      projectedCrossingSecondsFromNow:null,projectedMarginSeconds:null};
  }
  if(!Number.isFinite(check.projectedSecondsToTarget)||check.projectedSecondsToTarget<0)
    return reject('SILVER_BUFFER_DATA_UNAVAILABLE');
  // The projection starts at the source quote, not the later order check.
  const projectedCrossingSecondsFromNow=Math.max(0,check.projectedSecondsToTarget-(now-check.sourceTs)/1000);
  const projectedMarginSeconds=projectedCrossingSecondsFromNow-secondsRemaining;
  return {...check,allowed:projectedMarginSeconds>SILVER_ENTRY_TIME_BUFFER_SECONDS,
    reason:projectedMarginSeconds>SILVER_ENTRY_TIME_BUFFER_SECONDS?check.reason:'SILVER_CROSSING_TIME_BUFFER',
    entryTimeBufferSeconds:SILVER_ENTRY_TIME_BUFFER_SECONDS,
    projectedCrossingSecondsFromNow,projectedMarginSeconds};
}
