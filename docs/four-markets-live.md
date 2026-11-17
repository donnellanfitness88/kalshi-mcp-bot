# Gold, silver and currency late entries

This update enables GOLD (KXGOLD15M), SILVER (KXSILVER15M), EURUSD
(KXEURUSD15M) and USDJPY (KXUSDJPY15M) through the existing journaled late
executor. The separate $2,500 BTC scenario remains observation only. ETH and
all scalp paths retain their current disabled settings. Existing BTC late
price, timing, distance and shrinking-cushion rules are unchanged.

Each of the four markets uses these **incremental**, fee-inclusive budgets:

| Seconds remaining | Minimum executable contract ask | Additional budget |
| --- | --- | --- |
| 150 <= seconds < 180 | 90 cents | $2 |
| 120 <= seconds < 150 | 93 cents | $5 |
| 60 <= seconds < 120 | 95 cents | $25 |
| 45 <= seconds < 60 | 97 cents | $50 |
| 0 < seconds < 45 | 98 cents | $100 |

The combined cap is $182 per market/window, not per order. Missed stages are
not backfilled. Zero/partial fills can retry only the unused budget, at least
three seconds apart, while the same stage still qualifies. Requests buy whole
contracts and cannot exceed displayed top-of-book liquidity. Actual fractional
fills and actual fees are journaled using the existing execution path.

All four markets apply the exact corrected observer guard to **every purchase**:
Pyth spot must be fresh (at most two seconds old), on the winning side of the
published target, and have continuous valid history. No fixed $2 gold / 7-cent
silver cushion and no BTC $30 distance floor are applied to these four markets.
A 30% cushion decline over 15 seconds while still approaching, or the existing
15-second approach projection reaching the target before expiry, blocks entry.
The latch needs two full consecutive nondecreasing seconds to recover. There
is no separate large-BTC volatility multiplier requirement for these markets.
Pyth spot is a proxy, not the official settlement index. Holdings continue to
settlement unless manually sold; these are entry filters, not protective exits.

The shared executor serializes submissions and blocks all new orders while an
order outcome is uncertain. Account checks cover all six managed 15-minute
series; unrelated sports/combo holdings are ignored. Unknown or mismatched
managed-market positions and resting orders block entry. Existing loss caps,
loss cooldowns, DRY_RUN, simulation, farmArmed and disabled-asset controls apply.
New markets' position, stage budgets, guard latch and risk counters survive
restart. Original tickers and verified exchange settlement records determine
payouts, rather than hypothetical observer estimates.

BTC, gold and silver use available cash in **Exchange 2**; EUR/USD and USD/JPY
use **Exchange 0**. New-market metadata must confirm that exchange before an
order is sent. No automatic transfers are made. Five simultaneous fully filled
ladders require up to $910: $546 on Exchange 2 and $364 on Exchange 0. Smaller
balances limit actual entries. This is maximum committed capital, not an
expected loss or guaranteed payout.

`LATE_MARKETS_LIVE_ENABLED` defaults to enabled in this update. Set it to
`false` to block new purchases on these four markets; existing holdings still
reconcile. Keep the existing `SCALP_ENABLED=true` setting: despite its name, it
selects the managed late executor. Existing `DRY_RUN`/simulation toggles are
respected. A missing/expired Pyth key, stale data, invalid metadata or missing
history prevents new orders; it does not guess qualification.

The read-only observers continue separately. Their candidates may differ from
actual orders because live execution also checks account risk/cash, displayed
size, revalidates prices after account reads and handles partial fills. Never
count observer candidates as actual fills or actual P&L.

## Validation

Run the focused regression command supplied with this patch. The historical
scalp-execution file currently has 44 pre-existing failures that expect disabled
scalp behavior; the complete file has the same 84 passing and 44 failing tests
before and after this change. This patch does not re-enable scalps to satisfy
those obsolete expectations. New live-market tests and the current reference,
observer, order-client, balance and BTC-large-observer regressions pass.

## Directional executable-book correction

A new late purchase validates the executable offer and displayed size for the
contract it is buying. A missing offer in the unused opposite direction does
not, by itself, disqualify that purchase. Missing quotes stay null; the order
builder receives the actual selected-side price and converts it to the V2 YES
book price for NO purchases. No artificial bid or ask is substituted.

The response must still arrive within two seconds. Empty and invalid/crossed
books remain blocked, as do absent selected-side offers, less than one displayed
contract, a price below the active stage threshold, exhausted budgets, negative
fee-adjusted returns, account/risk mismatches and failed reference/guard checks.
The selected price, direction, time tier and available size are rechecked after
account reads; disappearing liquidity cannot produce an order. BTC's existing
order builder and book validation are unchanged. Error logs distinguish
EXECUTABLE_BOOK_STALE_RESPONSE, EXECUTABLE_BOOK_INVALID_OR_CROSSED and
EXECUTABLE_BOOK_EMPTY. This corrects a reproducible two-sided requirement; it
does not retrospectively identify the cause of every historical rejection.

Validation: `npm run test:four-markets` passes 99 focused tests, including
end-to-end one-sided YES and NO purchases for all four approved markets and
negative cases for stale/crossed/empty books, sub-contract size and disappearing
selected-side liquidity. The historical scalp suite retains the same 84 passing
and 44 pre-existing failures; no new BTC regression failures were introduced.

## Silver projected-crossing buffer

Every new live SILVER purchase, including the first entry, stage additions and
remaining-budget retries, must also pass a 20-second projected time margin.
The projection uses the existing 15-second average approach speed. When that
speed is positive, subtract the source quote's age from its projected crossing
time, then subtract the actual seconds remaining. The resulting margin must
be strictly greater than 20 seconds. Equality blocks entry. For example, a
crossing projected in 70 seconds with 57 seconds remaining blocks the purchase.

This is a condition-based wait, not a fixed 20-second timer. The normal retry
loop rechecks; the current stage can qualify once the trajectory moves outside
that buffer or the 15-second trend stops approaching, provided all original
checks pass. Two-second stabilization cannot override this extra gate. It is
checked again immediately before submission after account/book reads. Invalid
or stale projection data blocks entry. The normal exclusive time tiers still
apply: expired stages are not backfilled and no uncertain order is retried.

The 20-second gate is live SILVER only; EURUSD uses the separate 15-second
gate below. These gates do not sell existing holdings, change allocations, or
alter BTC, gold, USDJPY, baseline observers or the large BTC observation scenario. Entry logs include entryTimeBufferSeconds,
projectedCrossingSecondsFromNow and projectedMarginSeconds; blocked entries use
SILVER_CROSSING_TIME_BUFFER (or SILVER_BUFFER_DATA_UNAVAILABLE). It adds an entry
restriction and does not guarantee a crossing time, settlement result or
maximum loss. Historical observer totals do not include this extra live gate.


## EUR/USD projected-crossing buffer

Every new live EURUSD purchase, including initial entries, stage additions and
partial-fill budget retries, requires more than 15 seconds of projected margin
beyond expiry while the 15-second average trend approaches the target. The
same source-age adjustment and independent pre-submission recheck used for
silver apply. A margin of exactly 15 seconds blocks entry. A non-approaching
average trend can pass this gate, provided all original safeguards pass.
Two-second stabilization alone cannot override an insufficient time margin.

The existing SILVER buffer remains 20 seconds. No allocation, entry-price,
time-tier, freshness, book, fee, account, shrinking-latch or settlement rule is
removed. Block logs identify EURUSD_CROSSING_TIME_BUFFER or
EURUSD_BUFFER_DATA_UNAVAILABLE; entry logs record the 15-second threshold and
measured margin. This applies to new purchases and does not close holdings.
The read-only observer baselines do not include these extra live time buffers.

Validation: 105 focused tests pass, including YES/NO delay-and-resume execution,
quote-age adjustment, exact threshold rejection and preservation of silver's
20-second threshold and the original shrinking-cushion checks.

## USD/JPY buffer and large-stage warning recovery

USDJPY now uses the same independent projected-crossing margin gate as EURUSD:
when the 15-second average cushion is shrinking, the source-age-adjusted
projected crossing must be more than 15 seconds beyond expiry. Equality blocks.
This applies to every new USDJPY purchase, including initial purchases,
additions and partial-fill retries, and is rechecked immediately before
submission. A two-second pause cannot override this gate. Silver remains at
20 seconds; EURUSD remains at 15 seconds.

Across live BTC and all four approved markets, a stage allocated $25 or more
cannot clear a shrinking-cushion warning on two-second stabilization alone.
Recovery additionally requires both the trailing 15-second and trailing
60-second signed winning-side cushion changes to be nonnegative, allowing only
a 1e-9 numerical tolerance. The 60-second history must be continuous under the
existing gap limits. Missing history keeps a warning latched. Both flat and
improving broader trends can qualify if two-second stabilization and all other
checks also pass. A fresh rapid-drop or projected-crossing warning receives the
same treatment, including before the first fill of a larger stage.

The threshold uses the original stage allocation ($25/$50/$100), not the
remaining budget or actual order value: a $1 retry in a $25 stage still receives
the stricter recovery check. The latch is durably saved before a rejected
purchase returns and restored after a restart. The check runs before account
reads and again before submission. $2/$5 stages retain their existing recovery
rule. This does not create a new warning solely from a negative longer trend
when no current or persisted shrinking-cushion warning exists.

Logs expose `longRecovery` when a warning requires this check, including
`cushionChange15`, `cushionChange60` and `historyAvailable`. Rejections identify
`SHRINK_LONG_TREND_RECOVERY` or `SHRINK_LONG_HISTORY_UNAVAILABLE`; USDJPY time
buffer rejections use `USDJPY_CROSSING_TIME_BUFFER` or
`USDJPY_BUFFER_DATA_UNAVAILABLE`.

Allocations, entry-price/time tiers, existing BTC distance checks, settlement
handling and other risk gates are retained. These are purchase filters and do
not close existing holdings or guarantee a settlement result. Read-only
observer baselines, including the large BTC observation, retain their existing
recovery behavior. Their results should not be represented as a replay of
these stricter live gates.

Validation: `npm run test:four-markets` passes 114 tests, including USDJPY
YES/NO delay and resume, final pre-submission deterioration, exact time-buffer
thresholds, all four markets at all three larger stages, partial-budget retries,
YES/NO broader-trend recovery, missing/gapped history and restart persistence.

## Separate $900 sixth stage

BTC, GOLD, SILVER, EURUSD and USDJPY retain their first five stages. The separate
`under_45_extra` stage permits up to $900 including fees, only below 45 seconds
and at an executable purchased-side price of at least 98 cents. It unlocks once
confirmed, finite fifth-stage spending reaches $50 including fees, replacing
the former $99 prerequisite. ETH remains unchanged and disabled.

Every extra-stage purchase/retry still requires fresh continuous history and
nonnegative 15-second AND 60-second signed cushion changes. Five-second recovery
is required only when a current or persisted shrinking-cushion warning is
active. Without a warning, a small recent dip is not an independent rejection
if both broader trends and all other checks pass. Clearing a warning requires
five elapsed seconds of nondecreasing cushion across all intervening source
samples. These are rolling lookbacks, not a new timer after the fifth fill.
Broader-trend/history failures remain blocked and latched until recovery.

All existing proximity, crossing-time, cash, account, risk, price, expiry and
executable-liquidity checks remain and run again before submission. Available
liquidity and actual IOC execution still limit fills; $900 is not guaranteed.
Unfilled fifth-stage budget is not transferred to stage six: $50 plus $900 is
$950 across those two stages. No missed earlier stage is backfilled. The
maximum combined cap remains $1,082 per market, bounded by available cash.
The durable ledger and warning state survive retries and restarts. Existing
holdings can qualify if recorded fifth-stage spending meets $50. The 25% daily
cap, 5% session guard, other allocations and $2,500 BTC observer are unchanged.

Validation: 122 focused four-market tests and six daily-cap tests pass, covering
the $50 boundary across five markets, YES/NO partial fifth fills, unflagged small
dips, warned five-second recovery, gaps and adverse broader trends, final
pre-submit checks, partial-budget retries and restart persistence.
