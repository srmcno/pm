# ETF release verification — September 13, 2026

## Evidence completed before publication

- Canonical repository: `srmcno/pm`; default branch `claude/polymarket-wallets-analysis-m81p4j`.
- Model: `2026-09-13-etf-monthly-v1`; Moffitt Money interface 4.5.0.
- Frozen data: 5,457 daily observations per ETF, January 2005 through September 11, 2026; five raw-response hashes verified and session dates matched to the independent XNYS calendar.
- Fixed candidate replayed from January 3, 2006 with $1,000: 5.7646% annualized, -15.633% maximum drawdown. See generated report for exact stored values. All sensitivities retained, including the loss under $5 monthly operating overhead.
- 26 dedicated Python tests cover fee examples, entitlement/payment, splits, affordability, no same-session lookahead, delayed decisions, actual hold benchmarks, incomplete bootstrap months, corrupt accounts, source corrections, slow refresh crossing an open, publication failure and restart idempotency.
- Full local suites: 304 legacy Python tests, 88 Python tests including the ETF suite, 56 Node tests; all passed after installing the repository's documented `requests` dependency in an isolated environment. Initial legacy import failures were caused by that missing local dependency, not waived tests.
- Local site resource/syntax check: six pages passed. Static build and Git whitespace checks passed.
- Browser checks: desktop 1440×1000 and phone 390×844; paper account loaded with $1,000, no positions and pending September 14 decision. Scenario selection updates the chart, SPY visibility toggles, theme switches, transaction details open, and CSV download action runs. Phone page has no horizontal overflow; chart axes render at viewport scale. Prepublication raw-GitHub 404s correctly used the labeled local bundled snapshots.
- Independent accounting and safety reviews found and corrected decision backdating during slow collection, publication rollback, inconsistent completion cutoffs, overstated readiness, historical source-revision gaps and account-reconciliation gaps.

## Publication targets

- GitHub Pages: https://srmcno.github.io/pm/etf.html
- Existing owner-private Sites publication: https://moffitt-money.smoffitt74743.chatgpt.site/etf.html
- Automated operation: `Monthly ETF paper cycle`, weekdays 22:15 UTC, plus manual dispatch. No brokerage credentials or live order path.

The thread's deployment receipts and GitHub Actions runs record publication outcome. The public `build-info.json` identifies the deployed source; compare interface content when later data-only commits advance the repository.

## Remaining evidence

The first eligible forward fill is in a future market session. No new-strategy broker paper order or live order has been submitted. The profitable retrospective sample does not establish future profitability or outperformance. Keep the overall research goal open while those requirements remain unproven.

## Dormant broker-paper controller follow-up

`scripts/etf_broker.py` adds a separate, manually invoked paper-only controller. It is not called by the simulation workflow. Its private durable journal is ignored by Git; dedicated credentials, explicit paper submission, account binding, an allocation cap and reconciliation gate its orders. No credentials were configured and no broker requests were made.

24 new offline tests exercise full monthly allocation, partial fills, lost POST responses, missing orders, persistence failure, account/source changes, cash activities, deadline crossings and allocation limits with an oversized broker account. Independent review found and corrected the full-account-cash sizing leak, stale decision timestamps and a deadline crossing during journal commit. Updated full suites: 304 legacy Python, 112 Python in `tests`, and 56 Node tests passed (472 total), plus the six-page resource check and static build. Existing legacy tests emit file-handle ResourceWarnings; they pass.

This follow-up changes controller source and operating documentation, not the interface or public account data. The already-published ETF dashboard retains its simulation-only and incomplete broker-readiness labels. Actual broker acceptance, automated broker scheduling, cancellation/recovery workflows and real-money activation remain unverified or unimplemented as described in [ETF-BROKER.md](ETF-BROKER.md).
