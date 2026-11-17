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
