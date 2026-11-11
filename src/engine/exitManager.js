
import { getEarlyRetracementExitReason } from './EarlyRetracement.js';
import { executeSell, confirmedFillCount } from '../kalshi/orders.js';
import { getMarket, getPositions } from '../kalshi/client.js';
import { recordTradePnL } from './riskManager.js';
import { recordTrade as recordBrainTrade } from '../nn/store.js';
import { buildFeatures, buildFeaturesNorm } from '../nn/features.js';
import { predict } from '../nn/network.js';
import { notify } from '../notify.js';
import { recordOutcome } from './modeGuard.js';
import { state } from './state.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_LOG = path.join(__dirname, '../../logs/trades.json');

const STOP_LOSS = { CALM: 0.15, NORMAL: 0.12, CHOPPY: 0.10 };

const TRAIL_LEVELS = [
  { threshold: 0.75, pullback: 0.03 },
  { threshold: 0.65, pullback: 0.04 },
  { threshold: 0.55, pullback: 0.06 },
];

export function computeUnrealizedPnL(trade, yesAsk, yesBid) {
  const currentValue = trade.side === 'yes'
    ? trade.count * yesBid
    : trade.count * (1 - yesAsk);
  return currentValue - trade.amount;
}

// Called every tick when activeTrade is set.
// Checks all 5 exit triggers in priority order and executes sell if triggered.
export async function checkExit(ctx) {
  const { asset, s } = ctx;
  const trade = s.activeTrade;
  if (!trade || s.yesAsk === null) return;

  const { yesAsk, yesBid, yesVelHistory, secsLeft } = s;
  const unrealizedPnL = computeUnrealizedPnL(trade, yesAsk, yesBid);
  const pctCaptured = trade.maxProfit > 0 ? unrealizedPnL / trade.maxProfit : 0;

  // Dedicated exits for BTC early-retracement trades.
  // Do not apply the standard Farm exit rules to this mode.
  if (trade.mode === 'EARLY_RETRACEMENT') {
    const exitReason = getEarlyRetracementExitReason(
      trade,
      yesAsk,
      yesBid,
      secsLeft
    );

    if (exitReason) {
      await executeExit(asset, s, exitReason, unrealizedPnL);
    }

    return;
  }

  // Track peak side price for trail stop
  const currentSidePrice = trade.side === 'yes' ? yesBid : (1 - yesAsk);
  if (trade.peakYes === undefined) trade.peakYes = currentSidePrice;
  else trade.peakYes = Math.max(trade.peakYes, currentSidePrice);

  let exitReason = null;

  // 1. Take profit — locked at entry for farm trades, else 50% of max
  const tpTarget = trade.lockedTP ?? trade.maxProfit * 0.50;
  if (unrealizedPnL >= tpTarget) {
    exitReason = 'TAKE_PROFIT';
  }

  // 2. Stop loss — measured in cents of YES price movement from entry, not % of amount.
  //
  // WHY cents-from-entry instead of % of amount:
  //   Old formula: unrealizedPnL <= -(amount × slPct)
  //   Problem 1 — spread consumed 40-60% of the stop budget before price moved at all
  //     (buy at ask, mark-to-market at bid = instant -4% hole on a 6¢ spread).
  //   Problem 2 — 1Hz clock lets price gap through the % level, exiting at -30% instead
  //     of -15% because the threshold was too narrow to catch.
  //   Problem 3 — Kelly bet sizes varied $0.50-$4+, making dollar stops inconsistent.
  //
  //   New formula: if YES price has moved N cents AGAINST the trade from the entry
  //   side price, exit. N is regime-based (8¢ CALM, 10¢ NORMAL, 13¢ CHOPPY).
  //   This is spread-neutral (measured from actual entry price, spread already paid),
  //   bet-size-neutral (same price threshold regardless of Kelly size), and
  //   gap-through resistant (larger absolute threshold means less likely to skip).
  //
  // 3s minimum hold (canStopAfter) still applies — prevents sub-second noise triggers.
  if (!exitReason) {
    const holdReady = !trade.canStopAfter || Date.now() >= trade.canStopAfter;
    if (holdReady && trade.entrySidePrice != null) {
      // YES price movement against our position in cents
      const adverseCents = trade.side === 'yes'
        ? (trade.entrySidePrice - currentSidePrice) * 100   // UP bet: price fell
        : (currentSidePrice - trade.entrySidePrice) * 100;  // DOWN bet: price rose (NO price fell)
      const regime = s.regime ?? 'NORMAL';
      const slCents = trade.lockedSLCents ?? { CALM: 8, NORMAL: 10, CHOPPY: 13 }[regime] ?? 10;
      if (adverseCents >= slCents) {
        exitReason = 'STOP_LOSS';
      }
    } else if (holdReady && trade.entrySidePrice == null) {
      // Fallback for trades entered before this change (no entrySidePrice stored)
      const regime = s.regime ?? 'NORMAL';
      const slPct = trade.lockedSL ?? STOP_LOSS[regime];
      if (unrealizedPnL <= -(trade.amount * slPct)) exitReason = 'STOP_LOSS';
    }
  }

  // 3a. Velocity spike — single tick > 4¢/s against us → gap-through in progress, exit now.
  // WHY: 47% of stops are gap-throughs causing 77% of stop loss dollars. These happen when
  // YES price moves 5-20¢ in a single 1Hz tick, gapping well past the cents-from-entry stop.
  // A single-tick spike of 4¢/s is 33× the VEL_REVERSAL threshold — unambiguously a gap event.
  // No profit guard needed: if price is spiking 4¢ against us we want out regardless of profit.
  // canStopAfter still applies to prevent sub-second noise on entry.
  if (!exitReason && yesVelHistory.length >= 1) {
    const holdReady = !trade.canStopAfter || Date.now() >= trade.canStopAfter;
    if (holdReady) {
      const lastVel = yesVelHistory[yesVelHistory.length - 1];
      const spikeAgainst = trade.bet === 'UP' ? lastVel < -4.0 : lastVel > 4.0;
      if (spikeAgainst) exitReason = 'VEL_SPIKE';
    }
  }

  // 3b. Velocity reversal — YES moving hard against our bet for 3 ticks + have some profit locked
  // Raised pctCaptured 5%→15%: live data shows VEL/NN exits averaging $0.019 (too early).
  // TAKE_PROFIT exits average $0.119 — letting trades run to target is 6× more profitable.
  if (!exitReason && yesVelHistory.length >= 3 && pctCaptured > 0.15) {
    const recent = yesVelHistory.slice(-3);
    const avgVel = recent.reduce((a, b) => a + b) / recent.length;
    const against = trade.bet === 'UP' ? avgVel < -0.12 : avgVel > 0.12;
    if (against) exitReason = 'VEL_REVERSAL';
  }

  // 4. Trail stop — pulled back from peak by threshold cents
  // Guards (all must pass before trail can fire):
  //   a) pctCaptured >= 0.10 — must have 10% of maxProfit locked before trail activates.
  //      Without this, trail fires on normal early-trade noise at a loss (98% of exits).
  //   b) unrealizedPnL > 0 — must be in profit. Trail is a profit-protection tool, not a
  //      loss-cutter (STOP_LOSS handles that). Prevents firing when peakYes briefly crosses
  //      a threshold during a losing trade then pulls back.
  //   c) canStopAfter — same 3s minimum hold as STOP_LOSS to prevent sub-second triggers.
  if (!exitReason) {
    const holdReady = !trade.canStopAfter || Date.now() >= trade.canStopAfter;
    if (holdReady && pctCaptured >= 0.10 && unrealizedPnL > 0) {
      for (const { threshold, pullback } of TRAIL_LEVELS) {
        if (trade.peakYes >= threshold) {
          if (trade.peakYes - currentSidePrice >= pullback) {
            exitReason = 'TRAIL_STOP';
          }
          break;
        }
      }
    }
  }

  // 5. Time floor — exit at progressively lower capture thresholds as time runs out
  // secsLeft <= 30: FORCE exit regardless of PnL — prevents MARKET_SETTLED losses.
  // Live data: 3 MARKET_SETTLED trades lost $1.56 total ($0.44–$0.62 each) by holding
  // to expiry. A forced exit at breakeven or small loss is always better than settlement.
  
if (!exitReason) {
  const heldSeconds = trade.startedAt
    ? (Date.now() - trade.startedAt) / 1000
    : 0;

  const minimumHoldMet = heldSeconds >= 15;

  if (
    (secsLeft <= 30) ||
    (minimumHoldMet && (
      (secsLeft <= 45 && unrealizedPnL >= 0) ||
      (secsLeft <= 90 && unrealizedPnL > 0) ||
      (secsLeft <= 180 && pctCaptured >= 0.08) ||
      (secsLeft <= 360 && pctCaptured >= 0.20) ||
      (secsLeft <= 600 && pctCaptured >= 0.35)
    ))
  ) {
    exitReason = 'TIME_FLOOR';
  }
}


  // 6. Stale price guard — exit if YES price frozen > 30s during final 5 min
  // Protects against holding through an untracked move when Kalshi WS goes silent
  if (!exitReason && secsLeft < 300 && s.yesPriceHistory.length >= 2) {
    const newest = s.yesPriceHistory[s.yesPriceHistory.length - 1];
    if (Date.now() - newest.ts > 30_000) {
      exitReason = 'STALE_PRICE';
    }
  }

  // 7. NN second-opinion — re-evaluate current market conditions against entry confidence.
  // Fires when the NN now disagrees with our bet, locking in partial profit before
  // the rule-based stops catch up. Only activates once the NN is trained enough to trust.
  //   - brain.data.length >= 30: NN has enough samples to have a meaningful opinion
  //   - pctCaptured >= 0.05: some profit to protect (not a panic exit at breakeven)
  //   - canStopAfter: respects the 3s minimum hold
  //   - 20-point confidence drop + below 45%: strong disagreement, not noise
  if (!exitReason && s.brain && s.brain.data.length >= 30
      && pctCaptured >= 0.15 && trade.entryModelProb != null
      && (!trade.canStopAfter || Date.now() >= trade.canStopAfter)) {
    const currentFeatures = buildFeatures(asset);
    if (currentFeatures) {
      const currentFeatNorm = buildFeaturesNorm(currentFeatures, trade.bet);
      const currentProb = predict(
        s.brain.weights, currentFeatures, currentFeatNorm,
        trade.bet, s.brain.dataUp, s.brain.dataDown
      );
      if (currentProb < 0.45 && trade.entryModelProb - currentProb >= 0.20) {
        exitReason = 'NN_REVERSAL';
      }
    }
  }

  if (exitReason) {
    await executeExit(asset, s, exitReason, unrealizedPnL);
  }
}

async function executeExit(asset, s, reason, unrealizedPnL) {
    if (s.exitInProgress) return;
  s.exitInProgress = true;
  try {
    await performExit(asset, s, reason, unrealizedPnL);
  } finally {
    s.exitInProgress = false;
  }
}
async function performExit(asset, s, reason, unrealizedPnL) {
  const trade = s.activeTrade;
    // Reconcile against Kalshi before submitting a sell.
  if (!state.simMode && process.env.DRY_RUN !== 'true') {
    try {
      const positions = await getPositions();
      const position = positions.find(p => p.ticker === trade.ticker);
      const held = Number(position?.position_fp ?? 0);
      const expectedSide = trade.side === 'yes' ? 1 : -1;

      if (!Number.isFinite(held)) {
        console.warn('[Exit] Invalid position data; skipping sell');
        return;
      }

      if (held * expectedSide <= 0) {
        console.warn(
          `[Exit] No matching position for ${trade.ticker}; reconciliation required`
        );
        return;
      }

      const actualCount = Math.abs(held);
      if (actualCount < trade.count) {
        console.warn(
          `[Exit] Position count mismatch: tracked=${trade.count}, actual=${actualCount}`
        );
        return;
      }
    } catch (err) {
      console.error('[Exit] Position check failed:', err.message);
      return;
    }
  }
  const pctCaptured = trade.maxProfit > 0 ? unrealizedPnL / trade.maxProfit : 0;
  console.log(`[Exit] ${asset} ${trade.mode ?? ''} ${trade.bet} ${reason} PnL=$${unrealizedPnL.toFixed(2)}`);
  const emoji = unrealizedPnL > 0 ? '✅' : '❌';
  await notify(`${emoji} ${asset} Exit — ${reason}`, `${trade.mode} ${trade.bet} | PnL: $${unrealizedPnL.toFixed(3)}`, 'default');

  try {
    
const { body, result } = await executeSell(
  trade.ticker, trade.side, trade.count
);


const filled = confirmedFillCount(result, Number(body.count));

if (filled < Number(body.count)) {
  console.warn(
    `[Exit] Sell not fully filled: ${filled}/${body.count}`
  );

  if (filled > 0) {
    const originalCount = trade.count;
    const fractionSold = filled / originalCount;

    trade.count = Math.max(0, originalCount - filled);
    trade.amount *= (1 - fractionSold);
    trade.maxProfit *= (1 - fractionSold);

    if (trade.lockedTP != null) {
      trade.lockedTP *= (1 - fractionSold);
    }

    console.log(
      `[Exit] Partial fill recorded: ${filled} sold, ${trade.count} remaining`
    );
  }

  return;
}


  } catch (err) {
    // If market is finalized, Kalshi already settled the position — clear it
    if (err.message.includes('market_not_found')) {
      try {
        const market = await getMarket(trade.ticker);
        if (market.status === 'finalized') {
          console.log(`[Exit] Market finalized — Kalshi settled position; clearing trade`);
          recordTradePnL(s, unrealizedPnL);
          await appendLog({ asset, bet: trade.bet, mode: trade.mode, amount: trade.amount,
            pnl: unrealizedPnL, win: unrealizedPnL > 0, reason: 'MARKET_SETTLED', at: new Date().toISOString() });
          s.lastExitTime = Date.now();
          s.activeTrade = null;
          return;
        }
      } catch {}
    }
    console.error(`[Exit] Sell failed (${reason}):`, err.message);
    return; // Don't clear trade — will retry next tick
  }

  // Update risk counters
  recordTradePnL(s, unrealizedPnL);

  // In sim mode — update paper balance so bet sizing stays realistic
  if (state.simMode) {
    state.paperBalance = Math.max(0.50, state.paperBalance + unrealizedPnL);
    state.balance = state.paperBalance;
  }

  // Mode guard — track outcome so circuit breaker can disable bleeding combos
  if (trade.mode && trade.bet) {
    const action = recordOutcome(trade.mode, trade.bet, unrealizedPnL, unrealizedPnL > 0);
    if (action === 'disabled') {
      await notify('🚫 Mode Disabled', `${trade.mode} ${trade.bet} circuit breaker triggered`, 'default');
    } else if (action === 're-enabled') {
      await notify('✅ Mode Re-enabled', `${trade.mode} ${trade.bet} auto-reset after cooldown`, 'default');
    }
  }

  // Train NN with outcome quality — pass pctCaptured and raw PnL so the NN
  // can weight gradient updates by how well we exited (big wins reinforce strongly,
  // big losses penalise strongly, small reversals get a gentle correction).
  if (trade.featuresRaw && trade.featuresNorm && s.brain) {
    try {
      await recordBrainTrade(
        asset, s.brain,
        trade.featuresNorm, trade.featuresRaw,
        trade.bet, unrealizedPnL > 0,
        pctCaptured,        // fraction of maxProfit captured (drives soft win label)
        unrealizedPnL,      // raw dollar PnL (drives loss penalty weight)
        trade.amount,       // stake (normalises loss severity to %)
        trade.mode ?? null  // routes sample to MOMENTUM/ALIGNED mode NN
      );
    } catch (err) {
      console.error('[Exit] Brain record failed:', err.message);
    }
  }

  // Append to trade log
  await appendLog({
    asset, bet: trade.bet, mode: trade.mode,
    amount: trade.amount, pnl: unrealizedPnL,
    win: unrealizedPnL > 0, reason,
    at: new Date().toISOString(),
    ...(state.simMode ? { sim: true } : {}),
  });

  s.lastExitTime = Date.now();
  if (reason === 'STOP_LOSS') {
    if (trade.mode === 'MOMENTUM') s.lastMomentumStop = Date.now();
    // Track recent stops for regime block — farmBot blocks entries after 5 stops in 10min
    if (!s.recentStopTimes) s.recentStopTimes = [];
    s.recentStopTimes.push(Date.now());
    if (s.recentStopTimes.length > 20) s.recentStopTimes.shift();
  }
  if (reason === 'STALE_PRICE') {
    s.lastStalePriceExit = Date.now();
    // Track history for repeated-stale backoff (farmBot checks last 10 min)
    if (!s.stalePriceExitTimes) s.stalePriceExitTimes = [];
    s.stalePriceExitTimes.push(Date.now());
    if (s.stalePriceExitTimes.length > 20) s.stalePriceExitTimes.shift();
  }
  s.activeTrade = null;
}

async function appendLog(entry) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(TRADES_LOG, 'utf8')); } catch {}
  logs.push(entry);
  await fs.promises.writeFile(TRADES_LOG, JSON.stringify(logs, null, 2));
  // Branch a new learning event node in Obsidian — fire-and-forget, never blocks trade loop
  import('child_process').then(({ execFile }) => {
    execFile('node', ['scripts/update-obsidian-brain.js'], { cwd: path.join(__dirname, '../..') }, () => {});
  }).catch(() => {});
}
