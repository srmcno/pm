# Dormant broker-paper controller

The user's active choice remains the built-in $1,000 simulation. No broker credentials were configured and no broker requests were made to validate this controller. Offline fixtures demonstrate local behavior only. Real execution is not implemented here: there is no live endpoint, live credential fallback or browser activation switch.

## What is connected in code

`scripts/etf_broker.py` uses `etf_lab.target_weights`, the pinned exchange calendar and the historical evidence gate. It records monthly decisions at the actual current time and makes them eligible for a future market session. It uses a private, persistent SQLite account journal separate from `data/etf/paper.json`. Source revisions after decisions require review. State is never reset automatically.

Broker execution differs from the historical opening-price proxy: it uses fractional DAY limit orders during 09:35–10:00 Eastern on the recorded eligible session. Quotes are explicitly IEX, not consolidated NBBO. Quotes must be at most 15 seconds old, uncrossed and within a 50-basis-point spread. The controller checks tradability, fractionability, broker clock and calendar, cash, holdings, open orders and account identity. Limits cross the observed quote by five basis points, rounded to a cent. Targets freeze at initial sizing; a subsequent midpoint move over 2% holds the plan. These choices require actual broker-paper testing before comparing execution performance with the simulation.

At most one order is sent per invocation. Sells precede buys; a partial or working order blocks the next order. All order IDs, quantities and prices are committed with SQLite `synchronous=FULL` before POST. A lost response is looked up by the same client order ID. A missing lookup holds for investigation, even if the original request may never have left the machine. This deliberately avoids creating a replacement order while the first outcome is uncertain.

Reconciliation replays incremental fill quantities and explicit cash activities from the baseline, then compares them with broker positions, cash and order totals. Activity pagination is bounded and duplicate IDs or truncation fail closed. Late fees are included on subsequent reads. Unknown transfers, corporate actions and changes to previously recorded activities hold for review. The modeled regulatory-fee overlay uses the research fee schedule and is kept separate from broker cash; paper omissions such as dividends still prevent treating broker-paper results as validated net returns.

## Commands for a later, explicitly chosen broker-paper trial

No setup is needed for the active built-in simulation. This offline command requires no keys, creates no account and makes no network requests:

```sh
python3 scripts/etf_broker.py status
```

For a future broker-paper trial, provide `ETF_ALPACA_PAPER_KEY` and `ETF_ALPACA_PAPER_SECRET` through a local secure environment. Generic `APCA_*` credentials are intentionally ignored. Never commit keys, put them on a command line, or use a shared/live account. Start with a stable dedicated paper account with no holdings or open orders and at least $1,000 cash; any cash above $1,000 is excluded from the strategy allocation.

```sh
python3 scripts/etf_broker.py init
python3 scripts/etf_broker.py reconcile
python3 scripts/etf_broker.py run --submit-paper-orders
```

The last command is an explicit instruction to submit a broker PAPER order when eligible. It is not run by the website or the GitHub simulation workflow. Run it once before the eligible session to persist the decision, then invoke during the execution window to submit and reconcile each order. It is currently a manually invoked controller, not a background broker service. A missed execution window holds rather than silently trading on another day.

The default private directory is `data/etf/broker/`, ignored by Git and created with owner-only permissions. `--home` can select another **private persistent local directory**. Never put this journal in a public repository or use independent copies concurrently. A process lock serializes invocations sharing the directory. Ephemeral CI runners are refused because they cannot guarantee the journal survives a lost POST response. Keep a private backup after reconciliation; do not restore an older journal and resume submission before comparing every order with the broker.

## Stop and recovery

Create `STOP` inside the private journal directory to prevent new submissions. Existing accepted orders remain at the broker; this stop does not cancel or liquidate them. Inspect and cancel those orders in the broker's paper dashboard when needed, then run `reconcile`.

A canceled, expired, rejected, partly completed or missing order requires operator review. Do not delete the journal or remove intents to force a retry. Preserve the database and broker receipts, establish each order's final status and reconcile cash/positions before implementing an explicit recovery. Automated cancellation/replacement and corporate-action migration are not implemented. Such a hold is reported as incomplete execution, never a completed rebalance.

Before any future real-money transition, demonstrate actual broker-paper fills, recovery, costs and monthly outcomes, implement and verify the remaining recovery workflows, then obtain separate real-account authorization. An endpoint change alone does not satisfy these requirements.

## Validation and contracts

Run `python3 -m unittest discover -s tests -p test_etf_broker.py`. Fixtures cover a full monthly allocation, sells before buys, partial fills, timeout after acceptance, 404 lookup, write failure before POST, canceled partial orders, dividends/late fees, missing activity history, unsupported actions, account changes, source revisions, oversized broker balances, submission deadlines, pagination, redirects, credential isolation and journal locking/integrity.

Contracts checked September 13, 2026: [Alpaca order creation](https://docs.alpaca.markets/us/reference/postorder), [fractional trading](https://docs.alpaca.markets/us/docs/fractional-trading), and [account activities and pagination](https://docs.alpaca.markets/us/docs/account-activities). Offline tests are not evidence of current broker acceptance or profitable forward outcomes.
