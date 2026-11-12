// Explicit exchange rejection only. Timeouts, 429/5xx and duplicate-id errors
// are not evidence that an order was never accepted.
export function definiteOrderRejection(error) {
  if (error?.requestMethod !== 'POST' || error?.requestPath !== '/portfolio/events/orders' ||
      error?.httpStatus !== 400 || error?.kalshiCode !== 'insufficient_balance') return null;
  return { httpStatus: 400, code: 'insufficient_balance', source: 'exchange_response' };
}

// One-time recovery evidence from the production log. The old version did not
// persist structured rejection data. This exact client id received this HTTP
// rejection at the timestamp below; it must never be generalized to other ids.
const observed = Object.freeze({
  '777a5890-567c-4d8d-a124-f85bd8b834c5': Object.freeze({
    httpStatus: 400, code: 'insufficient_balance', source: 'verified_production_log',
    observedAt: '2026-11-12T20:44:26.002925153Z'
  })
});
export function historicalOrderRejection(clientOrderId) {
  return Object.hasOwn(observed, clientOrderId) ? observed[clientOrderId] : null;
}
