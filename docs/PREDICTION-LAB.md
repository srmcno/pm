# Prediction Lab: pre-registered paper shadow books

**Shadow experiments. Paper only. No real orders. Not the two $100 accounts.**

Lab version `2026-09-29-prediction-lab-v1`. Promotion screen `2026-09-29-screen-v1`. These rules were registered in code (`dashboard/prediction-lab-core.mjs`) and here before any book ran.

## Why the Lab exists

An audit of the two existing paper accounts on September 29, 2026 found no evidence of an edge. You can reproduce it with `node scripts/analyze-predictions.mjs`, which only reads the state file.

- **Polymarket US:** 14 settled trades, 4 wins against 7.0 expected at entry midpoints. The claimed edge of about +8¢ per contract realized about −25¢. The account is permanently halted by its 10% drawdown rule.
- **Kalshi:** about +$10 over 69 trades. One trade supplied about $6 of that, and the per-trade t statistic is under 1.
- **Walk-forward:** the experimental estimator's Brier score is worse than the plain market midpoint on both venues.
- **Polymarket freshness:** the existing freshness check uses the venue's last book-change time. Books that were fetched seconds earlier can therefore fail as "older than 90 seconds".

The Lab tests the few hypotheses with any positive raw signal. It also adds a cost-drag control and a shadow of the existing Polymarket policy that can keep producing evidence. Raw signals came from correlated, mostly single-weekend samples, so every book is treated as unproven.

## Relationship to the existing accounts

The Lab runs **beside, never inside,** the two $100 accounts. It reads `dashboard/data/predictions.json` and `data/predictions/state.json` as read-only inputs: their observed books, source times, calibration observations and verified settlements. It never writes, migrates or resets those files, their ledgers or their policy. Its own state is `data/prediction-lab/state.json`, and its public snapshot is `dashboard/data/prediction-lab.json`. The first scheduled run creates both files.

## Invariants for every book

- Each book is its own $100 paper account per venue it trades. The account starts at the book's first scheduled run. Nothing is backfilled.
- **Costs are the existing paper cost model, unchanged.** Fills walk the displayed ask depth (taker at the observed ask). Fees are rounded up to a cent per fill, plus 1¢ per contract slippage. The same `fill`, `fee` and `liquidation` functions are called. Equity is marked at conservative liquidation value. Settlement uses the existing `advanceAccount` arithmetic, which reconciles cash.
- An entry needs:
  - a book retrieved by the Lab within **90 seconds of the decision, measured from retrieval time** (the venue book time is recorded too);
  - complete rules, event identity and current fees;
  - displayed depth for both the order and a matching liquidation;
  - whole contracts, with a modeled all-in cost per contract below $1.00.
- **One position per event.** Kalshi sports markets whose event tickers share a game suffix (for example `KXNFLTD-26OCT04TENBAL` and `KXNFL1Q-26OCT04TENBAL`) are one event, and the tightest-spread qualifying market is chosen. A settled event is never re-entered.
- Positions hold to official settlement. The Lab has no stop, forced exit, maker fill, order intent, credential or authenticated call.
- **Explicit source-error states.** A missing snapshot, a snapshot older than 20 minutes, or a venue reported as failed by the existing collector each stops new entries, with the reason recorded. Settlement and marks still proceed. A failed mark keeps the last valid mark with its original time and is shown as stale.
- Entries come only from the existing collector's bounded sample, about 36 to 42 books per venue per cycle. This is not an exchange-wide scan.

## The books, as built

| id | version | role | canonical rule SHA-256 |
|---|---|---|---|
| `kalshi-favorite-3-7d` | 1 | candidate | `43ecd92da41470660c47be8cd8fdcb03336b724bcdbabdb8ad9028beac4ab2b1` |
| `kalshi-yes-60-80` | 1 | candidate | `2b1a71f67c60af6bd71871d111016729965db8d806acd347066aa7968ecfabe3` |
| `market-baseline` | 1 | control | `c78e35606d8125c62b22390c4e35969fdbfc6cee0cdeef1fc1827ea44c24a8d8` |
| `polymarket-fresh` | 1 | shadow | `7d6900aec038ce27bb58298d26f337bd0bd721112fd4ffcd313bb4777c81a278` |

Each hash is computed from `canonicalRule(book)`: the id, version, role, venues, rule text and parameters. `tests/prediction-lab.test.mjs` pins these values. The first run stores the canonical rule in state, and any later mismatch stops that book with an explicit `frozen-rule` error. **A changed parameter or reworded rule needs a new book id.**

1. **`kalshi-favorite-3-7d`**
   - **Window:** Kalshi markets closing in 72–168 hours, inclusive.
   - **Side:** the favored side (YES or NO) when its midpoint is 0.55–0.85.
   - **Rejects:** spreads over 5¢.
   - **Size:** a flat stake of 2% of book equity in whole contracts, with at most 20% of equity open.
   - **Exit:** hold to settlement.
2. **`kalshi-yes-60-80`**
   - **Window:** closing in 24–336 hours.
   - **Side:** YES only, with a YES midpoint of 0.60–0.80.
   - **Rejects:** spreads over 4¢.
   - **Size:** a flat stake of 1%, with at most 10% open.
   - **Exit:** hold to settlement.
3. **`market-baseline`** is a control and never a promotion candidate.
   - **Venues:** Kalshi and Polymarket US, each in its own $100 account.
   - **Side:** the favored side when its midpoint is above 0.90.
   - **Window:** more than 6 hours to close, up to 30 days.
   - **Rejects:** spreads over 5¢.
   - **Size:** a target stake of 0.5% of equity. When that is less than one contract, the stake rounds up to one contract, provided the contract costs at most 1.5% of equity. At most 10% open.
   - **Exit:** hold to settlement.
   - **Purpose:** to measure pure cost drag on well-calibrated favorites.
4. **`polymarket-fresh`** is a shadow of the existing policy `2026-09-16-experimental-paper-v1`, not a change to it.
   - **Same functions:** it calls the same `entryForecast`, `entryPlan` and `advanceAccount` on Polymarket US in a separate $100 account. That includes the two-scan rule, 2% per idea, 10% exposure, quarter Kelly and the 3¢ edge after costs.
   - **Difference 1, freshness:** book freshness is measured from retrieval time.
   - **Difference 2, drawdown:** the permanent 10% drawdown halt becomes a resettable pause. Entries resume only after both of these hold:
     - 7 days have passed;
     - at least 20 shadow forecasts recorded after the pause began have resolved, one per event and horizon, with a mean Brier score no worse than the market midpoint on the same events.
     Peak equity then resets to current equity.
   - **Pinned policy:** the shadow pins the existing policy's constants. If that policy changes, the shadow stops with an explicit error and must be re-registered under a new id.
   - **Why a shadow:** replicating the policy required no copied logic, so the fallback (running the favorite rule on Polymarket series) was not needed.

## Evidence and the predeclared promotion screen

For each account, the snapshot reports:

- entries, with retrieval time and venue book time;
- modeled fees and slippage;
- settlements and realized P&L after costs;
- breakdowns by sport and by series;
- the Brier score and log loss of the entry midpoint on the book's own picks, plus the shadow model's score for `polymarket-fresh`;
- an evidence status such as `n=12 settled of 50 needed; not evidence yet.`

The promotion screen has six criteria:

1. At least **50 settled events**.
2. The events fall in at least **3 distinct UTC weeks** (Monday to Sunday, by scheduled close).
3. Net P&L after modeled costs is **positive**.
4. Net P&L is still positive with fees and slippage **+50%**.
5. Net P&L is still positive **without the best single event**.
6. Net P&L is still positive **without the best single sport**.

Profit criteria are not assessed until the first two are met. Passing the screen is a paper result only. It is never presented as an edge, and it does not authorize real orders. The control book is never promoted.

## Operation and verification

`.github/workflows/predictions.yml` runs `node --test tests/prediction-lab.test.mjs tests/analyze-predictions.test.mjs`, then `node scripts/collect-prediction-lab.mjs`, then a separate publish commit. These run **after** the two accounts are published. Every Lab step uses `continue-on-error`, and a Lab problem only adds a workflow warning. The schedule is best effort, about every ten minutes, and the results are not continuous quotes.

For a dry run, `MM_PREDLAB_ROOT=<temp dir> MM_PREDLAB_SOURCE_ROOT=<repo> node scripts/collect-prediction-lab.mjs` writes only into the temp directory.

The overview page renders the Lab with `prediction-lab-ui.mjs` and `prediction-lab.css`, both on the build allowlist. A missing snapshot shows "not published yet" and invents nothing.
