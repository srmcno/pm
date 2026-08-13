# Copy-trading backtest — out-of-sample

Run 2026-08-13 02:08 UTC · virtual bankroll $20.00 · copy delay 1.0h · 8% of cash per position, max 10 open.

Watchlist chosen on first-half PnL only; traded on the second half (Jun 28 – Aug 12). Entries filled from real price history after the copy delay, +1¢ slippage.

## Result: $20.00 → **$19.61** (-2.0%)

- Trades entered: 95 · settled: 88 · open at end: 7
- Settled win rate: 43/88 (49%)
- Max drawdown: $-10.21
- Average latency cost (fill vs signal-time price): -0.9¢ per share
- Profit concentration: top 3 winners = 22% of gross profit

**Verdict: Copying did NOT beat holding cash in this window. The latency cost is real. Do not fund this.**

## Settled trades

| market | side | entry | settle | PnL |
|---|---|---|---|---|
| Will Argentina win on 2026-07-03? | No | 0.15 | 1.00 | +4.60 |
| Will Spain win the 2026 FIFA World Cup? | Yes | 0.22 | 1.00 | +3.65 |
| Swiss Open: Alexander Bublik vs Quentin Halys | Quentin Halys | 0.32 | 1.00 | +3.21 |
| Wimbledon ATP: Hubert Hurkacz vs Jan-Lennard Struff | Jan-Lennard Struff | 0.21 | 1.00 | +3.17 |
| Will Norway vs. England end in a draw? | Yes | 0.27 | 1.00 | +3.11 |
| France vs. England: Team to Win | England | 0.36 | 1.00 | +2.74 |
| Will Inter Miami CF win on 2026-07-25? | No | 0.57 | 0.00 | -2.00 |
| England vs. Argentina: Team to Advance | Argentina | 0.46 | 1.00 | +1.92 |
| Generali Open: Vit Kopriva vs Ignacio Buse | Vit Kopriva | 0.05 | 0.00 | -1.92 |
| Wimbledon WTA: Karolina Muchova vs Linda Noskova | Linda Noskova | 0.32 | 1.00 | +1.89 |
| National Bank Open: Valentin Vacherot vs Mariano Navone | Mariano Navone | 0.40 | 1.00 | +1.86 |
| Estoril Open: Luca Van Assche vs Alexander Blockx | Alexander Blockx | 0.48 | 0.00 | -1.84 |
| Will Argentina win the 2026 FIFA World Cup? | Yes | 0.18 | 0.00 | -1.77 |
| Canadian Open: Zachary Svajda vs Denis Shapovalov | Zachary Svajda | 0.43 | 1.00 | +1.71 |
| Croatia Open: Roman Andres Burruchaga vs Camilo Ugo Carabelli | Camilo Ugo Carabelli | 0.42 | 0.00 | -1.71 |
| Generali Open: Yannick Hanfmann vs Sebastian Baez | Yannick Hanfmann | 0.54 | 1.00 | +1.62 |
| Spread: France (-1.5) | France | 0.19 | 0.00 | -1.61 |
| Will Brazil win on 2026-06-29? | No | 0.43 | 0.00 | -1.60 |
| Mubadala Citi DC Open: Jessica Pegula vs Alexandra Eala | Jessica Pegula | 0.64 | 0.00 | -1.56 |
| Mubadala Citi DC Open: Julieta Pareja vs Xinyu Wang | Julieta Pareja | 0.14 | 0.00 | -1.56 |
| Will France vs. Spain end in a draw? | Yes | 0.31 | 0.00 | -1.48 |
| Will Brazil vs. Japan end in a draw? | Yes | 0.27 | 0.00 | -1.47 |
| Swiss Open: Alexander Shevchenko vs Dominic Stephan Stricker | Dominic Stephan Stricker | 0.71 | 0.00 | -1.45 |
| National Bank Open: Jiri Lehecka vs Rafael Jodar | Jiri Lehecka | 0.48 | 0.00 | -1.44 |
| National Bank Open: Luca Van Assche vs Titouan Droguet | Luca Van Assche | 0.55 | 0.00 | -1.43 |
| Mubadala Citi DC Open: Aleksandar Vukic vs Lorenzo Musetti | Aleksandar Vukic | 0.34 | 0.00 | -1.43 |
| Swiss Open: Arthur Rinderknech vs Stefanos Tsitsipas | Arthur Rinderknech | 0.24 | 0.00 | -1.41 |
| National Bank Open: Alexei Popyrin vs Thiago Agustin Tirante | Alexei Popyrin | 0.57 | 0.00 | -1.41 |
| Will Santos FC win on 2026-08-09? | Yes | 0.47 | 0.00 | -1.40 |
| National Bank Open: Karen Khachanov vs Terence Atmane | Terence Atmane | 0.46 | 1.00 | +1.34 |
| Argentina vs. Egypt: O/U 8.5 Total Corners | Under | 0.49 | 1.00 | +1.33 |
| National Bank Open: Arthur Rinderknech vs Brandon Nakashima | Brandon Nakashima | 0.54 | 1.00 | +1.32 |
| Will SK Puntigamer Sturm Graz win on 2026-07-21? | Yes | 0.57 | 1.00 | +1.30 |
| Mubadala Citi DC Open: Cristina Bucsa vs Polina Kudermetova | Polina Kudermetova | 0.57 | 1.00 | +1.30 |
| Will France win on 2026-07-18? | Yes | 0.53 | 0.00 | -1.30 |
| National Bank Open: Alexandra Eala vs Belinda Bencic | Alexandra Eala | 0.48 | 0.00 | -1.29 |
| Wimbledon ATP: Jannik Sinner vs Alexander Zverev | Alexander Zverev | 0.42 | 0.00 | -1.21 |
| Will Spain win on 2026-07-10? | No | 0.42 | 0.00 | -1.20 |
| Will Argentina vs. Egypt end in a draw? | Yes | 0.21 | 0.00 | -1.20 |
| Brazil vs. Japan: O/U 2.5 | Under | 0.57 | 0.00 | -1.15 |

## Equity curve (daily)

| date | equity |
|---|---|
| 2026-06-28 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-29 | $20.00 |
| 2026-06-30 | $16.93 |
| 2026-06-30 | $16.95 |
| 2026-06-30 | $14.93 |
| 2026-06-30 | $14.93 |
| 2026-07-01 | $15.51 |
| 2026-07-01 | $15.51 |
| 2026-07-01 | $15.51 |
| 2026-07-01 | $14.39 |
| 2026-07-02 | $13.35 |
| 2026-07-02 | $13.35 |
| 2026-07-02 | $13.28 |
| 2026-07-02 | $13.82 |
| 2026-07-03 | $13.82 |
| 2026-07-03 | $13.38 |
| 2026-07-03 | $13.43 |
| 2026-07-03 | $13.23 |
| 2026-07-04 | $13.23 |
| 2026-07-04 | $13.23 |
| 2026-07-04 | $12.16 |
| 2026-07-04 | $16.08 |
| 2026-07-05 | $15.39 |
| 2026-07-05 | $15.39 |
| 2026-07-05 | $15.66 |
| 2026-07-05 | $15.66 |
| 2026-07-06 | $14.92 |
| 2026-07-06 | $15.75 |
| 2026-07-06 | $14.72 |
| 2026-07-06 | $18.98 |
| 2026-07-07 | $18.10 |
| 2026-07-07 | $18.10 |
| 2026-07-07 | $18.10 |
| 2026-07-07 | $17.14 |
| 2026-07-08 | $17.20 |
| 2026-07-08 | $17.20 |
| 2026-07-08 | $18.11 |
| 2026-07-08 | $17.90 |
| 2026-07-09 | $17.90 |
| 2026-07-09 | $17.11 |
| 2026-07-09 | $16.31 |
| 2026-07-09 | $16.31 |
| 2026-07-10 | $16.31 |
| 2026-07-10 | $17.44 |
| 2026-07-10 | $17.44 |
| 2026-07-10 | $17.44 |
| 2026-07-11 | $16.24 |
| 2026-07-11 | $16.24 |
| 2026-07-11 | $16.31 |
| 2026-07-11 | $16.31 |
| 2026-07-12 | $16.31 |
| 2026-07-12 | $19.96 |
| 2026-07-12 | $23.07 |
| 2026-07-12 | $25.47 |
| 2026-07-13 | $24.48 |
| 2026-07-13 | $24.48 |
| 2026-07-13 | $25.10 |
| 2026-07-13 | $23.89 |
| 2026-07-14 | $23.89 |
| 2026-07-14 | $24.98 |
| 2026-07-14 | $24.98 |
| 2026-07-14 | $24.98 |
| 2026-07-15 | $23.21 |
| 2026-07-15 | $23.65 |
| 2026-07-15 | $24.62 |
| 2026-07-15 | $23.01 |
| 2026-07-16 | $23.01 |
| 2026-07-16 | $23.01 |
| 2026-07-16 | $23.01 |
| 2026-07-16 | $23.90 |
| 2026-07-17 | $23.90 |
| 2026-07-17 | $23.90 |
| 2026-07-17 | $23.90 |
| 2026-07-17 | $24.93 |
| 2026-07-18 | $23.48 |
| 2026-07-18 | $26.69 |
| 2026-07-18 | $26.69 |
| 2026-07-18 | $25.28 |
| 2026-07-19 | $23.98 |
| 2026-07-19 | $23.98 |
| 2026-07-19 | $23.98 |
| 2026-07-19 | $23.98 |
| 2026-07-20 | $23.98 |
| 2026-07-20 | $23.98 |
| 2026-07-20 | $23.98 |
| 2026-07-20 | $23.98 |
| 2026-07-21 | $23.98 |
| 2026-07-21 | $23.98 |
| 2026-07-21 | $23.98 |
| 2026-07-21 | $22.06 |
| 2026-07-22 | $22.06 |
| 2026-07-22 | $22.06 |
| 2026-07-22 | $22.06 |
| 2026-07-22 | $23.37 |
| 2026-07-23 | $23.37 |
| 2026-07-23 | $23.37 |
| 2026-07-23 | $23.37 |
| 2026-07-23 | $23.37 |
| 2026-07-24 | $23.37 |
| 2026-07-24 | $23.37 |
| 2026-07-24 | $24.99 |
| 2026-07-24 | $24.99 |
| 2026-07-25 | $24.99 |
| 2026-07-25 | $24.99 |
| 2026-07-25 | $24.99 |
| 2026-07-25 | $24.99 |
| 2026-07-26 | $24.99 |
| 2026-07-26 | $24.99 |
| 2026-07-26 | $22.99 |
| 2026-07-26 | $22.99 |
| 2026-07-27 | $22.99 |
| 2026-07-27 | $22.99 |
| 2026-07-27 | $22.99 |
| 2026-07-27 | $21.15 |
| 2026-07-28 | $21.15 |
| 2026-07-28 | $21.15 |
| 2026-07-28 | $21.15 |
| 2026-07-28 | $21.15 |
| 2026-07-29 | $21.15 |
| 2026-07-29 | $21.15 |
| 2026-07-29 | $21.15 |
| 2026-07-29 | $20.90 |
| 2026-07-30 | $20.90 |
| 2026-07-30 | $20.90 |
| 2026-07-30 | $20.90 |
| 2026-07-30 | $19.47 |
| 2026-07-31 | $19.47 |
| 2026-07-31 | $19.47 |
| 2026-07-31 | $19.47 |
| 2026-07-31 | $19.47 |
| 2026-08-01 | $19.47 |
| 2026-08-01 | $19.47 |
| 2026-08-01 | $19.47 |
| 2026-08-01 | $19.47 |
| 2026-08-02 | $19.47 |
| 2026-08-02 | $19.47 |
| 2026-08-02 | $19.47 |
| 2026-08-02 | $19.47 |
| 2026-08-03 | $19.89 |
| 2026-08-03 | $19.89 |
| 2026-08-03 | $19.88 |
| 2026-08-03 | $19.88 |
| 2026-08-04 | $19.49 |
| 2026-08-04 | $19.49 |
| 2026-08-04 | $17.51 |
| 2026-08-04 | $17.51 |
| 2026-08-05 | $16.48 |
| 2026-08-05 | $16.48 |
| 2026-08-05 | $16.48 |
| 2026-08-05 | $18.19 |
| 2026-08-06 | $18.92 |
| 2026-08-06 | $18.92 |
| 2026-08-06 | $18.92 |
| 2026-08-06 | $19.75 |
| 2026-08-07 | $20.95 |
| 2026-08-07 | $20.95 |
| 2026-08-07 | $20.93 |
| 2026-08-07 | $20.93 |
| 2026-08-08 | $20.90 |
| 2026-08-08 | $20.90 |
| 2026-08-08 | $21.81 |
| 2026-08-08 | $21.81 |
| 2026-08-09 | $21.44 |
| 2026-08-09 | $21.44 |
| 2026-08-09 | $21.44 |
| 2026-08-09 | $21.44 |
| 2026-08-10 | $18.91 |
| 2026-08-10 | $18.91 |
| 2026-08-10 | $18.91 |
| 2026-08-10 | $18.91 |
| 2026-08-11 | $17.60 |
| 2026-08-11 | $17.60 |
| 2026-08-11 | $17.60 |
| 2026-08-11 | $17.60 |
| 2026-08-12 | $18.55 |
| 2026-08-12 | $18.55 |
| 2026-08-12 | $19.61 |
| 2026-08-12 | $19.61 |
