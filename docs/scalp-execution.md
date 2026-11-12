# Scalp execution

`SCALP_ENABLED=true` selects scalp entries instead of farm/auto-buy entries.
The existing `DRY_RUN` and simulation override remain authoritative. Live
execution requires `DRY_RUN=false` and a live account balance.

- Entry cost is capped at $10 including a fee reserve (2 cents per contract
  plus one cent rounding). Actual entry price and fee come from the V2 order
  acknowledgment. This reserve exceeds the standard maximum taker fee for
  the supported BTC/ETH markets; review it if their fee multiplier changes.
- One active position or unresolved order across BTC and ETH.
- FOK entries; reduce-only IOC exits. A 45-second threshold triggers an exit
  attempt, not a guarantee of liquidation at that second or price.
- Targets are net of entry fees and reserved exit fees: 10% immediately, or
  at least 5% after 15 seconds. At 45 seconds exit regardless of return.
- Timeouts and incomplete acknowledgments stay pending. Subsequent ticks
  query the existing order and its fills; they do not resubmit it.
- Partial sales retain the unsold holding. Net realized P&L uses actual
  acknowledged prices and fees; final settlement requires reconciliation.
- Existing account positions or resting orders block new entries. Startup
  in scalp mode does not automatically liquidate unrelated account holdings.
- `SCALP_STATE_DIR` should point to a persistent volume (production:
  `/scalp-state`). The journal is written before an order is sent and restored
  after restarts. Without persisted state, account holdings still block new
  entries but cannot be reconstructed automatically.
- Existing cooldown and loss guards still apply. Profitability is unproven.

Validation: `node --test tests/unit/scalp-execution.test.js`.
The repository's older general test suite contains pre-existing failures
against its current API and neural-network shapes; compare to the parent
commit before attributing them to this change.

API references:
- https://docs.kalshi.com/api-reference/orders/create-order-v2
- https://docs.kalshi.com/api-reference/orders/get-order
- https://docs.kalshi.com/api-reference/portfolio/get-fills
- https://kalshi.com/docs/kalshi-fee-schedule.pdf
