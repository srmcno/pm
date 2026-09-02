# Desk evidence

Generated 2026-09-02 15:37 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.748 | 6.005% | -16.781% | 0.03469 | 0.939 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.728 | 10.074% | -26.487% | 0.03998 | 0.725 | $500 | $500 |
| trend | validated | validated | 0.95 | 24.401% | -28.381% | 0.08507 | 0.704 | $100 | $100 |
| xsect | not-significant | marginal | 0.503 | 8.474% | -33.213% | 0.15532 | 0.754 | $100 | $100 |
