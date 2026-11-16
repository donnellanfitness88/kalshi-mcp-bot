# Coordinated balance requests

`getBalance()` uses one process-wide coordinator. Background clock, entry and
other client callers share an in-flight request, including its waits and retries.
There is no completed-result cache. A later caller always performs a new read,
with at least 1,100 milliseconds after the previous response/error before the
next network attempt. This conservatively fits Kalshi's Basic/Advanced balance
limit without assuming this account has a higher tier.

Only balance GET requests retry 429 responses, at most twice (three total
attempts). Delays grow from 1.1s to 2.2s; the cooldown after a final rejection
continues to apply to the next caller. The server's X-RateLimit-Reset seconds
are considered, with backoff bounded to five seconds. Malformed/missing headers
use the default delay. No cached balance is returned after an error; exhausted
retries or invalid balances propagate an error. Authentication, network and
non-429 failures are not automatically retried. Request errors retain HTTP
status, exchange error code, method and path. No order placement, cancellation
or reconciliation request is automatically retried by this coordinator.

Existing post-balance entry checks still re-evaluate ticker, live/simulation
state, side, time tier, exact price, account positions, fresh reference distance
and shrinking cushion before submitting. A wait may legitimately mean skipping
an expired tier or expired contract. Portfolio/account isolation and ambiguous
order locks are unchanged. The BTC stage allocations, $30 proximity, two-second
recovery, ETH disable and metals observation mode are unchanged.

This coordinates callers within this bot process, not other applications using
the same Kalshi account. It can reduce self-generated 429s, not guarantee the
exchange never returns one. Warnings identify bounded retries in Railway logs.

Source: https://docs.kalshi.com/getting_started/rate_limits
