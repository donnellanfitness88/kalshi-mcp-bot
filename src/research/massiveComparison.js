import WebSocket from 'ws';

const SYMBOLS = Object.freeze({'XAU-USD':'GOLD','XAG-USD':'SILVER','EUR-USD':'EURUSD','USD-JPY':'USDJPY'});
const ASSETS = Object.values(SYMBOLS);
const ENDPOINT = 'wss://socket.massive.com/forex';
const MAX_AGE_MS = 2000;
const RETENTION_MS = 65000;
const MAX_POINTS = 8000;

function assetForPair(pair) {
  if (typeof pair !== 'string') return null;
  const symbol = pair.replace('/', '-');
  return Object.hasOwn(SYMBOLS,symbol) ? SYMBOLS[symbol] : null;
}

// Compare source timestamps against the existing shrinking-cushion history tolerances.
function describe(history, now, target) {
  const last = history?.at(-1);
  const ageMs = last ? now - last.sourceAt : null;
  if (ageMs === null || ageMs < 0 || ageMs > MAX_AGE_MS)
    return {ageMs, fresh:false, side:null, historyReady:false};
  const cutoff = last.sourceAt - 60000;
  const first = history.findLastIndex(point => point.sourceAt <= cutoff);
  let maxGapMs = null;
  if (first >= 0 && cutoff - history[first].sourceAt <= 500) {
    maxGapMs = 0;
    for (let i = first + 1; i < history.length; i++)
      maxGapMs = Math.max(maxGapMs, history[i].sourceAt - history[i-1].sourceAt);
  }
  const checkpoints = [3000,15000].every(ms => {
    const at = last.sourceAt - ms;
    const point = history.findLast(row => row.sourceAt <= at);
    return Boolean(point && at - point.sourceAt <= 500);
  });
  const distance = target === null ? null : last.price - target;
  return {price:last.price, sourceAt:last.sourceAt, ageMs, fresh:true, distance,
    side:distance === null ? null : distance > 0 ? 'yes' : distance < 0 ? 'no' : 'at_strike',
    maxGapMs, historyReady:checkpoints && maxGapMs !== null && maxGapMs <= 1500};
}

// Reads existing public-market state and logs prices. No order book or trading API calls.
export class MassiveComparison {
  constructor(observer, {Socket=WebSocket, now=Date.now}={}) {
    Object.assign(this,{observer,Socket,now});
    this.history = Object.fromEntries(ASSETS.map(asset => [asset,[]]));
    this.quoteWarnings = new Set();
  }

  warnQuote(asset,reason,ageMs) {
    const key = asset+':'+reason;
    if (this.quoteWarnings.has(key)) return;
    this.quoteWarnings.add(key);
    this.observer.emit({event:'MASSIVE_QUOTE_REJECTED',asset,reason,ageMs});
  }

  ingest(quote) {
    if (quote.ev !== 'C') return;
    const asset = assetForPair(quote.p);
    if (!asset) {
      this.warnQuote('UNKNOWN','UNRECOGNIZED_PAIR',null);
      return;
    }
    const {b:bid,a:ask,t:sourceAt} = quote;
    const age = Number.isSafeInteger(sourceAt) ? this.now() - sourceAt : null;
    if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask < bid ||
        age === null) {
      this.warnQuote(asset,'INVALID_FIELDS',age);
      return;
    }
    if (age < 0 || age > MAX_AGE_MS) {
      this.warnQuote(asset,age < 0 ? 'FUTURE_TIMESTAMP' : 'STALE_TIMESTAMP',age);
      return;
    }
    const history = this.history[asset], last = history.at(-1);
    if (last && sourceAt < last.sourceAt) return;
    const point = {price:(bid+ask)/2,bid,ask,sourceAt};
    if (last?.sourceAt === sourceAt) history[history.length-1] = point;
    else history.push(point);
    if (sourceAt - history[0].sourceAt > RETENTION_MS + 1000 || history.length > MAX_POINTS) {
      const start = history.findIndex(row => sourceAt-row.sourceAt <= RETENTION_MS);
      history.splice(0,Math.max(start,history.length-MAX_POINTS));
    }
    if (!last) this.observer.emit({event:'MASSIVE_FIRST_QUOTE',asset,sourceAt});
  }

  sample() {
    const at = this.now();
    for (const asset of ASSETS) {
      const market = this.observer.current[asset];
      if (!market) continue;
      const secondsRemaining = (Date.parse(market.close_time)-at)/1000;
      if (!(secondsRemaining > 0 && secondsRemaining < 180)) continue;
      const strike = this.observer.state.markets[market.ticker]?.target;
      const target = Number.isFinite(strike) && strike > 0 ? strike : null;
      const massive = describe(this.history[asset],at,target);
      const pyth = describe(this.observer.proxy?.history?.[asset],at,target);
      this.observer.emit({event:'MASSIVE_FEED_COMPARE',asset,ticker:market.ticker,target,secondsRemaining,
        massive,pyth,priceDifference:massive.fresh && pyth.fresh ? massive.price-pyth.price : null,
        strikeSideAgreement:massive.side !== null && pyth.side !== null ? massive.side === pyth.side : null});
    }
  }

  start(key) {
    if (!key) {
      this.observer.emit({event:'MASSIVE_COMPARISON_DISABLED',reason:'MASSIVE_API_KEY_NOT_SET'});
      return this;
    }
    this.stopped = false;
    this.connect(key);
    this.timer = setInterval(() => this.sample(),5000);
    this.timer.unref?.();
    return this;
  }

  connect(key) {
    const socket = new this.Socket(ENDPOINT,{handshakeTimeout:10000,maxPayload:1048576});
    this.socket = socket;
    let alive = true, rejected = false, authenticated = false;
    this.heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      if (socket.readyState === 1) { alive = false; socket.ping(); }
    },15000);
    this.heartbeat.unref?.();
    socket.on('pong',() => { alive = true; });
    socket.on('open',() => socket.send(JSON.stringify({action:'auth',params:key})));
    socket.on('message',data => {
      let events;
      try { events = JSON.parse(data.toString()); } catch { return; }
      if (!Array.isArray(events)) return;
      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        if (event.ev === 'status') {
          if (event.status === 'auth_success' && !authenticated) {
            authenticated = true;
            socket.send(JSON.stringify({action:'subscribe',params:Object.keys(SYMBOLS).map(pair => 'C.'+pair).join(',')}));
            this.observer.emit({event:'MASSIVE_CONNECTED',assets:ASSETS});
          } else if (event.status === 'success' && typeof event.message === 'string' &&
                     event.message.startsWith('subscribed to:')) {
            const assets = [...event.message.matchAll(/C[.]([A-Z]{3}[-/][A-Z]{3})/g)]
              .map(match => assetForPair(match[1])).filter(Boolean);
            if (assets.length) this.observer.emit({event:'MASSIVE_SUBSCRIPTION_CONFIRMED',assets});
          } else if (event.status === 'auth_failed' || event.status === 'not_authorized') {
            rejected = true;
            this.observer.emit({event:'MASSIVE_ACCESS_REJECTED',status:event.status});
            socket.close();
          } else if (event.status === 'error') {
            this.observer.emit({event:'MASSIVE_SUBSCRIPTION_ERROR'});
          }
        } else if (authenticated) this.ingest(event);
      }
    });
    socket.on('error',() => this.observer.emit({event:'MASSIVE_SOCKET_ERROR'}));
    socket.on('close',() => {
      clearInterval(this.heartbeat);
      if (!this.stopped && !rejected) {
        this.retry = setTimeout(() => this.connect(key),10000);
        this.retry.unref?.();
      }
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    this.socket?.terminate();
  }
}
