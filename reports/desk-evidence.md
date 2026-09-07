# Desk evidence

Generated 2026-09-07 12:55 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.825 | 6.621% | -17.155% | 0.01986 | 0.943 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.748 | 10.466% | -26.487% | 0.03486 | 0.725 | $500 | $500 |
| trend | validated | marginal | 1.034 | 27.389% | -26.565% | 0.06079 | 0.662 | $100 | $100 |
| xsect | not-significant | marginal | 0.542 | 9.229% | -33.212% | 0.12577 | 0.754 | $100 | $100 |
