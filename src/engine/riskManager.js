// Pure guard functions — return { blocked, reason } or mutate P&L counters.
// All dollar values in USD.

const RISK_DAILY_CAP           = 0.08;         // stop after 8% daily loss
const RISK_SESSION_KILL        = 0.05;         // stop after 5% session loss
const RISK_SESSION_KILL_COOLDOWN_MS = 60 * 60_000; // 1 hour cooldown after session kill, then auto-resume
const RISK_CONSEC_BRAKE        = 3;            // stop after 3 consecutive losses
const RISK_COOLDOWN_MS         = 45_000;       // 45s cooldown after normal loss
const RISK_STREAK_RESET_MS     = 30 * 60_000;  // auto-reset streak after 30 min of no trading
// Fix 5: Shorter cooldown for high-confidence modes (DECAY, STRONG_CONVICTION)
export const RISK_COOLDOWN_FAST_MS = 20_000;

export function checkRiskGuards(s, balance, fastCooldown = false, { skipLossCooldown = false } = {}) {
  const now = Date.now();
  const cooldown = fastCooldown ? RISK_COOLDOWN_FAST_MS : RISK_COOLDOWN_MS;

  if (!skipLossCooldown && now - s.lastLossTime < cooldown) {
    return { blocked: true, reason: 'COOLDOWN' };
  }

  // Auto-reset streak after 5 min so a dead market doesn't block forever
  if (s.consecutiveLosses >= RISK_CONSEC_BRAKE) {
    if (now - s.lastLossTime >= RISK_STREAK_RESET_MS) {
      s.consecutiveLosses = 0;
    } else {
      return { blocked: true, reason: 'STREAK' };
    }
  }

  // Session kill and daily cap are real-money guards — skip in DRY_RUN and sim mode
  // so the bot keeps collecting training data even after a bad streak.
  if (process.env.DRY_RUN !== 'true' && !s._simMode) {
    if (s.sessionStartBalance !== null &&
        s.sessionPnL <= -(s.sessionStartBalance * RISK_SESSION_KILL)) {
      // Auto-resume after cooldown instead of blocking until restart
      if (!s.sessionKillAt) s.sessionKillAt = now;
      if (now - s.sessionKillAt < RISK_SESSION_KILL_COOLDOWN_MS) {
        const minsLeft = Math.ceil((RISK_SESSION_KILL_COOLDOWN_MS - (now - s.sessionKillAt)) / 60_000);
        return { blocked: true, reason: 'SESSIONKILL', resumesInMins: minsLeft };
      }
      // Cooldown elapsed — reset session so trading resumes
      s.sessionPnL = 0;
      s.sessionStartBalance = s.sessionStartBalance; // keep same baseline
      s.sessionKillAt = null;
      console.log(`[Risk] SESSIONKILL cooldown elapsed — resuming trading`);
    }

    if (s.dailyStartBalance !== null &&
        s.dailyPnL <= -(s.dailyStartBalance * RISK_DAILY_CAP)) {
      return { blocked: true, reason: 'DAILYCAP' };
    }
  }

  return { blocked: false };
}

// Called after every trade closes
export function recordTradePnL(s, pnl) {
  s.sessionPnL += pnl;
  s.dailyPnL   += pnl;
  s.totalPnL   += pnl;
  s.tradeCount++;

  if (pnl < 0) {
    s.consecutiveLosses++;
    s.lastLossTime = Date.now();
  } else {
    s.consecutiveLosses = 0;
  }
}

// Reset session counters (call at bot start or on demand)
export function startSession(s, balance) {
  s.sessionStartBalance = balance;
  s.sessionPnL = 0;
  s.consecutiveLosses = 0;
  s.lastLossTime = 0;
}

// Reset daily counters (call at midnight ET)
export function startDay(s, balance) {
  s.dailyStartBalance = balance;
  s.dailyPnL = 0;
}
