import { CRYPTO_WICK_ASSETS } from './cryptoWickTiers.js';
// The four approved live markets. Large BTC observation is deliberately absent.
export const LIVE_LATE_MARKETS = Object.freeze({
  GOLD: {series:'KXGOLD15M',exchangeIndex:2},
  SILVER: {series:'KXSILVER15M',exchangeIndex:2},
  EURUSD: {series:'KXEURUSD15M',exchangeIndex:0},
  USDJPY: {series:'KXUSDJPY15M',exchangeIndex:0}
});
export const MANAGED_ASSETS = ['BTC','ETH',...Object.keys(LIVE_LATE_MARKETS), ...CRYPTO_WICK_ASSETS];
export const fourMarketsEnabled = () => process.env.LATE_MARKETS_LIVE_ENABLED !== 'false';
export const exchangeForAsset = asset => LIVE_LATE_MARKETS[asset]?.exchangeIndex ?? 2;
export const isFourMarket = asset => Object.hasOwn(LIVE_LATE_MARKETS,asset);
