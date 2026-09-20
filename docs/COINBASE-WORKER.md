# Coinbase rotation worker

This private worker is separate from the public paper dashboard. Its goal is an operator-activated, automated Coinbase Advanced USD spot test with an allocation ceiling of $20. Deploying the repository or editing a website does not activate trading. Automated tests use synthetic orders; subsequent operator-activated operation exposed the bracket accounting issue described below.

## Hosting

`render.yaml` configures one Node 24 background worker and a 1 GB persistent disk at `/var/data`. The displayed Render price at setup was $7/month for 0.5 CPU / 512 MB plus $0.25/month storage, before taxes or other usage charges. This cost is separate from trading fees and the trading loss trigger. Billing starts when the paid service is provisioned, even while disarmed.

The worker runs independently of the owner's computer. Public universe collection runs about every five minutes; the broker loop runs about every 15 seconds plus request latency. Collection runs independently so scanning 100 pairs does not suspend reconciliation. This is polling software, not an exchange-level latency guarantee. Broker-native attached brackets remain at Coinbase while the worker is unavailable; a stop-limit can remain unfilled during a gap.

Auto-deployment is off to avoid restarting the trading process on the repository's frequent paper-data commits. Deploy reviewed code changes manually. A disk-backed deployment stops the previous process before its replacement; the SQLite lock also prevents two processes from using one ledger. Never run independent workers with separate disks against the same allocation.

## Commissioning and operator activation

1. Create the worker from this repository and its default branch using the blueprint or the matching values above. Keep `MM_MODE=preview` while checking configuration. The start command is `node scripts/live/runner.mjs`; the build command is `node --test tests/live-*.test.mjs`.
2. In Render's private Environment settings, supply `COINBASE_KEY_NAME`, `COINBASE_PRIVATE_KEY`, and `COINBASE_PORTFOLIO_ID` from the intended Coinbase App ECDSA key/portfolio. Keep View and Trade permissions, with transfers disabled. Do not put the key in GitHub, public site configuration, chat, a build command, or a repository file. An initial service without credentials only verifies public feed collection; that is not completion of brokerage setup.
3. Read the service's current outbound IP ranges under Render's Connect/Outbound information. The account owner adds those exact ranges to the Coinbase key allowlist; a key restricted to a home computer cannot authenticate from Render. Do not remove the allowlist or guess IPs. Confirm the deployed process can verify portfolio binding, actual fees and current product availability in preview mode.
4. Provide an available USD balance for the authorized allocation. The supplied deployment caps this test at **$18.85**, with an absolute software ceiling of $20. Funding freezes once at the lesser of the cap and available USD, with a $5 minimum; deposits later do not top up the allocation. BTC and other existing assets are not USD cash and are never automatically converted or adopted as bot inventory. The account owner handles any funding or conversion in Coinbase. Funding/conversion costs incurred outside this ledger are not retroactively fabricated as execution fees.
5. The account owner performs live activation by setting `MM_MODE=live` and `MM_LIVE_ACK=I_ACCEPT_REAL_MONEY_TRADING`, then saving/redeploying. These are separate from paid hosting approval. The software can submit orders after this activation if every runtime gate passes. An assistant should not make that activation change or submit a test trade.

## Limits, evidence and recovery

The runtime bounds new risk to the configured $20 allocation ceiling, $5 absolute order ceiling and 1% modeled loss per entry. The default capacity profile allows three positions, 20% maximum entry weight and 60% exposure. Venue minimums can make a small test unable to trade. The software must skip such a setup rather than increase the allocation or weaken the risk checks. Profits do not authorize a larger allocation. The $2 trading loss trigger is a control signal, not a guaranteed maximum loss; slippage, gaps, fees and unavailable markets can exceed it. Hosting is outside that trading trigger.

### Using more of the existing allocation

The account owner can select `MM_CAPACITY_PROFILE=expanded` in the worker's private environment and save/redeploy. Omitting this variable retains `standard`; unknown or empty values stop configuration rather than silently choosing a profile. Publishing new code alone does not select expanded capacity.

| Entry capacity | Standard | Expanded |
|---|---:|---:|
| Simultaneous owned positions | 3 | 10 |
| Maximum entry weight | 20% | 30% |
| Maximum combined exposure | 60% | 90% |
| Absolute order reservation ceiling | $5 | $5 |
| Modeled loss per entry | 1% | 1% |

At the initial $18.85 allocation, expanded capacity permits up to $16.965 of combined exposure, subject to current equity, fees, the cash ledger and venue requirements. The $5 absolute order cap still takes precedence over the 30% weight. These are entry ceilings, not target purchases; the 1% loss sizing often produces much smaller orders. A larger position count does not require the bot to fill every slot.

Both profiles use the same frozen initial allocation, actual-fee checks, native protection, signal confirmation and $2 loss trigger. Deposits and unrelated account holdings are not adopted. A profile change never resizes an existing position, modifies its immutable protection plan, resets accounting or clears a loss/recovery hold. Switching back to standard blocks additional entries when over its limits; it does not force liquidation. The selected profile is recorded in the private journal and the `capacity` section of worker status so the effective setting is visible after deployment.

With more holdings, pending BUY reconciliation takes priority over established positions. Fee receipts refresh during longer marking/exit cycles, while the same 15-second freshness checks remain. If the earliest portfolio books expire during collection, aggregate marks are incomplete and new entries wait; independently verified exits still obtain their own fresh books and fees. Synthetic latency tests cover this ten-position case.

New orders require fresh authenticated books, account fees, tradable USD spot products, sufficient real USD, a current rotation signal and successful Coinbase cost preview. The public paper minimum of $10 does not define the broker minimum; authenticated product increments/minimums do. Protective orders use Coinbase's attached bracket. Stop execution and partial fills must be reconciled rather than inferred from a successful HTTP response.

The execution journal records immutable client IDs before submission. Unknown outcomes are held for reconciliation; they are never retried with a fresh ID. Accounting uses cumulative broker fill quantities, values and actual fees, including partial fills on cancelled orders. Only inventory acquired by recorded bot orders belongs to the bot. Unrelated account holdings and paper balances are not available to sell.

State persists under `/var/data/rotation/execution`; market/preflight evidence lives under `/var/data/rotation/monitor`. Deleting or restoring an old execution journal can lose ownership history while Coinbase orders remain. Do not reset a journal or clear a recovery latch without matching the account's open orders/fills and preserved intent history. When reconciliation cannot establish identity, amounts or protection, new activity stops and the status identifies recovery as required.

Private worker logs and `status.json` expose operating status and aggregate marked trading P&L without credentials, account identifiers or order responses. Marked P&L is available only with complete liquidation marks less than 60 seconds old, and is explicitly distinct from realized profit. Quantities, fills and account identity remain in the private journal. The public Pages/Sites figures continue to be paper results; they do not become this worker's realized profit. Hosting accrual is an estimate, not a Render invoice. Funding, conversion, withdrawal, taxes and any other external costs must be included separately when judging overall profitability.

Turning the worker off stops software reconciliation. Changing it to preview preserves read-only reconciliation when the credentials remain configured; it does not sell positions or cancel broker-native orders. Check and manage those positions in Coinbase when pausing live execution. A persistent loss or recovery latch does not automatically reset after redeployment.

## Narrow recovery for an open bracket's projected total

An observed Coinbase `OPEN` protective bracket reported a projected `total_value_after_fees` despite zero cumulative fills. The original tests did not cover this response shape. Comparing that projected amount with zero actual proceeds incorrectly raised the manual recovery hold `Venue total and cumulative fees disagree`. Accounting must continue to use cumulative `filled_size`, `filled_value` and `total_fees`; a projected total is not realized proceeds or profit.

The recovery path is limited to that specific hold and a single existing protected position. Fresh broker evidence must verify the immutable entry as `FILLED`, its attached protection as `OPEN` with zero child fills, matching quantities and identities, no software exits, and no other manual recovery or loss condition. It does not authorize clearing unrelated holds, adopting balances, changing protection or resetting the journal.

1. After deploying the reviewed recovery code, run `node scripts/live/check-recovery.mjs` in the worker's private shell with its existing environment and persistent disk. The checker opens the existing execution database read-only, inspects a snapshot, forces preview mode and disables broker submissions. It never calls the execution loop, changes journal state, or creates/cancels orders; there is no `--apply` option.
2. An eligible result reports the product, owned quantity, `protectionStatus: "OPEN"` and `MM_RECOVER_PROJECTION_ACK`. It omits account/order identifiers, credentials and raw responses. A failed check returns no token and leaves the hold in place. The result is a point-in-time check, not a guarantee that protection remains unchanged.
3. The account owner sets `MM_RECOVER_PROJECTION_ACK` to that exact check token in the worker's private environment and redeploys. This acknowledgement is scoped to the existing immutable intent. The worker checks the same conditions against fresh evidence again before recording recovery; this path itself does not submit or cancel orders. Ordinary operation afterward still follows the configured live/preview mode and all existing risk gates.
4. Remove the acknowledgement after successful recovery. An old token is inert after success and cannot clear later or unrelated holds. If the fresh recheck fails, preserve the ledger and inspect current broker orders; do not delete state or substitute a different acknowledgement.

## Verification scope

Tests use synthetic broker responses to exercise order lifecycle failures without moving real money. Public data and authenticated read-only checks can verify feed connectivity, key permissions and current fee contracts, but cannot prove fill quality, returns, cloud IP access, or successful live protection. The setup is an experimental small-allocation test, not evidence of a profitable strategy.

Primary references: [Render background workers](https://render.com/docs/background-workers), [persistent disks](https://render.com/docs/disks), [outbound IPs](https://render.com/docs/outbound-ip-addresses), [Coinbase order management](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders), [order types](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/order-types).
