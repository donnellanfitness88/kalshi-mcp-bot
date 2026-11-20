import WebSocket from 'ws';
import { buildHeaders } from '../kalshi/client.js';
import { scalpExecutor } from './scalpExecution.js';
import { state } from './state.js';
import { CRYPTO_WICK_ASSETS as assets, cryptoWickEnabled } from './cryptoWickTiers.js';

const fast = ['SOL', 'XRP', 'DOGE'];
const slow = assets.filter(asset => !fast.includes(asset));
const indexId = asset => asset + 'USD_RTI';
const channel = asset => 'cfbenchmarks_value' + (fast.includes(asset) ? '_5hz' : '');
const history = new Map();
const metadata = new Map();
let socket;
let watchdog;
let reconnect;
let stopped = true;
let busy = false;

function connect() {
  if (stopped) return;
  history.clear();
  socket = new WebSocket('wss://external-api-ws.kalshi.com/trade-api/ws/v2', {
    headers: buildHeaders('GET', '/trade-api/ws/v2'),
    handshakeTimeout: 8000,
  });
  socket.on('open', () => {
    for (const [id, group] of [fast, slow].entries()) {
      socket.send(JSON.stringify({ id: id + 1, cmd: 'subscribe', params: {
        channels: [channel(group[0])], index_ids: group.map(indexId),
      } }));
    }
  });
  let lastMessage = Date.now();
  socket.on('message', raw => {
    lastMessage = Date.now();
    try {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'error') {
        console.warn('[CRYPTO_WICK] CF subscription error', frame.msg?.code);
        return;
      }
      const asset = assets.find(a => indexId(a) === frame.msg?.index_id);
      if (!asset || frame.type !== channel(asset)) return;
      const value = fast.includes(asset)
        ? { time: frame.msg.source_ts_ms, value: frame.msg.value_usd }
        : JSON.parse(frame.msg.data);
      const at = Date.now(), price = Number(value.value), sourceTime = value.time;
      if (!Number.isSafeInteger(sourceTime) || sourceTime > at || at - sourceTime > 2000 ||
          !Number.isFinite(price) || price <= 0) return;
      const rows = history.get(asset) ?? [];
      if (!rows.length) console.log('[CRYPTO_WICK] benchmark ready', asset, channel(asset));
      // Bucket the slower feed by UTC second for the guard's one-second lookbacks.
      const sourceTs = fast.includes(asset) ? sourceTime : Math.floor(sourceTime / 1000) * 1000;
      if (sourceTs <= (rows.at(-1)?.sourceTs ?? 0)) return;
      rows.push({ sourceTs, price });
      history.set(asset, rows.filter(row => row.sourceTs >= at - 65000));
    } catch { /* Malformed messages leave the last valid reading to expire. */ }
  });
  socket.on('error', error => console.warn('[CRYPTO_WICK] CF socket', error.message));
  socket.on('close', () => {
    clearInterval(watchdog);
    history.clear();
    if (!stopped) reconnect = setTimeout(connect, 3000);
  });
  watchdog = setInterval(() => {
    if (Date.now() - lastMessage > 15000) socket.terminate();
  }, 5000);
}

async function read(route) {
  const response = await fetch('https://api.elections.kalshi.com/trade-api/v2' + route, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error('Market discovery HTTP ' + response.status);
  return response.json();
}

async function discover(asset, now) {
  const data = metadata.get(asset) ?? { next: 0 };
  metadata.set(asset, data);
  if (now < data.next || Date.parse(data.market?.close_time) > now) return data;
  data.next = now + 15000;
  data.market = null;
  const ticker = 'KX' + asset + '15M';
  if (!data.series) {
    const { series } = await read('/series/' + ticker);
    if (series?.ticker !== ticker) return data;
    data.series = series;
  }
  const { markets } = await read('/markets?status=open&limit=50&series_ticker=' + ticker);
  data.market = markets.find(m => m.ticker?.startsWith(ticker + '-') &&
    Date.parse(m.open_time) <= now && Date.parse(m.close_time) > now &&
    Date.parse(m.close_time) - Date.parse(m.open_time) === 900000);
  return data;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const enabled = cryptoWickEnabled();
    const now = Date.now();
    await Promise.allSettled(enabled ? assets.map(asset => discover(asset, now)) : []);
    for (const asset of assets) {
      const s = state[asset], data = metadata.get(asset);
      const market = data?.market, close = Date.parse(market?.close_time);
      const remaining = close - Date.now();
      if (enabled && remaining > 0 && remaining < 180000) {
        s.ticker = market.ticker;
        s.marketCloseTs = close;
        s.lateFeeType = data.series.fee_type;
        s.lateFeeMultiplier = data.series.fee_multiplier == null ? NaN : Number(data.series.fee_multiplier);
      } else if (!s.activeTrade) {
        s.ticker = null;
      }
      if (s.activeTrade || (enabled && s.ticker && history.has(asset))) {
        await scalpExecutor.tick({ asset, s, balance: state.balance,
          getReferenceHistory: () => history.get(asset) ?? [] });
      }
    }
  } finally {
    busy = false;
  }
}

export function startCryptoWickRunner() {
  const enabled = cryptoWickEnabled();
  if (enabled) { stopped = false; connect(); }
  console.log('[CRYPTO_WICK] ' + JSON.stringify({ event: 'STARTED', enabled, assets }));
  const run = () => void tick().catch(error => console.warn('[CRYPTO_WICK]', error.message));
  run();
  const timer = setInterval(run, 1000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(watchdog);
    clearTimeout(reconnect);
    socket?.terminate();
  };
}
