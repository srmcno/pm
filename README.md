# Moffitt Money

[Open the app](https://moffitt-money.smoffitt74743.chatgpt.site/) · [GitHub Pages](https://srmcno.github.io/pm/)

A focused prediction-market research desk for **Kalshi and Polymarket US**. It uses built-in simulation, with two separate $100 prediction accounts and a separate $1,000 ETF experiment. Real orders remain off.

## Three views

- **Desk:** dated order books, venue/search filters, understandable entry holds and the full cost of each contract. Price gaps compares the best equal-quantity package across both Kalshi team-strike books and the corresponding Polymarket US game.
- **Paper trades:** actual simulated positions, settlements, fees, net results and CSV export. Recorded research outcomes are never counted as trades.
- **Research:** calibration samples, historical price-gap evidence, the ETF experiment and concise conclusions from earlier strategies. Detailed account records and uncertainty checks remain available in disclosures.

A matching game is not proof of equivalent settlement. The paired scanner verifies named team-provider IDs, the scheduled start and outcome orientation; walks both books; applies current fees and slippage; checks separate cash, exposure and quote times; and records rule hashes. Exceptional settlement remains unverified, so paired execution is held. The browser is a dated research view, not a low-latency execution system.

## What the evidence currently says

The September 13 study aligned **3,474 historical directional observations across two games**. There were 58 packages below $1 before costs and **zero after modeled costs**. The observations are correlated quotes, not executed or independent trades. The games' exceptional settlement rules also differ. [Complete study and reproducible inputs](reports/paired-market-history.md).

The revised crypto rules lost 10.40% across the preserved 90-day replay; all three chronological slices lost money. The retired stock paper account lost 5.13%. Older wallet and crypto-arbitrage profit figures use incomplete costs or optimistic execution assumptions and do not establish an edge for this desk. [Review of earlier evidence](reports/research-review-2026-09-13.md).

The fixed monthly ETF trend rule has a distribution/split-aware 2006–2026 replay, matched hold benchmarks, cost/delay stress tests and bootstrap uncertainty. It trails buy-and-hold; a $5 monthly operating cost makes the original $1,000 simulation lose money over the full test. The separate forward account starts from $1,000 with no inherited historical gains. [ETF report](reports/etf-research.md) · [ETF runbook](docs/ETF-RUNBOOK.md).

These findings guide what stays held. They do not justify lowering evidence requirements or manufacturing trades.

## Run and verify

```sh
npm test
python3 -m unittest discover -s scripts/tests
python3 -m unittest discover -s tests
python3 scripts/check_site.py
npm run build
python3 -m http.server 8874 --directory dist
```

Python tests require `requests>=2.31,<3`. The browser app needs no package installation. The build clears `dist/` and copies only the supported public surface. Sites and Pages use that identical output; archived raw histories stay in the repository.

```sh
python3 scripts/study-paired-history.py --output /tmp/paired-reproduction
```

This reproduces the frozen price-gap study without network requests or account changes.

## Code and operation

| Path | Responsibility |
|---|---|
| `dashboard/app.mjs`, `app.css`, `app-schema.mjs` | Three-view interface and validated display contracts |
| `dashboard/prediction-core.mjs` | Fees, depth, calibration, risk and persistent paper accounting |
| `dashboard/prediction-arbitrage.mjs` | Complementary packages, funding, quote freshness and settlement uncertainty |
| `scripts/predictions/arbitrage.mjs` | Bounded public game discovery and identity matching |
| `scripts/collect-predictions.mjs` | Automatic prediction cycles, official settlements and observation history |
| `data/predictions/state.json` | Authoritative prediction accounts, observations and bounded paired-book receipts |
| `scripts/etf_lab.py`, `data/etf/` | Fixed-rule ETF research and separate forward simulation |
| `scripts/desk/`, `engine/` | Separate strategy and execution laboratories; no new real-order activation |
| `data/research/` | Frozen inputs and retired public snapshots; excluded from the site build |

Prediction cycles run about every ten minutes through GitHub Actions, best effort. The display checks publication once a minute and retains newer loaded data on failure. Source times and errors remain visible. Existing strategy-laboratory and opportunity paper workflows continue managing their own accounts; their raw state has not been deleted or reset.

[Prediction methodology and controls](docs/PREDICTIONS.md) · [Publishing and maintenance](docs/SITES.md) · [Cleanup and current research decisions](reports/research-review-2026-09-13.md).
