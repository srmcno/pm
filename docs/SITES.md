# Publishing and maintenance

The canonical source is the GitHub default branch `claude/polymarket-wallets-analysis-m81p4j` of `srmcno/pm`. The existing owner-private Sites identity is stored in `.openai/hosting.json`. Reuse it; do not create a second Site or branch.

- Site: https://moffitt-money.smoffitt74743.chatgpt.site/
- Pages mirror: https://srmcno.github.io/pm/
- Source: `dashboard/`; build: `npm run build`; public artifact: `dist/`.

## Interface

Copy trading, Crypto arbitrage, Predictions and Research are the primary navigation. Copy trading is the opening view. `wallets.html` routes to `#copy`; `arb.html` routes to `#crypto`. Their full core workflows are integrated into the shared shell. Prediction paper accounts remain under `#trades`, ETF results under `#research/etf`, and the separate strategy laboratory at `desk.html`.

The build deletes the previous `dist/` before copying an explicit public allowlist. Both GitHub Pages and Sites publish that same directory. Backend-only modules and raw backtest inputs are not part of the public artifact. Compact dated copy and crypto history publications are included because they are core research features. Do not upload `dashboard/` directly: it also contains research inputs used by scheduled collectors.

## Data updates

`dashboard/data-client.mjs` retrieves dated snapshots from GitHub raw default-branch `HEAD`, then falls back to bundled or newer retained records. The main display checks once per minute. It does not stream trading quotes or submit orders. Refreshing does not advance a paper account.

Prediction collection runs every ten minutes, best effort. ETF simulation runs on its existing weekday schedule. The separate desk and opportunity workflows remain active for their own saved accounts. The opportunity workflow also refreshes public crypto-arbitrage comparisons without any ledger effects. Copy consensus and paper collectors remain paused; wallet profiles can make bounded public activity reads. A data-only commit does not need a Sites interface deployment. Each venue's book times and collection errors, ETF source dates, and retained-data notices remain visible.

## Interface publication

Read the Sites building/hosting skills, preserve `.openai/hosting.json`, and use the existing source credential without writing it into files, logs, remote URLs or git configuration. Preserve concurrent bot commits. Run `npm test`, both Python test suites, `python3 scripts/check_site.py` and the build; inspect the affected interface on desktop and mobile.

Commit the exact source on the default branch and push the same source to GitHub and the existing Sites source repository. Build after recording the commit so `dist/build-info.json` identifies that revision. Package only the static output, deploy the existing private Site, and verify terminal success plus release identity. Pages builds the same artifact on interface changes and completed data cycles.

The existing hourly maintenance task compares interface sources, the build script and manifest. It excludes data-only and generated build-info changes, republishes when needed, and reports unresolved failures. Do not create duplicate maintenance tasks or put temporary Sites credentials into GitHub secrets.

## Retained operational boundaries

Built-in simulation is the selected mode. Prediction and ETF balances are independent. No real orders, broker credentials or international venue collectors are activated by this interface update. Do not restart retired collectors to make an old page appear current. See [prediction controls](PREDICTIONS.md), [ETF operation](ETF-RUNBOOK.md), and the [September research review](../reports/research-review-2026-09-13.md).
