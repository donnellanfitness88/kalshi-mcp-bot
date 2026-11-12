// Pure reconciliation: an absent position alone never proves a sale.
export function remainingHeldContracts(positions, trade) {
  const rows = positions.filter(row => row.ticker === trade.ticker);
  if (rows.length > 1) throw new Error('Ambiguous account positions');
  if (!rows.length) return 0;
  const raw = rows[0].position_fp;
  if (!['string', 'number'].includes(typeof raw) || String(raw).trim() === '' || !Number.isFinite(Number(raw))) {
    throw new Error('Invalid account position');
  }
  const held = Number(raw) * (trade.side === 'yes' ? 1 : -1);
  if (!Number.isSafeInteger(held) || held < 0 || held > trade.count) {
    throw new Error('Account position increased or changed side; reconciliation required');
  }
  return held;
}
function value(raw, field) {
  if (!['string', 'number'].includes(typeof raw) || String(raw).trim() === '' ||
      !Number.isFinite(Number(raw)) || Number(raw) < 0) throw new Error('Invalid manual ' + field);
  return Number(raw);
}
export function reconcileManualExit(trade, held, fills) {
  const missing = trade.count - held;
  if (!Number.isSafeInteger(missing) || missing <= 0) throw new Error('No position reduction to reconcile');
  if (!trade.entryOrderId) throw new Error('Entry order ID required for manual reconciliation');
  const accounted = new Set(trade.accountedExitOrderIds ?? []);
  const seen = new Set(trade.manualExitFillIds ?? []);
  const closingBook = trade.side === 'yes' ? 'ask' : 'bid';
  const candidates = [];
  let sold = 0, proceeds = 0, fees = 0;
  for (const fill of fills) {
    if ((fill.ticker ?? fill.market_ticker) !== trade.ticker) continue;
    if (fill.order_id === trade.entryOrderId || accounted.has(fill.order_id)) continue;
    const ts = Date.parse(fill.created_time);
    // Fill timestamps may be rounded to seconds. Never match earlier windows.
    if (!Number.isFinite(ts) || ts < Math.floor(trade.startedAt / 1000) * 1000) continue;
    const id = fill.fill_id ?? fill.trade_id;
    if (id && seen.has(id)) continue;
    if (!id || !fill.order_id) throw new Error('Manual fill identifiers missing');
    if (fill.book_side !== closingBook) throw new Error('Unexpected external entry; reconciliation required');
    const quantity = value(fill.count_fp, 'count');
    const price = value(trade.side === 'yes' ? fill.yes_price_dollars : fill.no_price_dollars, 'price');
    const fee = value(fill.fee_cost, 'fee');
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || price > 1) throw new Error('Invalid manual fill');
    seen.add(id);
    candidates.push({ id, orderId: fill.order_id, quantity });
    sold += quantity; proceeds += quantity * price; fees += fee;
  }
  if (sold !== missing) throw new Error('Manual fills do not match account reduction; waiting for reconciliation');
  const allocatedEntryFees = trade.entryFees * sold / trade.count;
  return {
    held, sold, proceeds, fees, allocatedEntryFees,
    net: proceeds - sold * trade.entrySidePrice - allocatedEntryFees - fees,
    fillIds: candidates.map(fill => fill.id),
    orders: [...new Set(candidates.map(fill => fill.orderId))].map(orderId => ({
      orderId, count: candidates.filter(fill => fill.orderId === orderId).reduce((sum, fill) => sum + fill.quantity, 0)
    }))
  };
}
