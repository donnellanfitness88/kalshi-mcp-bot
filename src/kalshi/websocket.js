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
    this._heartbeatTimer = null; 
this._diagReceived = 0;
this._diagValid = 0;
this._diagLastReport = Date.now();
    
this._diagReasons = {};

// watchdog — triggers reconnect if feed goes silent

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
    this._lastBookSeq = null;
    this._wasCrossed = false;

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
  
  try {
        const msg = JSON.parse(data.toString());


if (
  msg.type === 'subscribed' ||
  msg.type === 'error' ||
  msg.type === 'orderbook_snapshot'
) {
  console.log(
    `[WS-DIAG] ticker=${this.ticker}` +
    ` type=${msg.type}` +
    ` market=${msg.msg?.market_ticker ?? 'none'}` +
    ` sid=${msg.msg?.sid ?? 'none'}`
  );
}

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

if (
  type === 'orderbook_snapshot' ||
  type === 'orderbook_delta'
) {
  this._diagReceived++;
  this._resetHeartbeat();
}



    // Capture subscription ID from server ack — needed for clean unsubscribe on ticker switch
    if (type === 'subscribed') {
      this._sid = msg.msg?.sid ?? null;
      return;
    }

    const data = msg?.msg;
    if (!data) return;
if (data.market_ticker && data.market_ticker !== this.ticker) return;

if (type === 'orderbook_snapshot') {
  this._lastBookSeq = msg.seq;
}

if (type === 'orderbook_delta') {
  if (!Number.isSafeInteger(msg.seq)) {
    console.warn('[WS-SEQ] Missing or invalid sequence number');
    this._open();
    return;
  }

  if (this._lastBookSeq === null) {
    console.warn('[WS-SEQ] Delta received before snapshot');
    this._open();
    return;
  }

  if (msg.seq !== this._lastBookSeq + 1) {
    console.warn(
      `[WS-SEQ] Gap detected: expected ${this._lastBookSeq + 1}, got ${msg.seq}`
    );
    this._open();
    return;
  }

  this._lastBookSeq = msg.seq;
}

    if (type === 'orderbook_snapshot') {
      // Populate orderbook from snapshot.
      // yes_dollars_fp: [[price_dollars, qty], ...] — YES bids
      // no_dollars_fp:  [[price_dollars, qty], ...] — NO bids
      this._yesBook.clear();
      this._noBook.clear();

      if (Array.isArray(data.yes_dollars_fp)) {
        for (const [price, qty] of data.yes_dollars_fp) {
          const q = parseFloat(qty);
          if (q > 0) this._yesBook.set(Number(price), q);
        }
      }
      if (Array.isArray(data.no_dollars_fp)) {
        for (const [price, qty] of data.no_dollars_fp) {
          const q = parseFloat(qty);
          if (q > 0) this._noBook.set(Number(price), q);
        }
      }
    } else if (type === 'orderbook_delta') {
      // Apply delta to the relevant book.
      // side: "yes" → YES book, side: "no" → NO book
      const price = Number(data.price_dollars);
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

if (type === 'orderbook_delta') {
  const bestYes = Math.max(
  ...Array.from(this._yesBook.keys(), Number)
);
const bestNo = Math.max(
  ...Array.from(this._noBook.keys(), Number)
);

  const crossed = Number.isFinite(bestYes) &&
    Number.isFinite(bestNo) &&
    bestYes + bestNo > 1 + 1e-9;

  if (crossed && !this._wasCrossed) {
    console.warn(
      `[WS-FIRST-CROSS] ticker=${this.ticker}` +
      ` seq=${msg.seq}` +
      ` side=${data.side}` +
      ` price=${data.price_dollars}` +
      ` delta=${data.delta_fp}` +
      ` bestYes=${bestYes}` +
      ` bestNo=${bestNo}` +
      ` yesLevels=${this._yesBook.size}` +
      ` noLevels=${this._noBook.size}`
    );
  }

  this._wasCrossed = crossed;
}

    const { yesAsk, yesBid } = this._bestPrices();
    
if (type === 'orderbook_snapshot') {
  console.log(
    `[WS-SNAPSHOT-CHECK] ticker=${this.ticker}` +
    ` seq=${msg.seq}` +
    ` yesBid=${yesBid}` +
    ` yesAsk=${yesAsk}` +
    ` yesLevels=${this._yesBook.size}` +
    ` noLevels=${this._noBook.size}` +
    ` crossed=${yesBid !== null &&
      yesAsk !== null &&
      yesBid - yesAsk > 1e-9}`
  );
}

if (yesAsk !== null && yesBid !== null) {
  this._diagValid++;
  this.onPrice(yesAsk, yesBid, data.market_ticker || this.ticker);
}

if (Date.now() - this._diagLastReport >= 30000) {
  console.log(
    `[WS-HEALTH] ticker=${this.ticker}` +
    ` received=${this._diagReceived}` +
    ` valid=${this._diagValid}` +
    ` invalid=${this._diagReceived - this._diagValid}`
  );

console.log(
  `[WS-REASONS] ticker=${this.ticker}` +
  ` reasons=${JSON.stringify(this._diagReasons)}`
);

this._diagReasons = {};

  this._diagReceived = 0;
  this._diagValid = 0;
  this._diagLastReport = Date.now();
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
  const invalid = (reason) => {
    this._diagReasons[reason] =
      (this._diagReasons[reason] || 0) + 1;

    return { yesAsk: null, yesBid: null };
  };

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

  if (bestYesBid === -Infinity) {
    return invalid('EMPTY_YES_BOOK');
  }

  const yesBid = bestYesBid;

  const yesAsk =
    bestNoBid !== -Infinity
      ? 1 - bestNoBid
      : Math.min(0.99, bestYesBid + 0.01);

  if (!Number.isFinite(yesBid) ||
      !Number.isFinite(yesAsk)) {
    return invalid('NONFINITE_PRICE');
  }

  if (yesBid <= 0 || yesBid >= 1 ||
      yesAsk <= 0 || yesAsk >= 1) {
    return invalid('OUT_OF_RANGE');
  }

  
if (yesBid - yesAsk > 1e-9) {
  const now = Date.now();

  if (!this._lastCrossedLog ||
      now - this._lastCrossedLog >= 30000) {
    console.warn(
      `[WS-CROSSED] ticker=${this.ticker}` +
      ` yesBid=${yesBid.toFixed(4)}` +
      ` yesAsk=${yesAsk.toFixed(4)}` +
      ` noBid=${bestNoBid.toFixed(4)}` +
      ` yesLevels=${this._yesBook.size}` +
      ` noLevels=${this._noBook.size}`
    );
    this._lastCrossedLog = now;
  }

  return invalid('CROSSED_BOOK');
}


  return { yesAsk, yesBid };
}

  
switchTicker(newTicker) {
  if (newTicker === this.ticker) return;

  this.ticker = newTicker;
  this._clearHeartbeat();
  clearTimeout(this.reconnectTimer);
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
