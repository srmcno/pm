# Copy-trading backtest — out-of-sample

Run 2026-08-13 00:40 UTC · virtual bankroll $20.00 · copy delay 3.0h · 8% of cash per position, max 10 open.

Watchlist chosen on first-half PnL only; traded on the second half (Jun 28 – Aug 12). Entries filled from real price history after the copy delay, +1¢ slippage.

## Result: $20.00 → **$14.77** (-26.2%)

- Trades entered: 46 · settled: 36 · open at end: 10
- Settled win rate: 17/36 (47%)
- Max drawdown: $-6.49
- Average latency cost (fill vs signal-time price): +0.5¢ per share
- Profit concentration: top 3 winners = 66% of gross profit

**Verdict: Copying did NOT beat holding cash in this window. The latency cost is real. Do not fund this.**

## Settled trades

| market | side | entry | settle | PnL |
|---|---|---|---|---|
| Will Argentina win on 2026-07-03? | No | 0.15 | 1.00 | +4.90 |
| Will FK Dynamo Kyiv win on 2026-07-09? | No | 0.30 | 1.00 | +1.88 |
| Will Brazil win on 2026-07-05? | No | 0.47 | 1.00 | +1.52 |
| Will Brazil win on 2026-06-29? | No | 0.43 | 0.00 | -1.47 |
| Wimbledon ATP: Adam Walton vs Dino Prizmic | Adam Walton | 0.46 | 0.00 | -1.35 |
| Will Argentina win on 2026-07-07? | No | 0.08 | 0.00 | -1.25 |
| Will Ronaldo Cry at the World Cup? | No | 0.80 | 0.00 | -1.25 |
| Will Mexico vs. England end in a draw? | Yes | 0.34 | 0.00 | -1.21 |
| Will France win on 2026-07-09? | No | 0.40 | 0.00 | -1.15 |
| Will Mexico win on 2026-06-30? | No | 0.57 | 0.00 | -1.15 |
| Will Kylian Mbappe be the top goalscorer at the 2026 FIFA World Cup? | No | 0.59 | 0.00 | -1.08 |
| Exact Score: Portugal 2 - 1 Croatia? | No | 0.90 | 0.00 | -0.94 |
| Will LeBron James play for the Golden State Warriors in 2026-27? | No | 0.56 | 1.00 | +0.93 |
| Will Victor Marx win the 2026 Colorado Governor Republican primary election? | No | 0.23 | 0.00 | -0.91 |
| Will Abdul El-Sayed win the 2026 Michigan Democratic Primary? | No | 0.21 | 0.00 | -0.90 |
| Will there be no change in Fed interest rates after the July 2026 meeting? | No | 0.10 | 0.00 | -0.90 |
| Wimbledon ATP: Jannik Sinner vs Alexander Zverev | Alexander Zverev | 0.26 | 0.00 | -0.84 |
| Will Anthropic have the best AI model at the end of July 2026? | No | 0.11 | 0.00 | -0.83 |
| Will France win on 2026-07-04? | No | 0.18 | 0.00 | -0.82 |
| Will LeBron James play for the Cleveland Cavaliers in 2026-27? | No | 0.57 | 1.00 | +0.64 |
| Will "Spider-Man: Brand New Day" Opening Weekend Box Office be greater than 280m? | No | 0.88 | 0.00 | -0.62 |
| Will France win on 2026-07-18? | Yes | 0.54 | 0.00 | -0.61 |
| Will the Bank of Russia decrease the key rate after the July Meeting? | No | 0.69 | 0.00 | -0.56 |
| Will Lionel Messi be the top goalscorer at the 2026 FIFA World Cup? | No | 0.60 | 1.00 | +0.50 |
| Will Argentina win the 2026 FIFA World Cup? | No | 0.59 | 1.00 | +0.43 |
| Norway vs. England: Team to Advance | England | 0.66 | 1.00 | +0.41 |
| Will Shenna Bellows be the Maine Senate Democratic nominee on July 27? | No | 0.78 | 1.00 | +0.27 |
| Will LeBron James play for the Miami Heat in 2026-27? | No | 0.79 | 1.00 | +0.26 |
| Will the Fed increase interest rates by 25 bps after the July 2026 meeting? | No | 0.84 | 1.00 | +0.25 |
| Will Erling Haaland be the top goalscorer at the 2026 FIFA World Cup? | No | 0.88 | 1.00 | +0.15 |
| Will FC Universitatea Cluj win on 2026-07-09? | No | 0.88 | 1.00 | +0.14 |
| Will Apple be the largest company in the world by market cap on July 31? | No | 0.90 | 1.00 | +0.12 |
| LoL: Hanwha Life Esports vs LYON (BO5) - Mid-Season Invitational Playoffs | Hanwha Life Esports | 0.89 | 1.00 | +0.11 |
| Will PH win the 2026 Johor general elections? | No | 0.93 | 1.00 | +0.07 |
| Will Harry Kane be the top goalscorer at the 2026 FIFA World Cup? | No | 0.93 | 1.00 | +0.06 |
| Dota 2: Vici Gaming vs PlayTime (BO3) - Esports World Cup Survival | PlayTime | 0.53 | 0.50 | -0.03 |

## Equity curve (daily)

| date | equity |
|---|---|
| 2026-06-28 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-30 | $20.00 |
| 2026-06-30 | $18.53 |
| 2026-06-30 | $17.17 |
| 2026-06-30 | $17.42 |
| 2026-07-01 | $17.42 |
| 2026-07-01 | $16.27 |
| 2026-07-01 | $16.27 |
| 2026-07-01 | $16.27 |
| 2026-07-02 | $16.27 |
| 2026-07-02 | $17.21 |
| 2026-07-02 | $16.13 |
| 2026-07-02 | $15.48 |
| 2026-07-03 | $15.54 |
| 2026-07-03 | $15.54 |
| 2026-07-03 | $15.54 |
| 2026-07-03 | $14.59 |
| 2026-07-04 | $15.24 |
| 2026-07-04 | $14.34 |
| 2026-07-04 | $13.51 |
| 2026-07-04 | $18.41 |
| 2026-07-05 | $18.91 |
| 2026-07-05 | $18.91 |
| 2026-07-05 | $18.91 |
| 2026-07-05 | $18.09 |
| 2026-07-06 | $18.09 |
| 2026-07-06 | $18.09 |
| 2026-07-06 | $18.09 |
| 2026-07-06 | $19.61 |
| 2026-07-07 | $18.39 |
| 2026-07-07 | $18.54 |
| 2026-07-07 | $18.54 |
| 2026-07-07 | $18.54 |
| 2026-07-08 | $18.54 |
| 2026-07-08 | $17.28 |
| 2026-07-08 | $17.28 |
| 2026-07-08 | $16.03 |
| 2026-07-09 | $16.03 |
| 2026-07-09 | $14.87 |
| 2026-07-09 | $14.87 |
| 2026-07-09 | $14.87 |
| 2026-07-10 | $14.99 |
| 2026-07-10 | $14.23 |
| 2026-07-10 | $16.12 |
| 2026-07-10 | $16.12 |
| 2026-07-11 | $16.12 |
| 2026-07-11 | $16.12 |
| 2026-07-11 | $16.12 |
| 2026-07-11 | $16.19 |
| 2026-07-12 | $16.19 |
| 2026-07-12 | $16.46 |
| 2026-07-12 | $16.57 |
| 2026-07-12 | $16.98 |
| 2026-07-13 | $16.98 |
| 2026-07-13 | $16.98 |
| 2026-07-13 | $16.98 |
| 2026-07-13 | $16.15 |
| 2026-07-14 | $16.15 |
| 2026-07-14 | $16.15 |
| 2026-07-14 | $16.15 |
| 2026-07-14 | $16.15 |
| 2026-07-15 | $16.15 |
| 2026-07-15 | $16.15 |
| 2026-07-15 | $16.15 |
| 2026-07-15 | $16.12 |
| 2026-07-16 | $16.12 |
| 2026-07-16 | $16.12 |
| 2026-07-16 | $16.12 |
| 2026-07-16 | $16.12 |
| 2026-07-17 | $16.55 |
| 2026-07-17 | $16.55 |
| 2026-07-17 | $16.55 |
| 2026-07-17 | $16.55 |
| 2026-07-18 | $16.55 |
| 2026-07-18 | $15.93 |
| 2026-07-18 | $15.93 |
| 2026-07-18 | $15.93 |
| 2026-07-19 | $15.93 |
| 2026-07-19 | $15.93 |
| 2026-07-19 | $15.93 |
| 2026-07-19 | $15.32 |
| 2026-07-20 | $15.32 |
| 2026-07-20 | $15.32 |
| 2026-07-20 | $15.32 |
| 2026-07-20 | $15.32 |
| 2026-07-21 | $15.32 |
| 2026-07-21 | $15.32 |
| 2026-07-21 | $14.77 |
| 2026-07-21 | $14.77 |
| 2026-07-22 | $14.77 |
| 2026-07-22 | $14.77 |
| 2026-07-22 | $14.77 |
| 2026-07-22 | $14.77 |
| 2026-07-23 | $14.77 |
| 2026-07-23 | $14.77 |
| 2026-07-23 | $14.77 |
| 2026-07-23 | $14.77 |
| 2026-07-24 | $14.77 |
| 2026-07-24 | $14.77 |
| 2026-07-24 | $14.77 |
| 2026-07-24 | $14.77 |
| 2026-07-25 | $14.77 |
| 2026-07-25 | $14.77 |
| 2026-07-25 | $14.77 |
| 2026-07-25 | $14.77 |
| 2026-07-26 | $14.77 |
| 2026-07-26 | $14.77 |
| 2026-07-26 | $14.77 |
| 2026-07-26 | $14.77 |
| 2026-07-27 | $14.77 |
| 2026-07-27 | $14.77 |
| 2026-07-27 | $14.77 |
| 2026-07-27 | $14.77 |
| 2026-07-28 | $14.77 |
| 2026-07-28 | $14.77 |
| 2026-07-28 | $14.77 |
| 2026-07-28 | $14.77 |
| 2026-07-29 | $14.77 |
| 2026-07-29 | $14.77 |
| 2026-07-29 | $14.77 |
| 2026-07-29 | $14.77 |
| 2026-07-30 | $14.77 |
| 2026-07-30 | $14.77 |
| 2026-07-30 | $14.77 |
| 2026-07-30 | $14.77 |
| 2026-07-31 | $14.77 |
| 2026-07-31 | $14.77 |
| 2026-07-31 | $14.77 |
| 2026-07-31 | $14.77 |
| 2026-08-01 | $14.77 |
| 2026-08-01 | $14.77 |
| 2026-08-01 | $14.77 |
| 2026-08-01 | $14.77 |
| 2026-08-02 | $14.77 |
| 2026-08-02 | $14.77 |
| 2026-08-02 | $14.77 |
| 2026-08-02 | $14.77 |
| 2026-08-03 | $14.77 |
| 2026-08-03 | $14.77 |
| 2026-08-03 | $14.77 |
| 2026-08-03 | $14.77 |
| 2026-08-04 | $14.77 |
| 2026-08-04 | $14.77 |
| 2026-08-04 | $14.77 |
| 2026-08-04 | $14.77 |
| 2026-08-05 | $14.77 |
| 2026-08-05 | $14.77 |
| 2026-08-05 | $14.77 |
| 2026-08-05 | $14.77 |
| 2026-08-06 | $14.77 |
| 2026-08-06 | $14.77 |
| 2026-08-06 | $14.77 |
| 2026-08-06 | $14.77 |
| 2026-08-07 | $14.77 |
| 2026-08-07 | $14.77 |
| 2026-08-07 | $14.77 |
| 2026-08-07 | $14.77 |
| 2026-08-08 | $14.77 |
| 2026-08-08 | $14.77 |
| 2026-08-08 | $14.77 |
| 2026-08-08 | $14.77 |
| 2026-08-09 | $14.77 |
| 2026-08-09 | $14.77 |
| 2026-08-09 | $14.77 |
| 2026-08-09 | $14.77 |
| 2026-08-10 | $14.77 |
| 2026-08-10 | $14.77 |
| 2026-08-10 | $14.77 |
| 2026-08-10 | $14.77 |
| 2026-08-11 | $14.77 |
| 2026-08-11 | $14.77 |
| 2026-08-11 | $14.77 |
| 2026-08-11 | $14.77 |
| 2026-08-12 | $14.77 |
| 2026-08-12 | $14.77 |
| 2026-08-12 | $14.77 |
| 2026-08-12 | $14.77 |
