import WebSocket from 'ws';
import { buildHeaders } from '../kalshi/client.js';

const URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const INDEX_ASSETS = { BRTI: 'BTC', ETHUSD_RTI: 'ETH' };
export const BENCHMARK_MAX_AGE_MS = 2000;

// This feed is independent of the Binance/Kraken indicator feed. Never silently
// substitute a different exchange price for the settlement reference index.
export class BenchmarkFeed {
  constructor({ Socket = WebSocket, headers = buildHeaders, now = Date.now,
    log = message => console.log('[CF] ' + message) } = {}) {
    Object.assign(this, { Socket, headers, now, log });
    this.history = {}; this.quotes = {}; this.ws = null; this.closed = true;
    this.reconnectTimer = null; this.watchdog = null;
    this.btcDiagnostics = { connectionAttempts: 0, rejected: {}, capacityTrimmed: 0 };
  }
  ingest(frame) {
    if (frame?.type !== 'cfbenchmarks_value_5hz') return false;
    const m = frame.msg, asset = INDEX_ASSETS[m?.index_id];
    const price = typeof m?.value_usd === 'string' && m.value_usd.trim() ? Number(m.value_usd) : NaN;
    const sourceTs = m?.source_ts_ms, now = this.now();
    if (!asset) return false;
    const diagnostics = asset === 'BTC' ? this.btcDiagnostics : null;
    if (diagnostics) diagnostics.lastFrameAt = now;
    const rejection = !Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(sourceTs) ? 'invalid' :
      sourceTs > now ? 'future' :
      now - sourceTs > BENCHMARK_MAX_AGE_MS ? 'stale' :
      sourceTs <= (this.quotes[asset]?.sourceTs ?? 0) ? 'duplicate_or_out_of_order' : null;
    if (rejection) {
      if (diagnostics) {
        diagnostics.rejected[rejection] = (diagnostics.rejected[rejection] ?? 0) + 1;
        diagnostics.lastRejected = { reason: rejection, receivedAt: now,
          sourceTs: Number.isSafeInteger(sourceTs) ? sourceTs : null };
      }
      return false;
    }
    const first = !this.quotes[asset];
    const retained = [...(this.history[asset] ?? []), {price,sourceTs}]
      .filter(p => p.sourceTs >= sourceTs-65000);
    if (diagnostics) diagnostics.capacityTrimmed += Math.max(0, retained.length - 500);
    this.history[asset] = retained.slice(-500);
    this.quotes[asset] = { price, sourceTs, receivedAt: now, source: 'CF_BENCHMARKS' };
    if (first) this.log(`${asset} reference ready (${m.index_id})`);
    return true;
  }
  getHistory(asset) { return (this.history[asset] ?? []).map(p => ({...p})); }
  getQuote(asset) {
    const q = this.quotes[asset], now = this.now();
    if (!q || now < q.sourceTs || now - q.sourceTs > BENCHMARK_MAX_AGE_MS ||
        now - q.receivedAt > BENCHMARK_MAX_AGE_MS) return null;
    return { ...q };
  }
  getBtcDiagnostics() {
    const now = this.now(), quote = this.quotes.BTC, rows = this.history.BTC ?? [];
    return { ...this.btcDiagnostics, rejected: { ...this.btcDiagnostics.rejected },
      firstHistorySourceTs: rows[0]?.sourceTs ?? null, historyPoints: rows.length,
      lastSourceTs: quote?.sourceTs ?? null, lastReceivedAt: quote?.receivedAt ?? null,
      sourceAgeMs: quote ? now - quote.sourceTs : null,
      receiveAgeMs: quote ? now - quote.receivedAt : null };
  }
  resetHistory(reason) {
    this.btcDiagnostics.lastReset = { reason, at: this.now() };
    this.history = {}; this.quotes = {};
  }
  connect() {
    if (!this.closed) return;
    this.closed = false; this.open();
  }
  open() {
    if (this.closed) return;
    this.btcDiagnostics.connectionAttempts++;
    this.resetHistory('connection_attempt');
    try {
      const ws = new this.Socket(URL, { headers: this.headers('GET', '/trade-api/ws/v2') });
      this.ws = ws;
      let lastMessage = this.now();
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: {
        channels: ['cfbenchmarks_value_5hz'], index_ids: ['BRTI', 'ETHUSD_RTI']
      } })));
      ws.on('ping', () => ws.pong());
      ws.on('message', raw => {
        if (this.ws !== ws) return;
        lastMessage = this.now();
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'error') {
            this.log('Reference subscription rejected; late buys remain blocked');
            ws.terminate(); return;
          }
          this.ingest(frame);
        } catch { /* Invalid data cannot refresh a reference quote. */ }
      });
      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.btcDiagnostics.lastDisconnectAt = this.now();
        this.resetHistory('socket_close'); clearInterval(this.watchdog); this.watchdog = null;
        this.schedule();
      });
      ws.on('error', () => { if (this.ws === ws) { this.resetHistory('socket_error'); ws.terminate(); } });
      clearInterval(this.watchdog);
      this.watchdog = setInterval(() => {
        if (this.now() - lastMessage > 15000) ws.terminate();
      }, 5000);
      this.watchdog.unref?.();
    } catch {
      this.log('Reference connection unavailable; late buys remain blocked');
      this.schedule();
    }
  }
  schedule() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.open(); }, 3000);
    this.reconnectTimer.unref?.();
  }
  close() {
    this.closed = true; clearTimeout(this.reconnectTimer); clearInterval(this.watchdog);
    this.reconnectTimer = null; this.watchdog = null; this.resetHistory('feed_stop');
    const ws = this.ws; this.ws = null; ws?.terminate();
  }
}
export const benchmarkFeed = new BenchmarkFeed();
