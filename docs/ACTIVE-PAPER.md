# Active paper accounts and archive, September 16, 2026

This revision supersedes the old validation-only *paper entry* gate in PREDICTIONS.md. It does not authorize real execution, restart retired collectors, reset balances, or reinterpret historical returns.

## Main app

The build publishes `dashboard/focus.html` as `dist/index.html`. The main navigation is Overview, Activity and Archive. Overview contains both prediction accounts, actual positions and an expandable scan-details section. Activity combines their ledgers without pooling their capital and supports filters and a CSV export. Only the prediction snapshot is requested on initial load.

The previous `dashboard/index.html` workspace is preserved as `archive-workspace.html`, with a return-to-main link added during build. Archive groups active auxiliary tools separately from historical studies and diagnostics. Copy, spot and ETF accounts keep their own existing collectors. Crypto comparisons remain comparison-only. Legacy root hashes route to the appropriate archived tool. The focused interface does not import or initialize the old wallet/crypto modules.

## Experimental paper policy

Version: `2026-09-16-experimental-paper-v1`. The two existing $100 paper accounts remain authoritative; there is no new deposit or account reset.

Paper eligibility can begin with 20 resolved events in the same venue/series/time-horizon cohort and 10 events in its current price band. A price-band outcome frequency is shrunk toward the current midpoint with a weight of 10 observations: `(wins + 10 * midpoint) / (bin_count + 10)`. A three-percentage-point buffer is applied to the estimate before the existing three-cent-after-cost edge test. This buffer is a trial decision margin, not a confidence interval. These thresholds are design choices for a prospective experiment, not evidence that it is profitable. Trades are never forced to meet an activity quota.

Strict 100/50/30 calibration and its Brier screen remain separately computed and preserved. A forecast passing that existing screen uses the original bounds. Experimental estimates do not backfill original forecast observations or count as historically validated predictions. New positions carry the policy identity in their stored forecast; each cycle receipt records its entry policy. Prior positions and trades retain their original records.

Every candidate still needs current public books, complete rules, current fees, acceptable spread and depth, the permitted entry window, whole-contract sizing, two qualifying scans, the existing 2% per-entry/10% total exposure caps, and the drawdown/stale-mark controls. The collector's candidate refresh uses the same entry policy as its account-advancement stage. A policy migration clears old pending confirmations only, requiring a fresh two-scan sequence. Official settlements remain the only source of payouts.

## Verification and publishing

Run `npm test`, both existing Python suites, `python3 scripts/check_site.py`, and `npm run build`. New tests cover sparse and sufficient paper evidence, duplicate/future/current-event exclusions, costs, safety controls, automatic two-venue entries, policy migration, settlement conservation, UI statuses, ledger exports and the reduced main navigation. Synthetic fixtures are tests, not trading-performance evidence.

Publish this same build to the existing GitHub Pages and Sites identities. A successful source commit is not proof of either deployment. Do not mark the Sites publication complete without verifying its actual release.
