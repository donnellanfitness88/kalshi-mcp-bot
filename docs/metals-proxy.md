# Metals spot-proxy observation

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
