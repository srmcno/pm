# Desk evidence

Generated 2026-09-02 16:02 UTC

Walk-forward figures are out-of-sample with fixed parameters over 5 windows (the first trains only, so one fewer
is scored), each desk replayed at its own capital floor with every cost
charged. The `declared` column is the desk author's
verdict, which may be stricter than the statistic; the allocator funds a
desk only when both agree and this record is under 30 days old, and funds
a `marginal` desk only when it is named explicitly in `data/desk/config.json`.

| desk | statistic | declared | OOS Sharpe | OOS CAGR | max DD | p | benchmark Sharpe | replayed at | floor |
|---|---|---|---|---|---|---|---|---|---|
| kalshi-bias | no-data | rejected | — | —% | —% | — | — | $100 | $25 |
| overnight | validated | validated | 0.747 | 5.976% | -16.781% | 0.03477 | 0.938 | $2,000 | $2,000 |
| reversion | validated | marginal | 0.726 | 10.111% | -26.487% | 0.04017 | 0.725 | $500 | $500 |
| trend | validated | validated | 0.941 | 24.196% | -28.553% | 0.08745 | 0.705 | $100 | $100 |
| xsect | not-significant | marginal | 0.502 | 8.365% | -33.213% | 0.1559 | 0.753 | $100 | $100 |
