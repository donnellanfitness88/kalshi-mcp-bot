// Shared mutable state for both assets — read by MCP tools and terminal

function createAssetState() {
  return {
    // Market data (updated by Kalshi WS)
    yesAsk: null,
    yesBid: null,
    ticker: null,
    secsLeft: 900,
    windowId: null,
    windowOpenPrice: null,
    spotPrice: null,       // current BTC/ETH spot price (updated every tick)
    liquidity: 'MEDIUM',

    // YES price velocity tracking
    yesPriceHistory: [],  // [{price, ts}] last 30 readings
    yesVel: 0,            // ¢/s (current)
    yesVelHistory: [],    // last 10 yesVel readings (for reversal + velocity reversal exit)

    // pctAbove: fraction of window ticks where YES mid >= 50¢ (for DECAY mode)
    ticksAbove: 0,
    ticksTotal: 0,

    // Bot control
    farmArmed: true,
    autoBuyArmed: true,

    // Active trade (null when flat)
    activeTrade: null,
    
    // SCALP entry state.
    // An uncertain order must be reconciled, not retried.
    scalpEntryInProgress: false,
    scalpPendingOrder: null,
    scalpEntryError: null,

    /* activeTrade shape:
      { ticker, bet, side, amount, count, entryYes, maxProfit,
        lockedTP, lockedSL, peakYes,
        featuresRaw, featuresNorm, startedAt, mode } */

    // NN brain (loaded at startup via loadBrain)
    brain: null, // { weights, data, dataUp, dataDown }

    // Farm bot state
    farmRounds: 0,
    lastExitTime: 0,
    lastLargeJumpTs: 0, // timestamp of last 3¢+ single-tick YES price jump

    // Auto-buy state
    crowdVelHistory: [], // last 4 yesVel readings (crowd block gate)
    autobuyCooldownUntil: 0,
    countdown: null,     // { bet, remaining, features, featuresNorm } — 3s pre-fire

    // Risk state
    consecutiveLosses: 0,
    lastLossTime: 0,
    sessionKillAt: null,  // timestamp when session kill tripped (for cooldown timer)
    _simMode: false,      // mirror of state.simMode — lets riskManager check it synchronously

    // P&L
    sessionStartBalance: null,
    sessionPnL: 0,
    dailyStartBalance: null,
    dailyPnL: 0,
    totalPnL: 0,
    tradeCount: 0,
  };
}

export const state = {
  BTC: createAssetState(),
  ETH: createAssetState(),
  balance: null, // dollars (updated every 30s)

  // Sim mode — auto-enabled when balance drops below $0.50.
  // Paper trades execute instantly (no Kalshi API calls), NN still trains on outcomes.
  // Auto-reverts to live when real balance is detected above SIM_LIVE_THRESHOLD.
  simMode: true,               // TRAINING MODE — forced on until WR > 55% over 200 sim trades
  paperBalance: 50.00,         // $50 paper balance so Kelly sizing produces meaningful bets
  SIM_TRIGGER_THRESHOLD: 0.50,
  SIM_LIVE_THRESHOLD:    1.00,
  simTradesTarget: 200,        // min sim trades before considering live again
  simWinRateTarget: 0.55,      // min win rate before considering live again
  disabledAssets: [],          // assets skipped in sim (e.g. ["ETH"]) — set from sim_override.json
};
