# Metals spot-proxy observation

## EUR/USD and USD/JPY observation extension

The same observer now includes EURUSD (`KXEURUSD15M`) and USDJPY (`KXUSDJPY15M`).
It requests trial feeds `FX.EUR/USD` (327) and `FX.USD/JPY` (340) in a separate
subscription on the existing three connections. An FX subscription rejection
does not close the metals subscription. No extra API key or paid upgrade is needed
by the code; actual entitlement is verified by fresh incoming values after deployment.

EUR/USD cushions are in USD per EUR; USD/JPY cushions are in JPY per USD.
The corresponding pip sizes are 0.0001 and 0.01. `estimatedCushionPips` exposes
this conversion without changing the signed price-distance calculation.
No dollar-per-ounce thresholds are copied to FX. These measurements remain
research references, not a validated reconstruction of the official close.

Currency rules, target and settlement source are preserved per market. Published
close rounding is five decimals for EUR/USD and three for USD/JPY; results come
from Kalshi's final result, not a locally rounded stream. Contract text contains
both 'at least' and 'strictly greater' wording; no live equality rule is inferred.

All four assets use the existing $2/$5/$25/$50/$100 exclusive observation stages.
Each is tracked independently. Cash, fills, proximity and shrinking-cushion guards
remain unmodeled. FX is NOT added to the live executor or account scope. No exchange
0 purchases are introduced. The existing metals journal, totals, settings and
report command are retained; FX totals appear as additional asset rows.

Missing targets discovered before publication are refreshed during final-stage
observation. Historical entries with missing targets are not backfilled.

Validate with `node --test tests/unit/fx-observer.test.js tests/unit/metals-proxy.test.js tests/unit/metals-observer.test.js`.

Set `PYTH_PRO_API_KEY` as a private Railway service variable. Do not put the key
in GitHub, patches, chat, screenshots or command history. No subscription is purchased
by this code. Without the variable the existing public observer continues normally.

The observer subscribes to Pyth Pro GOLD spot (346, Metal.XAU/USD) and SILVER
spot (345, Metal.XAG/USD) through all three documented WebSocket endpoints.
This is separate from Kalshi's paid Pyth feed. Trial entitlement must be verified
by receiving fresh data; a connected socket is not proof of entitlement.

Only regular-session, positive prices with a valid exponent and source timestamp
no more than two seconds old are accepted. Duplicate and older timestamps are
ignored. Carried-forward prices become stale even if messages continue arriving.
No stale or closed-session substitute is used during market breaks or weekends.

At each existing final-three-minute observer snapshot, the journal records:
- Target, proxy source/price/time/age, confidence if provided, and candidate/held side.
- Estimated signed cushion: spot minus target for YES, target minus spot for NO.
- Price change, range and signed cushion change over 15/30/60 elapsed seconds.
  Incomplete or gapped histories produce null metrics.

`CANDIDATE` and `PROXY_OBSERVATION` logs include these measurements. The journal
retains the existing bounded observations and closed-market history. Earlier
observations cannot be backfilled by this patch.

These spot feeds are NOT Metal.Index.1OZGOLD/USD or Metal.Index.SILVER/USD.
`referencePrice` and `distance` stay null; official proximity/shrinking filters
remain NOT_EVALUATED. `proxyIndexDifference` stays null because we have no official
index stream to compare against. Comparing to the final expiration value would
measure both price movement and source difference, not contemporaneous basis.
No calibrated buffer or live-entry permission can be inferred from these data alone.

Hypothetical entry sizing, stage selection and settlement estimates are unchanged.
No order placement is added, and BTC/ETH execution is untouched. Feed errors never
print credentials or raw server payloads. Expired/denied trial access produces
unavailable proxy measurements, not a paid upgrade or a trading fallback.

References:
- https://docs.pyth.network/pro/subscribe-to-prices
- https://docs.pyth.network/pro/payload-reference
- https://app.pyth.com/explore/Metal.XAU%2FUSD
- https://app.pyth.com/explore/Metal.XAG%2FUSD
