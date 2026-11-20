import { evaluateShrinkingCushion } from './shrinkingCushion.js';
import { wickMetrics } from '../research/btcWickStudy.js';

export const CRYPTO_WICK_ASSETS = ['SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'NEAR', 'ZEC'];
export const isCryptoWick = asset => CRYPTO_WICK_ASSETS.includes(asset);
export const cryptoWickEnabled = () => process.env.CRYPTO_WICK_LIVE_ENABLED === 'true';
export const CRYPTO_WICK_TIERS = [
  { bps: 50, budget: 10 },
  { bps: 37.5, budget: 5 },
  { bps: 25, budget: 2 },
];

export function cryptoWickTier({ history, asset, ticker, side, target, close, now, guards }) {
  const remaining = (close - now) / 1000;
  if (!(remaining > 0 && remaining < 180 && target > 0)) return null;
  let qualified = null;
  for (const tier of CRYPTO_WICK_TIERS) {
    const floor = target * tier.bps / 10000;
    const key = ticker + ':' + side + ':' + tier.bps;
    const check = evaluateShrinkingCushion({
      history, asset, ticker, side, target, minimumDistance: floor, secondsRemaining: remaining,
      now, previous: guards[key], requireLongRecovery: true, stabilizationSeconds: 5,
    });
    if (check.guardState) guards[key] = check.guardState;
    if (qualified || !check.allowed) continue;
    const wick = wickMetrics(history, now, target, side === 'yes' ? 1 : -1, close, floor);
    if (wick?.heldMs >= 5000) qualified = { ...check, ...tier, floor, wickHeldMs: wick.heldMs };
  }
  return qualified;
}
