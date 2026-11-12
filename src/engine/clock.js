import { state } from './state.js';
import fs from 'fs';
import { checkEarlyRetracement } from './EarlyRetracement.js';
import { checkFarmBot } from './farmBot.js';
import { checkAutoBuy } from './autoBuy.js';
import { checkExit } from './exitManager.js';
import { startSession, startDay } from './riskManager.js';
import { loadBotState } from './botStateStore.js';
import { writeStateSnapshot } from './stateSnapshot.js';
import { priceFeed } from '../prices/binance.js';
import { krakenFallback } from '../prices/kraken.js'; // activates fallback wiring
import { KalshiWebSocket } from '../kalshi/websocket.js';
import { getBalance, findActiveMarket, getPositions } from '../kalshi/client.js';
import { executeSell } from '../kalshi/orders.js';
import { loadBrain } from '../nn/store.js';
import { startOfflineTraining, stopOfflineTraining } from './offlineTrainer.js';
import { notify } from '../notify.js';
import { scalpExecutor, restoreScalpExecution, isManagedTrade } from './scalpExecution.js';

// ── Offline-mode tracking ─────────────────────────────────────────────────────
// After OFFLINE_THRESHOLD consecutive failed onWindowRoll calls, the bot stops
// hammering Kalshi and enters offline-learning mode. A separate 30s poller
// checks for market availability. When the market appears the bot auto-resumes.
const OFFLINE_THRESHOLD = 15; // ~12 min of failed market lookups before giving up
const OFFLINE_POLL_MS   = 30_000;

const _offlineMode    = { BTC: false, ETH: false };
const _marketFails    = { BTC: 0,     ETH: 0     };
const _offlinePollers = {};

// Saved armed state so we can restore it on resume (offline entry clears in-memory flags)
const _armedBeforeOffline = {};

// One Kalshi WS per asset — updates YES price in state
const kalshiWS = {
  BTC: new KalshiWebSocket((ask, bid) => updateYes('BTC', ask, bid)),
  ETH: new KalshiWebSocket((ask, bid) => updateYes('ETH', ask, bid)),
};

function updateYes(asset, yesAsk, yesBid) {
  const s = state[asset];
  const now = Date.now();
  const mid = (yesAsk + yesBid) / 2;

  // Sample at 10 Hz so the momentum window spans ten seconds at any feed rate.
  const last = s.yesPriceHistory.at(-1);
  if (!last || now - last.ts >= 100) s.yesPriceHistory.push({ price: mid, ts: now });
  s.yesPriceHistory = s.yesPriceHistory.filter(p => p.ts >= now - 10_000);

  // YES velocity in ¢/s over last 3 WS readings
  if (s.yesPriceHistory.length >= 3) {
    const prev = s.yesPriceHistory[s.yesPriceHistory.length - 3];
    const dt = (now - prev.ts) / 1000;
    s.yesVel = dt > 0 ? (mid - prev.price) * 100 / dt : 0;
  }

  // Detect large single-tick jumps for the large order guard in farmBot
  if (s.yesPriceHistory.length >= 2) {
    const prev = s.yesPriceHistory[s.yesPriceHistory.length - 2];
    const jump = Math.abs((mid - prev.price) * 100);
    if (jump > 3) s.lastLargeJumpTs = now;
  }

  if (s.yesAsk !== yesAsk || s.yesBid !== yesBid) {
  s.lastQuoteChangeTs = Date.now();
}

s.lastQuoteMessageTs = Date.now();
s.yesAsk = yesAsk;
s.yesBid = yesBid;
}

function secsLeft() {
  const now = new Date();
  return 900 - ((now.getUTCMinutes() % 15) * 60 + now.getUTCSeconds());
}

function windowId() {
  return Math.floor(Date.now() / (15 * 60 * 1000));
}

// ET hour (EDT = UTC-4). Adjust to -5 after DST ends in November.
function etHour() {
  return (new Date().getUTCHours() - 4 + 24) % 24;
}

// Fix 1: Dynamic spread-based liquidity — replaces fixed clock schedule.
// Spread < 3¢ → HIGH, < 6¢ → MEDIUM, otherwise → LOW.
// Falls back to clock-based estimate when YES prices aren't available yet.
function getLiquidity(asset, hour, yesAsk, yesBid) {
  if (yesAsk !== null && yesBid !== null) {
    const spread = yesAsk - yesBid;
    if (spread < 0.03) return 'HIGH';
    if (spread < 0.06) return 'MEDIUM';
    return 'LOW';
  }
  // Fallback: clock-based estimate while orderbook warms up
  const btcLiq =
    (hour >= 3 && hour < 13) || hour >= 20 ? 'HIGH' :
    (hour >= 1 && hour < 3)  || (hour >= 13 && hour < 17) ? 'MEDIUM' :
    'LOW';
  if (asset === 'BTC') return btcLiq;
  if (hour >= 9 && hour < 16) return btcLiq;
  return btcLiq === 'HIGH' ? 'MEDIUM' : 'LOW';
}

// Per-asset lock — prevents concurrent onWindowRoll calls while one is in-flight
const _rolling = { BTC: false, ETH: false };

// Returns:
//   true  — market found successfully
//   false — all 10 attempts failed (genuine failure, counts toward offline threshold)
//   null  — call already in progress (rolling lock) or already in offline mode;
//            ignored by caller — does NOT count toward offline threshold
async function onWindowRoll(asset) {
  if (_rolling[asset] || _offlineMode[asset]) return null; // already in progress / offline
  _rolling[asset] = true;

  const s = state[asset];
  console.log(`[Clock] ${asset} window rolled — fetching new market`);
  s.farmRounds = 0;
  s.ticksAbove = 0;
  s.ticksTotal = 0;
  s.windowOpenPrice = priceFeed.getPrice(asset);
  // Clear stale prices so tick() skips this asset until fresh WS data arrives
  s.yesAsk = null;
  s.yesBid = null;
  s.yesPriceHistory = [];
s.lastQuoteMessageTs = null;
s.lastQuoteChangeTs = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const market = await findActiveMarket(asset);
      s.ticker = market.ticker;
      s.marketCloseTs = Date.parse(market.close_time);
      kalshiWS[asset].switchTicker(market.ticker);
      console.log(`[Clock] ${asset} new ticker: ${market.ticker}`);
      _rolling[asset] = false;
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 5000)); // 10 × 5s = 50s max wait
    }
  }
  console.error(`[Clock] ${asset} market lookup failed (attempt ${_marketFails[asset] + 1}/${OFFLINE_THRESHOLD})`);
  _rolling[asset] = false;
  return false;
}

/**
 * Enter offline-learning mode for one asset.
 * - Disarms farm + auto-buy so no spurious entries fire
 * - Starts the offline trainer to keep the NN improving on existing data
 * - Polls every 30s for market availability; auto-resumes when found
 */
function enterOfflineMode(asset) {
  if (_offlineMode[asset]) return;
  _offlineMode[asset] = true;

  const s = state[asset];

  // Save armed state so we can restore it on resume
  _armedBeforeOffline[asset] = {
    farmArmed:    s.farmArmed,
    autoBuyArmed: s.autoBuyArmed,
  };

  // Disarm — no new entries while market is down
  s.farmArmed    = false;
  s.autoBuyArmed = false;

  console.log(
    `[Clock] ${asset} entering offline mode after ${OFFLINE_THRESHOLD} failed market lookups. ` +
    `Bots paused — NN will keep learning from existing data.`
  );
  notify(
    '🔴 Offline Mode',
    `${asset}: market unavailable — bots paused, NN training continues`,
    'default'
  );

  // Start offline learning loop
  if (s.brain) startOfflineTraining(asset, s.brain);

  // Poll every 30s — resume when market comes back
  _offlinePollers[asset] = setInterval(async () => {
    try {
      const market = await findActiveMarket(asset);
      await exitOfflineMode(asset, market);
    } catch {
      // Market still unavailable — keep training, log every 5 polls
      const polls = (_offlinePollers[asset + '_count'] = (_offlinePollers[asset + '_count'] ?? 0) + 1);
      if (polls % 5 === 0) {
        const samples = s.brain?.data?.length ?? 0;
        console.log(`[Offline] ${asset} — still waiting for market (${samples} samples trained)`);
      }
    }
  }, OFFLINE_POLL_MS);
}

/**
 * Exit offline mode when a market becomes available.
 * Restores armed state, reconnects WS, resumes bot tick.
 */
async function exitOfflineMode(asset, market) {
  clearInterval(_offlinePollers[asset]);
  delete _offlinePollers[asset];
  delete _offlinePollers[asset + '_count'];
  _offlineMode[asset]   = false;
  _marketFails[asset]   = 0;

  // Stop offline trainer now that live data is flowing again
  stopOfflineTraining(asset);

  const s = state[asset];
  s.ticker          = market.ticker;
  s.marketCloseTs   = Date.parse(market.close_time);
  s.windowId        = windowId();
  s.farmRounds      = 0;
  s.ticksAbove      = 0;
  s.ticksTotal      = 0;
  s.windowOpenPrice = priceFeed.getPrice(asset);
  s.yesAsk          = null;
  s.yesBid          = null;

  // Reconnect Kalshi WS to new ticker
  kalshiWS[asset].switchTicker(market.ticker);

  // Restore the armed state that was active before the market went down
  const saved = _armedBeforeOffline[asset] ?? {};
  s.farmArmed    = saved.farmArmed    ?? false;
  s.autoBuyArmed = saved.autoBuyArmed ?? false;

  const armedLabel = s.farmArmed ? 'FARM' : (s.autoBuyArmed ? 'AUTO_BUY' : 'disarmed');
  console.log(`[Clock] ${asset} market found (${market.ticker}) — bots resuming (${armedLabel})`);
  notify('🟢 Market Resumed', `${asset}: new market found — bots back online (${armedLabel})`, 'success');
}

let _lastBalanceFetch = 0;
let _tickActive = false; // prevents concurrent tick executions (async tick > 1s causes race conditions)

async function tick() {
  if (_tickActive) return;
  _tickActive = true;
  try {
    await _tickBody();
  } finally {
    _tickActive = false;
  }
}

async function _tickBody() {
  const now = Date.now();
  const sl = secsLeft();
  const wid = windowId();
  const hour = etHour();

  // Refresh balance every 30s.
  // In DRY_RUN mode with PAPER_BALANCE set, use the simulated balance instead.
  const paperBalance = process.env.DRY_RUN === 'true' && process.env.PAPER_BALANCE
    ? parseFloat(process.env.PAPER_BALANCE) : null;
  if (paperBalance !== null) {
    state.balance = paperBalance;
    _lastBalanceFetch = now;
  } else if (!state.simMode && now - _lastBalanceFetch > 30_000) {
    try {
      const realBalance = (await getBalance()) / 100;
      state.balance = realBalance;
      _lastBalanceFetch = now;

      // Auto-switch to sim mode when real balance is too low to trade
      if (realBalance < state.SIM_TRIGGER_THRESHOLD && !state.simMode) {
        state.simMode = true;
        state.paperBalance = 10.00;
        state.balance = state.paperBalance;
        console.log('[Clock] Balance depleted — switching to SIM MODE. NN will keep training on paper trades.');
        notify('📚 Sim Mode Active', `Balance $${realBalance.toFixed(2)} — training on paper trades with $10.00`, 'default');
      }
    } catch {}
  } else if (state.simMode) {
    // In sim mode use paper balance; only check real balance if no sim_override active
    state.balance = state.paperBalance;
    const hasOverride = (() => {
      try { return JSON.parse(fs.readFileSync(new URL('../../data/sim_override.json', import.meta.url), 'utf8')).forceSimMode; } catch { return false; }
    })();
    if (!hasOverride && now - _lastBalanceFetch > 30_000) {
      try {
        const realBalance = (await getBalance()) / 100;
        _lastBalanceFetch = now;
        if (realBalance >= state.SIM_LIVE_THRESHOLD) {
          state.simMode = false;
          state.balance = realBalance;
          console.log(`[Clock] Real balance $${realBalance.toFixed(2)} detected — switching back to LIVE MODE.`);
          notify('💰 Live Mode Restored', `Real balance $${realBalance.toFixed(2)} detected — back to live trading`, 'default');
        }
      } catch {}
    }
  }

  for (const asset of ['BTC', 'ETH']) {
    const s = state[asset];
    s.secsLeft   = sl;
    s.clockUpdatedAt = now;
    s.spotPrice  = priceFeed.getPrice(asset);
    s.liquidity  = getLiquidity(asset, hour, s.yesAsk, s.yesBid);
    s.regime     = priceFeed.getRegime(asset);
    s._simMode   = state.simMode; // sync sim flag so riskManager can check it

    // Recompute YES velocity at 1Hz from a 5-second price window.
    // The WS fires 60+/s but price only moves occasionally, so computing velocity
    // from the last 3 WS frames (≈50ms) always gives 0.  Using a 5-second window
    // captures real moves before they fade back to flat.
    if (s.yesPriceHistory.length >= 2) {
      const cutoff = now - 5000;
      const window = s.yesPriceHistory.filter(p => p.ts >= cutoff);
      if (window.length >= 2) {
        const oldest = window[0];
        const newest = window[window.length - 1];
        const dt = (newest.ts - oldest.ts) / 1000;
        s.yesVel = dt > 0 ? (newest.price - oldest.price) * 100 / dt : 0;
      }
    }

    // YES velocity history (rolling, for reversal detection)
    s.yesVelHistory.push(s.yesVel);
    if (s.yesVelHistory.length > 10) s.yesVelHistory.shift();

    // Crowd velocity history (for auto-buy crowd-block gate)
    s.crowdVelHistory.push(s.yesVel);
    if (s.crowdVelHistory.length > 4) s.crowdVelHistory.shift();

    // pctAbove tracking (for DECAY mode)
    if (s.yesAsk !== null) {
      s.ticksTotal++;
      if ((s.yesAsk + s.yesBid) / 2 >= 0.50) s.ticksAbove++;
    }

    // Window roll detection — only advance windowId on success so that a
    // failed lookup retries on the next tick. The _rolling lock in onWindowRoll
    // prevents concurrent in-flight calls for the same asset.
    // Skip this block entirely while in offline mode — the exitOfflineMode poller
    // takes over market-finding and will update windowId when successful.
    if (_offlineMode[asset]) {
      // Nothing to do here — poller handles reconnection
    } else if (s.windowId === null) {
      s.windowId = wid; // initial set on startup
    } else if (s.windowId !== wid || !s.ticker) {
      // Market lookups retry for up to 50s; keep the heartbeat available for exits.
      void onWindowRoll(asset).then(ok => {
      if (ok === true) {
        s.windowId = wid;
        _marketFails[asset] = 0; // reset on success
      } else if (ok === false) {
        // Only count completed attempts (not rolling-lock short-circuits which return null)
        _marketFails[asset]++;
        if (_marketFails[asset] >= OFFLINE_THRESHOLD) {
          enterOfflineMode(asset);
        }
      }
      // ok === null → already in progress or offline, skip silently
      }).catch(err => console.error('[Clock] market roll failed:', err.message));
    }
if (now % 60000 < 1000) {
  console.log(
    `[KalshiFeed] ${asset}` +
    ` ticker=${s.ticker}` +
    ` ask=${s.yesAsk} bid=${s.yesBid}` +
    ` armed=${s.farmArmed}` +
    ` messageAge=${s.lastQuoteMessageTs
      ? Math.round((now - s.lastQuoteMessageTs) / 1000)
      : 'none'}s` +
    ` changeAge=${s.lastQuoteChangeTs
      ? Math.round((now - s.lastQuoteChangeTs) / 1000)
      : 'none'}s`
  );
}

    // Skip if no market data
    if (!s.ticker || s.yesAsk === null) {
      if (isManagedTrade(s.activeTrade) || scalpExecutor.snapshot().pending) {
        await scalpExecutor.tick({ asset, s, balance: state.balance ?? 0 });
      }
      continue;
    }

    const ctx = {
      asset,
      s,
      balance: state.balance ?? 0,
      pctAbove: s.ticksTotal > 0 ? s.ticksAbove / s.ticksTotal : 0.5,
    };

// Pending orders and held scalps are serviced even if the entry toggle is off.
    if (process.env.SCALP_ENABLED === 'true' || isManagedTrade(s.activeTrade) || scalpExecutor.snapshot().pending) {
      await scalpExecutor.tick(ctx);
    }

    // Exit check always runs first
    if (s.activeTrade && !isManagedTrade(s.activeTrade)) {
      await checkExit(ctx);
    }

    
    // New entry only when flat — skip disabled assets.
    if (!s.activeTrade && !state.disabledAssets.includes(asset)) {
      // BTC early-retracement strategy gets first evaluation.
     
if (
  asset === 'BTC' &&
  s.farmArmed &&
  process.env.SCALP_ENABLED !== 'true'
) {
  await checkEarlyRetracement(ctx);
}


      
// Keep SCALP monitoring separate from other entries.
// Only one strategy may open a new position per tick.
if (!s.activeTrade) {
  if (process.env.SCALP_ENABLED === 'true') {
    // SCALP execution is serviced above; do not mix other entry strategies.
  } else if (s.farmArmed) {
    await checkFarmBot(ctx);
  } else if (s.autoBuyArmed) {
    await checkAutoBuy(ctx);
  }
}

    }

  }
}

export async function startClock() {
  console.log('[Clock] Starting price feeds...');
  priceFeed.connect();

  // Check for sim override file — persists sim mode across restarts
  try {
    const override = JSON.parse(fs.readFileSync(
      new URL('../../data/sim_override.json', import.meta.url), 'utf8'
    ));
    if (override.forceSimMode) {
      state.simMode = true;
      state.paperBalance = override.paperBalance ?? 50.00;
      state.balance = state.paperBalance;
      console.log(`[Clock] SIM OVERRIDE active — paper balance $${state.paperBalance.toFixed(2)}`);
    }
    if (Array.isArray(override.disabledAssets) && override.disabledAssets.length) {
      state.disabledAssets = override.disabledAssets.map(a => a.toUpperCase());
      console.log(`[Clock] Disabled assets: ${state.disabledAssets.join(', ')}`);
    }
  } catch {}

  console.log('[Clock] Loading brains...');
  state.BTC.brain = await loadBrain('BTC');
  state.ETH.brain = await loadBrain('ETH');

  // Restore our journal before servicing scalp orders. Existing account holdings
  // block new entries; do not liquidate unrelated positions during scalp startup.
  restoreScalpExecution();
  if (process.env.SCALP_ENABLED === 'true') console.log('[SCALP] Execution enabled; scalp budget=$10 including fee reserve; one position across BTC/ETH except same-side late stages; early entries >480s YES<15c targeting20c or either55-70c; higher scalps >70c and <97c only <120s; late stages: $1>=90c/<180s, $10>=94c/<120s, $20>=97c/<60s; combined cap=$31 including fees; scalp stop=disabled; reentry wait=0; contract-price profit targets');
  // Legacy startup handling applies only outside scalp mode.
  if (process.env.SCALP_ENABLED !== 'true') try {
    const positions = await getPositions();
    for (const p of positions) {
      const fp = parseFloat(p.position_fp);
      if (fp === 0) continue;
      const side = fp < 0 ? 'no' : 'yes';
      const count = Math.abs(fp);
      console.log(`[Clock] Closing orphaned ${side.toUpperCase()} position (${fp}) in ${p.ticker}`);
      try { await executeSell(p.ticker, side, count); } catch (err) {
        console.warn(`[Clock] Could not close orphan:`, err.message);
      }
    }
  } catch {}

  // Fetch balance before initialising session/day guards so they don't trigger
  // immediately due to sessionStartBalance=0 (state.balance is null at this point).
  try {
    state.balance = (await getBalance()) / 100;
    _lastBalanceFetch = Date.now();
  } catch {}
  const bal = state.balance ?? 5; // safe fallback; real value fetched above
  startSession(state.BTC, bal);
  startSession(state.ETH, bal);
  startDay(state.BTC, bal);
  startDay(state.ETH, bal);

  console.log('[Clock] Connecting to Kalshi markets...');
  for (const asset of ['BTC', 'ETH']) {
    try {
      const market = await findActiveMarket(asset);
      state[asset].ticker = market.ticker;
      state[asset].marketCloseTs = Date.parse(market.close_time);
      state[asset].windowId = windowId();
      state[asset].windowOpenPrice = priceFeed.getPrice(asset);
      kalshiWS[asset].connect(market.ticker);
      console.log(`[Clock] ${asset} → ${market.ticker}`);
    } catch (err) {
      console.error(`[Clock] Init ${asset}:`, err.message);
    }
  }

  // Fetch initial balance
  try {
    state.balance = (await getBalance()) / 100;
    _lastBalanceFetch = Date.now();
    console.log(`[Clock] Balance: $${state.balance.toFixed(2)}`);
  } catch {}

  // Restore persisted arm state (farm/autobuy armed flags)
  loadBotState();

  
 // 1-second heartbeat — prevent overlapping cycles
let tickInProgress = false;

setInterval(async () => {
  if (tickInProgress) return;

  tickInProgress = true;
  try {
    await tick();
  } catch (err) {
    console.error('[Clock] tick error:', err.message);
  } finally {
    tickInProgress = false;
    writeStateSnapshot();
  }
}, 1000);


  console.log('[Clock] Running.');
}
