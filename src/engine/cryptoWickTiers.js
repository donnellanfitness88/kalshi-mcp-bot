import { evaluateShrinkingCushion } from './shrinkingCushion.js';
import { wickMetrics } from '../research/btcWickStudy.js';

export const CRYPTO_WICK_ASSETS = ['SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'NEAR', 'ZEC'];
export const isCryptoWick = asset => CRYPTO_WICK_ASSETS.includes(asset);
export const cryptoWickEnabled = () => process.env.CRYPTO_WICK_LIVE_ENABLED === 'true';
export const CRYPTO_WICK_TIERS = [{ bps: 32.5, budget: 200 }];

export const ETH_WICK_PAPER_TIERS = [
  { bps: 50, budget: 100 },
  { bps: 37.5, budget: 50 },
  { bps: 32.5, budget: 20 },
];

const cooldownSeconds = 60;
const openingShockBps = 55;
const recentShockBps = 25;
const shockRangeMultiple = 2;

export function cryptoWickCooldown({ history, asset, ticker, side, target, now, remaining, guards }) {
  if (remaining <= cooldownSeconds) return null;
  const key = asset + ':' + side + ':cooldown';
  if (guards[key]?.ticker === ticker) return guards[key];
  const latest = history.at(-1);
  if (!latest || latest.sourceTs > now || now - latest.sourceTs > 2000) return null;
  const sign = side === 'yes' ? 1 : -1;
  const openingBps = sign * (latest.price - target) / target * 10000;
  const minuteAgo = latest.sourceTs - 60000;
  const previous = history.findLast(point => point.sourceTs <= minuteAgo);
  const baseline = history.filter(point => point.sourceTs >= minuteAgo - 60000 &&
    point.sourceTs <= minuteAgo);
  const coverage = baseline.length > 1 && baseline[0].sourceTs <= minuteAgo - 58500 &&
    baseline.at(-1).sourceTs >= minuteAgo - 1500 &&
    baseline.every((point, index) => !index || point.sourceTs - baseline[index - 1].sourceTs <= 1500);
  let recentBps = null, baselineRangeBps = null;
  if (coverage && previous && minuteAgo - previous.sourceTs <= 1500) {
    recentBps = sign * (latest.price - previous.price) / target * 10000;
    const prices = baseline.map(point => point.price);
    baselineRangeBps = (Math.max(...prices) - Math.min(...prices)) / target * 10000;
  }
  const openingShock = openingBps >= openingShockBps;
  const recentShock = recentBps !== null && recentBps >= recentShockBps &&
    recentBps >= shockRangeMultiple * baselineRangeBps;
  if (!openingShock && !recentShock) return null;
  const block = { allowed: false, reason: 'CRYPTO_WICK_POST_MOVE_COOLDOWN', ticker, side,
    openingBps, recentBps, baselineRangeBps, recheckSeconds: cooldownSeconds };
  guards[key] = block;
  return block;
}

export function cryptoWickTier({ history, asset, ticker, side, target, close, now, guards }) {
  const remaining = (close - now) / 1000;
  if (!(remaining > 0 && remaining < 180 && target > 0)) return null;
  const cooldown = cryptoWickCooldown({ history, asset, ticker, side, target, now, remaining, guards });
  if (cooldown) return cooldown;
  let qualified = null;
  const isEthPaper = asset === 'ETH';
  const tiers = isEthPaper ? ETH_WICK_PAPER_TIERS : CRYPTO_WICK_TIERS;
  for (const tier of tiers) {
    const floor = target * tier.bps / 10000;
    const key = ticker + ':' + side + ':' + tier.bps;
    const check = evaluateShrinkingCushion({
      history, asset, ticker, side, target, minimumDistance: floor, secondsRemaining: remaining,
      now, previous: guards[key], requireLongRecovery: true, stabilizationSeconds: 5,
    });
    if (check.guardState) guards[key] = check.guardState;
    if (qualified || !check.allowed || (!isEthPaper && check.currentCushion <= floor + 1e-9)) continue;
    const wick = wickMetrics(history, now, target, side === 'yes' ? 1 : -1, close, floor);
    if (wick?.heldMs >= 5000) qualified = { ...check, ...tier, floor, wickHeldMs: wick.heldMs };
  }
  return qualified;
}
