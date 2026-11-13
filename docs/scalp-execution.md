# Scalp execution

`SCALP_ENABLED=true` selects scalp and late settlement entries. Existing
DRY_RUN, simulation, risk guards and disabled-asset controls still apply.

## Current scalp rules

- Every scalp entry has a maximum $1 budget including the fee reserve,
  limited by available cash and whole contracts. All existing entry eligibility,
  timing, momentum checks and price targets stay in place. There is still no
  per-trade stop or maximum hold. Existing holdings are not resized.
  One position or unresolved order is allowed across BTC and ETH, with additions
  allowed only to the same late holding. Early entries require more than
  480 seconds remaining.
- Filter the executable ask of the contract being purchased, YES or NO.
  Early entries allow YES below 15 cents, or either side at 55–70 cents inclusive.
  Cheap NO entries are blocked. When YES is below 40 cents and falling,
  the existing downward momentum signal can buy NO, subject to its own
  executable 55–70-cent purchase price and the existing timing gates.
  A YES purchase below 15 cents targets a 20-cent executable bid.
  Higher-priced scalps (above 70 and below 97 cents) are allowed only with
  strictly less than 120 seconds remaining. They retain momentum confirmation
  and scalp profit targets. Prices >=97 cents remain reserved for late settlement. Qualifying staged
  settlement entries take priority over higher-priced scalps.
- Require at least a 2-cent midpoint move over 5–10 seconds, positive movement
  in each of the last three elapsed one-second intervals, and no pullback
  greater than 1 cent below the purchased contract's recent midpoint high.
  NO signals use 1 minus YES midpoint. Existing spread/freshness gates apply.
- Profit exits use contract-price points, not a percent return on the stake:

| Actual entry price | Target contract bid |
| --- | --- |
| YES below 15 cents | 20 cents |
| Other entries below 80 cents | Entry plus 5 cents |
| 80 to below 90 cents | 90 cents |
| 90 to below 97 cents | 97 cents |

- Profit targets can trigger immediately; no 15-second waiting period.
  Examples: 70→75, 80→90, 90→97. Fees reduce net profit from these moves.
- No maximum scalp holding time and no per-trade dollar-loss exit. A holding
  stays open for its profit target or settlement unless manually closed.
  It can lose its entire entry cost at settlement.
- Profit exits use a reduce-only IOC limit at the target price; partial or
  unfilled quantities remain managed. Unfilled profit orders are
  retried only while the target remains executable; otherwise the position
  stays managed until another target opportunity or settlement.
- Existing scalps are not closed solely for passing the 480-second boundary.
  Existing trades still receive the current price-target rules after deploy;
  entry-band restrictions apply to new orders, not forced liquidation.
- An open scalp continues to block the late settlement entry. It exits at its
  profit target, or is reconciled against its actual
  settlement if held through market expiry. After rollover, it retains its
  original ticker and cannot use the new market quote for its exit.

## Late settlement entries

Late entries use three incremental budgets, including estimated entry fees:

| Time remaining | Minimum executable contract ask | Additional budget |
| --- | --- | --- |
| Below 180 seconds, down to 120 seconds inclusive | 90 cents | $2 |
| Below 120 seconds, down to 60 seconds inclusive | 95 cents | $25 |
| Below 60 seconds, above zero | 97 cents | $50 |

Each stage has one budget per ticker, which may be filled through multiple
IOC limit orders. Missed earlier stages are skipped;
there is no catch-up buying. A higher price does not trigger several stages at
once. Each budget buys whole contracts and is bounded by available cash and the
remaining combined $77 cap. Potential payout must exceed estimated fees.
Market price is not an independent probability estimate or a guarantee.

The first purchase requires a flat account. Later stages may add only to the
same ticker, side, and live/simulation mode. An open scalp, a different asset's
holding, an unexpected account position, or a resting/uncertain order blocks
additions. Existing risk guards continue to apply. The tracked weighted entry
price, contract count, actual fees, total spend, and every entry order ID are
persisted together. Confirmed partial fills reduce both that stage's remaining
budget and the combined remaining budget, including their actual fees. Confirmed
zero fills consume no budget. Retry checks and submissions are spaced at least
three seconds apart for the same stage, and the retry timestamp and spent amount
survive restarts. Each retry uses a new client order ID, a fresh price/time check,
and an account check. The limit stays at the current executable quote; there is
no extra slippage allowance. Unfilled IOC quantities are canceled rather than
left resting. Uncertain or nonterminal orders block all further purchases until
reconciled; a terminal zero-fill result permits a retry. Explicit insufficient-
balance rejections block that stage without adding spend or P&L. Once a late
sequence starts, a nonqualifying stage cannot fall through into a scalp or switch
sides. Older stage reservations without per-stage spend records remain blocked
for the already-attempted stages rather than guessing how much was spent. A fully verified manual close ends further stages
for that ticker. Partial manual sales do not reset the spend cap.

Older journal holdings without staged reservation history are held and
reconciled normally but cannot receive additions. Higher-priced scalp entries
retain their existing below-two-minute timing and profit targets if no staged
settlement entry qualifies. Early scalp rules are unchanged.

Late positions use `LATE_SETTLEMENT` mode and hold through settlement; scalp
profit targets do not apply. Full
entry cost remains at risk. After rollover, query the original held ticker.
Require a finalized binary outcome, a matching account settlement record
and no remaining account position before clearing a live holding. Attribute
only this tracked lot's payout/cost/entry fee, not cumulative prior scalp
activity in the same ticker. Void or ambiguous outcomes require reconciliation.

## Order and manual-sale reconciliation

FOK entries use actual acknowledged counts/prices/fees. Journal before
sending; ambiguous responses are reconciled from the existing order and its
fills, never resubmitted. A partial sale retains the remainder. Persist mode,
pending orders and late ticker reservations under SCALP_STATE_DIR (production:
/scalp-state on a volume). Holdings and pending orders remain managed when
new entries are disabled or quotes are unavailable.

For a manual sale, verify the account reduction against closing fills since
entry, terminal external orders and actual fees, then reread positions.
Full verified sales record net P&L and release the lock; partial sales retain
remaining contracts, proportional fees and realized P&L. Persist before
changing in-memory holdings. Remember manual fill IDs and bot exit order IDs
against duplicate accounting. Missing fills, reversed/increased holdings or
invalid data remain blocked. Account-level risk guards still apply.

Validate:
`node --test tests/unit/scalp-entry-filters.test.js tests/unit/scalp-execution.test.js`

The older general suite has pre-existing failures against current API/NN
shapes. Passing execution tests verifies programmed behavior, not profitability.

References:
- https://docs.kalshi.com/api-reference/orders/create-order-v2
- https://docs.kalshi.com/api-reference/orders/get-order
- https://docs.kalshi.com/api-reference/portfolio/get-fills
- https://docs.kalshi.com/api-reference/portfolio/get-settlements
- https://kalshi.com/docs/kalshi-fee-schedule.pdf

## Reentry

No fixed waiting period between scalp trades. The 8-second reentry delay and
45-second after-loss entry cooldown do not apply to scalps. A fresh qualifying
signal, valid quotes, a flat account and no unresolved order are still required.
Consecutive-loss, session-loss and daily-loss guards remain in force; those
can still prevent new entries. Other strategies retain their existing cooldowns.
A 61-cent scalp entry targets 66 cents immediately when executable. The late
settlement entry keeps its per-stage budget reservation and existing risk guards.

## Explicitly rejected requests

Preserve HTTP status, exchange error code, method and endpoint on API errors.
An explicit HTTP 400 insufficient_balance from POST /portfolio/events/orders
is a rejection, not an unknown fill. Before releasing its pending lock,
verify no matching client-order record, no resting order on the ticker,
and (for entries) no account position or tracked holding. Recheck order state
and durably clear the pending record before releasing the memory lock. Do
not record a trade or change P&L for the rejected request.

One migration proof covers client id 777a5890-567c-4d8d-a124-f85bd8b834c5:
the production log recorded HTTP 400 insufficient_balance at
2026-11-12T20:44:26.002925153Z. Apply the same account checks to it. This
proof is exact-id only and cannot clear other missing orders. Timeouts,
429/5xx, conflicting exchange records and incomplete evidence remain blocked.

Execution reference: https://docs.kalshi.com/api-reference/orders/create-order-v2
