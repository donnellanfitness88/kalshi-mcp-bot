
import crypto from 'node:crypto';
import { placeOrder, cancelOrder, getOrders } from './client.js';
import { state } from '../engine/state.js';

// Kalshi V2 uses a single YES book: bid = buy YES; ask = sell YES.
// The existing strategy's UP/DOWN and yes/no position terminology is retained.
function validQuote(yesAsk, yesBid) {
  if (![yesAsk, yesBid].every(Number.isFinite) ||
      yesBid <= 0 || yesAsk >= 1 || yesAsk < yesBid) {
    throw new Error('Invalid orderbook prices');
  }
}

export function buildBuyBody(ticker, bet, amount, yesAsk, yesBid) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  if (bet !== 'UP' && bet !== 'DOWN') {
    throw new Error(`Invalid bet: ${bet}`);
  }
  validQuote(yesAsk, yesBid);
  const isUp = bet === 'UP';
  const sidePrice = isUp ? yesAsk : 1 - yesBid;
  const count = Math.floor(amount / sidePrice);
  if (count < 1) throw new Error('Budget too low for one contract');
  return {
    ticker,
    client_order_id: crypto.randomUUID(),
    side: isUp ? 'bid' : 'ask',
    count: count.toFixed(2),
    price: (isUp ? yesAsk : yesBid).toFixed(4),
    time_in_force: 'fill_or_kill',
    self_trade_prevention_type: 'taker_at_cross',
  };
}

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
    time_in_force: 'immediate_or_cancel',
self_trade_prevention_type: 'taker_at_cross',
reduce_only: true,
  };
}

// V2 returns fill_count at the top level. Never infer a fill from a missing field.
export function confirmedFillCount(result, requestedCount) {
  if (result?.sim === true) return requestedCount;
  const raw = result?.fill_count;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error('Kalshi V2 response missing fill_count');
  }
  const count = Number(raw);
  if (!Number.isFinite(count) || count < 0 || count > requestedCount) {
    throw new Error(`Invalid Kalshi fill_count: ${raw}`);
  }
  return count;
}

export async function executeBuy(ticker, bet, amount, yesAsk, yesBid) {
  const body = buildBuyBody(ticker, bet, amount, yesAsk, yesBid);
  if (state.simMode || process.env.DRY_RUN === 'true') {
    console.log(`[SIM] BUY ${bet} $${amount.toFixed(2)} @ ${bet === 'UP' ? yesAsk : (1 - yesBid)}`);
    return { body, result: { fill_count: body.count, remaining_count: '0.00', sim: true } };
  }
  const result = await placeOrder(body);
  confirmedFillCount(result, Number(body.count));
  return { body, result };
}

export async function cancelOpenOrders(ticker) {
  const orders = await getOrders({ ticker, status: 'resting' });
  for (const order of orders) {
    try {
      await cancelOrder(order.order_id);
    } catch (err) {
      console.warn(`[Orders] Could not cancel ${order.order_id}: ${err.message}`);
    }
  }
}

export async function executeSell(ticker, side, contractsHeld) {
  const body = buildSellBody(ticker, side, contractsHeld);
  if (state.simMode || process.env.DRY_RUN === 'true') {
    console.log(`[SIM] SELL ${side} ${contractsHeld} contracts`);
    return { body, result: { fill_count: body.count, remaining_count: '0.00', sim: true } };
  }

console.log('[SELL-DIAG] Request:', JSON.stringify({
  ticker: body.ticker,
  side: body.side,
  price: body.price,
  count: body.count,
  time_in_force: body.time_in_force,
  reduce_only: body.reduce_only
}));

const result = await placeOrder(body);

console.log('[SELL-DIAG] Response:', JSON.stringify({
  order_id: result?.order_id ?? result?.order?.order_id,
  fill_count: result?.fill_count,
  remaining_count: result?.remaining_count,
  status: result?.status ?? result?.order?.status
}));

confirmedFillCount(result, Number(body.count));
return { body, result };

}

