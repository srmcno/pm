# Publication and maintenance

Canonical source: `srmcno/pm`, using the repository default branch. Do not create a new project or publish to another Site. `.openai/hosting.json` holds the persistent Sites identity. The Sites Git remote is a publishing mirror of this source, not a competing development branch.

## Data updates

`dashboard/data-client.mjs` requests current public JSON from the default branch through GitHub raw `HEAD`. The main interface checks snapshots once per minute, histories when a completed hour is missing, and replay results every five minutes. Quotes stream directly from Coinbase with REST fallback. These continue without a new interface deployment while the page is open. GitHub collection schedules remain best effort. On failure, retain newer loaded data or use the bundled data, never relabel source timestamps. Original source dates and errors are visible in Data Health.

No market orders, brokerage activation or wallet connections are introduced by this site. Existing independent execution controls are retained. Do not restart retired workflows merely to remove an archive label.

## Interface updates

For a Sites update, read the Sites building and hosting skills, reuse the manifest project ID, and obtain its existing source credential. Fetch the default branch and preserve concurrent work. Run `npm test` and `python3 scripts/check_site.py`, commit the exact source, and publish that same source to Sites. `npm run build` produces `dist/` from the checked-in dashboard. Publish using the Sites helper and verify terminal success. Push code changes to GitHub as well, without creating stray branches. Never store a credential in source, config or a workflow.

A requested hourly ChatGPT maintenance task checks this source for interface changes and republishes the existing Site when required. It must compare content in `dashboard/` excluding `dashboard/data/` and generated `build-info.json`, plus the build script and manifest. Data-only commits need no Sites rebuild. Notify the owner on an unresolved source or publishing failure. The task is scheduled maintenance, not a promise of instantaneous deployment or uninterrupted external APIs.

The source check may run with fresh credentials when its retained token expires. Do not put a temporary Sites token in a GitHub secret to simulate permanent push deployment.

## Verification

The September 12 rebuild passes offline calculation, fallback/rollback regression checks and local resource/embedded JavaScript checks. Optional WebMCP is feature-detected; no supported browser WebMCP context was available for end-to-end validation. No browser-based visual QA was requested or run.

## Outcome policy, September 12

`dashboard/outcomes.mjs` validates replay model, costs, ledger accounting, chronology and coverage before allowing a strategy to start a new shared paper position. The current failed standalone replays hold both strategies. The collector always marks and manages existing positions even when a replay is missing or unreadable. This policy is separate from the frozen baseline model so past losing results remain reproducible. Minimum 30 trades and 1.15 profit factor are explicit research screening thresholds, not proof of an edge.

The Outcomes view compares realized payoffs, exit contributions, original equity and bounded rule experiments. Both tested variants lost money and were not adopted. See reports/outcome-review.md.

## Crypto entry revision, September 13

The user's separate request to revise Volume breakout and Trend reclaim authorizes scanner model `2026-09-13-scanner-v3`. Both require actual positive moving-average slopes and a distinct completed confirmation hour after the original volume trigger. Stops and targets remain anchored to the original trigger; costs, sizing, risk limits and exits are unchanged. Existing paper accounts, positions and closed ledgers are preserved. Versioned signal IDs prevent old pending candidates from confirming a changed model.

`reports/scanner-revision-plan.md` declares the single revision before replay. The original v2 inputs and results are pinned in `backtest-inputs-v2.json.gz` and `scanner-baseline-v2.json`; the frozen research runner uses those archives. Automatic source-change replays reuse committed inputs. An explicit workflow input can collect a new window, whose report labels any non-comparable input change. The current report includes all scenarios and the prior-model comparison. Reused history is not a holdout, reduced losses are not validation, and the existing evidence policy continues to hold failing strategies. Historical v2 experiments remain visible.

## Automatic prediction desk

The v4.3 correction makes Autopilot the default: both prediction accounts are monitored together, while market inspection and personal forecasts are optional. Completed collector receipts report automatic entries, settlements, and pending confirmations. The collector evaluates both venues without browser input. No strategy or risk thresholds were relaxed, no balances reset, and real execution remains locked.

The main Predictions view now uses Polymarket US and Kalshi public books with independent persistent $100 paper accounts. The authorized new prediction cycle runs every ten minutes, best effort; snapshots update in the browser every minute and Pages follows the cycle. Include its source/collector health in maintenance and preserve all paper state. Real execution remains locked. See docs/PREDICTIONS.md for evidence thresholds, costs, original archive limitations and remaining activation work.

## Monthly ETF experiment, September 13

`etf.html` adds a separate distribution/split-aware fixed-rule research report and persistent $1,000 simulated account. Both `data/etf-research.json` and `data/etf-paper.json` use the same dated publication transport; failing source requests retain prior records with their timestamps. Original prediction and crypto accounts are preserved. See docs/ETF-RUNBOOK.md for operation, the current simulated-only boundary and outstanding broker transition work. The ETF workflow runs weekdays at 22:15 UTC and triggers Pages publishing on completion.
