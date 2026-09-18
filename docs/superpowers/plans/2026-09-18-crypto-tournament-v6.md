# Crypto Tournament v6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved dynamic 40-market, eight-strategy, cost-aware crypto paper tournament without altering existing ledger history.

**Architecture:** Split universe discovery/cost metadata into the public feed and keep deterministic signal/accounting logic in `crypto-strategies-core.mjs`. State migrates once from v1 to v2 and remains authoritative. UI renders the published snapshot only.

**Tech Stack:** Node 22 ES modules, static HTML/CSS/JS, GitHub Actions, Coinbase public Exchange REST data.

**Spec:** `docs/superpowers/specs/2026-09-18-crypto-tournament-v6-design.md`

## Global Constraints
- Real orders remain disabled.
- Preserve existing rotation/recovery ledger values exactly through migration.
- Use Coinbase Advanced U.S. entry-level maker 0.50% / taker 0.90% profile dated 2026-09-16; active fills use taker.
- Actual bid/ask depth and 0.10% extra slippage reserve apply on both sides.
- Never fabricate missing fills or rejuvenate stale timestamps.
- Retired strategies cannot restart.

---

### Task 1: Fee profile, v2 state, and migration
**Files:** `tests/crypto-strategies.test.mjs`, `dashboard/crypto-strategies-core.mjs`
**Interfaces:** Produce `FEE_PROFILE`, `CRYPTO_VERSION`, `migrateCompetition(previous, now)`, expanded `STRATEGIES`.
- [ ] Add failing tests for fee profile, eight accounts, and exact v1 ledger migration.
- [ ] Run targeted tests and confirm expected failures.
- [ ] Implement v2 profile/state migration while accepting old position versions.
- [ ] Run targeted tests to green.

### Task 2: Eight strategy signals and after-cost plans
**Files:** `tests/crypto-strategies.test.mjs`, `dashboard/crypto-strategies-core.mjs`
**Interfaces:** `evaluateUniverse(markets, now)` emits decisions for all eight strategies; `advanceCompetition` opens only qualifying after-cost candidates.
- [ ] Add failing deterministic tests for six new strategy families and fee rejection.
- [ ] Verify red.
- [ ] Implement completed-bar features, breadth features, strategy conditions, stops/targets, and taker-cost sizing.
- [ ] Verify green and existing accounting tests.

### Task 3: Dynamic product discovery and top-40 selection
**Files:** `tests/crypto-strategies.test.mjs`, `scripts/crypto-feed.mjs`, `scripts/collect-crypto-strategies.mjs`
**Interfaces:** `collectCoinbaseMarkets({cached, requiredProducts,...})` returns `{markets, errors, universe}`.
- [ ] Add failing mocked-adapter tests for discovery, stablecoin exclusion, ranking, 40-market cap, GET-only behavior, and required open-position retention.
- [ ] Verify red.
- [ ] Implement product-list discovery, stats pre-ranking, bounded depth/history collection, final ranking, and required-product retention.
- [ ] Verify green.

### Task 4: Snapshot, collector continuity, and current state
**Files:** `scripts/collect-crypto-strategies.mjs`, `.github/workflows/opportunities.yml`, `scripts/build-site.mjs`
**Interfaces:** Published snapshot includes fee profile, universe metrics, strategies, accounts, decisions, and feed cache.
- [ ] Add collection assertions to targeted tests where practical.
- [ ] Update collector migration, required products, notes, snapshot, and workflow paths.
- [ ] Ensure build publishes crypto snapshot and new source modules.
- [ ] Run targeted tests.

### Task 5: Tournament UI and main-page summary
**Files:** `dashboard/crypto.html`, `dashboard/crypto-strategies-ui.mjs`, `dashboard/crypto-strategies.css`, `dashboard/focus.html`, `dashboard/focus.mjs`, `dashboard/focus.css`, `tests/focus.test.mjs`
**Interfaces:** Crypto page renders 8 cards and dynamic account filters; home page renders compact crypto summary.
- [ ] Add failing HTML/model tests for eight dynamic strategy labels, fee disclosure, universe count, and home summary container.
- [ ] Verify red.
- [ ] Implement responsive tournament board, fee details, activity cost attribution, and home summary.
- [ ] Verify green.

### Task 6: Documentation and full verification
**Files:** `README.md`, `docs/CRYPTO-STRATEGIES.md`, `docs/SITES.md`, `package.json`
- [ ] Update version and current operating documentation without rewriting historical results.
- [ ] Run `npm test` and confirm zero failures.
- [ ] Run both Python suites and `python3 scripts/check_site.py`.
- [ ] Run `npm run build` and inspect output.
- [ ] Run live collector locally or in GitHub Actions and validate resulting state.
- [ ] Inspect 390px and desktop pages for overflow/content issues.
- [ ] Publish source to default branch, verify CI and GitHub Pages, then verify the public build/version.
