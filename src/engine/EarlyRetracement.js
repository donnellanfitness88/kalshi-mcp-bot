
import { state } from './state.js';
import { checkRiskGuards } from './riskManager.js';
import {
  executeBuy,
  confirmedFillCount
} from '../kalshi/orders.js';

export const EARLY_RETRACEMENT = Object.freeze({
  mode: 'EARLY_RETRACEMENT',
  entryBelow: 0.15,
  minSecondsRemaining: 480,
  maxEntryUsd: 2.00,
  takeProfitPrice: 0.25,
  stopLossPrice: 0.05,
  timeExitSeconds: 60
});

// Only one entry per BTC market cycle.
// Existing farm and auto-buy strategies retain their own controls.
export async function checkEarlyRetracement(ctx) {
  const { asset, s, balance } = ctx;

  if (asset !== 'BTC') return;
  if (!s.farmArmed) return;
  if (s.activeTrade) return;
  if (!s.ticker) return;
  if (state.simMode || process.env.DRY_RUN === 'true') return;

  if (
    !Number.isFinite(s.secsLeft) ||
    s.secsLeft <= EARLY_RETRACEMENT.minSecondsRemaining
  ) return;

  const ask = s.yesAsk;
  const bid = s.yesBid;

  if (
    !Number.isFinite(ask) ||
    !Number.isFinite(bid) ||
    bid <= 0 ||
    ask >= 1 ||
    ask < bid
  ) return;

  // Do not trade on stale orderbook information.
  if (
    !Number.isFinite(s.lastQuoteMessageTs) ||
    Date.now() - s.lastQuoteMessageTs > 15000
  ) return;

  if (
    !Number.isFinite(balance) ||
    balance <= 0
  ) return;

  // Preserve existing cooldowns and loss limits.
  if (checkRiskGuards(s, balance).blocked) return;

  // Avoid repeated entries in the same market.
  if (s.earlyRetracementTicker === s.ticker) return;

  const yesPrice = ask;
  const noPrice = 1 - bid;

  const candidates = [];

  if (
    yesPrice > 0 &&
    yesPrice < EARLY_RETRACEMENT.entryBelow
  ) {
    candidates.push({ bet: 'UP', price: yesPrice });
  }

  if (
    noPrice > 0 &&
    noPrice < EARLY_RETRACEMENT.entryBelow
  ) {
    candidates.push({ bet: 'DOWN', price: noPrice });
  }

  if (!candidates.length) return;

  // Choose the cheapest qualifying contract.
  candidates.sort((a, b) => a.price - b.price);
  const { bet, price } = candidates[0];

  const budget = Math.min(
    EARLY_RETRACEMENT.maxEntryUsd,
    balance * 0.20,
    balance
  );

  const count = Math.floor((budget + 1e-9) / price);
  if (count < 1) return;

  const amount = count * price;
  if (amount > EARLY_RETRACEMENT.maxEntryUsd + 1e-9) {
    return;
  }

  // Reserve the cycle before submitting an order.
  // A rejected order can be retried next cycle, not
  // repeatedly in the same market.
  s.earlyRetracementTicker = s.ticker;

  try {
    const { body, result } = await executeBuy(
      s.ticker,
      bet,
      amount,
      ask,
      bid
    );

    const filled = confirmedFillCount(
      result,
      Number(body.count)
    );

    if (filled <= 0) {
      console.warn(
        '[EarlyRetracement] Entry not filled'
      );
      return;
    }

    const spent = filled * price;

    s.activeTrade = {
      ticker: s.ticker,
      bet,
      side: bet === 'UP' ? 'yes' : 'no',
      mode: EARLY_RETRACEMENT.mode,
      amount: spent,
      count: filled,
      entrySidePrice: price,
      entryYes: (ask + bid) / 2,
      peakYes: bet === 'UP' ? bid : 1 - ask,
      maxProfit: filled - spent,
      startedAt: Date.now(),
      takeProfitSidePrice:
        EARLY_RETRACEMENT.takeProfitPrice,
      stopLossSidePrice:
        EARLY_RETRACEMENT.stopLossPrice,
      timeExitSeconds:
        EARLY_RETRACEMENT.timeExitSeconds,
      canStopAfter: Date.now()
    };

    s.farmRounds++;

    console.log(
      `[EarlyRetracement] ${bet} ` +
      `${filled} contracts @ $${price.toFixed(2)} ` +
      `cost $${spent.toFixed(2)}`
    );
  } catch (error) {
    console.error(
      '[EarlyRetracement] Buy failed:',
      error.message
    );
  }
}

// Called by exitManager before its normal exit rules.
export function getEarlyRetracementExitReason(
  trade,
  yesAsk,
  yesBid,
  secsLeft
) {
  if (trade?.mode !== EARLY_RETRACEMENT.mode) {
    return null;
  }

  if (
    !Number.isFinite(yesAsk) ||
    !Number.isFinite(yesBid) ||
    !Number.isFinite(secsLeft)
  ) {
    return null;
  }

  const sellPrice = trade.side === 'yes'
    ? yesBid
    : 1 - yesAsk;

  if (secsLeft <= trade.timeExitSeconds) {
    return 'EARLY_TIME_EXIT';
  }

  if (sellPrice >= trade.takeProfitSidePrice) {
    return 'EARLY_TAKE_PROFIT';
  }

  if (sellPrice <= trade.stopLossSidePrice) {
    return 'EARLY_STOP_LOSS';
  }

  return null;
}
