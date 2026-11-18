import { buildFeatures, buildFeaturesNorm } from '../nn/features.js';
import { predict } from '../nn/network.js';
import { executeBuy } from '../kalshi/orders.js';
import { checkRiskGuards } from './riskManager.js';
import { priceFeed } from '../prices/binance.js';
import { getParams } from '../research/params.js';

const COOLDOWN_MS  = 60_000; // 60s between auto-buy fires
const COUNTDOWN_S  = 3;      // 3-second countdown before firing
const VEL_FLOOR    = 0.01;   // % — BTC must be moving at least this fast

// Dynamic edge threshold based on spread
function dynThreshold(spread) {
  if (spread < 0.04) return 0.06;
  if (spread < 0.08) return 0.08;
  if (spread < 0.12) return 0.10;
  if (spread < 0.18) return 0.13;
  return 0.17;
}

// Check all 11 regime gates — returns { blocked, reason } or { blocked: false }
function checkGates(s, balance, btcVelocity) {
  const { yesAsk, yesBid, secsLeft, consecutiveLosses, lastLossTime,
          sessionPnL, sessionStartBalance, dailyPnL, dailyStartBalance,
          autobuyCooldownUntil, crowdVelHistory, liquidity } = s;

  const now = Date.now();
  const spread = yesAsk - yesBid;
  const yesPrice = (yesAsk + yesBid) / 2;
  const regime = priceFeed.getRegime('BTC'); // market condition uses BTC as base
  const elapsed = 900 - secsLeft; // seconds into window

  if (spread > 0.20)                                    return { blocked: true, reason: 'SPREAD' };
  if (yesPrice >= 0.44 && yesPrice <= 0.56)             return { blocked: true, reason: 'DEADZONE' };
  if (elapsed < 120)                                    return { blocked: true, reason: 'EARLY' };
  if (secsLeft < 180)                                   return { blocked: true, reason: 'LATE' };
  if (Math.abs(btcVelocity) < VEL_FLOOR)               return { blocked: true, reason: 'FLATLINE' };
  if (now < autobuyCooldownUntil)                       return { blocked: true, reason: 'COOLDOWN' };
  if (consecutiveLosses >= 3) {
    if (Date.now() - lastLossTime >= 30 * 60_000) {
      s.consecutiveLosses = 0; // auto-reset after 30 min idle — mirrors checkRiskGuards
    } else {
      return { blocked: true, reason: 'STREAK' };
    }
  }
  if (liquidity === 'LOW')                              return { blocked: true, reason: 'MKTCOND' };
  if (liquidity === 'MEDIUM' && regime === 'CHOPPY')    return { blocked: true, reason: 'MKTCOND' };

  if (!s.ticker?.startsWith('KXBTC15M-') && dailyStartBalance && dailyPnL <= -(dailyStartBalance * 0.08))
    return { blocked: true, reason: 'DAILYCAP' };
  if (sessionStartBalance && sessionPnL <= -(sessionStartBalance * 0.05))
    return { blocked: true, reason: 'SESSIONKILL' };

  // Crowd block: YES velocity sustained against model for last 4 readings > 0.5¢/s
  if (crowdVelHistory.length >= 4) {
    const avgCrowd = crowdVelHistory.reduce((a, b) => a + b) / crowdVelHistory.length;
    if (Math.abs(avgCrowd) > 0.5) {
      // Will check direction after we determine bet — store avgCrowd
      s._avgCrowdVel = avgCrowd;
    } else {
      s._avgCrowdVel = 0;
    }
  }

  return { blocked: false };
}

export async function checkAutoBuy(ctx) {
  const { asset, s, balance } = ctx;
  const now = Date.now();

  // Handle active countdown (3s pre-fire)
  if (s.countdown) {
    s.countdown.remaining--;

    // Cancel if bet direction flipped since countdown started
    const yesPrice = (s.yesAsk + s.yesBid) / 2;
    const currentBetDir = yesPrice >= 0.50 ? 'UP' : 'DOWN';
    if (currentBetDir !== s.countdown.bet) {
      console.log(`[AutoBuy] ${asset} countdown cancelled — direction flipped`);
      s.countdown = null;
      return;
    }

    if (s.countdown.remaining <= 0) {
      await fireAutoBuy(asset, s, balance, s.countdown);
      s.countdown = null;
    }
    return;
  }

  const btcVelocity = priceFeed.getVelocity('BTC', 5);
  const gates = checkGates(s, balance, btcVelocity);
  if (gates.blocked) return;

  const features = buildFeatures(asset);
  if (!features) return;

  const { yesAsk, yesBid } = s;
  const spread = yesAsk - yesBid;
  const yesPrice = (yesAsk + yesBid) / 2;

  // Determine model bet direction + probability
  const betUp   = yesPrice > 0.50;
  const bet     = betUp ? 'UP' : 'DOWN';
  const marketProb = betUp ? yesAsk : (1 - yesBid); // what market is pricing

  const featuresNorm = buildFeaturesNorm(features, bet);
  const P = getParams();
  let modelProb = P.MODEL_PROB_DEFAULT ?? 0.52;
  const minSamples = P.MODEL_PROB_MIN_SAMPLES ?? 10;
  if (s.brain && (bet === 'UP' ? s.brain.dataUp : s.brain.dataDown).length >= minSamples) {
    modelProb = predict(s.brain.weights, features, featuresNorm, bet, s.brain.dataUp, s.brain.dataDown);
  }

  const rawEdge = modelProb - marketProb;

  // Dynamic threshold with momentum boost
  let thresh = dynThreshold(spread);
  const velForBet = betUp ? s.yesVel : -s.yesVel; // positive = momentum in our direction
  if (velForBet >= 0.15)      thresh *= 0.70;
  else if (velForBet >= 0.08) thresh *= 0.85;

  // Ceiling block: < 12¢ upside
  const ceiling = betUp ? yesAsk > 0.88 : (1 - yesBid) > 0.88;
  if (ceiling) return;

  // Crowd block: crowd velocity sustained against our model direction
  if (s._avgCrowdVel) {
    const crowdAgainst = betUp ? s._avgCrowdVel < -0.5 : s._avgCrowdVel > 0.5;
    if (crowdAgainst) return;
  }

  // Full EV formula: EV = P_true × (1 - P_market) - (1 - P_true) × P_market
  // More correct than the simplified modelProb/sidePrice - 1 form.
  // Hard floor at 5% EV — eliminates ~90% of marginal trades per Polymarket research.
  const ev = modelProb * (1 - marketProb) - (1 - modelProb) * marketProb;
  const MIN_EV = 0.05;

  if (rawEdge < thresh || ev < MIN_EV) return;

  console.log(`[AutoBuy] ${asset} ${bet} edge=${(rawEdge*100).toFixed(1)}% thresh=${(thresh*100).toFixed(1)}% — starting 3s countdown`);

  s.countdown = {
    bet,
    remaining: COUNTDOWN_S,
    features,
    featuresNorm,
    modelProb,
  };
}

async function fireAutoBuy(asset, s, balance, cd) {
  const { bet, features, featuresNorm, modelProb } = cd;
  const KALSHI_MIN_BET = 0.05;
  const MAX_FRACTION   = 0.20;

  // Quarter-Kelly bet sizing (reduced from half-Kelly).
  // Half-Kelly is mathematically optimal but causes large enough swings to trigger
  // emotional decision-making and risk breakers prematurely. Quarter-Kelly halves
  // variance at the cost of ~13% long-run growth rate — a good trade at this scale.
  const { yesAsk, yesBid } = s;
  const b = bet === 'UP' ? (1 - yesAsk) / yesAsk : yesBid / (1 - yesBid);
  const kelly = (b * modelProb - (1 - modelProb)) / b;
  const quarterKelly = Math.max(0, kelly * 0.25);
  const sidePrice = bet === 'UP' ? yesAsk : (1 - yesBid);
  const minBet = Math.max(KALSHI_MIN_BET, sidePrice); // must afford ≥1 contract
  const amount = Math.max(Math.min(quarterKelly * balance, MAX_FRACTION * balance), minBet);

  console.log(`[AutoBuy] FIRE ${asset} ${bet} $${amount.toFixed(2)} p=${(modelProb*100).toFixed(0)}%`);

  try {
    const { result } = await executeBuy(s.ticker, bet, amount, yesAsk, yesBid);
    const sidePrice = bet === 'UP' ? yesAsk : (1 - yesBid);
    const filled = typeof result?.order?.remaining_count === 'number'
      ? (Math.floor(amount / sidePrice) - result.order.remaining_count)
      : Math.floor(amount / sidePrice);

    if (filled < 1) { console.warn('[AutoBuy] 0 contracts filled'); return; }

    const spentActual = filled * sidePrice;
    const maxProfit   = filled * 1.00 - spentActual;

    s.activeTrade = {
      ticker: s.ticker, bet,
      side: bet === 'UP' ? 'yes' : 'no',
      amount: spentActual, count: filled,
      entryYes: (yesAsk + yesBid) / 2,
      maxProfit,
      // Auto-buy uses dynamic (unlocked) exit thresholds — no lockedTP/lockedSL
      featuresRaw: features,
      featuresNorm,
      entryModelProb: modelProb,
      startedAt: Date.now(),
      mode: 'AUTO_BUY',
    };

    s.autobuyCooldownUntil = Date.now() + 60_000; // 60s between fires
  } catch (err) {
    console.error(`[AutoBuy] Buy failed:`, err.message);
  }
}
