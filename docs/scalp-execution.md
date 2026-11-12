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

## Timing and dollar-loss update

- Open new scalps only with **more than 180 seconds** remaining. An existing
  scalp is not liquidated merely because the clock passes that boundary.
- Scalp profit targets remain 5% net after 15 seconds / 10% net immediately.
  Trigger an exit at 45 seconds or estimated total trade net P&L <= -$3.
  The loss calculation includes entry fees, reserved exit fees, and any
  realized partial exits. Gaps, network delays and slippage can exceed $3.
- Between 180 and 90 seconds remaining, open no new positions.
- With >0 and <=90 seconds remaining, allow one late entry per ticker on
  either side whose executable ask is >=$0.97 and <$1.00. Do not rely on
  midpoint or the opposite side's bid as the purchase price. The contract
  must have a positive potential payout after estimated entry fees.
- Late entries have a $10 entry budget including a standard taker-fee
  estimate, and share the single-position lock with scalp trades. Existing
  disabled-asset, balance, loss and cooldown guards still apply.
- Late trades use `LATE_SETTLEMENT` mode. Do not apply scalp stop-loss,
  profit targets or its 45-second timer to them. They can lose their full
  entry cost if the outcome reverses. A 97-cent price is not a guarantee.
- The journal persists mode, pending orders and late-entry ticker
  reservations. An unverified fill blocks further orders.
- After rollover, keep querying the original held ticker. Wait for a
  finalized binary result, a matching account settlement record and a zero
  remaining account position before clearing a live late holding. Attribute
  payout only to the tracked lot, subtract its confirmed entry cost/fee,
  and do not count the settlement record's cumulative prior scalp fees or
  revenue again. Unexpected fills, void results or invalid records require
  reconciliation rather than assumed profit. Simulation uses public market
  results and is explicitly marked simulated.
- Entry timing is rechecked after portfolio/balance reads, using the market's
  actual close time. Live holdings and pending orders remain managed even
  when new-entry mode is disabled or the market quote is unavailable.

Settlement schema reference:
https://docs.kalshi.com/api-reference/portfolio/get-settlements

## Stronger scalp entry filters

Scalp signals require at least a 2-cent midpoint move over a 5-to-10-second
observation. Each of the last three elapsed one-second intervals must show
positive movement in the chosen contract's direction, with timestamped
samples covering those intervals (not merely three feed messages). Reject
entry more than 1 cent below that contract's highest midpoint in the recent
observation. NO signals use the mirrored `1 - YES midpoint` series. These
filters do not change the late settlement entry or existing exit rules.

Validate with:
`node --test tests/unit/scalp-entry-filters.test.js tests/unit/scalp-execution.test.js`

## Manual sales

When a live holding is reduced outside the bot, poll account positions and
match the reduction to closing fills since entry. Verify each external
order is terminal, count/price/fee fields are valid, and the position is
unchanged on a second read. An absent position alone never clears a trade.
Full verified manual sales record net P&L and release the position lock;
partial sales retain the remaining contracts, proportional entry fees, and
realized net P&L. Persist before changing in-memory holdings. Remember
manual fill IDs and bot exit order IDs to prevent duplicate accounting.
The same path handles manual closure of late settlement holdings. Increased
or reversed positions, missing fills, nonterminal orders, and invalid data
remain blocked. Existing loss guards and cooldowns still apply after a
verified manual close. No keys or journal deletion are needed.
