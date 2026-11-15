# Gold and silver observation

This first phase runs alongside BTC without importing an authenticated client,
placing orders, changing balances, or adding metals to the live execution engine.
It uses only public GET market and series endpoints. Set
`METALS_OBSERVER_ENABLED=false` to disable it; otherwise it starts with the app.
It does not purchase or subscribe to a Pyth data service.

## What it records

Gold (`KXGOLD15M`) and silver (`KXSILVER15M`) each use BTC's five price/time tiers:
$2 at >=90c under 180s; $5 at >=93c under 150s; $25 at >=95c under 120s;
$50 at >=97c under 60s; $100 at >=98c under 45s. Current tier only;
no catch-up. Strict time boundaries, either side, same side after the first
candidate. A market may have up to $182 of hypothetical cost including fees.

The observer records late-window best asks derived from opposite bids, displayed
size, official target/rules, fee metadata and one theoretical entry snapshot
per tier. Whole-contract estimates use at most visible best-level size and the
quadratic fee formula with series multiplier. Unsupported fee types yield no
candidate. Prices that arrive after a >2s HTTP request are discarded, but server
cache/quote age is unknown: receipt time is NOT an exchange quote timestamp.
Event-specific fee overrides, queue effects, changing liquidity and actual fills
are not modeled. Repeated partial-fill retries are not simulated.

Only official finalized/settled YES or NO results produce hypothetical payouts.
Unknown, delayed or void outcomes remain unresolved. Settlement estimates are
counted once and survive restart. Independent per-metal totals count winning
and losing market windows, not individual add-ons as separate wins. Settlement
checks rotate unresolved markets at one request/minute. Discovery is once per
minute per metal; books are polled every 5s in the final 3 minutes. HTTP failures
are contained and no polls overlap. No open market is a normal recorded state;
do not infer trading hours or manufacture contracts in gaps.

## What is still missing

These are PRICE_TIME_LIQUIDITY_ONLY candidates, not full BTC-strategy qualifiers.
There is no settlement-reference feed, metals-specific proximity threshold or
shrinking-cushion history in this phase. Account risk and shared available cash
are also not evaluated for these hypothetical independent portfolios. All these
checks are explicitly marked not evaluated. Do not treat the results as a live
profit forecast or claim a candidate passed proximity.

Series metadata inspected on 2026-11-15 identifies Pyth's
`Metal.Index.1OZGOLD/USD` for gold and `Metal.Index.SILVER/USD` for silver.
Retrieved market rules use one-minute candle closes (gold rounded to 2 decimal
places; silver to 3), unlike BTC's CF Benchmarks final-minute average.
Read current series/market rules again before live integration.
Kalshi's Pyth streaming documentation lists $1,000/month, first 7 days free.
No paid access is enabled by this patch. A matching source and separately chosen
gold/silver proximity limits are required before adding those filters.

## Persistence and reporting

State is atomically saved to `METALS_OBSERVER_DIR/state.json`, defaulting to
`$SCALP_STATE_DIR/metals-observer/state.json` (or `data/metals-observer/state.json`).
It never touches `scalp_execution.json`. Up to 512 closed markets and 120 late
book samples per market are retained; aggregate totals persist. Unresolved
markets are retained. Corrupt journals stop this observer rather than resetting
history. Candidate and settlement summaries appear under `[METALS_OBSERVER]`
in Railway logs. An offline report is available with:

```bash
node scripts/metals-observer-report.mjs
```

Run it where the saved observer directory is available (Railway's volume is not
automatically copied into Codespaces).

Sources:
- https://docs.kalshi.com/websockets/pyth-value
- https://api.elections.kalshi.com/trade-api/v2/series/KXGOLD15M
- https://api.elections.kalshi.com/trade-api/v2/series/KXSILVER15M
- https://docs.kalshi.com/api-reference/market/get-market-orderbook
