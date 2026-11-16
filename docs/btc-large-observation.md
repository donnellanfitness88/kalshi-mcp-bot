# BTC independent large-entry observation

This scenario never places orders. It runs independently of the live ladder,
including while that ladder holds a position, and reuses its CF Benchmarks BRTI
connection. No additional reference subscription or API key is required.

Eligibility for either YES or NO:

- Strictly more than zero and less than 90 seconds remaining.
- Executable purchase ask at least 99 cents and strictly below $1. **No upper
  purchase-price cap**: 99.9 and 99.99 cents are included if fee-adjusted profit
  remains positive. The displayed percentage is not used as the purchase price.
- Official current market target, fresh CF reference no older than two seconds,
  and signed distance **strictly greater than $50** onto the purchased side.
- Six elapsed one-second checkpoints covering five seconds; each interval must
  improve the purchased side's cushion. Flat intervals do not qualify.
- Continuous 60-second reference history, with no gap over 1.5 seconds. Cushion
  must also be at least twice the observed 60-second high-low range. This is a
  preliminary volatility heuristic, not a calibrated probability estimate.
- Existing shrinking-cushion evaluator applies even to the first hypothetical
  purchase: minimum distance $50, rapid-drop absolute minimum $50, existing
  projected-crossing rule and two-second recovery. Its latch is scenario-local.

The model uses one $2,500 fee-inclusive budget per ticker. At the first qualifying
sample it sizes whole contracts against displayed best-price volume, the budget,
and the series' standard quadratic fee multiplier. It records the modeled spend,
unused budget and fee-adjusted potential profit. A partial displayed fill is
recorded once; this version does not model later top-ups, book walking or retries.
No limit is imposed based on the real wallet balance because this is a capacity
observation, not an executable trading plan. Cash, account risk, other live
holdings and combined exposure are explicitly unevaluated. Hypothetical P&L
must not be added to the actual live account profit.

Public discovery runs once per minute and book sampling every five seconds only
inside the final 90 seconds. Book responses older than two seconds are discarded;
the reference and all conditions are rechecked after receiving the book. API
errors cannot stop live execution. Missing data rejects qualification. Settlement
uses the exchange's official finalized YES/NO result, not the observer's own
price comparison. No stop-loss or predictive settlement guarantee is modeled.

Persistent journal: `$SCALP_STATE_DIR/btc-large-observer/state.json` (default
`data/btc-large-observer/state.json`). Retains 512 settled windows and the last
120 checks per window. A restart preserves entries and guards; it never copies
live ladder purchases. Windows whose observation starts inside the final 90
seconds are marked partial. Logs use `[BTC_LARGE_OBSERVER]` with STARTED, CHECK,
CANDIDATE, SETTLED_ESTIMATE and error events. Set
`BTC_LARGE_OBSERVER_ENABLED=false` to disable only this observer.

CF history retention increases from 60 to 65 seconds so a complete 60-second
interval has an earlier endpoint. Live eligibility, budgets and order code are
unchanged; the live shrinking evaluator still applies its own 60-second window.
