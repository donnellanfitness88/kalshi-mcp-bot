// One coordinator for all balance callers. No completed-response cache and no
// order retries: a caller either gets a fresh successful read or an error.
export function createBalanceReader({read, now=()=>performance.now(),
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  log=message=>console.warn('[Balance] '+message),
  minimumIntervalMs=1100, maxRetries=2, maxBackoffMs=5000}={}) {
  if(typeof read!=='function') throw new TypeError('Balance reader requires a read function');
  let inFlight=null, nextAllowedAt=0;
  async function run() {
    for(let attempt=0;;attempt++) {
      while(now()<nextAllowedAt) await sleep(nextAllowedAt-now());
      try {
        const balance=await read();
        if(!Number.isSafeInteger(balance) || balance<0) throw new Error('Invalid Kalshi balance response');
        nextAllowedAt=now()+minimumIntervalMs;
        return balance;
      } catch(error) {
        nextAllowedAt=Math.max(nextAllowedAt,now()+minimumIntervalMs);
        if(error?.httpStatus!==429) throw error;
        const reset=Number.isFinite(error.rateLimitResetMs)?Math.max(0,error.rateLimitResetMs):0;
        const delay=Math.min(maxBackoffMs,Math.max(minimumIntervalMs*2**attempt,reset));
        nextAllowedAt=Math.max(nextAllowedAt,now()+delay);
        if(attempt>=maxRetries) throw error;
        log(`Rate-limited balance read; waiting ${Math.ceil(delay)}ms before retry ${attempt+1}/${maxRetries}`);
      }
    }
  }
  return function getBalanceCoordinated() {
    if(!inFlight) inFlight=run().finally(()=>{inFlight=null;});
    return inFlight;
  };
}
