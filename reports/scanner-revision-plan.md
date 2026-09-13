# Entry revision declared before replay

Model `2026-09-13-scanner-v3` changes entry selection only. This is a single fixed revision motivated by the v2 stop-heavy losing ledger, not a parameter search or a claim of an edge.

- Require EMA20 to rise over three completed hours and EMA50 over six completed hours, in addition to the existing EMA20 > EMA50 and price > EMA50 checks.
- Keep original trigger thresholds: close above the prior 20-hour high with 1.5x relative volume for Volume breakout; cross back above EMA20 with 1.1x volume for Trend reclaim.
- Require the next completed hourly candle to close above the trigger close and the relevant breakout/EMA level. For reclaim, its low must also stay above the trigger low.
- Keep stop and target anchored to the original trigger candle. Reject entries beyond the existing 0.75 ATR chase allowance from that trigger. Recheck the confirmed level using the current bid.
- Keep two scheduled scan confirmations, all fees, slippage, sizing, drawdown/daily limits, fixed stops/targets and 48-hour exits unchanged. Existing positions retain their stored rules. New signal IDs include the model version so v2 pending signals cannot confirm v3 entries.

Compare both individual strategies, combined, higher costs and three chronological slices using the same preserved June 10 through September 8 input. No parameter tuning after seeing these results. This is reused history, not an untouched holdout. Preserve the v2 input, model and reports. Revised entries remain governed by the existing outcome-evidence checks.
