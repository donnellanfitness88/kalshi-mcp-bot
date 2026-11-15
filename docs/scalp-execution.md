# Scalp execution

`SCALP_ENABLED=true` selects scalp and late settlement entries. Existing
DRY_RUN, simulation, risk guards and disabled-asset controls still apply.

## Current scalp rules

- New early/low-price scalp entries are disabled in the production executor,
  including the former below-15-cent YES exception and 16–25-cent band.
  The `earlyScalpsEnabled` dependency is used only by regression tests to
  exercise management of legacy entries; production defaults to false.
- Existing low-price holdings remain managed for their fee-aware profit target,
  verified manual sale, or settlement. No forced liquidation or journal deletion.
  Their existing <=20-cent target remains 50% estimated net return on original
  invested dollars including actual entry fees and reserved exit fees.
- A BTC late holding and an ETH late holding may coexist. Stage additions
  remain restricted to the same ticker, side and live/simulation mode per coin.
  Each coin retains its $77 cap, so combined late entry costs can reach $154,
  including fees and bounded by available exchange cash. Two new scalps remain
  prohibited. Existing early holdings may coexist with the other coin's late
  position while they finish. An unresolved order blocks all submissions.
- Any remaining higher-price scalp has at most a $1 entry budget including fees.
  Higher-priced scalps (above 70 and below 97 cents) are allowed only with
  strictly less than 120 seconds remaining. They retain momentum confirmation
  and scalp profit targets. Prices >=97 cents remain reserved for late settlement. Qualifying staged
  settlement entries take priority over higher-priced scalps.
- Require at least a 2-cent midpoint move over 5–10 seconds, positive movement
  in each of the last three elapsed one-second intervals, and no pullback
  greater than 1 cent below the purchased contract's recent midpoint high.
  NO signals use 1 minus YES midpoint. Existing spread/freshness gates apply.
- Existing low-price holdings retain fee-aware targets; higher-price scalp
  exits use contract-price points:

| Actual entry price | Target contract bid |
| --- | --- |
| Entry at or below 20 cents | Fee-aware price for 50% net return on original cost |
| Entries above 20 and below 80 cents | Entry plus 5 cents |
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
  Existing trades receive the current fee-aware profit rules after deploy;
  entry-band restrictions apply to new orders, not forced liquidation.
- An open scalp blocks late entries on its own coin. An early scalp permits
  late settlement entries on the other coin only. It exits at its
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

Every new late purchase and add-on must also pass this signed dollar-distance
check against the current market's official `floor_strike`:

| Stage | BTC minimum distance | ETH minimum distance |
| --- | --- | --- |
| under_180 ($2) | $50.00 | $1.00 |
| under_120 ($25) | $50.00 | $0.75 |
| under_60 ($50) | $50.00 | $0.50 |

Equality qualifies. YES requires the reference price above the target by at
least the buffer; NO requires it below by at least the buffer. Absolute distance
on the losing side never qualifies. These are entry filters, not stop-losses.
Existing holdings still follow their settlement/manual-sale reconciliation.

The reference is Kalshi's authenticated `cfbenchmarks_value_5hz` stream, index
`BRTI` for BTC and `ETHUSD_RTI` for ETH. Both source publication and local receipt
must be no older than two seconds, with no future timestamp. No Binance/Kraken
fallback is used for this gate. Missing, rejected or stale reference data blocks
late purchases until healthy data returns; existing holdings remain managed.
The socket responds to pings, reconnects after disconnects and clears old quotes.

The target is cached by coin and ticker after validating its market identity,
positive numeric strike and `greater_or_equal` contract type. Missing targets
are retried no faster than five seconds; a new ticker never inherits an old
strike. Recheck proximity after the final account reads immediately before
submission. A rejected distance does not reserve a stage or consume its budget,
and may be retried while its time/price stage remains eligible.

Entry confirmation logs include ticker and the order's proximity check: target,
reference price, signed distance, required minimum, source timestamp and check
time. The same evidence is persisted in the pending order for uncertain-response
recovery. This captures the submission check, not a guarantee of price at fill.

This filter uses the current reference index. It does not predict the eventual
final-minute settlement average, dynamically widen for volatility, or force an
exit if distance later shrinks. The fixed buffers are user-selected and do not
guarantee profit or a maximum loss.

### Shrinking-cushion guard for additional purchases

The first filled late purchase retains the existing fixed-distance and pricing
rules. Every subsequent purchase into a held late position (including retries
of a partly filled stage) must also pass the shrinking-cushion guard.

Use signed CF Benchmarks distance onto the winning side. Block an add-on when
all three conditions hold: the cushion fell at least 30% over 15 elapsed seconds,
the dollar drop is at least the current stage's existing minimum distance,
and the latest three-second change still approaches the target. Independently,
block while still approaching if the fifteen-second average approach speed
would consume the remaining cushion before expiry. This linear projection is a
risk heuristic, not a prediction of settlement or its final-minute average.

A trigger latches by coin, ticker and side. Resume only after ten consecutive
elapsed one-second checkpoints show a flat or improving cushion, with valid
continuous data and all original distance/price/time/risk requirements met.
The last ten seconds are scanned for recent triggers even if no order check ran
at the exact drop. Missing fifteen-second history, stale prices, or gaps over
1.5 seconds block add-ons. First buys do not need this additional history.

The guard uses sixty seconds of in-memory CF tick history and is checked both
before and after slow account reads. Latches are saved in the execution journal
before transmission and survive restarts; history rebuilds after a reconnect.
Blocked adds reserve no new stage budget and may retry within the original
stage. Logs retain guard metrics alongside the order's proximity evidence.
It does not force a sale, change entry prices, move budget between stages, or
change the $2/$25/$50 budgets or BTC/ETH fixed-distance thresholds.

Each stage has one budget per ticker, which may be filled through multiple
IOC limit orders. Missed earlier stages are skipped;
there is no catch-up buying. A higher price does not trigger several stages at
once. Each budget buys whole contracts and is bounded by available cash and the
remaining $77 cap for that coin. Potential payout must exceed estimated fees.
Market price is not an independent probability estimate or a guarantee.

The first purchase requires no holding on that coin. A tracked late holding
on the other coin (or a legacy early scalp there) is allowed. All in-scope live account
positions must exactly match both tracked holdings; unexpected, increased,
reversed or malformed positions and resting/uncertain orders still block entry.
Later stages may add only to the same ticker, side, and live/simulation mode. Existing risk guards continue to apply. The tracked weighted entry
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
settlement entry qualifies. New early/low-price scalps are disabled.

Late positions use `LATE_SETTLEMENT` mode and hold through settlement; scalp
profit targets do not apply. Full
entry cost remains at risk. After rollover, query the original held ticker.
Require a finalized binary outcome, a matching account settlement record
and no remaining account position before clearing a live holding. Attribute
only this tracked lot's payout/cost/entry fee, not cumulative prior scalp
activity in the same ticker. Void or ambiguous outcomes require reconciliation.

## Account scope and unrelated sports bets

Portfolio entry checks consider `KXBTC15M-` and `KXETH15M-` markets across all
windows, plus exact current, tracked and pending tickers. Unrelated sports,
combo and other series holdings or resting orders are excluded from these
exposure checks; no orders or positions outside the bot are canceled or sold.
A combo that merely mentions a crypto ticker in its own name is not a standalone
crypto position and is excluded unless its own ticker is explicitly tracked.

The bot still verifies every tracked live holding's exact signed quantity and
blocks unexpected BTC/ETH 15-minute positions or resting crypto orders. Missing
or conflicting market identities cannot be silently treated as sports and fail
closed. Both `ticker` and `market_ticker` response keys are supported when they
agree. Existing pending bot orders still block new submissions on both coins.
Manual-sale and settlement reconciliation remain specific to the held ticker.

Position scoping does not change exchange selection or balance accounting.
Available exchange cash is fetched as before and bounds each purchase; sports
stakes and reserved funds are never added back to available cash. Existing
risk limits, prices, stage budgets, proximity and shrinking guards remain in
force. Account mismatch logs now identify the entry coin and use
`CRYPTO_ACCOUNT_MISMATCH`, throttled to one per coin/reason per minute.

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
`node --test tests/unit/shrinking-cushion.test.js tests/unit/late-proximity.test.js tests/unit/scalp-entry-filters.test.js tests/unit/scalp-execution.test.js`

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
can still prevent new entries. The 8% daily-loss cap resets at midnight
America/New_York on the next entry check, independently of process restarts.
The 5% session-loss pause and three-loss streak brake retain their existing
behavior and are not cleared by a daily reset. Entry-block logs identify the
coin and risk reason, at most once per minute for each coin/reason pair.
Other strategies retain their existing cooldowns.
The late
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

## Fractional fill reconciliation

Entry sizing still requests whole contracts with the existing budgets. Exchange
fills may nevertheless contain hundredths of a contract. Quantities are parsed
as exact integer hundredths, and partial fills, holdings, manual reductions,
exit orders and settlement preserve those quantities without flooring.

On restart, the pending journal is reconciled against its terminal order and
all uniquely identified fills. The fill sum must exactly match the order's
filled quantity and cannot exceed the request. Missing fills, mismatched order
identity, unsupported precision, or overfills retain the pending lock. No
journal deletion or speculative clearing is performed. Pending reconciliation
is polled at most once every three seconds; count errors include the requested
and returned counts for diagnosis. Prices, budgets and strategy rules do not
change.

Reference: https://docs.kalshi.com/getting_started/fixed_point_migration.md

Proximity feed reference: https://docs.kalshi.com/websockets/cfbenchmarks-value-5hz
