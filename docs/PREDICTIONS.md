# Prediction markets: two $100 paper accounts

The September 13, 2026 user request authorizes new Polymarket and Kalshi paper research, separate $100 paper allocations, and preparation for later real-money execution. It does not activate real trading. The active Polymarket venue is **Polymarket US**. The international wallet archive is preserved separately with its original dates and limitations.

## Operation

`node scripts/collect-predictions.mjs` reads only unauthenticated public venue endpoints. `.github/workflows/predictions.yml` runs it every ten minutes, best effort. `data/predictions/state.json` is the authoritative shared state; it initializes each venue with $100 only when absent, validates every existing account, and refuses corrupt state. `dashboard/data/predictions.json` is the public display snapshot. Neither is a deposit or exchange account. Do not reset either account during maintenance.

The collector has a local exclusive lock and unique atomic-write files. The workflow serializes runs and rebases without force before pushing. Conflicting state writers fail instead of choosing a winner. The browser reads current repository JSON every minute and can refresh the selected public book directly without changing the shared accounts; data-only commits do not require a Sites deployment. Pages is also triggered after the prediction cycle. Public data and paper snapshots never contain private keys.

Discovery is deliberately bounded: up to 300 general Polymarket US events plus up to 12 upcoming events each for NFL, MLB and college football and 3,000 Kalshi contracts per cycle, then 36 event-distinct books per venue plus existing positions. Discovery also samples those verified upcoming-game feeds, because the default event list puts old futures ahead of current games. Work is bounded to eight minutes before completing the current batch and publishing partial source status. This is not an exhaustive exchange search. Retain failed samples and venue snapshots with original times and explicit source errors. Prefer ordinary game moneylines when available, then sort and sample using declared quote availability, entry window and reported volume, not a fabricated confidence score.

Each observation is recorded at its own retrieval time, before unrelated slow requests can age it out. Entry candidates and existing positions are refreshed again before advancing accounts. This distinction matters when an API is slow. A page showing a ten-minute snapshot is not showing an executable live quote.

## Hypothesis and evidence

Frozen strategy version: `2026-09-13-calibration-v2`.

Hypothesis: recurring markets may have persistent probability miscalibration within a venue, series, horizon and ten-point price band. It is an unvalidated prospective paper experiment. No legacy win rates are used as training data or readiness evidence.

- Record one contract per venue/event, before resolution, with the contemporaneous midpoint, book time, series, horizon, price band and rule hash. Group Polymarket US sport cohorts by explicit series ID when available; otherwise by the supplied league and sport-market-type fields. Markets lacking a defensible cohort remain viewable but cannot train a model.
- Horizon buckets are 6–24 hours, 1–3 days, 3–7 days and 7–30 days until the conservative entry cutoff. Polymarket US game contracts use game start; other US contracts use expiry. Kalshi uses expected expiry or contractual close, whichever is earlier. Contractual expiry remains separately visible, since game contracts can expire days after play. Draft v1 observations from before this cutoff correction are retained and excluded from v2 training.
- Train only on binary final labels first verified before the prediction, excluding the candidate's own event. Never infer settlement from a price near zero or one. Fractional alternative payouts settle the ledger but are excluded from binary calibration.
- Require at least 100 resolved events in the cohort and 50 in the current price bin. Forecast `(wins + 0.5)/(n + 1)` and retain that prediction before its label is available.
- Paper eligibility also needs 30 previously recorded forecasts in the cohort and mean Brier score improvement greater than 0.002 versus those same observations' market midpoints. This is a screening heuristic, not a significance test or an untouched held-out backtest.
- Compute a 99% Wilson interval and widen it by another ten percentage points to accommodate the price bin. Use the lower bound for YES, or one minus the upper bound for NO. That conservatism does not guarantee future calibration or account for all temporal correlation, sample selection or repeated testing.

## When and how much

New paper entries need an open ordinary $1 binary market, complete rules/identity, current fees, two-sided spread no larger than 5¢, a quote and retrieval age no greater than 90 seconds, and 6 hours to 30 days until the entry cutoff. The conservative probability must exceed full acquisition cost by at least 3¢ per contract.

Traverse the actual displayed ask depth, round modeled fees up to cents for each fill, and charge an additional 1¢ per contract as slippage. This is a conservative paper cost estimate, not an exact member-specific invoice. Both entry and immediate liquidation must fit displayed depth. Use whole contracts, respecting any larger market minimum. No fee rebates or maker queue fills are assumed.

Quarter Kelly is computed from the conservative probability and fee-inclusive contract cost. Total loss-at-settlement is capped at 2% of equity per idea and 10% of equity across open positions, additionally limited by cash. At initial capital this is at most $2 per idea and $10 total. Require two distinct qualifying scans 1–30 minutes apart. Allow only one open position per event and no repeat bet on a previously settled contract. Halt entries after 10% peak drawdown. A stale position mark also holds new entries.

Positions hold until official final settlement. There is no synthetic intraday stop or forced exit at a predicted market price. All downside is funded upfront. Reconcile `cash = 100 - all acquisition costs + final payouts`; reconcile equity to cash plus conservative liquidation marks. Store original forecast, rule text, costs, quote time, order intent and resolution source. Never reset a losing account to pass a gate.

## Official sources verified September 13, 2026

- [Polymarket US API introduction](https://docs.polymarket.us/api-reference/introduction): public `gateway.polymarket.us` is separate from authenticated `api.polymarket.us`.
- [US order book](https://docs.polymarket.us/api-reference/markets/get-market-book): bids/offers are for the YES instrument. NO acquisition cost is one minus the YES bid. Depth fields in BBO are level counts, not quantities. Do not zip the misaligned display outcome arrays.
- [US fees](https://docs.polymarket.us/fees): current coefficient is read from each market; exact venue rounding differs from this conservative simulation.
- [US settlement](https://docs.polymarket.us/api-reference/markets/get-market-settlement): require resolved status plus the dedicated settlement response. OPEN books can contain `stats.settlementPx`; that is not proof of resolution.
- [Kalshi public data](https://docs.kalshi.com/getting_started/quick_start_market_data): the existing `api.elections.kalshi.com/trade-api/v2` public host was observed working; the newer documented external-api host returned403 here.
- [Kalshi fixed point](https://docs.kalshi.com/getting_started/fixed_point_migration): read `_dollars` and `_fp`; sort bids numerically and complement the opposite side for asks.
- [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding), [event overrides](https://docs.kalshi.com/api-reference/events/get-event-fee-changes): use current series metadata plus the latest effective event override, never apply a future override early. Unknown/flat fee types suppress entry.
- [Kalshi settlement](https://docs.kalshi.com/getting_started/market_settlement): retain the actual contract rules/source; settlement may be fractional under alternative rules. Do not hardcode the weather provider.

## Later real-money connection

`orderIntent()` is a shared boundary containing venue, market, side, whole quantity, quote time, limit price, maximum modeled cash and strategy version. Calling it with real mode throws. The paper collector contains no order POST or live authentication path. Existing unrelated archived adapters remain disarmed.

Remaining activation work is explicit: confirm account/venue eligibility, connect server-held credentials, implement and test authenticated previews and order adapters, align actual fee/quantity/tick rules, add order reconciliation/cancel/duplicate protection/kill switch, review forward results, select funded cash limits, and obtain the user's explicit real-money activation. Paper balances cannot be converted into deposited money. Never expose credentials through the static dashboard or GitHub snapshots.

## Verification

`npm test` includes prediction math, malformed ledger rejection, bid/ask complement, fee overrides, quote expiry, future-label exclusion, event deduplication, two-scan entry, cash conservation, fractional settlement, settlement idempotence, and locked real execution. Run `python3 scripts/check_site.py` and build the same committed source for Sites. DOM integration checks cover the mobile-oriented card structure, tabs, filters, ticket, forecast calculator and ledger export. No browser visual QA is claimed unless separately performed.
