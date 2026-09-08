# Moffitt Money 3.0

[Open the opportunity desk](https://srmcno.github.io/pm/)

A U.S. spot-market research app with streaming quotes, explicit trade plans, an isolated forward paper ledger, and a tested Python execution laboratory. The active experience excludes MEXC and the offshore Polymarket platform. Nothing in the new scanner places real orders or connects a wallet.

## What changed on September 8, 2026

- New responsive opportunity terminal with live connection health, completed-hour charts, market filters, a position planner, light/dark themes, and CSV ledger export.
- Volume-confirmed breakouts and trend-reclaim setups on BTC, ETH, SOL, LINK, AVAX and DOGE USD spot products. Product status and two-sided quote freshness are checked. No setup is described as a proven edge.
- The browser connects directly to Coinbase Exchange public WebSocket quotes. REST is an explicitly labeled fallback. Scheduled snapshots and paper records are separate from live quotes.
- Pump.fun/PumpSwap discovery from a bounded DEX Screener profile sample. Thin liquidity, young pools, extreme moves and weak sell activity are filtered. Missing mint, freeze, holder, liquidity-ownership and sell-simulation checks remain visible. Execution is disabled because token safety and account/jurisdiction eligibility are not established.
- Corrected auction lookahead: replay decisions and share sizing use prior completed sessions, while fills use the subsequent auction print. Live auction decisions use the same information boundary.
- Corrected drawdowns at zero/negative equity, fee-inclusive cash sizing, daily rounding by actual regulatory fee type, and entry-plus-exit fees in realized trade reporting.
- Invalid/nonfinite risk settings and corrupt persisted account state now fail closed. An explicit empty desk list stays empty after save/load.
- Validation is versioned. Prior results do not authorize trading after these calculation changes. Fresh walk-forward validation runs when the desk code changes and weekly thereafter.
- Retired legacy offshore, optimistic arb and earlier stock simulation workflows. Historical source, measurements and wallet research remain available. The wallet build now writes `wallets.html`, never the new homepage.

## Strategies and honest limits

| Rule | Entry | Exit / sizing |
|---|---|---|
| Volume breakout | Completed hourly close above the previous 20-hour high; 20 EMA above 50 EMA; at least 1.5x relative volume | Initial stop at least 2 ATR below the signal; initial 3R price target; reject excessive chase |
| Trend reclaim | Hourly close regains 20 EMA in an established uptrend; at least 1.1x volume | Same cost-aware risk sizing and exit conditions |
| Shared paper account | A candidate must survive two separate scans, 30 seconds to 15 minutes apart | Starts at $1,000; 1.5% planned risk per idea; 25% position cap; 3% combined modeled open risk; at most 3 positions |

Paper costs default to **60 bps taker fee and 10 bps slippage per side**. These are assumptions, not a promise of your account's fee tier. The browser planner can use your actual fees. Its settings are local and never alter the shared paper account.

For one unit, with fee fraction `f` and slippage fraction `s`:

```
entry fill = ask * (1 + s)
cash cost = entry fill * (1 + f)
stop proceeds = stop * (1 - s) * (1 - f)
net risk = cash cost - stop proceeds
net reward = target * (1 - s) * (1 - f) - cash cost
quantity = min(risk budget / net risk, capital cap / cash cost, 10% of visible ask size if supplied)
```

This is a risk/reward calculation, **not expected value**. No calibrated success probability is available. The displayed breakeven win rate is the win rate the planned payoff would require, not a forecast. Portfolio correlation and gaps can produce losses beyond planned risk.

The paper ledger marks positions at modeled liquidation proceeds. It pays fees on both sides, uses conservative adverse stop fills, gives stops priority when a completed bar is ambiguous, and has 48-hour time exits. It does not invent target fills that were not observed. New entries stop after a 5% UTC-day loss or a 15% peak drawdown. A drawdown halt persists. An existing position with stale quotes prevents new portfolio entries.

GitHub Actions schedules are best effort. Five-minute scans are not continuous execution. An intrahour move, incomplete bar, network outage or delayed job can be missed. This app is unsuitable for latency arbitrage. Fresh quotes do not make delayed ledger snapshots real-time.

## U.S. access review

Reviewed **2026-09-08**. Platform access is conditional on current account, identity, location, state and product restrictions. A public API response is not a legal authorization to trade.

| Venue | Treatment | Primary source |
|---|---|---|
| Coinbase spot | Public market data and conditional U.S. spot research; enter your actual fee tier | [Advanced fees](https://help.coinbase.com/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees) |
| Alpaca | Existing paper/live adapter retains explicit arming gates; broker/account rules apply | [Intraday margin update](https://alpaca.markets/blog/finra-retires-the-pdt-rule-introducing-alpacas-new-intraday-margin-framework/) |
| Kalshi | Separate existing research desk, currently subject to its evidence and account gates | [Fee schedule](https://kalshi.com/fee-schedule), [rounding API](https://docs.kalshi.com/getting_started/fee_rounding) |
| Polymarket US | Separate U.S. venue; the offshore wallet signals do not map automatically to its contracts | [Official U.S. site](https://polymarket.us/) |
| MEXC | Excluded; order submission is blocked | [Terms](https://www.mexc.com/terms) |
| Pump.fun/PumpSwap | Discovery only; eligibility not established, no execution | [Terms](https://pump.fun/docs/terms-and-conditions), [fees](https://pump.fun/docs/fees) |

FINRA's new intraday-margin rules took effect June 4, 2026, with a broker transition period. Do not assume every broker adopted them immediately. [FINRA Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10).

## Code map

| Path | Responsibility |
|---|---|
| `dashboard/market-core.mjs` | Shared pure signal, sizing, token-screen and paper-accounting rules |
| `dashboard/terminal.mjs` | Direct WebSocket/REST feeds and UI; no keys or trading calls |
| `scripts/collect-opportunities.mjs` | Bounded public-data collection and atomic paper-state publication |
| `data/opportunities/paper.json` | Complete shared paper ledger, separate from earlier simulations |
| `dashboard/data/opportunities.json` | Published snapshot, original source times and source errors |
| `scripts/desk/` | Existing U.S. desk allocation, broker adapters, reconciliation, backtesting and validation |
| `scripts/build_dashboard.py` | Archived wallet-research rebuild only |
| `tests/market-core.test.mjs`, `scripts/tests/`, `tests/test_engine.py` | Offline regression coverage |
| `scripts/check_site.py` | Local links, unique IDs and embedded JavaScript integrity |

## Run and verify

Node 22+ and Python 3.12:

```sh
python -m pip install 'requests>=2.31,<3'
python -m unittest discover -s scripts/tests
python -m unittest discover -s tests
node --test tests/market-core.test.mjs
python scripts/check_site.py
node scripts/collect-opportunities.mjs
python -m http.server 8765 --directory dashboard
```

`U.S. opportunity scan` collects on a five-minute best-effort schedule. `Deploy dashboard to GitHub Pages` verifies and publishes `dashboard/`, and records the actual deployed commit in `build-info.json`. CI covers changes and pull requests. The watchdog recovers missing scans. Data commits from workflow tokens are published by the scheduled Pages workflow because such commits do not trigger push workflows.

Existing desk operation is documented in [the runbook](docs/RUNBOOK.md). Corrected replay results supersede all historical performance claims in older studies. Real orders still require all existing explicit arming gates and valid evidence. No real orders were needed to develop or test this release.
