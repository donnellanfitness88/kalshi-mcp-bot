import crypto from 'node:crypto';
import { placeOrder, cancelOrder, getOrders } from './client.js';
import { state } from '../engine/state.js';

// UP bet  → buy YES side  → count = floor(amount / ask_yes_price)
// DOWN bet → buy NO side  → count = floor(amount / (1 - bid_yes_price))
// Getting this wrong makes DOWN P&L show ~$0.00 (was 16x too small before fix)


export function buildSellBody(ticker, side, contractsHeld) {
  const count = Math.floor(contractsHeld);

  if (!Number.isFinite(contractsHeld) || count < 1) {
    throw new Error(`Invalid contracts held: ${contractsHeld}`);
  }

  if (side !== 'yes' && side !== 'no') {
    throw new Error(`Invalid position side: ${side}`);
  }

  return {
    ticker,
    client_order_id: crypto.randomUUID(),
    side: side === 'yes' ? 'ask' : 'bid',
    count: count.toFixed(2),
    price: side === 'yes' ? '0.0100' : '0.9900',
    time_in_force: 'fill_or_kill',
    reduce_only: true
  };
}

export async function executeBuy(ticker, bet, amount, yesAsk, yesBid) {
  const body = buildBuyBody(ticker, bet, amount, yesAsk, yesBid);
  // Sim mode — paper trade, no API call
  if (state.simMode || process.env.DRY_RUN === 'true') {
    console.log(`[SIM] BUY ${bet} $${amount.toFixed(2)} @ ${bet === 'UP' ? yesAsk : (1-yesBid)}`);
    return { body, result: { order: { remaining_count: 0 }, sim: true } };
  }
  const result = await placeOrder(body);
  return { body, result };
}

// Cancel any open orders for a ticker before selling to avoid double-buying
export async function cancelOpenOrders(ticker) {
  const orders = await getOrders({ ticker, status: 'resting' });
  for (const order of orders) {
    try {
      await cancelOrder(order.order_id);
    } catch {
      // Best-effort
    }
  }
}

export async function executeSell(ticker, side, contractsHeld) {
  // Sim mode — paper trade, no API call
  if (state.simMode || process.env.DRY_RUN === 'true') {
    const body = buildSellBody(ticker, side, contractsHeld);
    console.log(`[SIM] SELL ${side} ${contractsHeld} contracts`);
    return { body, result: { order: {}, sim: true } };
  }
  await cancelOpenOrders(ticker);
  const body = buildSellBody(ticker, side, contractsHeld);
  const result = await placeOrder(body);
  return { body, result };
}
