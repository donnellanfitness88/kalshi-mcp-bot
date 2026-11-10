import WebSocket from 'ws';
import { buildHeaders } from './client.js';

const WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const RECONNECT_DELAY_MS  = 500;
const HEARTBEAT_TIMEOUT_MS = 30_000; // force reconnect if no orderbook message for 5s
// WHY these values: STALE_PRICE exit fires after 30s of no price updates.
// Old values (15s timeout + 3s delay) left only ~10s margin before the stale exit fired,
// and Kalshi sometimes takes 5-8s to deliver the first message after reconnect.
// New values: silence detected at 5s, reconnected by 5.5s, first message by ~8-10s —
// well within the 30s stale window. Reconnect is cheap; firing STALE_PRICE is not.

export class KalshiWebSocket {
  constructor(onPrice) {
    this.onPrice = onPrice;  // callback(yesAsk, yesBid, ticker)
    this.ticker = null;
    this.ws = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.cmdSeq = 1;
    this._sid = null;  // subscription ID returned by server — needed for unsubscribe
    this._heartbeatTimer = null; // watchdog — triggers reconnect if feed goes silent

    // In-memory orderbook: price (as string) → quantity (as float)
    // yesBook: bids for YES contracts
    // noBook:  bids for NO contracts (best NO bid = 1 - best YES ask)
    this._yesBook = new Map();
    this._noBook  = new Map();
  }

  connect(ticker) {
    this.ticker = ticker;
    this.intentionalClose = false;
    this._open();
  }

  _open() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {}); // prevent unhandled error on close-before-open
      this.ws.close();
    }

    // Reset orderbook and subscription state on reconnect
    this._yesBook.clear();
    this._noBook.clear();
    this._sid = null;

    const headers = buildHeaders('GET', '/trade-api/ws/v2');
    this.ws = new WebSocket(WS_URL, { headers });

    this.ws.on('open', () => {
      this._subscribe(this.ticker);
      this._resetHeartbeat();
    });

    // Kalshi sends Ping frames (0x9) every 10s with body "heartbeat".
    // Must respond with Pong or the server closes the connection.
    this.ws.on('ping', () => {
      this.ws.pong();
    });

    this.ws.on('message', (data) => {
  this._resetHeartbeat();
  try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', () => {
      this._clearHeartbeat();
      if (!this.intentionalClose) this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      this._clearHeartbeat();
      if (!this.intentionalClose) this._scheduleReconnect();
    });
  }

  _subscribe(ticker) {
    const msg = {
      id: this.cmdSeq++,
      cmd: 'subscribe',
      params: { channels: ['orderbook_delta'], market_tickers: [ticker] },
    };
    this.ws.send(JSON.stringify(msg));
  }

  _unsubscribe(sid) {
    const msg = {
      id: this.cmdSeq++,
      cmd: 'unsubscribe',
      params: { sids: [sid] },
    };
    this.ws.send(JSON.stringify(msg));
  }

  _handleMessage(msg) {
    const type = msg?.type;

    // Capture subscription ID from server ack — needed for clean unsubscribe on ticker switch
    if (type === 'subscribed') {
      this._sid = msg.msg?.sid ?? null;
      return;
    }

    const data = msg?.msg;
    if (!data) return;

    if (type === 'orderbook_snapshot') {
      // Populate orderbook from snapshot.
      // yes_dollars_fp: [[price_dollars, qty], ...] — YES bids
      // no_dollars_fp:  [[price_dollars, qty], ...] — NO bids
      this._yesBook.clear();
      this._noBook.clear();

      if (Array.isArray(data.yes_dollars_fp)) {
        for (const [price, qty] of data.yes_dollars_fp) {
          const q = parseFloat(qty);
          if (q > 0) this._yesBook.set(price, q);
        }
      }
      if (Array.isArray(data.no_dollars_fp)) {
        for (const [price, qty] of data.no_dollars_fp) {
          const q = parseFloat(qty);
          if (q > 0) this._noBook.set(price, q);
        }
      }
    } else if (type === 'orderbook_delta') {
      // Apply delta to the relevant book.
      // side: "yes" → YES book, side: "no" → NO book
      const price = data.price_dollars;
      const delta = parseFloat(data.delta_fp ?? '0');
      const book  = data.side === 'yes' ? this._yesBook : this._noBook;

      if (price != null) {
        const current = book.get(price) ?? 0;
        const updated = current + delta;
        if (updated <= 0) book.delete(price);
        else              book.set(price, updated);
      }
    } else {
      // Not a price message we care about
      return;
    }

    // Compute best bid/ask from current orderbook state
    const { yesAsk, yesBid } = this._bestPrices();
    if (yesAsk !== null && yesBid !== null) {
      this._resetHeartbeat(); // feed is live — reset watchdog
      this.onPrice(yesAsk, yesBid, data.market_ticker || this.ticker);
    }
  }

  /**
   * Compute best YES bid and best YES ask.
   *
   * Best YES bid  = highest price in yesBook (buyers paying the most for YES)
   * Best YES ask  = 1 - highest price in noBook
   *                 (sellers of YES = buyers of NO; best NO bid implies best YES ask)
   */
  _bestPrices() {
    let bestYesBid = -Infinity;
    for (const price of this._yesBook.keys()) {
      const p = parseFloat(price);
      if (p > bestYesBid) bestYesBid = p;
    }

    let bestNoBid = -Infinity;
    for (const price of this._noBook.keys()) {
      const p = parseFloat(price);
      if (p > bestNoBid) bestNoBid = p;
    }

    // Need at least the YES book to compute a price
    if (bestYesBid === -Infinity) return { yesAsk: null, yesBid: null };

    const yesBid = bestYesBid;
    let yesAsk;

    if (bestNoBid !== -Infinity) {
      // Normal case: derive ask from best NO bid
      yesAsk = 1 - bestNoBid;
    } else {
      // NO book is empty (thin market / extreme probability).
      // Estimate ask = best YES bid + 1¢ minimum spread.
      yesAsk = Math.min(0.99, bestYesBid + 0.01);
    }

    // Sanity check
    if (yesBid <= 0 || yesBid >= 1 || yesAsk <= 0 || yesAsk >= 1 || yesAsk < yesBid) {
      return { yesAsk: null, yesBid: null };
    }

    return { yesAsk, yesBid };
  }

  // Call this when the 15-minute window rolls and a new ticker is active.
  // Unsubscribes from the old ticker first to avoid duplicate orderbook feeds.
  switchTicker(newTicker) {
    this.ticker = newTicker;
    this._yesBook.clear();
    this._noBook.clear();
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this._sid !== null) {
        this._unsubscribe(this._sid);
        this._sid = null;
      }
      this._subscribe(newTicker);
    } else {
      this._open();
    }
  }

  _resetHeartbeat() {
    clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      // No orderbook message for HEARTBEAT_TIMEOUT_MS — zombie connection, force reconnect
      console.log(`[WS] Heartbeat timeout for ${this.ticker} — forcing reconnect`);
      this._clearHeartbeat();
      this._open();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _clearHeartbeat() {
    clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), RECONNECT_DELAY_MS);
  }

  close() {
    this.intentionalClose = true;
    this._clearHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
