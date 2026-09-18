# Publishing and maintenance

The canonical source is the GitHub default branch `claude/polymarket-wallets-analysis-m81p4j` of `srmcno/pm`. Preserve the existing owner-private Sites identity in `.openai/hosting.json`. Do not create a second Site or branch.

- Site: https://moffitt-money.smoffitt74743.chatgpt.site/
- Pages mirror: https://srmcno.github.io/pm/
- Source: `dashboard/`; build: `npm run build`; public artifact: `dist/`.

## Interface, version 6.0

`dashboard/focus.html` is the new primary entry. The build publishes it as `dist/index.html`. Primary navigation exposes Predictions, Crypto Tournament, Activity and Archive. The original `dashboard/index.html` is the advanced workspace, published as `archive-workspace.html` with a return-to-main link. Do not replace the focused root with the old workspace when deploying.

The Archive groups active auxiliary tools separately from historical studies and diagnostics. Existing copy, crypto, ETF and strategy screens remain available. Legacy root hashes for copy, crypto, research and desk redirect to the archived workspace; the old trades hash opens the new activity screen. Existing wallet and arb redirect pages continue to resolve through these aliases.

The build clears the previous output and copies an explicit public allowlist. Backend-only modules and raw backtest inputs remain outside the public artifact. Publish `dist/`, not the unbuilt dashboard folder. See [current paper policy and archive design](ACTIVE-PAPER.md).

## Data updates

`dashboard/data-client.mjs` reads dated snapshots from GitHub raw default-branch HEAD, falling back to bundled or newer retained records. The focused main app checks prediction data once per minute and does not initialize the archived wallet/crypto screens. Refreshing the page never advances an account or submits an order.

The prediction collector runs every ten minutes, best effort. The opportunity workflow runs every five minutes and advances the dynamic crypto tournament plus separate arbitrage/copy research. Tournament ledgers remain separate from crypto comparisons; comparison-only arbitrage has no ledger effect. Retired international collectors and the earlier $50 copy account remain paused. Dates, partial collections and failures remain explicit. Data-only updates do not require an interface deployment.

## Interface publication

Preserve `.openai/hosting.json` and the existing Site source identity. Run `npm test`, both Python suites, `python3 scripts/check_site.py`, and the build. Inspect the affected interface on mobile and desktop. Preserve concurrent bot commits and all account/history files.

Publish the same committed source and static artifact to Pages and the existing private Site, then verify terminal deployment success and release identity. A GitHub source update is not proof that Sites has updated. Do not expose credentials in files, logs, git configuration, static output or GitHub secrets. The existing maintenance task should be reused rather than duplicated.

## Operational boundaries

All existing accounts remain simulations. The experimental paper-entry policy does not unlock real execution. Do not reset either $100 prediction account, fabricate historical forecasts, restart retired collectors, or make historical results appear live. See [original accounting controls](PREDICTIONS.md), [forward copy study](COPY-TRADING.md), and [ETF operation](ETF-RUNBOOK.md).
