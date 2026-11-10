import WebSocket from 'ws';
import { computeEMA, computeRSI, computeBollinger, buildCandles,
         patternScore, wickPressure, candleMomentum, computeRegime,
         computeATR, computeADX } from './indicators.js';
import { hmmUpdate } from './hmm.js';

const BINANCE_WS = 'wss://stream.binance.com:9443/stream';
const SAMPLE_INTERVAL_MS = 1000; // 1-second samples for indicator history
const BUFFER_SIZE = 200;          // 200 seconds of history

class BinanceFeed {
  constructor() {
    this.lastPrice = { BTC: null, ETH: null };
    this.buffer = { BTC: [], ETH: [] };
    this.hmmObs = { BTC: [], ETH: [] }; // rolling observation window for HMM
    this.ws = null;
    this.sampleTimer = null;
    this.reconnectTimer = null;
    this.connected = false;
    this.onFallback = null; // called when Binance drops, so Kraken can take over
  }

  connect() {
    this._open();
    this.sampleTimer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
  }

  _open() {
    const streams = 'btcusdt@aggTrade/ethusdt@aggTrade';
    this.ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`);

    this.ws.on('open', () => { this.connected = true; });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const price = parseFloat(msg.data?.p);
        if (!price) return;
        if (msg.stream === 'btcusdt@aggTrade') this.lastPrice.BTC = price;
        else if (msg.stream === 'ethusdt@aggTrade') this.lastPrice.ETH = price;
      } catch {}
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.onFallback?.();
      this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      this.connected = false;
      this.onFallback?.();
      this._scheduleReconnect();
    });
  }

  _sample() {this._diagnosticTicks = (this._diagnosticTicks ?? 0) + 1;

if (this._diagnosticTicks % 60 === 0) {
  for (const asset of ['BTC', 'ETH']) {
    console.log(
      `[PriceFeed] ${asset} samples=${this.buffer[asset].length} ready=${this.isReady(asset)} price=${this.lastPrice[asset] ?? 'none'}`
    );
  }
}
    for (const asset of ['BTC', 'ETH']) {
      if (this.lastPrice[asset] !== null) {
        this.buffer[asset].push(this.lastPrice[asset]);
        if (this.buffer[asset].length > BUFFER_SIZE) this.buffer[asset].shift();
      }
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), 3000);
  }

  // Inject a price from Kraken when Binance is down
  injectPrice(asset, price) {
    this.lastPrice[asset] = price;
  }

  getPrice(asset) { return this.lastPrice[asset]; }

  getVelocity(asset, seconds = 5) {
    const buf = this.buffer[asset];
    if (buf.length < seconds + 1) return 0;
    const cur = buf[buf.length - 1];
    const past = buf[buf.length - 1 - seconds];
    return (cur - past) / past * 100; // % change
  }

  getWindowDrift(asset, windowOpenPrice) {
    const cur = this.lastPrice[asset];
    if (!cur || !windowOpenPrice) return 0;
    return (cur - windowOpenPrice) / windowOpenPrice * 100; // % since window opened
  }

  getIndicators(asset) {
    const prices = this.buffer[asset];
    if (prices.length < 27) return null; // need at least 27 for EMA26

    const price = prices[prices.length - 1];
    const rsi = computeRSI(prices);
    const ema9  = computeEMA(prices, 9);
    const ema12 = computeEMA(prices, 12);
    const ema21 = computeEMA(prices, 21);
    const ema26 = computeEMA(prices, 26);
    const bb = computeBollinger(prices);
    const candles = buildCandles(prices, 5);
    const adxResult = computeADX(candles);

    // ATR on two windows: short (14) and long (28).
    // atrRatio = shortATR / longATR — >1 means currently more volatile than normal,
    // <1 means quieter. Used in farmBot for dynamic stop scaling.
    const atrShort = computeATR(candles, 14);
    const atrLong  = computeATR(candles, 28);
    const atrRatio = (atrShort !== null && atrLong !== null && atrLong > 0)
      ? atrShort / atrLong
      : 1.0;

    return {
      price,
      rsi,
      ema9, ema12, ema21, ema26,
      bb,
      candles,
      regime: computeRegime(prices),
      patternScore: patternScore(candles),
      wickPressure: wickPressure(candles),
      candleMomentum: candleMomentum(candles),
      atr: atrShort,
      atrRatio,   // short/long ATR ratio: >1 = currently volatile, <1 = quiet
      adx: adxResult?.adx ?? null,
    };
  }

  getRegime(asset) {
    return computeRegime(this.buffer[asset]);
  }

  // HMM-based regime detection — more stable than CV-based getRegime().
  // Returns { state: 'CALM'|'NORMAL'|'CHOPPY', confidence: 0–1 }
  // confidence < 0.5 = regime is transitioning/uncertain.
  getHMMRegime(asset) {
    const buf = this.buffer[asset];
    const ind = this.getIndicators(asset);
    if (!ind || buf.length < 6) return null;

    const price5ago  = buf[Math.max(0, buf.length - 6)];
    const momentum5  = price5ago > 0 ? (buf[buf.length - 1] - price5ago) / price5ago * 1000 : 0;
    return hmmUpdate(this.hmmObs[asset], ind.atrRatio ?? 1.0, momentum5);
  }

  isReady(asset) {
    return this.buffer[asset].length >= 27;
  }

  close() {
    clearInterval(this.sampleTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

export const priceFeed = new BinanceFeed();
