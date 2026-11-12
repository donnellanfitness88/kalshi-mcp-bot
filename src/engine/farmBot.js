import { buildFeatures, buildFeaturesNorm } from '../nn/features.js';
import { predict } from '../nn/network.js';
import { executeBuy, confirmedFillCount } from '../kalshi/orders.js';
import { checkRiskGuards, RISK_COOLDOWN_FAST_MS } from './riskManager.js';
import { priceFeed } from '../prices/binance.js';
import { notify } from '../notify.js';
import { getParams } from '../research/params.js';
import { isComboAllowed } from './modeGuard.js';
import { state } from './state.js';

const FARM_REENTRY_WAIT_MS = 8_000;
const FARM_MIN_TIME_LEFT   = 200; // closes the 181-240s dead band
const FARM_MAX_ROUNDS      = 99;
const KALSHI_MIN_BET       = 0.05;
const MAX_BET_FRACTION     = 0.20;

// Time-based kill windows (ET = UTC−4 during EDT, active Mar–Nov).
// Derived from 992-trade live log — these hours show persistent losses
// that no parameter tuning has been able to fix.
//
// ETH: 11 AM–1 PM ET (UTC 15–17) — worst 3 hours: −$5.38, −$3.05, −$14.28
//   US morning open causes violent ETH repricing that our signals can't track.
// BTC: 8 AM ET (UTC 12) — −$13.51 on 15 trades at 47% WR (losses >> wins)
//   Pre-market BTC order flow creates fake velocity signals at open.
const TIME_BLOCKS = {
  ETH: [15, 16, 17], // 11 AM, 12 PM, 1 PM ET
  BTC: [12],         // 8 AM ET
};

// MOMENTUM overnight block — UTC 23:00–12:00 (7pm–8am ET)
// 1am–3am ET live log shows 13 losses / 20 trades: thin volume creates
// fake velocity signals with no follow-through.
const MOMENTUM_BLOCK_UTC = new Set([23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

function isMomentumBlocked() {
  return MOMENTUM_BLOCK_UTC.has(new Date().getUTCHours());
}

// MOMENTUM re-entry cooldown after a stop loss — 30s (vs 8s global)
const MOMENTUM_STOP_COOLDOWN_MS = 30_000;

// Returns true if entries should be blocked for this asset right now
function isTimeBlocked(asset) {
  const utcHour = new Date().getUTCHours();
  return (TIME_BLOCKS[asset] ?? []).includes(utcHour);
}

const TARGET = { CALM: 0.12, NORMAL: 0.18, CHOPPY: 0.25 };

// Mode-specific stop losses calibrated to actual per-mode volatility risk:
// REVERSAL/MOMENTUM need wider stops — single large orders cause 3-5¢ adverse moves
// STRONG_CONVICTION/CONVICTION raised from 1.5%/3% → 5%/6%: the old values were
// inside normal bid/ask spread noise and produced 20% win rates from pure whipsaw exits.
const STOP_BY_MODE = {
  REVERSAL:          0.15,  // 15% — needs room to breathe through noise reversals
  MOMENTUM:          0.15,  // 15% — widened from 12%: stops were firing before moves develop (0/16 STOP_LOSS record)
  ALIGNED:           0.15,  // 15% — weakest signal, widest stop
  CONVICTION:        0.06,  // 6%  — raised from 3%; tight stops caused 79% whipsaw rate
  STRONG_CONVICTION: 0.05,  // 5%  — raised from 1.5%; spread alone was blowing 1.5% stops
  DECAY:             0.02,  // 2%  — final minutes, small target
};

// Quarter-Kelly bet sizing for binary options with volatility adjustment.
// atrRatio (shortATR/longATR) scales the fraction inversely — when markets are
// more volatile than usual (atrRatio > 1), bet less; when calm (< 1), bet up to 35%.
// Clamped to [0.15, 0.35] to prevent extreme bet sizing in either direction.
function kellyBet(bet, yesAsk, yesBid, modelProb, balance, atrRatio = 1.0) {
  const p = modelProb;
  const q = 1 - p;
  const b = bet === 'UP'
    ? (1 - yesAsk) / yesAsk
    : yesBid / (1 - yesBid);
  const kelly = (b * p - q) / b;
  const volAdjFraction = Math.max(0.15, Math.min(0.35, 0.25 / atrRatio));
  const scaledKelly = Math.max(0, kelly * volAdjFraction);
  const sidePrice = bet === 'UP' ? yesAsk : (1 - yesBid);
  const minBet = Math.max(KALSHI_MIN_BET, sidePrice);
  return Math.max(Math.min(scaledKelly * balance, MAX_BET_FRACTION * balance), minBet);
}

// Evaluate all 6 farm modes + gates.
// Returns { shouldFarm, bet, target, stop, mode } or { shouldFarm: false, reason }
function evaluateModes(s, regime, cycleDelta, pctAbove, adx, atrRatio, ind = null) {
  const { yesAsk, yesBid, secsLeft, yesVel, yesVelHistory, yesPriceHistory, liquidity } = s;
  const yesPrice = (yesAsk + yesBid) / 2;

  // ── Gate A: Momentum divergence (95% confidence, data-backed) ─────────────
  if (Math.abs(cycleDelta) > 0.6 && Math.abs(yesVel) > 0.8) {
    if ((cycleDelta > 0) !== (yesVel > 0)) {
      return { shouldFarm: false, reason: 'GATE_A' };
    }
  }

  // ── Gate B: EMA/momentum conflict (raised to 0.4%/0.5¢ — fewer false blocks)
  if (Math.abs(cycleDelta) > 0.4 && Math.abs(yesVel) > 0.5) {
    if ((cycleDelta > 0) !== (yesVel > 0)) {
      return { shouldFarm: false, reason: 'GATE_B' };
    }
  }

  // ── Gate C: Volatility gate — block entry when market is whipsawing ────────
  // If the YES mid-price spanned > 5¢ in the last 30 WS readings, the book is
  // too choppy for scalping. Single large orders create fake velocity signals.
  if (yesPriceHistory && yesPriceHistory.length >= 10) {
    const last30 = yesPriceHistory.slice(-30);
    const prices = last30.map(x => x.price);
    const range = (Math.max(...prices) - Math.min(...prices)) * 100; // cents
    if (range > 5) return { shouldFarm: false, reason: 'HIGH_VOLATILITY' };
  }

  // ── Gate D: Large order guard — 5s cooldown after a 3¢+ price jump ─────────
  // Large individual orders cause synthetic velocity spikes. Wait for liquidity
  // to reset before trading.
  if (s.lastLargeJumpTs && Date.now() - s.lastLargeJumpTs < 5_000) {
    return { shouldFarm: false, reason: 'POST_LARGE_ORDER' };
  }

  // ── ATR-based dynamic stop multiplier ─────────────────────────────────────
  // atrRatio = shortATR / longATR: >1 = currently more volatile than recent average.
  // Scale stop proportionally so losses don't exceed the intended % in high-vol.
  // Clamped to [0.6, 1.8] to prevent absurd stops in extreme conditions.
  const atrMult = atrRatio !== null ? Math.max(0.6, Math.min(1.8, atrRatio)) : 1.0;

  // ── Gate C (stop tightener): strong signal → tighter stop ─────────────────
  const signalStrength = Math.abs(cycleDelta) * 10 + Math.abs(yesVel);
  const stopMult = (signalStrength > 5 ? 0.70 : 1.0) * atrMult;

  // ── Common entry blocks ───────────────────────────────────────────────────
  if (secsLeft < FARM_MIN_TIME_LEFT && !(secsLeft >= 60 && secsLeft <= 180)) {
    return { shouldFarm: false, reason: 'TOO_LATE' };
  }
  if (yesPrice <= 0.05 || yesPrice >= 0.95) return { shouldFarm: false, reason: 'SPREAD_EXTREME' };
  if (yesPrice >= 0.49 && yesPrice <= 0.51) return { shouldFarm: false, reason: 'DEAD_ZONE' };
  if (liquidity === 'LOW')                   return { shouldFarm: false, reason: 'LOW_LIQ' };

  // ── Spread cost guard ─────────────────────────────────────────────────────
  // Research: spread consumes 40-60% of the -15% stop budget at entry + exit.
  // When spread > 6¢, the full stop budget is consumed by spread cost alone —
  // there is no room left for actual price movement before hitting the stop.
  // When spread is 4-6¢, widen the stop so actual adverse price movement (not
  // just spread) is what triggers it.
  const spread = (yesAsk - yesBid) * 100; // cents
  if (spread > 6) return { shouldFarm: false, reason: 'SPREAD_TOO_WIDE' };

  // ── Mode 1: TIME DECAY (60–180s left) — disabled in sim training mode ─────
  if (!s._simMode && secsLeft >= 60 && secsLeft <= 180) {
    if (yesPrice >= 0.80 && pctAbove >= 0.65) {
      return { shouldFarm: true, bet: 'UP',   target: 0.04, stop: STOP_BY_MODE.DECAY * stopMult, mode: 'DECAY' };
    }
    if (yesPrice <= 0.20 && pctAbove <= 0.35) {
      return { shouldFarm: true, bet: 'DOWN', target: 0.04, stop: STOP_BY_MODE.DECAY * stopMult, mode: 'DECAY' };
    }
    // No pctAbove confirmation — fall through to STRONG_CONVICTION / CONVICTION
  }

  // ── Mode 2: REVERSAL — DISABLED ─────────────────────────────────────────
  // Live log + autoresearch simulation: 0% win rate, −$8.24 total across 58 windows.
  // Mean-reversion on 15M crypto markets has no edge — price continues the original
  // direction more often than it reverses. Re-enable only after collecting 20+ winning
  // REVERSAL examples with confirmed edge in simulation.

  // ── Mode 3: STRONG CONVICTION — DISABLED ────────────────────────────────
  // 376-trade live log: 8–9% win rate, −$2.56 total. Simulation confirms this mode
  // has no edge on 15M crypto markets — the upside (5–20¢) is too thin relative to
  // the mean-reversion risk. Re-enable only after collecting 50+ winning examples.

  // ── Mode 4: CONVICTION — DISABLED ───────────────────────────────────────
  // 376-trade live log: 20% win rate, −$1.56 total. Same structural problem as
  // STRONG_CONVICTION. Price alone at 70–80¢ is not a reliable entry signal.
  // Re-enable only after collecting sufficient positive training data.

  // ── TRAINING MODE: sim-only — skip ALIGNED and DECAY, only MOMENTUM fires ──
  // ALIGNED: 46% WR, R:R bleeds slowly. DECAY: 34% WR, inverted R:R.
  // In sim mode we only train on MOMENTUM (64% WR, positive R:R) to build
  // a clean high-quality dataset before going live again.
  if (s._simMode) {
    // fall through to MOMENTUM below — skip ALIGNED and DECAY
  } else {

  // ── Mode 5: ALIGNED ───────────────────────────────────────────────────────
  // Raised cycleDelta threshold 0.04→0.10 (autoresearch v2: tighter entry turned
  // ALIGNED from −$1.48 to +$0.29 by filtering low-conviction signals — 52%→67% WR).
  if (Math.abs(cycleDelta) >= 0.10 && Math.abs(yesVel) >= 0.03) {
    if ((cycleDelta > 0) === (yesVel > 0)) {
      // ADX gate: require a trending market (ADX >= 20) for trend-following modes.
      if (adx !== null && adx < 20) return { shouldFarm: false, reason: 'ADX_WEAK' };
      const bet = cycleDelta > 0 ? 'UP' : 'DOWN';
      // DOWN bet filter: live data shows ALIGNED DOWN 14W/27L −$1.70 vs UP 7/8 +$0.14.
      // Require stronger conviction for DOWN: cycleDelta must be < −0.15 (vs −0.10 for UP).
      // This halves the DOWN entry frequency while keeping only high-conviction shorts.
      if (bet === 'DOWN' && cycleDelta > -0.15) {
        return { shouldFarm: false, reason: 'ALIGNED_DOWN_WEAK' };
      }
      return { shouldFarm: true, bet, target: TARGET[regime], stop: STOP_BY_MODE.ALIGNED * stopMult, mode: 'ALIGNED' };
    }
    return { shouldFarm: false, reason: 'ALIGNED_CONFLICT' };
  }

  } // end !simMode block for ALIGNED

  // ── Mode 6: MOMENTUM ──────────────────────────────────────────────────────
  // Research filters (Polymarket v2→v3 study + Walk-Forward Optimization paper):
  //   1. BTC spot gate: require >= 0.05% move from window open (< 0.03% = noise)
  //   2. 120s velocity confirmation: avg of last N ticks must agree with entry direction
  //      Prevents entering on micro-bounces within larger opposing trends
  //   3. EMA trend filter: block entries opposing EMA12>EMA26 (10-min trend proxy)
  //      Counter-trend entries have halved confidence in research — here we block them
  //   4. ATR-scaled stop: 15% × atrRatio, clamped [0.10, 0.22]
  // In sim training mode: wider YES range (0.15–0.85) and lower vel threshold (0.05)
  // so the NN sees more MOMENTUM scenarios and learns faster.
  const momYesMin  = s._simMode ? 0.15 : 0.30;
  const momYesMax  = s._simMode ? 0.85 : 0.70;
  const momVelMin  = s._simMode ? 0.05 : 0.08;
  const momSecsMin = s._simMode ? 120  : 240;
  if (yesPrice >= momYesMin && yesPrice <= momYesMax && Math.abs(yesVel) >= momVelMin && secsLeft > momSecsMin) {
    if (!s._simMode && Math.abs(cycleDelta) < 0.05) return { shouldFarm: false, reason: 'MOM_NO_SPOT_MOVE' };
    const bet = yesVel > 0 ? 'UP' : 'DOWN';

    // Filter 2: 120s velocity confirmation
    const P = getParams();
    const confirmTicks = Math.round(P.MOMENTUM_VEL_CONFIRM_TICKS ?? 40);
    if (yesVelHistory.length >= confirmTicks) {
      const avgVel = yesVelHistory.slice(-confirmTicks).reduce((a, b) => a + b, 0) / confirmTicks;
      if (Math.sign(avgVel) !== Math.sign(yesVel)) {
        return { shouldFarm: false, reason: 'MOM_VEL_UNCONFIRMED' };
      }
    }

    // Filter 3: EMA trend alignment — block counter-trend entries
    if ((P.MOMENTUM_EMA_FILTER ?? 1) && ind?.ema12 && ind?.ema26) {
      const emaUp = ind.ema12 > ind.ema26;
      if ((bet === 'UP') !== emaUp) {
        return { shouldFarm: false, reason: 'MOM_COUNTER_TREND' };
      }
    }

    // Spread-aware stop: when spread is 4-6¢ it consumes ~30% of the stop budget.
    // Add the spread cost (in % of a typical $0.60 contract) to the stop so that
    // actual adverse price movement — not just the entry/exit spread — triggers it.
    const spreadPct = spread / 100; // spread in cents → fraction of $1
    const spreadAdj = Math.min(0.05, spreadPct); // cap adjustment at +5%
    const atrStop = Math.max(0.10, Math.min(0.27, STOP_BY_MODE.MOMENTUM * atrRatio + spreadAdj));
    return { shouldFarm: true, bet, target: TARGET[regime], stop: atrStop * stopMult, mode: 'MOMENTUM' };
  }

  
return {
  shouldFarm: false,
  reason: 'NO_MODE',
  diagnostics: {
    secsLeft,
    yesPrice: Number(yesPrice.toFixed(4)),
    yesVel,
    cycleDelta,
    pctAbove,
    adx,
    liquidity,
    spreadCents: Number(spread.toFixed(2)),
    simMode: Boolean(s._simMode)
  }
};

}


// ── Feature 3: Confidence-scored entry ────────────────────────────────────────
// Scores bull vs bear signals to produce a 0–1 confidence value.
// Inspired by TradingAgents adversarial bull/bear debate: each signal votes,
// the ratio determines entry quality. Below 0.55 = blocked; scales bet size.
//
// Bull signals (6 pts max) — conditions that favour winning the trade:
//   ADX ≥ 25:              trend strength confirmed (+2)
//   cycleDelta + vel aligned with bet: macro drift confirms direction (+2)
//   RSI in momentum zone:  not overbought/oversold against the bet (+1)
//   BB position has room:  price not already at extreme in bet direction (+1)
//
// Bear signals (5 pts max) — conditions that favour blocking/reducing:
//   ADX < 20:              no trend, signals likely noise (+2)
//   atrRatio > 1.3:        currently more volatile than normal (+2)
//   Recent stale exit:     feed instability within last 5 min (+1)
//
// HMM regime modifier: CHOPPY with high confidence → +2 bear; CALM/NORMAL
//   with high confidence → +1 bull; uncertain regime (conf < 0.5) → +1 bear.
function computeEntryConfidence(decision, ind, s, adx, atrRatio, cycleDelta, hmmRegime) {
  let bull = 0, bear = 0;
  const { bet } = decision;
  const betDir = bet === 'UP' ? 1 : -1;

  // ── Bull signals ──────────────────────────────────────────────────────────
  if (adx !== null && adx >= 25) bull += 2;

  // Both macro drift and YES velocity agree with the bet direction
  if (Math.abs(cycleDelta) >= 0.06 && cycleDelta * betDir > 0) bull += 1;
  if (Math.abs(s.yesVel) >= 0.04 && s.yesVel * betDir > 0) bull += 1;

  // RSI in a momentum-friendly zone (not overextended against our direction)
  const rsi = ind?.rsi ?? 50;
  const rsiBull = (bet === 'UP'   && rsi >= 45 && rsi <= 70)
               || (bet === 'DOWN' && rsi >= 30 && rsi <= 55);
  if (rsiBull) bull += 1;

  // Bollinger position leaves room to move in the bet direction
  if (ind?.bb && ind.bb.range > 0 && ind?.price) {
    const bbPos = (ind.price - ind.bb.lower) / ind.bb.range; // 0=lower, 1=upper
    const bbGood = (bet === 'UP'   && bbPos <= 0.65) // room above current price
                || (bet === 'DOWN' && bbPos >= 0.35); // room below
    if (bbGood) bull += 1;
  }

  // ── Bear signals ──────────────────────────────────────────────────────────
  if (adx !== null && adx < 20) bear += 2;
  if (atrRatio > 1.3) bear += 2;
  if (s.lastStalePriceExit && Date.now() - s.lastStalePriceExit < 300_000) bear += 1;

  // ── HMM regime modifier ───────────────────────────────────────────────────
  if (hmmRegime) {
    if (hmmRegime.state === 'CHOPPY' && hmmRegime.confidence > 0.65) bear += 2;
    else if (hmmRegime.state !== 'CHOPPY' && hmmRegime.confidence > 0.65) bull += 1;
    else if (hmmRegime.confidence < 0.50) bear += 1; // uncertain regime = caution
  }

  const total = bull + bear;
  if (total === 0) return 0.5;
  return bull / total;
}

// Bet scale factor based on entry confidence.
// Below 0.65: scale down (caution, borderline entry)
// 0.65–0.80: normal
// Above 0.80: scale up (high-conviction entry)
function confidenceBetScale(confidence) {
  if (confidence >= 0.80) return 1.20;
  if (confidence >= 0.65) return 1.00;
  return 0.75;
}

// Called every tick by clock.js when farmArmed and no activeTrade
export async function checkFarmBot(ctx) {
  const { asset, s, balance, pctAbove } = ctx;
  const now = Date.now();
  const simMode = state.simMode;

  // In sim mode: faster reentry (2s vs 8s) so NN gets more training reps per window
  const reentryWait = simMode ? 2_000 : FARM_REENTRY_WAIT_MS;
  if (now - s.lastExitTime < reentryWait) return;
  if (s.farmRounds >= FARM_MAX_ROUNDS) return;

  // Time-based kill window — skip in sim mode (NN needs exposure to all hours)
  if (!simMode && isTimeBlocked(asset)) return;

  // Stale price gate — three layers:
  // 1. Block entry if WS hasn't ticked in 15s (feed currently dead)
  // 2. Block entry for 120s after any STALE_PRICE exit (doubled from 60s —
  //    WS heartbeat watchdog reconnects in ~15s but orderbook rebuild takes longer;
  //    32/66 post-restart exits were STALE_PRICE, confirming 60s was insufficient)
  // 3. Repeated-stale backoff: 3+ stale exits in 10 minutes → block for 5 minutes
  if (s.yesPriceHistory.length >= 1) {
    const lastTick = s.yesPriceHistory[s.yesPriceHistory.length - 1];
    if (now - lastTick.ts > 15_000) return;
  }
  if (s.lastStalePriceExit && now - s.lastStalePriceExit < 120_000) return;

  // Repeated-stale backoff
  if (!s.stalePriceExitTimes) s.stalePriceExitTimes = [];
  const recentStales = s.stalePriceExitTimes.filter(t => now - t < 10 * 60_000);
  if (recentStales.length >= 3) return; // feed is chronically unstable — back off

  const ind = priceFeed.getIndicators(asset);
  const cycleDelta = (s.windowOpenPrice && priceFeed.getPrice(asset))
    ? (priceFeed.getPrice(asset) - s.windowOpenPrice) / s.windowOpenPrice * 100
    : 0;
  const adx      = ind?.adx ?? null;
  const atrRatio = ind?.atrRatio ?? 1.0;

  const decision = evaluateModes(s, priceFeed.getRegime(asset) ?? 'NORMAL',
    cycleDelta, pctAbove, adx, atrRatio, ind
  );
  const fastCooldown = decision.shouldFarm && decision.mode === 'DECAY';
  const risk = checkRiskGuards(s, balance, fastCooldown);
  if (risk.blocked) { if (Math.random() < 0.02) console.log(`[Farm] ${asset} risk blocked: ${risk.reason}`); return; }

  const features = buildFeatures(asset, {
    secsLeft: s.secsLeft,
    adx,
    pctAbove,
    spread:   s.yesAsk - s.yesBid,
  });
  if (!features) { if (Math.random() < 0.02) console.log(`[Farm] ${asset} features null — buffer not warm`); return; }

  if (!decision.shouldFarm) {
    if (Math.random() < 0.01) console.log(`[Farm] ${asset} blocked: ${decision.reason}`);
    return;
  }

  const { bet, target, stop, mode } = decision;

  // Mode guard — circuit breaker (skip in sim mode — NN learns from all combos)
  if (!simMode && !isComboAllowed(mode, bet)) {
    if (Math.random() < 0.02) console.log(`[Farm] ${asset} ${mode} ${bet} blocked by circuit breaker`);
    return;
  }

  // MOMENTUM-specific guards (skip overnight block in sim — expose NN to all hours)
  if (mode === 'MOMENTUM') {
    if (!simMode && isMomentumBlocked()) return;
    if (s.lastMomentumStop && now - s.lastMomentumStop < MOMENTUM_STOP_COOLDOWN_MS) return;
  }

  // ── Tiered stop-loss regime response ─────────────────────────────────────
  // Rather than blocking all entries after N stops (which also kills profitable
  // NN_REVERSAL / VEL_REVERSAL / TAKE_PROFIT exits), we apply progressive
  // tightening so high-quality entries still flow through while marginal ones
  // are filtered out. Full block is reserved for known hostile time windows only.
  //
  // Tier 1 — 3+ stops in 10 min: tighten confidence + spread requirements.
  //   Stays in market but raises the bar. Profitable exits (NN_REVERSAL etc.)
  //   continue because those are exits, not entries.
  //
  // Tier 2 — 5+ stops in 10 min AND in a known hostile hour (UTC 12-14 or 15-17,
  //   i.e. US pre-market and morning open): full 30-min block.
  //   Research: stop clustering was overwhelmingly in these hours.
  //   Outside these hours, 5 stops likely means bad luck not bad regime.
  if (!s.recentStopTimes) s.recentStopTimes = [];
  const recentStops = s.recentStopTimes.filter(t => now - t < 10 * 60_000);
  const utcHour = new Date().getUTCHours();
  const isHostileHour = [12, 13, 14, 15, 16, 17].includes(utcHour);

  if (recentStops.length >= 5 && isHostileHour) {
    if (Math.random() < 0.05) console.log(`[Farm] ${asset} REGIME_BLOCK — ${recentStops.length} stops in hostile hour ${utcHour}UTC`);
    return;
  }

  // Tier 1: tighten thresholds progressively under stop pressure
  const stopPressure = recentStops.length; // 0-4 in normal hours, 0-4 in hostile (5+ blocked above)
  const pressureConfBoost  = stopPressure >= 3 ? 0.15 : stopPressure >= 1 ? 0.05 : 0;
  const pressureSpreadCap  = stopPressure >= 3 ? 0.04 : 0.06; // ¢ → fraction (already in fraction below)

  // Feature 3: Confidence scoring — gates entry, scales bet size.
  // Base threshold: 0.45 sim / 0.55 live. Under stop pressure, raised by pressureConfBoost.
  const hmmRegime = priceFeed.getHMMRegime(asset);
  const confidence = computeEntryConfidence(decision, ind, s, adx, atrRatio, cycleDelta, hmmRegime);
  const confThreshold = (simMode ? 0.45 : 0.55) + pressureConfBoost;
  if (confidence < confThreshold) {
    if (Math.random() < 0.02) console.log(`[Farm] ${asset} ${mode} low confidence: ${confidence.toFixed(2)} < ${confThreshold.toFixed(2)} (pressure=${stopPressure})`);
    return;
  }

  // Under stop pressure: tighten spread cap beyond the hard 6¢ gate in evaluateModes
  const currentSpread = s.yesAsk - s.yesBid;
  if (stopPressure >= 3 && currentSpread > pressureSpreadCap) {
    if (Math.random() < 0.05) console.log(`[Farm] ${asset} spread ${(currentSpread*100).toFixed(1)}¢ too wide under pressure`);
    return;
  }

  const featuresNorm = buildFeaturesNorm(features, bet);
  const P = getParams();
  let modelProb = P.MODEL_PROB_DEFAULT ?? 0.52;

  // Post-streak tightener — research: after 3 consecutive losses, require higher edge
  // Polymarket study: "After 3+ consecutive losses: edge > 5% required"
  // We proxy edge with modelProb: require MOMENTUM_POST_LOSS_PROB (default 0.60) instead of default
  const consecutiveLosses = s.consecutiveLosses ?? 0;
  const postLossMinProb = mode === 'MOMENTUM' && consecutiveLosses >= 3
    ? (P.MOMENTUM_POST_LOSS_PROB ?? 0.60)
    : 0;

  // Feature 4: Mode-specialized NN in ensemble
  const modeData = mode === 'MOMENTUM' ? (s.brain?.dataMomentum ?? [])
                 : mode === 'ALIGNED'  ? (s.brain?.dataAligned  ?? [])
                 : [];
  const minSamples = P.MODEL_PROB_MIN_SAMPLES ?? 10;
  if (s.brain && (bet === 'UP' ? s.brain.dataUp : s.brain.dataDown).length >= minSamples) {
    modelProb = predict(s.brain.weights, features, featuresNorm, bet,
                        s.brain.dataUp, s.brain.dataDown, mode, modeData);
  }

  // Apply post-streak min prob gate — block MOMENTUM if NN isn't confident enough
  if (postLossMinProb > 0 && modelProb < postLossMinProb) {
    if (Math.random() < 0.05) console.log(`[Farm] ${asset} MOMENTUM post-streak blocked: prob=${modelProb.toFixed(2)} < ${postLossMinProb}`);
    return;
  }

  const baseAmount = kellyBet(bet, s.yesAsk, s.yesBid, modelProb, balance, atrRatio);
  const sidePrice  = bet === 'UP' ? s.yesAsk : (1 - s.yesBid);
  // Re-apply 1-contract floor after confidence scaling — confidenceBetScale can reduce
  // baseAmount below sidePrice (e.g. 0.62 × 0.75 = $0.46 at YES=0.62 → 0 contracts).
  // If balance can cover it, always send at least enough to buy 1 contract.
  let amount = Math.max(baseAmount * confidenceBetScale(confidence), Math.min(sidePrice, balance));

  // Gap-through position cap — simulation shows 47% of stops are gap-throughs causing 77%
  // of stop loss dollars. Large Kelly bets in volatile markets amplify these losses linearly.
  // When atrRatio > 1.5 (currently more volatile than normal), cap to $2 per trade.
  // This preserves all entries (no false blocking) while bounding gap-through damage.
  // At balance $50, Kelly can reach $10; a 20¢ gap-through on $10 = $2 loss.
  // At $2 cap, same gap-through = $0.40 — acceptable and recoverable.
  if (atrRatio > 1.5 && amount > 2.0) amount = 2.0;

  console.log(`[Farm] ${asset} ${mode} ${bet} $${amount.toFixed(2)} p=${(modelProb*100).toFixed(0)}% conf=${confidence.toFixed(2)}`);
  await notify(`🤖 ${asset} Farm Entry`, `${mode} ${bet} $${amount.toFixed(2)} | p=${(modelProb*100).toFixed(0)}% conf=${confidence.toFixed(2)}`, 'default');

  try {
    
const { body, result } = await executeBuy(
  s.ticker, bet, amount, s.yesAsk, s.yesBid
);

const filled = confirmedFillCount(result, Number(body.count));

console.log(
  `[Farm] Confirmed ${filled}/${body.count} contracts filled`
);

    if (filled < 1) { console.warn('[Farm] 0 contracts filled'); s.lastExitTime = Date.now(); return; }

    const spentActual = filled * (bet === 'UP' ? s.yesAsk : (1 - s.yesBid));
    const maxProfit   = filled * 1.00 - spentActual;

    s.activeTrade = {
      ticker: s.ticker, bet,
      side: bet === 'UP' ? 'yes' : 'no',
      amount: spentActual, count: filled,
      entryYes: (s.yesAsk + s.yesBid) / 2,
      // entrySidePrice: the actual price paid per contract (ask for UP, no-ask for DOWN).
      // Used by the cents-from-entry stop loss — measures real adverse price movement
      // independent of bet size and spread cost.
      entrySidePrice: bet === 'UP' ? s.yesAsk : (1 - s.yesBid),
      // peakYes initialised at entry side price so the trail correctly tracks the
      // HIGH WATER MARK from the actual entry point, not from whenever checkExit()
      // first runs. Without this, a market dip between entry and first tick resets
      // peakYes below entry, causing trail to fire the moment price recovers + dips.
      peakYes: bet === 'UP' ? s.yesBid : (1 - s.yesAsk),
      maxProfit,
      lockedTP: maxProfit * 0.45,
      lockedSL: stop,
      // Cents-from-entry stop: regime locked at entry so a regime shift mid-trade
      // doesn't suddenly widen the stop. CALM=8¢, NORMAL=10¢, CHOPPY=13¢.
      lockedSLCents: { CALM: 8, NORMAL: 10, CHOPPY: 13 }[priceFeed.getRegime(asset) ?? 'NORMAL'] ?? 10,
      featuresRaw: features,
      featuresNorm,
      entryModelProb: modelProb,
      startedAt: Date.now(),
      // Sim mode: 1s min hold (faster decisions); live: 3s (noise protection)
      canStopAfter: Date.now() + (simMode ? 1_000 : 3_000),
      mode,
      sim: simMode || undefined,
    };
    s.farmRounds++;
  } catch (err) {
    console.error(`[Farm] Buy failed:`, err.message);
    s.lastExitTime = Date.now();
  }
}
