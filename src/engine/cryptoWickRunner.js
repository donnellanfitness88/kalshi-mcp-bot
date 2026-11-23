import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHeaders } from '../kalshi/client.js';
import { benchmarkFeed } from '../prices/cfBenchmarks.js';
import { metalBook } from '../research/metalsObserver.js';
import { lateFee, lateStageSize, scalpExecutor } from './scalpExecution.js';
import { state } from './state.js';
import { CRYPTO_WICK_ASSETS as assets, ETH_WICK_PAPER_TIERS, cryptoWickEnabled, cryptoWickTier } from './cryptoWickTiers.js';

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
      history.set(asset, rows.filter(row => row.sourceTs >= at - 125000));
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

async function read(route, timeoutMs = 2500) {
  const response = await fetch('https://api.elections.kalshi.com/trade-api/v2' + route, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error('Market discovery HTTP ' + response.status);
  return response.json();
}

async function discover(asset, now, readMarket = read) {
  const data = metadata.get(asset) ?? { next: 0 };
  metadata.set(asset, data);
  if (now < data.next || Date.parse(data.market?.close_time) > now) return data;
  data.next = now + 15000;
  data.market = null;
  const ticker = 'KX' + asset + '15M';
  if (!data.series) {
    const series = (await readMarket('/series/' + ticker))?.series;
    if (series?.ticker !== ticker) return data;
    data.series = series;
  }
  const markets = (await readMarket('/markets?status=open&limit=50&series_ticker=' + ticker))?.markets;
  if (!Array.isArray(markets)) return data;
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

function startEthWickObserver() {
  const asset = 'ETH';
  const metadataTimeoutMs = 6500;
  const maxBookAgeMs = 2000;
  const minimumCushionBps = Math.min(...ETH_WICK_PAPER_TIERS.map(tier => tier.bps));
  const log = event => console.log('[ETH_WICK_PAPER] ' + JSON.stringify({ asset, ...event }));
  const directory = process.env.SCALP_STATE_DIR ?? fileURLToPath(new URL('../../data/', import.meta.url));
  const file = path.join(directory, 'eth_wick_paper.json');
  let positions = {};
  try {
    positions = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let reference = [];
  let guardTicker;
  let guards = {};
  let checkedMarket;
  let nextMarketCheck = 0;
  let nextSettlement = 0;
  let settling = false;
  let busy = false;

  async function readPaper(route, operation, timeoutMs = metadataTimeoutMs) {
    const startedAt = Date.now();
    try { return await read(route, timeoutMs); }
    catch (error) {
      log({ event: 'READ_ERROR', operation, elapsedMs: Date.now() - startedAt, timeoutMs,
        error: error.name, message: error.message });
      return null;
    }
  }

  function save(ticker, position) {
    const next = { ...positions, [ticker]: position };
    const settled = Object.keys(next).filter(key => next[key].result);
    for (const key of settled.slice(0, Math.max(0, settled.length - 192))) delete next[key];
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(next));
    fs.renameSync(file + '.tmp', file);
    positions = next;
  }

  function updateReference(now) {
    const latest = reference.at(-1)?.sourceTs ?? 0;
    reference = reference.concat(benchmarkFeed.getHistory(asset).filter(point => point.sourceTs > latest))
      .filter(point => point.sourceTs >= now - 125000);
  }

  async function settleDue(now) {
    if (settling || now < nextSettlement) return;
    settling = true;
    nextSettlement = now + 15000;
    try {
      for (const position of Object.values(positions)) {
        if (position.result || position.close > now) continue;
        const market = (await readPaper('/markets/' + position.ticker, 'SETTLEMENT'))?.market;
        if (market?.ticker !== position.ticker || market.status !== 'finalized' ||
            !['yes', 'no'].includes(market.result)) continue;
        const payout = market.result === position.side ? position.count : 0;
        const settled = { ...position, result: market.result, payout, pnl: payout - position.cost };
        save(position.ticker, settled);
        log({ event: 'SETTLED', ...settled });
      }
    } finally { settling = false; }
  }

  async function tickPaper() {
    const now = Date.now();
    updateReference(now);
    const { market, series } = await discover(asset, now,
      route => readPaper(route, route.startsWith('/series/') ? 'SERIES' : 'DISCOVERY'));
    const close = Date.parse(market?.close_time);
    const ticker = market?.ticker;
    const remaining = close - Date.now();
    if (!(remaining > 0 && remaining < 180000) || positions[ticker] ||
        series?.fee_type !== 'quadratic' || series.fee_multiplier == null) return;
    const feeMultiplier = Number(series.fee_multiplier);
    if (!Number.isFinite(feeMultiplier) || feeMultiplier < 0) return;
    if (guardTicker !== ticker) {
      guardTicker = ticker;
      guards = {};
      checkedMarket = null;
      nextMarketCheck = 0;
    }
    if (!checkedMarket && now >= nextMarketCheck) {
      nextMarketCheck = now + 5000;
      const details = (await readPaper('/markets/' + ticker, 'MARKET_DETAILS'))?.market;
      if (details?.ticker === ticker && ['open', 'active'].includes(details.status) &&
          details.strike_type === 'greater_or_equal' && Date.parse(details.close_time) === close &&
          Number.isFinite(Number(details.floor_strike)) && Number(details.floor_strike) > 0) {
        checkedMarket = details;
      }
    }
    if (!checkedMarket) return;
    const target = Number(checkedMarket.floor_strike);
    const checkedAt = Date.now();
    updateReference(checkedAt);
    const latest = reference.at(-1);
    if (!latest || !Number.isFinite(latest.price) || latest.sourceTs > checkedAt ||
        checkedAt - latest.sourceTs > 2000 ||
        Math.abs(latest.price - target) + 1e-9 < target * minimumCushionBps / 10000) return;
    const eligibleQuote = price => price >= 0.90 && price < 1 &&
      (close - Date.now() < 120000 || price <= 0.979);
    const readBook = async operation => {
      const requestedAt = Date.now();
      const data = await readPaper('/markets/' + ticker + '/orderbook?depth=1', operation, maxBookAgeMs);
      const book = data ? metalBook(data) : null;
      return Date.now() - requestedAt <= maxBookAgeMs && Date.now() < close ? book : null;
    };
    const tierFor = side => {
      const checkedAt = Date.now();
      updateReference(checkedAt);
      return cryptoWickTier({ history: reference, asset, ticker, side, target, close, now: checkedAt, guards });
    };
    const book = await readBook('ENTRY_BOOK');
    const side = ['yes', 'no'].find(key => eligibleQuote(book?.[key]?.price) && book[key].size >= 1);
    if (!side) return;
    const initialTier = tierFor(side);
    if (!initialTier?.allowed) return;
    const quote = (await readBook('CONFIRM_BOOK'))?.[side];
    if (!quote || !eligibleQuote(quote.price) || quote.price !== book[side].price) return;
    const finalTier = tierFor(side);
    if (!finalTier?.allowed) return;
    const tier = initialTier.budget <= finalTier.budget ? initialTier : finalTier;
    const { budget, bps } = tier;
    const count = Math.min(Math.floor(quote.size), lateStageSize(quote.price, budget, budget, feeMultiplier));
    const fee = lateFee(count, quote.price, feeMultiplier);
    if (count < 1 || count * (1 - quote.price) <= fee) return;
    const position = { ticker, close, side, target, bps, budget, price: quote.price, count, fee,
      cost: count * quote.price + fee, cushion: finalTier.currentCushion,
      wickHeldMs: finalTier.wickHeldMs, enteredAt: Date.now() };
    save(ticker, position);
    log({ event: 'ENTRY', ...position });
  }

  const run = async () => {
    // Public settlement requests should not consume the entry observer's polling slot.
    void settleDue(Date.now()).catch(error => log({ event: 'ERROR', operation: 'SETTLEMENT', message: error.message }));
    if (busy) return;
    busy = true;
    try { await tickPaper(); }
    catch (error) { log({ event: 'ERROR', message: error.message }); }
    finally { busy = false; }
  };
  log({ event: 'STARTED', paper: true, metadataTimeoutMs, maxBookAgeMs });
  void run();
  const timer = setInterval(run, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function startCryptoWickRunner() {
  const enabled = cryptoWickEnabled();
  let stopEthWickObserver;
  try { stopEthWickObserver = startEthWickObserver(); }
  catch (error) { console.warn('[ETH_WICK_PAPER] Startup failed', error.message); }
  if (enabled) { stopped = false; connect(); }
  console.log('[CRYPTO_WICK] ' + JSON.stringify({ event: 'STARTED', enabled, assets }));
  const run = () => void tick().catch(error => console.warn('[CRYPTO_WICK]', error.message));
  run();
  const timer = setInterval(run, 1000);
  timer.unref?.();
  return () => {
    stopEthWickObserver?.();
    stopped = true;
    clearInterval(timer);
    clearInterval(watchdog);
    clearTimeout(reconnect);
    socket?.terminate();
  };
}
