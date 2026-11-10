import { placeOrder, cancelOrder, getOrders } from './client.js';
import { state } from '../engine/state.js';

// UP bet  → buy YES side  → count = floor(amount / ask_yes_price)
// DOWN bet → buy NO side  → count = floor(amount / (1 - bid_yes_price))
// Getting this wrong makes DOWN P&L show ~$0.00 (was 16x too small before fix)

export function buildBuyBody(ticker, bet, amount, yesAsk, yesBid) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  if (!Number.isFinite(yesAsk) ||
      !Number.isFinite(yesBid) ||
      yesBid <= 0 ||
      yesAsk >= 1 ||
      yesAsk < yesBid) {
    throw new Error('Invalid orderbook prices');
  }

  const isUp = bet === 'UP';

  if (!isUp && bet !== 'DOWN') {
    throw new Error(`Invalid bet: ${bet}`);
  }

  const sidePrice = isUp ? yesAsk : 1 - yesBid;
  const count = Math.floor(amount / sidePrice);

  if (count < 1) {
    throw new Error('Budget too low for one contract');
  }

  return {
    ticker,
    client_order_id: crypto.randomUUID(),
    side: isUp ? 'bid' : 'ask',
    count: count.toFixed(2),
    price: (isUp ? yesAsk : yesBid).toFixed(4),
    time_in_force: 'fill_or_kill'
  };
}


export function buildSellBody(ticker, side, contractsHeld) {
  const count = Math.floor(contractsHeld);
  if (count < 1) throw new Error(`Invalid contractsToSell: ${contractsHeld}`);

  const body = {
    ticker,
    client_order_id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    side,
    action: 'sell',
    count,
    time_in_force: 'fill_or_kill',
  };

  // Minimum acceptable sell price — take whatever the market gives
  if (side === 'yes') {
    body.yes_price_dollars = '0.0100';
  } else {
    body.no_price_dollars = '0.0100';
  }

  return body;
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
