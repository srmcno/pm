# Copy-trading backtest — out-of-sample

Run 2026-08-13 00:39 UTC · virtual bankroll $20.00 · copy delay 1.0h · 8% of cash per position, max 10 open.

Watchlist chosen on first-half PnL only; traded on the second half (Jun 28 – Aug 12). Entries filled from real price history after the copy delay, +1¢ slippage.

## Result: $20.00 → **$19.63** (-1.9%)

- Trades entered: 53 · settled: 43 · open at end: 10
- Settled win rate: 21/43 (49%)
- Max drawdown: $-4.88
- Average latency cost (fill vs signal-time price): +0.0¢ per share
- Profit concentration: top 3 winners = 46% of gross profit

**Verdict: Copying did NOT beat holding cash in this window. The latency cost is real. Do not fund this.**

## Settled trades

| market | side | entry | settle | PnL |
|---|---|---|---|---|
| Will Argentina win on 2026-07-03? | No | 0.15 | 1.00 | +5.63 |
| Germany vs. Paraguay: Team to Advance | Paraguay | 0.33 | 1.00 | +2.38 |
| Will FK Dynamo Kyiv win on 2026-07-09? | No | 0.30 | 1.00 | +2.31 |
| Wimbledon WTA: Karolina Muchova vs Linda Noskova | Linda Noskova | 0.32 | 1.00 | +2.15 |
| Will Brazil win on 2026-07-05? | No | 0.47 | 1.00 | +1.70 |
| Will Brazil win on 2026-06-29? | No | 0.43 | 0.00 | -1.47 |
| Will Ronaldo Cry at the World Cup? | No | 0.79 | 0.00 | -1.41 |
| Will Mexico vs. England end in a draw? | Yes | 0.33 | 0.00 | -1.36 |
| Wimbledon ATP: Adam Walton vs Dino Prizmic | Adam Walton | 0.45 | 0.00 | -1.35 |
| Will Argentina win on 2026-07-07? | No | 0.61 | 0.00 | -1.30 |
| Will Kylian Mbappe be the top goalscorer at the 2026 FIFA World Cup? | No | 0.59 | 0.00 | -1.28 |
| LoL: Hanwha Life Esports vs LYON (BO5) - Mid-Season Invitational Playoffs | Hanwha Life Esports | 0.47 | 1.00 | +1.25 |
| Will France win on 2026-07-09? | No | 0.39 | 0.00 | -1.20 |
| BetBoom Team to win 2-0? | No | 0.53 | 1.00 | +1.17 |
| Will Abdul El-Sayed win the 2026 Michigan Democratic Primary? | No | 0.21 | 0.00 | -1.10 |
| Will Victor Marx win the 2026 Colorado Governor Republican primary election? | No | 0.32 | 0.00 | -1.09 |
| Exact Score: Portugal 2 - 1 Croatia? | No | 0.90 | 0.00 | -1.08 |
| Will Mexico win on 2026-06-30? | No | 0.57 | 0.00 | -1.05 |
| Will there be no change in Fed interest rates after the July 2026 meeting? | No | 0.10 | 0.00 | -1.03 |
| Will France win on 2026-07-04? | No | 0.18 | 0.00 | -0.95 |
| Will Anthropic have the best AI model at the end of July 2026? | No | 0.11 | 0.00 | -0.95 |
| Will LeBron James play for the Cleveland Cavaliers in 2026-27? | No | 0.53 | 1.00 | +0.89 |
| Will "Spider-Man: Brand New Day" Opening Weekend Box Office be greater than 280m? | No | 0.88 | 0.00 | -0.89 |
| Spread: France (-1.5) | France | 0.13 | 0.00 | -0.88 |
| Will Lionel Messi be the top goalscorer at the 2026 FIFA World Cup? | No | 0.50 | 1.00 | +0.87 |
| Will LeBron James play for the Golden State Warriors in 2026-27? | No | 0.56 | 1.00 | +0.87 |
| Will France win on 2026-07-18? | Yes | 0.54 | 0.00 | -0.86 |
| Wimbledon ATP: Jannik Sinner vs Alexander Zverev | Alexander Zverev | 0.42 | 0.00 | -0.86 |
| Argentina vs. Switzerland: Team to Advance | Switzerland | 0.26 | 0.00 | -0.85 |
| Will the Bank of Russia decrease the key rate after the July Meeting? | No | 0.69 | 0.00 | -0.80 |
| Norway vs. England: Team to Advance | Norway | 0.43 | 0.00 | -0.78 |
| Will Argentina win the 2026 FIFA World Cup? | No | 0.59 | 1.00 | +0.62 |
| Norway vs. England: Team to Advance | England | 0.66 | 1.00 | +0.48 |
| LoL: Bilibili Gaming vs Hanwha Life Esports (BO5) - Mid-Season Invitational Playoffs | Bilibili Gaming | 0.71 | 1.00 | +0.38 |
| Will Shenna Bellows be the Maine Senate Democratic nominee on July 27? | No | 0.78 | 1.00 | +0.34 |
| Will LeBron James play for the Miami Heat in 2026-27? | No | 0.80 | 1.00 | +0.30 |
| Will the Fed increase interest rates by 25 bps after the July 2026 meeting? | No | 0.84 | 1.00 | +0.25 |
| Will FC Universitatea Cluj win on 2026-07-09? | No | 0.87 | 1.00 | +0.18 |
| Will Erling Haaland be the top goalscorer at the 2026 FIFA World Cup? | No | 0.89 | 1.00 | +0.16 |
| Will Apple be the largest company in the world by market cap on July 31? | No | 0.92 | 1.00 | +0.12 |

## Equity curve (daily)

| date | equity |
|---|---|
| 2026-06-28 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-30 | $18.53 |
| 2026-06-30 | $18.53 |
| 2026-06-30 | $17.17 |
| 2026-06-30 | $17.42 |
| 2026-07-01 | $19.80 |
| 2026-07-01 | $18.75 |
| 2026-07-01 | $18.75 |
| 2026-07-01 | $18.75 |
| 2026-07-02 | $18.75 |
| 2026-07-02 | $19.61 |
| 2026-07-02 | $18.33 |
| 2026-07-02 | $17.54 |
| 2026-07-03 | $17.61 |
| 2026-07-03 | $17.61 |
| 2026-07-03 | $17.61 |
| 2026-07-03 | $16.53 |
| 2026-07-04 | $17.42 |
| 2026-07-04 | $16.39 |
| 2026-07-04 | $15.44 |
| 2026-07-04 | $21.07 |
| 2026-07-05 | $21.94 |
| 2026-07-05 | $21.94 |
| 2026-07-05 | $21.94 |
| 2026-07-05 | $20.99 |
| 2026-07-06 | $20.11 |
| 2026-07-06 | $20.11 |
| 2026-07-06 | $20.11 |
| 2026-07-06 | $21.82 |
| 2026-07-07 | $20.45 |
| 2026-07-07 | $20.61 |
| 2026-07-07 | $20.61 |
| 2026-07-07 | $20.61 |
| 2026-07-08 | $20.61 |
| 2026-07-08 | $19.21 |
| 2026-07-08 | $20.38 |
| 2026-07-08 | $19.07 |
| 2026-07-09 | $19.07 |
| 2026-07-09 | $17.87 |
| 2026-07-09 | $17.87 |
| 2026-07-09 | $17.87 |
| 2026-07-10 | $17.99 |
| 2026-07-10 | $17.07 |
| 2026-07-10 | $19.76 |
| 2026-07-10 | $19.76 |
| 2026-07-11 | $19.76 |
| 2026-07-11 | $19.76 |
| 2026-07-11 | $19.76 |
| 2026-07-11 | $19.84 |
| 2026-07-12 | $19.84 |
| 2026-07-12 | $20.19 |
| 2026-07-12 | $21.44 |
| 2026-07-12 | $24.08 |
| 2026-07-13 | $22.45 |
| 2026-07-13 | $22.45 |
| 2026-07-13 | $22.45 |
| 2026-07-13 | $21.59 |
| 2026-07-14 | $21.59 |
| 2026-07-14 | $21.59 |
| 2026-07-14 | $21.59 |
| 2026-07-14 | $21.59 |
| 2026-07-15 | $21.59 |
| 2026-07-15 | $21.59 |
| 2026-07-15 | $21.59 |
| 2026-07-15 | $21.56 |
| 2026-07-16 | $21.56 |
| 2026-07-16 | $21.56 |
| 2026-07-16 | $21.56 |
| 2026-07-16 | $21.56 |
| 2026-07-17 | $22.18 |
| 2026-07-17 | $22.18 |
| 2026-07-17 | $22.18 |
| 2026-07-17 | $22.18 |
| 2026-07-18 | $22.18 |
| 2026-07-18 | $21.29 |
| 2026-07-18 | $21.29 |
| 2026-07-18 | $21.29 |
| 2026-07-19 | $21.29 |
| 2026-07-19 | $21.29 |
| 2026-07-19 | $21.29 |
| 2026-07-19 | $20.42 |
| 2026-07-20 | $20.42 |
| 2026-07-20 | $20.42 |
| 2026-07-20 | $20.42 |
| 2026-07-20 | $20.42 |
| 2026-07-21 | $20.42 |
| 2026-07-21 | $20.42 |
| 2026-07-21 | $19.63 |
| 2026-07-21 | $19.63 |
| 2026-07-22 | $19.63 |
| 2026-07-22 | $19.63 |
| 2026-07-22 | $19.63 |
| 2026-07-22 | $19.63 |
| 2026-07-23 | $19.63 |
| 2026-07-23 | $19.63 |
| 2026-07-23 | $19.63 |
| 2026-07-23 | $19.63 |
| 2026-07-24 | $19.63 |
| 2026-07-24 | $19.63 |
| 2026-07-24 | $19.63 |
| 2026-07-24 | $19.63 |
| 2026-07-25 | $19.63 |
| 2026-07-25 | $19.63 |
| 2026-07-25 | $19.63 |
| 2026-07-25 | $19.63 |
| 2026-07-26 | $19.63 |
| 2026-07-26 | $19.63 |
| 2026-07-26 | $19.63 |
| 2026-07-26 | $19.63 |
| 2026-07-27 | $19.63 |
| 2026-07-27 | $19.63 |
| 2026-07-27 | $19.63 |
| 2026-07-27 | $19.63 |
| 2026-07-28 | $19.63 |
| 2026-07-28 | $19.63 |
| 2026-07-28 | $19.63 |
| 2026-07-28 | $19.63 |
| 2026-07-29 | $19.63 |
| 2026-07-29 | $19.63 |
| 2026-07-29 | $19.63 |
| 2026-07-29 | $19.63 |
| 2026-07-30 | $19.63 |
| 2026-07-30 | $19.63 |
| 2026-07-30 | $19.63 |
| 2026-07-30 | $19.63 |
| 2026-07-31 | $19.63 |
| 2026-07-31 | $19.63 |
| 2026-07-31 | $19.63 |
| 2026-07-31 | $19.63 |
| 2026-08-01 | $19.63 |
| 2026-08-01 | $19.63 |
| 2026-08-01 | $19.63 |
| 2026-08-01 | $19.63 |
| 2026-08-02 | $19.63 |
| 2026-08-02 | $19.63 |
| 2026-08-02 | $19.63 |
| 2026-08-02 | $19.63 |
| 2026-08-03 | $19.63 |
| 2026-08-03 | $19.63 |
| 2026-08-03 | $19.63 |
| 2026-08-03 | $19.63 |
| 2026-08-04 | $19.63 |
| 2026-08-04 | $19.63 |
| 2026-08-04 | $19.63 |
| 2026-08-04 | $19.63 |
| 2026-08-05 | $19.63 |
| 2026-08-05 | $19.63 |
| 2026-08-05 | $19.63 |
| 2026-08-05 | $19.63 |
| 2026-08-06 | $19.63 |
| 2026-08-06 | $19.63 |
| 2026-08-06 | $19.63 |
| 2026-08-06 | $19.63 |
| 2026-08-07 | $19.63 |
| 2026-08-07 | $19.63 |
| 2026-08-07 | $19.63 |
| 2026-08-07 | $19.63 |
| 2026-08-08 | $19.63 |
| 2026-08-08 | $19.63 |
| 2026-08-08 | $19.63 |
| 2026-08-08 | $19.63 |
| 2026-08-09 | $19.63 |
| 2026-08-09 | $19.63 |
| 2026-08-09 | $19.63 |
| 2026-08-09 | $19.63 |
| 2026-08-10 | $19.63 |
| 2026-08-10 | $19.63 |
| 2026-08-10 | $19.63 |
| 2026-08-10 | $19.63 |
| 2026-08-11 | $19.63 |
| 2026-08-11 | $19.63 |
| 2026-08-11 | $19.63 |
| 2026-08-11 | $19.63 |
| 2026-08-12 | $19.63 |
| 2026-08-12 | $19.63 |
| 2026-08-12 | $19.63 |
| 2026-08-12 | $19.63 |
