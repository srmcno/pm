# Polymarket Wallet Intelligence

A study of every wallet that topped a Polymarket leaderboard, traced trade-by-trade
across the trailing 90 days — plus the tools the study feeds: an interactive
dashboard, a smart-money signal engine, and a paper-trading simulator with an
honest out-of-sample backtest.

Everything runs on Polymarket's public APIs. No keys, no accounts, no real money.

## What's here

| Piece | Path | What it does |
|---|---|---|
| Data pipeline | `scripts/fetch_data.py` | Pulls leaderboards (week/month/all-time × PnL/volume × 10 categories), then every candidate wallet's 90-day trades, open positions, portfolio value, and daily PnL series. Timestamp-cursor pagination gets past the API's 5,500-row offset cap. |
| Re-fetch helper | `scripts/refetch_capped.py` | Re-pulls any wallet whose history hit the pagination cap. |
| Analyzer | `scripts/analyze.py` | Per-wallet 90-day metrics (volume, sizing, timing, category mix, entry-price appetite, drawdown, win-day rate) and archetype classification. Writes `data/analyzed.json`. |
| Dashboard | `dashboard/index.html` (built by `scripts/build_dashboard.py`) | Self-contained explorer: ranked cohort table with expandable per-wallet profiles, plus aggregate views. No external dependencies. |
| Signal engine | `scripts/signals.py` | Finds outcomes that several historically profitable wallets are independently net-buying right now. Writes `data/signals/latest.json` + `reports/signals-latest.md`. |
| Paper trader | `scripts/papertrade.py` | Simulates the copy strategy with a virtual bankroll — live loop and out-of-sample backtest. Writes `reports/paper-latest.md` / `reports/backtest-latest.md`. |
| Live executor | `scripts/livetrade.py` | The only tool that can touch real money — ships disarmed. `plan` is a keyless dry run; `execute` needs your keys, two explicit flags, and enforces hard caps + a STOP file. See the arming checklist in its docstring. |

## Quick start

```bash
pip install requests

# 1. Fetch the cohort (≈300 MB into data/raw/, ~30–90 min)
python3 scripts/fetch_data.py
python3 scripts/refetch_capped.py     # deep-fetch high-frequency wallets

# 2. Analyze and build the dashboard
python3 scripts/analyze.py
python3 scripts/build_dashboard.py    # -> dashboard/index.html, open in a browser

# 3. Smart-money signals (live)
python3 scripts/signals.py --live --hours 48

# 4. Paper-trade the signals with a virtual $20
python3 scripts/papertrade.py init --bankroll 20
python3 scripts/papertrade.py trade   # act on the latest signals
python3 scripts/papertrade.py mark    # mark to market / settle / report

# 5. The honest test: out-of-sample backtest of the copy strategy
python3 scripts/papertrade.py backtest --bankroll 20
```

## How the signal engine thinks

1. **Watchlist** — wallets qualify on realized 90-day PnL and win-day rate.
   Market-maker/HFT and crypto-scalper archetypes are excluded: their order
   flow is inventory management, not opinion.
2. **Stance, not trades** — a wallet's stance in a market is its best-net
   outcome minus whatever it spent on the other side. A trader who bought both
   sides has hedged, not spoken.
3. **Consensus with dominance** — a signal needs ≥2 independent qualified
   backers, and if the other side of the market also has real backing, the
   winning side must beat it by 1.5×; otherwise the market is contested and
   emits nothing.
4. **No chasing** — signals whose price has already moved >15¢ past the
   backers' average entry are dropped; the move already happened.
5. **Short horizon only** — with a max-days rail set (the watcher uses 3),
   markets resolving further out are skipped, and a market with *no*
   parseable end date counts as too far out: an unknown horizon can lock
   capital for weeks.

Scoring per backer: `wallet quality × √conviction × recency decay`, where
conviction is the net stake relative to that wallet's own median trade.

## How the backtest stays honest

- **Out-of-sample split**: the watchlist qualifies on the *first half* of the
  90-day window only; the strategy then trades the *second half*. (Residual
  look-ahead: archetype labels come from the full window.)
- **Real fills**: entries are taken from actual CLOB price history at signal
  time *plus a copy delay* (default 1 h), +1¢ slippage. If nothing traded within
  2 h of the intended fill, the trade is skipped — resolved markets can't be
  entered, exactly like real life.
- **The latency cost is measured** — the report shows the average difference
  between the fill and the price when the signal fired.

Run it before believing anything about copy-trading. The verdict line in
`reports/backtest-latest.md` is generated from the numbers, not from hope.

### Results on the full dataset (Jun 28 – Aug 12 window)

| config | result | note |
|---|---|---|
| ≥2 backers, 1 h delay | −1.9% | coin flip (49% win rate) |
| ≥2 backers, 3 h delay | −26.2% | latency is fatal |
| ≥3 backers, 1 h delay | +42.3% | promising but concentrated — one window, not proof |

Full breakdown: `reports/backtest-summary.md`. The live paper account runs the
strict config to accumulate a real out-of-sample record before any conclusion.

## The live site

The dashboard deploys to **https://srmcno.github.io/pm/** (GitHub Pages).
Human pushes touching `dashboard/` deploy on push; the watcher's own data
pushes use the workflow token, which GitHub never lets trigger on-push
workflows, so the watcher explicitly dispatches the deploy after each
publish. It stays live end to end:

- A cloud watcher (`watch-shift.yml`) runs back-to-back ~2-hour shifts,
  polling the trade feed every 45 s. It reacts to new consensus within about
  a minute, and every ~15 minutes it re-prices standing signals, re-marks the
  paper account, and pushes the data — each push redeploys the site.
- A watchdog (`watch-watchdog.yml`) checks twice an hour that a shift is
  actually running and dispatches one if GitHub dropped the scheduled start.
- The page itself re-fetches `data/signals.json` and `data/paper.json` every
  60 s and shows a **bot live / bot stale** pill, so a dead pipeline is
  visible instead of silently serving old numbers.

## The arb desk

A second page of the app — **https://srmcno.github.io/pm/arb.html** — runs a
micro-cap arbitrage scanner on MEXC spot (chosen over Pionex for its full
public market-data API and ~2,100 listed pairs), rescanning every ~25 s:

- **Triangular cycles** (USDT → coin → USDC/USD1/BTC/ETH → USDT) priced by
  crossing real bids and asks net of each pair's actual taker fee, then
  re-verified by walking live order-book depth at size. Fees kill almost
  everything — what survives is small and dies in seconds, so the page also
  measures edge survival scan-to-scan.
- **Microstructure board** — spread, depth within 1%, book imbalance, taker
  aggression, print sizes: the flow behind the candles.
- **Cross-venue gaps vs Gate.io**, guarded against the same-ticker-
  different-token trap (price-ratio and volume filters), published as intel
  only — capturing one needs funded accounts on both venues.
- A **$20 paper account** (same stake as the Polymarket bot) executes
  verified cycles at walked-depth prices, assuming atomic fills — an upper
  bound, clearly labeled. No keys, no real orders.
- **Historical testing, the honest way**: books aren't archived anywhere
  public and candles can't see spreads, so the desk records its own tick
  history every scan (`data/arb/history/`) and continuously replays it with
  one scan of latency (`arb.py backtest`) — the capture ratio between
  atomic and delayed PnL is the measured cost of being ~25 s slow.
  `arb-watch.yml` runs everything in self-chaining ~2-hour shifts like the
  Polymarket watcher.

## Data sources

- `https://data-api.polymarket.com/v1/leaderboard` — trader rankings
- `https://data-api.polymarket.com/activity` — per-wallet trade history
- `https://data-api.polymarket.com/positions`, `/value` — holdings
- `https://user-pnl-api.polymarket.com/user-pnl` — daily PnL series
- `https://gamma-api.polymarket.com/markets` — market metadata & resolution
- `https://clob.polymarket.com/prices-history`, `/midpoint` — prices

## Honest limitations

- The cohort is leaderboard-seeded: a strong wallet that never surfaced on any
  leaderboard window doesn't appear.
- Category classification is keyword-based on event slugs; a small share of
  volume lands in "Other".
- 90-day PnL comes from Polymarket's own per-user PnL series (realized +
  mark-to-market).
- Signals are information, not advice. Past profitability of a wallet is a weak
  predictor of its future trades' value — that is precisely what the backtest
  is for. Nothing here places real orders, and nothing here should be read as a
  promise that $20 becomes more than $20.
