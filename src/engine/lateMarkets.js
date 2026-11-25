import { CRYPTO_WICK_ASSETS } from './cryptoWickTiers.js';
export const PILOT_WICK_MARKETS = Object.freeze({
  WTI: {series:'KXWTI15M', exchangeIndex:2, minimumCushion:0.05, repeatedCrossingCushion:0.10},
  COPPER: {series:'KXCOPPER15M', exchangeIndex:2, minimumCushion:0.003, repeatedCrossingCushion:0.006},
  USDCAD: {series:'KXUSDCAD15M', exchangeIndex:0, minimumCushion:0.00015, repeatedCrossingCushion:0.00030}
});
export const FALLING_NINETY_BUDGET = 300;
export const fallingNinetyEnabled = () => process.env.PILOT_FALLING_NINETY_LIVE_ENABLED !== 'false';

export const PYTH_LIVE_MAX_HISTORY_GAP_MS = 2500;
export const PILOT_WICK_BUDGET = 100;
export const PILOT_WICK_CUTOFF_SECONDS = 30;
export const pilotWickEnabled = () => process.env.PILOT_WICK_LIVE_ENABLED !== 'false';

// Pyth-backed live settlement markets. Large BTC observation is deliberately absent.
export const LIVE_LATE_MARKETS = Object.freeze({
  GOLD: {series:'KXGOLD15M',exchangeIndex:2},
  SILVER: {series:'KXSILVER15M',exchangeIndex:2},
  EURUSD: {series:'KXEURUSD15M',exchangeIndex:0},
  USDJPY: {series:'KXUSDJPY15M',exchangeIndex:0},
  ...PILOT_WICK_MARKETS
});
export const MANAGED_ASSETS = ['BTC','ETH',...Object.keys(LIVE_LATE_MARKETS), ...CRYPTO_WICK_ASSETS];
export const fourMarketsEnabled = () => process.env.LATE_MARKETS_LIVE_ENABLED !== 'false';
export const exchangeForAsset = asset => LIVE_LATE_MARKETS[asset]?.exchangeIndex ?? 2;
export const isPilotWick = asset => Object.hasOwn(PILOT_WICK_MARKETS,asset);
export const isPythLateMarket = asset => Object.hasOwn(LIVE_LATE_MARKETS,asset);
export const isFourMarket = asset => isPythLateMarket(asset) && !isPilotWick(asset);
