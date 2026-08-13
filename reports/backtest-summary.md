# Copy-trading retro test — summary of all runs

Out-of-sample protocol: the watchlist qualified on **first-half** (May 14 – Jun 27)
PnL only; the strategy then traded the **second half** (Jun 28 – Aug 12) with fills
taken from real CLOB price history *after* the copy delay, +1¢ slippage. Virtual
$20 bankroll, 8% of cash per position.

| config | consensus | copy delay | result | win rate | top-3 profit share | latency cost |
|---|---|---|---|---|---|---|
| A (default) | ≥2 backers | 1 h | $20 → **$19.63** (−1.9%) | 49% | 46% | +0.0¢/sh |
| B (slow copier) | ≥2 backers | 3 h | $20 → **$14.77** (−26.2%) | 47% | 66% | +0.5¢/sh |
| C (strict) | ≥3 backers | 1 h | $20 → **$28.46** (+42.3%) | 53% | 51% | −0.2¢/sh |

## What this actually says

1. **Speed decides everything.** The identical strategy loses 26% at a 3-hour
   delay and breaks even at 1 hour. Whatever information is in the sharps' flow
   is priced in within hours. A casual copier is the exit liquidity.
2. **Shallow consensus is noise.** Two backers agreeing (config A) was a coin
   flip: 49% win rate, −1.9%.
3. **Deep consensus might be signal.** Three-plus independent backers (config C)
   returned +42% — but 51% of the profit came from three trades, and this is a
   single 45-day window. That is *interesting*, not *proven*. A result this
   config-sensitive can easily be selection luck.
4. **An earlier run on incomplete data showed +382%.** After the dataset was
   completed (12.3M trades vs 867K), that vanished. Treat any single backtest
   number — including config C's — with the same suspicion.

## Robustness runs (strict config, different train/trade splits)

| split | result | win rate | top-3 profit share |
|---|---|---|---|
| train 45d / trade 45d | +42.3% | 53% | 51% |
| train 30d / trade 60d | **+25.8%** | 61% | **37%** |
| train 60d / trade 30d | +82.8% | 61% | 76% |
| train 45d / trade 45d, 16% sizing | +64.8% | 53% | 52% |

The strict (≥3 backers, ~1h copy) config is positive in every split tested,
with 53–61% settled win rates and ~zero measured latency cost. Honest
caveats: these windows **overlap** (they share the same 90 days of data, so
the same lucky trades can appear in several rows — this is not four
independent samples), and every fill is simulated from printed trades +1¢.
The 30/60 split is the highest-quality evidence: most trades, least
concentration. Aggressive 16% sizing scaled returns without blowing up in
this window, but doubles the drawdown risk by construction.

## Verdict

Do **not** fund this. The only defensible next step is the one that costs
nothing: keep the live paper account running on the strict (≥3 backers, fast
copy) config for several more weeks and judge the accumulated out-of-sample
record, not one window.
