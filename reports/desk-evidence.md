# Desk evidence

Generated 2026-09-02 14:57 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 folds, each desk replayed at its own capital
floor with every cost charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree, and funds a `marginal` desk only when it is
named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25.0 |
| overnight | validated | validated | 0.748 | 6.005% | -16.781% | 0.03469 | 0.939 | $2,000 | $2000.0 |
| reversion | validated | marginal | 0.728 | 10.074% | -26.487% | 0.03998 | 0.725 | $500 | $500.0 |
| trend | validated | validated | 0.952 | 24.472% | -28.381% | 0.08435 | 0.705 | $100 | $100.0 |
| xsect | not-significant | marginal | 0.503 | 8.474% | -33.213% | 0.15532 | 0.754 | $100 | $100.0 |
