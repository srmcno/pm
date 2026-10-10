# Prediction arbitrage worker (Kalshi live-capable, Polymarket US scan-only)

On **October 10, 2026** the account owner authorized real-money trading on Kalshi and Polymarket US, restricted to **positive-edge-after-fees arbitrage**. Directional bets are not authorized. This document describes the engine built for that authorization. It ships **disarmed**. Deploying it, or setting `PM_MODE=preview`, never places an order. The two $100 prediction paper accounts (`docs/PREDICTIONS.md`), their ledgers and all directional strategies remain paper.

**Set expectations low.** The engine only trades packages whose payout is fixed in every outcome. Those are rare:

- **Single venue:** Kalshi and Polymarket US each run one book per binary market. A same-market YES + NO gap can only show up in a crossed book, and the matching engine clears crossed books.
- **Cross venue:** the frozen September study ([`reports/paired-market-history.md`](../reports/paired-market-history.md)) found **no** cross-venue package that was positive after fees.
- **Live scan:** the October 10 scan below also found **no** locked positive package.

The worker may trade rarely, or never.

## What it does

`scripts/predlive/` runs as a **separate engine inside the existing Render worker** (`scripts/live/runner.mjs`). It starts only when `PM_MODE` is set. It keeps its own SQLite journal at `MM_DATA_DIR/predictions/execution`, using the same `Journal` class as the Coinbase worker. It runs in the background and catches every error of its own, so it never blocks or crashes Coinbase reconciliation. When the `PM_*` variables are absent, the Coinbase worker behaves exactly as before. That includes its status JSON, which then has no `prediction_arbitrage` block.

| File | Role |
|---|---|
| `arb.mjs` | Pure detection: venue fee bounds, freshness, depth sizing and the three package types. Every amount is an 18-place fixed-point integer (`D`/`S` from `scripts/live/risk.mjs`). |
| `kalshi.mjs` | Signed Kalshi Trade API v2 adapter. It has a strict route allowlist, bounded responses, timeouts and generic errors. It can make exactly one kind of mutation: an immediate-only buy. |
| `polymarket.mjs` | Polymarket US adapter: public books plus signed, read-only balance and position reads. It has **no submit path** (see below). |
| `engine.mjs` | Durable execution: intents, reconciliation, repair, ledger, loss latch and status. |
| `scanner.mjs` | Public-data discovery. It re-reads the books immediately before any trade. |
| `worker.mjs` | Integration with the runner: scan cadence, fast repair polling and the status block. |
| `config.mjs` | `PM_*` parsing with hard ceilings fixed in code. |
| `scan.mjs` | One-off preview scan against real public data. It reads no credentials. |

### Opportunity types

Every type must clear all of these checks:

- **Positive after all fees.** Each leg's cash is bounded by `ceil_to_cent(q·L + θ·q·L·(1−L) + 0.0001) + $0.01`, where `L` is the leg's limit (the worst price needed for `q` contracts) and `θ` is the venue fee coefficient. This bound is at least as large as how each venue actually rounds:
  - **Kalshi:** each fill's trade fee is rounded up to $0.000001, the balance is aligned to the member's precision, and accumulated rounding is rebated per order.
  - **Polymarket US:** fees use banker's rounding, and an order's total never exceeds the banker's rounding of the cumulative exact fee.
  - **Allowance:** the extra cent per order covers per-fill rounding residue.
- **Clears the safety margin.** The package must clear `PM_MARGIN_USD` per contract (default and minimum $0.01). A net edge less than or equal to the margin is never traded.
- **Fresh books.** Every book must have been retrieved less than **10 seconds** before the decision, measured from the start of the retrieval request. Kalshi books carry no venue timestamp, so the age is measured from retrieval. The engine re-reads every book immediately before trading and never trades on the copy from the scan.
- **Size.** Whole contracts only, up to the smallest of: displayed depth on every leg, `PM_MAX_TRADE_USD` of worst-case cost, and the cash available in the frozen allocation.
- **No sports.** Sports contracts are excluded unless `PM_ALLOW_SPORTS=true`. This follows the Oklahoma AG dispute recorded in `docs/FUNDING.md`.

The three types:

1. **Complement (single venue):** buy YES and NO of the same binary market. Kalshi nets the pair into $1 immediately. As explained above, this only appears on a crossed book.
2. **Cross-venue:** YES on one venue and NO on the other, for an event matched by the existing paper matcher (`matchingIdentity`: provider team IDs and exact start time).
   - **Confidence allowlist:** `['exact']`. "Exact" requires the identity match plus **identical contractual close times** and **identical, non-empty settlement sources**. Identity-only matches are refused, including any pair whose sources or close times differ.
   - **Current effect:** the matcher covers only NFL/MLB moneylines, which are sports. Also, Polymarket US does not expose a settlement-source list, and the September review found rule mismatches. So this type is currently **detect-only**.
3. **Multi-outcome (single venue):** buy YES on every market of a Kalshi event that the API marks `mutually_exclusive: true` with `collateral_return_type: "MECNET"`.
   - **Exhaustiveness:** Kalshi documents that **at most one** market in such an event resolves YES, not **exactly one** ([Get Event](https://docs.kalshi.com/api-reference/events/get-event)). If no outcome resolves YES, the package pays $0.
   - **Owner review:** the engine therefore trades this type only for series listed in `PM_EXHAUSTIVE_SERIES`. List a series only after reading its rules and confirming every event always resolves exactly one listed outcome, including no-winner, tie and cancellation cases.
   - **Other requirements:** every market of the event must have a fresh book, and all outcomes must share one close time.

Packages that fail a lock condition are still evaluated and counted as `unlockedGapsIgnored`. They are never counted as arbitrage and never traded.

### Execution

Legs are **fill-or-kill limit buys at the observed price**. The leg with the **scarcer displayed depth goes first**. The next leg is sent only after the previous one filled completely.

- **First leg unfilled:** nothing else is placed and the package closes flat.
- **Later leg fails** (or the engine was interrupted between legs):
  1. **No resumption.** The package is never resumed at stale prices. It enters bounded repair.
  2. **One hedge attempt.** The engine buys each missing leg once with an immediate-or-cancel order at up to its original limit plus `PM_HEDGE_TOLERANCE_USD` (default $0.02, maximum $0.05). The hedge is placed only if it fits in the remaining cash.
  3. **One unwind attempt.** Any remaining excess is closed once with a **reduce-only** immediate-or-cancel order for the opposite outcome. The worst price accepted is the original limit minus `PM_UNWIND_TOLERANCE_USD` (default $0.05). Reduce-only orders cannot open new exposure.
  4. **Manual latch.** If exposure still remains, the engine latches **manual review**. It records the exact residual position (market, outcome, contracts) in the private journal; the status shows only counts.
- **Repair cadence.** While a package is executing or under repair, the worker reconciles it about every 15 seconds and does not wait for the next scan.

Kalshi orders use the V2 endpoint `POST /portfolio/events/orders`, whose single-book vocabulary is YES-priced:

- **Buy YES:** `side:"bid"` with `price` set to the YES limit.
- **Buy NO:** `side:"ask"` with `price` set to `1 − NO limit`.
- **Fixed fields:** `time_in_force` is `fill_or_kill` or `immediate_or_cancel`, `self_trade_prevention_type:"taker_at_cross"`, `post_only:false`, `cancel_order_on_pause:true`.
- **Never sent:** resting order types, `expiration_time`, `buy_max_cost` (absent from V2), `subaccount` overrides, cancels, amendments and transfers. The adapter has no method for any of them.

### Durable safety (copied from the Coinbase worker)

- **Intent before POST.** Every order is saved to the journal with an immutable random `client_order_id` before its POST.
- **Unknown outcomes.** A lost or unclear response leaves the order `UNKNOWN`. It is **never resent and never retried with a new ID**.
  - **Reconciliation:** the order is matched by `client_order_id` from `GET /portfolio/orders?ticker=&min_ts=` (all pages), including after a restart.
  - **Ten-minute limit:** if no match appears within 10 minutes, the engine latches manual review.
  - **Resting orders:** an immediate-only order found resting latches manual review too, because the worker has no cancel path.
- **Accounting from venue fills.** Every figure comes from cumulative venue fills (`GET /portfolio/fills?order_id=`): `count_fp`, the own-outcome price (`yes_price_dollars` / `no_price_dollars`) and `fee_cost`.
  - **Consistency:** the fills must sum to the order's `fill_count_fp`. If fills lag, the engine waits.
  - **Mismatches:** direction mismatches, prices above the limit and non-monotonic fills all latch manual review.
- **Two mutation guards.** Every POST requires engine `mode:'live'` **and** an adapter built with `allowSubmit:true`, which needs live credentials. The engine also checks that shutdown is not in progress.
- **Frozen allocation.** On the first **live** tick, the starting capital is frozen at `min(Kalshi available balance, PM_KALSHI_ALLOCATION_USD)`, with a $5 minimum.
  - **No top-ups:** later deposits never raise it.
  - **No changes:** a changed `PM_KALSHI_ALLOCATION_USD` after funding is refused at startup.
  - **Spending:** each new package may use at most `min(ledger cash, venue balance)`.
- **Loss latch.** Conservative equity is cash plus $1 per locked, unsettled set. When it falls to the initial capital minus `PM_LOSS_LIMIT_USD` or below, a **permanent** latch is set. Restarts and raising the limit do not clear it.
- **Least privilege.** About once an hour, the engine reads its own key's scopes (`GET /api_keys`).
  - **Refused:** a key with the broad `write` scope or with `write::transfer`.
  - **Required for live:** `write::trade` plus `read` (or `read::portfolio_balance`).
- **Credentials.** They are read only from the environment and never logged, journaled or put in status. Errors are generic. Tests check status, logs and the journal for leaks.

### Status

When `PM_MODE` is set, the runner's status JSON and log gain a `prediction_arbitrage` block. It contains only aggregates and no identifiers or balances:

- **Mode and controls:** `mode`, `realOrdersEnabled`, `hold`, `funded`, `lossLatched`, `manualRecovery`, `openPackages`.
- **Hit rates:** `scans`, `opportunitiesSeen`, `opportunitiesPositive` (locked and positive), `opportunitiesExecutable`, `unlockedGapsIgnored`, `attempted`, `filled`.
- **Edges:** `latestNetEdgePerContractUsd` and `bestNetEdgePerContractUsd` (locked packages only).
- **Results:** `realizedPnlUsd` and `lockedPnlUsd`.
- **Configuration and sources:** `credentialsConfigured`, `venues` (`kalshi` preview or live-capable, `polymarket` scan-only), `allowSports`, `coverage`, `sourceErrors`.

The private journal keeps a bounded log of the latest 500 entries: every locked positive opportunity with its net edge, a per-scan summary, and `would_trade` records in preview mode. This lets the owner see hit rates before arming.

## Research (verified October 10, 2026)

### Kalshi Trade API v2

**Hosts and authentication** ([API keys](https://docs.kalshi.com/getting_started/api_keys), [environments](https://docs.kalshi.com/getting_started/api_environments)):

- **Hosts:** production `https://external-api.kalshi.com/trade-api/v2` (also `api.elections.kalshi.com`); demo `https://external-api.demo.kalshi.co/trade-api/v2`. Demo and production keys are separate.
- **Headers:** `KALSHI-ACCESS-KEY` (key ID), `KALSHI-ACCESS-TIMESTAMP` (milliseconds), `KALSHI-ACCESS-SIGNATURE`.
- **Signature:** base64 of a signature over `timestamp + METHOD + path`. The path starts at `/trade-api/v2` and excludes the query string.
- **Key types:** RSA keys sign with RSA-PSS/SHA-256 (MGF1-SHA256, salt equal to the digest length). Ed25519 keys (now the default) sign the same text directly. The adapter detects the type from the parsed key and supports both.

**Key scopes** ([create key](https://docs.kalshi.com/api-reference/api-keys/create-api-key), [list keys](https://docs.kalshi.com/api-reference/api-keys/get-api-keys)):

- **Available scopes:** `read`, `write`, `read::portfolio_balance`, `write::trade`, `write::transfer`, and others. A key defaults to `read` + `write`.
- **Listing:** `GET /api_keys` returns each key's `scopes` and an `api_key_region_expiration_ts` (location attestation).

**Orders** ([Create Order V2](https://docs.kalshi.com/api-reference/orders/create-order-v2), [order direction](https://docs.kalshi.com/getting_started/order_direction)):

- **Endpoint:** `POST /portfolio/events/orders`. The legacy `/portfolio/orders` POST is deprecated no earlier than May 6, 2026.
- **Request fields:** `ticker`, `client_order_id`, `side` (`bid`=buy YES, `ask`=sell YES ≡ buy NO), `count` (fixed-point string), `price` (fixed-point dollars, 2–4 decimals), `time_in_force` (`fill_or_kill` | `good_till_canceled` | `immediate_or_cancel`), `self_trade_prevention_type` (required), `post_only`, `reduce_only` (immediate-or-cancel only), `cancel_order_on_pause`, `subaccount`, `order_group_id`, `exchange_index`.
- **Response fields:** `order_id`, `client_order_id`, `fill_count`, `remaining_count`, `average_fill_price`, `average_fee_paid`, `ts_ms`.

**Reads** ([Get Order](https://docs.kalshi.com/api-reference/orders/get-order), [Get Orders](https://docs.kalshi.com/api-reference/orders/get-orders), [Get Fills](https://docs.kalshi.com/api-reference/portfolio/get-fills), [Get Balance](https://docs.kalshi.com/api-reference/portfolio/get-balance)):

- **Single order:** `GET /portfolio/orders/{order_id}` returns `status` (`resting` | `canceled` | `executed`), `outcome_side`, `book_side`, `fill_count_fp`, `taker_fees_dollars` and `taker_fill_cost_dollars`.
- **Order list:** `GET /portfolio/orders` takes `ticker`, `event_ticker`, `min_ts`, `max_ts`, `status`, `limit` (≤1000) and `cursor`. It has **no client-order-ID filter**, so the engine pages by ticker and time.
- **Fills:** `GET /portfolio/fills?order_id=` returns `count_fp`, `yes_price_dollars`, `no_price_dollars`, `fee_cost` and `outcome_side`.
- **Balance:** `GET /portfolio/balance` returns `balance` (cents) and `balance_dollars`.
- **Cancel (not used):** `DELETE /portfolio/events/orders/{order_id}` exists but is deliberately absent from the adapter.

**Market data** ([multiple orderbooks](https://docs.kalshi.com/api-reference/market/get-multiple-market-orderbooks), [Get Event](https://docs.kalshi.com/api-reference/events/get-event)):

- **Books:** `GET /markets/orderbooks?tickers=` returns up to 100 books, YES and NO bids only. Asks are the complements.
- **Events:** event objects carry `mutually_exclusive` and `collateral_return_type`.

**Fees** ([schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf), [fee rounding](https://docs.kalshi.com/getting_started/fee_rounding)):

- **Model:** quadratic `0.07 × multiplier × C × P × (1−P)`, using the series multiplier plus the latest effective event override. This reuses `effectiveKalshiFee` from the paper code.
- **Rounding:** each fill's trade fee is rounded up to $0.000001. A rounding fee then aligns the balance to $0.0001 (direct members) or $0.01 (non-direct). Accumulated overpayment is rebated per order.

**Rate limits** ([rate limits](https://docs.kalshi.com/getting_started/rate_limits)):

- **Budgets:** token buckets, 10 tokens per request by default. The Basic tier gets 200 read and 100 write tokens per second.
- **Throttling:** a 429 carries no `Retry-After`. The scanner pauses between pages.

### Polymarket US

[API introduction](https://docs.polymarket.us/api-reference/introduction), [authentication](https://docs.polymarket.us/api-reference/authentication), [Create Order](https://docs.polymarket.us/api-reference/orders/create-order), [Get Order](https://docs.polymarket.us/api-reference/orders/get-order), [orders concept](https://docs.polymarket.us/concepts/orders), [order management](https://docs.polymarket.us/trader-guide/order-management), [fees](https://docs.polymarket.us/fees).

**The retail API exists:**

- **Hosts:** authenticated `https://api.polymarket.us`; public `https://gateway.polymarket.us`.
- **Keys:** issued at `polymarket.us/developer` after identity verification in the app.
- **Headers:** `X-PM-Access-Key`, `X-PM-Timestamp` (ms, within 30 s of server time), `X-PM-Signature`. The signature is Ed25519 over `timestamp + METHOD + path`; the secret's first 32 bytes are the seed.
- **Orders:** `POST /v1/orders` takes `marketSlug`, `type`, `price{value,currency}`, `quantity`, `tif` (including `TIME_IN_FORCE_IMMEDIATE_OR_CANCEL` and `TIME_IN_FORCE_FILL_OR_KILL`), `intent` (`ORDER_INTENT_BUY_LONG` / `..._BUY_SHORT` …), `synchronousExecution` and `maxBlockTime`.
- **Other endpoints:** `GET /v1/order/{orderId}`, `GET /v1/account/balances`, `GET /v1/portfolio/positions`, `GET /v1/portfolio/activities`.
- **Fees (effective October 7, 2026):** taker `0.0695 × C × p × (1−p)` (table tennis 0.10), banker's-rounded to the cent and capped at the cumulative exact fee. Maker rebate −0.0125.

**Why Polymarket US is scan-only:**

- **No idempotency key.** The retail create-order request has **no client-supplied order identifier**. It returns only the exchange `id`, and acceptance can be asynchronous.
- **Unsafe recovery.** After a timeout, the only way to find the order is to search account activity by market, size and time. That cannot reliably tell this worker's order apart from any other. Retrying risks a duplicate, and guessing breaks the journal's core rule.
- **Institutional API excluded.** The institutional Trading API (`api.prod.polymarketexchange.com`, field `clordId`) is not a retail product.
- **Unverified eligibility.** Oklahoma eligibility for Polymarket US products is also still unverified (`docs/FUNDING.md`).

`POLYMARKET_SUBMIT_SUPPORTED=false` is a code constant, and the adapter's `create()` always throws. Revisit this if the retail API adds a client order ID.

## Owner steps

The assistant does not perform any of these. Do not paste keys into chat, GitHub, the website or a build command.

1. **Eligibility and funding.** Confirm your Kalshi account is approved for API trading from Oklahoma. Deposit at least the amount you intend to allocate; the hard ceiling is $100.
2. **Optional rehearsal on demo.** Create a demo account and key at the demo site and set `PM_KALSHI_ENV=demo`. Demo keys only work there.
3. **Create the production API key.** Go to **kalshi.com → Account → Profile → API Keys → Create New API Key**. Ed25519 (the default) or RSA both work.
   - **Scopes:** if scopes are offered, grant only **read** and **trade** (`write::trade`), and **not** transfer.
   - **Full-access keys are refused.** The worker refuses a key carrying the broad `write` or `write::transfer` scope. If the website only issues full-access keys, see the open questions below.
   - **Save both values:** the **Key ID** and the private key file. The private key is shown once.
4. **Add the variables in Render.** Open **Render → moffitt-rotation → Environment** and add these as **private** variables:
   - `PM_MODE=preview`
   - `KALSHI_KEY_ID` = the Key ID
   - `KALSHI_PRIVATE_KEY` = the full PEM text. Newlines or literal `\n` are both accepted.
   - `PM_KALSHI_ALLOCATION_USD` = for example `25`. It must be 5–100 and is frozen at the first live tick.
   - Optional: `PM_MAX_TRADE_USD` (default 5, maximum 25), `PM_LOSS_LIMIT_USD` (default 5, maximum 20, below the allocation), `PM_MARGIN_USD` (default 0.01).
   - Leave `PM_ALLOW_SPORTS=false`.
   - Polymarket US keys (`POLYMARKET_US_KEY_ID`, `POLYMARKET_US_SECRET_KEY`) are optional and only enable read-only checks.
5. **Deploy and check preview.** Deploy the reviewed commit manually; auto-deploy stays off. Then check the logs for `prediction_arbitrage`:
   - `hold` shows no scope or permission error.
   - `scans` increases.
   - `opportunitiesPositive` shows how often locked arbitrage appears.
   - Watch it for days before arming. A 403 can indicate Kalshi location attestation or IP rules (see open questions).
6. **Arm.** Set `PM_MODE=live` and `PM_LIVE_ACK=I_ACCEPT_REAL_MONEY_PREDICTION_ARBITRAGE`, then save and redeploy. The allocation freezes on the first live tick.
7. **Optional exhaustive series.** After reading a Kalshi series' rules, add its series ticker to `PM_EXHAUSTIVE_SERIES` (comma-separated). Only do this if every event in the series is guaranteed to resolve exactly one listed market YES. Range brackets with open-ended tails are typical candidates; candidate lists without an "Other" outcome are not.
8. **Disarm.** Set `PM_MODE=preview`. The engine keeps reconciling read-only but cannot hedge or unwind, so finish any repair in the Kalshi app first. Removing `PM_MODE` stops the engine entirely; the journal is preserved.
   - Never delete `/var/data/rotation/predictions`.
   - A loss or manual latch persists across deploys.

## What it will not do

- **No directional trades.** It never bets on an outcome, and never sends a resting, post-only, market or good-till-canceled order.
- **No account operations.** It never cancels or amends orders, transfers funds or withdraws. It never uses subaccount overrides or touches the paper accounts.
- **No unsafe venues or contracts.** It never trades on Polymarket US, never trades sports by default, and never trades a cross-venue pair whose rules, sources or close times are not proven identical.
- **No silent recovery.** It never resends an unknown order, never retries with a new client ID, and never adopts unrelated holdings.
- **No limit drift.** It never tops up the allocation and never exceeds the ceilings fixed in code: $100 allocation per venue, $25 per trade, $20 loss limit.

## Preview scan on real data (October 10, 2026, ~16:02 UTC)

The scan ran with `node scripts/predlive/scan.mjs --max-events=150 --cross-venue`, using public endpoints only and no credentials.

- **Coverage:**
  - 100 Kalshi event pages, 10,000 open events, of which 3,457 are mutually exclusive.
  - 114 shortlisted events re-read with fresh books.
  - 30 matched NFL/MLB cross-venue pairs, each checked in both orientations.
- **Results:**
  - 857 packages were evaluated, and **0 were locked with a positive net edge**. Nothing was executable.
  - The best locked package was a complement at **−$0.04 per contract**.
  - The best cross-venue package was **−$0.06 per contract**: identity-only and sports, so refused anyway.
  - 55 multi-outcome "gaps" were ignored because exhaustiveness is unverified. They reach up to $0.88 per contract on low-liquidity events such as primaries and "51st state" questions. They are prices for the chance that **no** listed outcome happens, not arbitrage.

## Verification

```sh
node --test tests/live-*.test.mjs        # includes tests/live-predarb-*.test.mjs (Render build command)
npm test
node scripts/predlive/scan.mjs           # optional, public data only
```

All tests use synthetic venue responses; no test touches the network. They cover:

- **Fees and refusals:** fee rounding and edge cases; no trade at or below the margin; stale books; sports exclusion; mismatched resolution criteria.
- **Execution:** an unfilled first fill-or-kill leg stops the package; a hedge, then a reduce-only partial unwind, then a manual latch with the exact exposure; unknown POST outcomes reconciled by client ID after a restart on a real SQLite journal; the 10-minute unknown latch; lagging and partial fills.
- **Controls:** loss latch permanence; allocation freeze; preview never mutating; scope refusal; Polymarket refusal.
- **Signatures and adapters:** RSA-PSS and Ed25519 signatures verified against locally generated keys; the route and order-body allowlist; size, timeout and error hygiene.
- **Isolation:** no credentials in status, logs or the journal; the Coinbase worker unchanged when `PM_*` is absent and unaffected when the prediction engine fails.

Synthetic tests and a public-data scan do not prove live fills, venue rounding on your account, or that your key works from Render. The first real verification is the owner's armed run.

## Open questions

1. **Key scopes from the website.** It is unconfirmed whether kalshi.com's key screen offers scoped keys. If it issues only full-access keys (`read`, `write`), the worker refuses to run. A scoped key could be generated through `POST /api_keys/generate` with `scopes:["read","write::trade"]`, but that request itself needs an existing key. Decide whether to accept that extra step or to relax the rule (a code change, not a setting).
2. **Location attestation.** `GET /api_keys` exposes `api_key_region_expiration_ts` (location attestation for API key requests). Kalshi does not document how it applies to a server in Render's Oregon region acting for an Oklahoma resident. A 403 in preview would point here.
3. **Exhaustive series.** No series is allowlisted by default. Candidates such as `POWER-*` (eight House/Senate/President party combinations) or `KXGDPYEAR-*` brackets need a rules review for "none of the above" outcomes before listing.
4. **Polymarket US.** It stays scan-only until the retail API supports a client order ID (or the owner accepts a different reconciliation rule). A cross-venue matcher beyond sports moneylines would also be needed for type (b) to be useful.
5. **Kalshi fee precision.** The bound assumes at most 100 fills per order and non-direct cent rounding. The bound remains valid for direct members, whose rounding is finer.
