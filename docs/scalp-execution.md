# Scalp execution

`SCALP_ENABLED=true` selects scalp and late settlement entries. Existing
DRY_RUN, simulation, risk guards and disabled-asset controls still apply.

## Current scalp rules

- Entry budget: at most $10 including a fee reserve. One position or unresolved
  order across BTC and ETH. Entries require more than 480 seconds remaining.
- Filter the executable ask of the contract being purchased, YES or NO.
  Exclude 40–60 cents inclusive. Allow below 40 cents or above 60 cents and
  below 97 cents. Prices >=97 cents are reserved for the separate late mode.
- Require at least a 2-cent midpoint move over 5–10 seconds, positive movement
  in each of the last three elapsed one-second intervals, and no pullback
  greater than 1 cent below the purchased contract's recent midpoint high.
  NO signals use 1 minus YES midpoint. Existing spread/freshness gates apply.
- Profit exits use contract-price points, not a percent return on the stake:

| Actual entry price | Target contract bid |
| --- | --- |
| Below 80 cents | Entry plus 5 cents |
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

Between 480 and 90 seconds remaining, open no new position. In the final
90 seconds, when flat, allow one late entry per ticker on a YES or NO
executable ask >=97 cents and <$1. Entry cost plus estimated standard taker
fees must fit within $10 and potential settlement gain must exceed estimated
fees. This price is not an independent probability estimate or guarantee.

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
settlement entry keeps its once-per-ticker reservation and existing risk guards.
