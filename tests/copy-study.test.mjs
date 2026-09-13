import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COPY_RULES,
  rankCopyWallets,
  parseCopyTrade,
  buildCopyCandidates,
  copyFee,
  priceCopyEntry,
  copyResolutionPayout,
  createCopyStudy,
  advanceCopyStudy,
  validateCopyStudyState,
} from "../scripts/copy-study-core.mjs";
import {
  collectCopyActivity,
  normalizeCopyMarket,
  normalizeCopyBook,
  copyStudySnapshot,
} from "../scripts/collect-copy-study.mjs";
import { validCopyStudy } from "../dashboard/copy-core.mjs";
const at = 1789000000,
  cond = "0x" + "a".repeat(64),
  address = (n) => "0x" + String(n).padStart(40, "0");
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const cohort = [1, 2, 3, 4].map((n) => ({
  wallet: address(n),
  name: "Wallet " + n,
  score: 80,
  medianTradeUsd: 100,
}));
const activity = (n, props = {}) => ({
  id: String(n),
  wallet: address(n),
  condition: cond,
  token: "123",
  title: "Outcome",
  outcome: "Yes",
  eventSlug: "event",
  outcomeIndex: 0,
  eventAt: at - 300,
  firstObservedAt: at - 1,
  side: "BUY",
  price: 0.3,
  shares: 1000,
  usd: 300,
  ...props,
});
const candidate = () =>
  buildCopyCandidates(
    cohort.slice(0, 3).map((_, i) => activity(i + 1)),
    cohort,
    at,
  )[0];
const book = (time = at, more = {}) => ({
  token: "123",
  condition: cond,
  receivedAt: time,
  providerAt: time,
  bids: [[0.29, 1000]],
  asks: [[0.3, 1000]],
  ...more,
});
const market = {
  condition: cond,
  tokens: [
    { token: "123", index: 0, outcome: "Yes" },
    { token: "456", index: 1, outcome: "No" },
  ],
  fee: { r: 0.07, e: 1 },
  minShares: 5,
  tick: 0.01,
  accepting: true,
};
function state() {
  const s = createCopyStudy(
    JSON.parse(readFileSync(new URL("../data/analyzed.json", import.meta.url))),
    "a".repeat(64),
    at,
  );
  return s;
}
const observation = (time, more = {}) => ({
  at: time,
  complete: true,
  candidates: [candidate()],
  books: { 123: book(time) },
  markets: { [cond]: market },
  ...more,
});
function entered() {
  let s = advanceCopyStudy(state(), observation(at + 1));
  return advanceCopyStudy(s, observation(at + 62));
}
test("ranking measures shape rather than absolute dollars and reproduces the audited cohort", () => {
  const a = JSON.parse(
      readFileSync(new URL("../data/analyzed.json", import.meta.url)),
    ),
    r = rankCopyWallets(a);
  assert.equal(r.filter((w) => w.eligible).length, 52);
  assert.equal(r[0].name, "fildoro");
  close(r[0].score, 89.16451);
  const w = a.wallets.find((w) => w.wallet.toLowerCase() === r[0].wallet),
    scale = 10;
  const changed = {
    ...w,
    pnl90: w.pnl90 * scale,
    maxDrawdown90: w.maxDrawdown90 * scale,
    volume90: w.volume90 * scale,
    medianTradeUsd: w.medianTradeUsd * scale,
    pnlDaily: w.pnlDaily.map((p) => ({ ...p, p: p.p * scale })),
  };
  close(rankCopyWallets({ wallets: [changed] })[0].score, r[0].score);
  assert.equal(
    rankCopyWallets({ wallets: [{ ...w, truncated: true }] })[0].eligible,
    false,
  );
});
test("trade principal is separate from V2 fee-inclusive reported cash", () => {
  const raw = {
    proxy_wallet: address(1),
    type: "TRADE",
    condition_id: cond,
    transaction_hash: "0x" + "1".repeat(64),
    token_id: "123",
    timestamp: at - 1,
    size: 160,
    price: 0.4,
    usdc_size: 65.92,
    side: "BUY",
    title: "Market",
    outcome: "Yes",
    outcome_index: 0,
  };
  const t = parseCopyTrade(raw, address(1), at, at - 100, at);
  close(t.usd, 64);
  close(t.reportedCash, 65.92);
  for (const change of [
    { proxy_wallet: address(2) },
    { price: NaN },
    { usdc_size: 10000 },
    { timestamp: at + 3 },
    { token_id: "bad" },
    { is_combo: true },
  ])
    assert.equal(
      parseCopyTrade({ ...raw, ...change }, address(1), at, at - 100, at),
      null,
    );
});
test("cursor pages retain all same-second trades and identical fixed filters; repeated cursors fail", async () => {
  const raw = {
    proxy_wallet: address(1),
    type: "TRADE",
    condition_id: cond,
    transaction_hash: "0x" + "1".repeat(64),
    token_id: "123",
    timestamp: at - 1,
    size: 100,
    price: 0.3,
    usdc_size: 30,
    side: "BUY",
    title: "M",
    outcome: "Yes",
  };
  const urls = [];
  const result = await collectCopyActivity(
    address(1),
    at - 100,
    at,
    async (url) => {
      urls.push(new URL(url));
      return urls.length === 1
        ? { data: [raw], pagination: { has_more: true, next_cursor: "opaque" } }
        : {
            data: [raw, { ...raw, token_id: "456" }],
            pagination: { has_more: false, next_cursor: null },
          };
    },
  );
  assert.equal(result.trades.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(urls[1].searchParams.get("cursor"), "opaque");
  for (const k of ["start", "end", "limit", "sort_by", "user"])
    assert.equal(urls[0].searchParams.get(k), urls[1].searchParams.get(k));
  await assert.rejects(
    () =>
      collectCopyActivity(address(1), at - 100, at, async () => ({
        data: [raw],
        pagination: { has_more: true, next_cursor: "same" },
      })),
    /repeated/,
  );
});
test("share-weighted VWAP: equal dollars at .2 and .8 produce .32, never .50", () => {
  const trades = cohort
    .slice(0, 3)
    .flatMap((w, i) => [
      activity(i + 1, { id: i + "a", price: 0.2, shares: 500, usd: 100 }),
      activity(i + 1, { id: i + "b", price: 0.8, shares: 125, usd: 100 }),
    ]);
  const c = buildCopyCandidates(trades, cohort, at)[0];
  close(c.avgEntry, 0.32);
  assert.equal(c.backerCount, 3);
  close(c.effectiveBackers, 3);
});
test("sold and hedged shares do not dominate entry reference or rejuvenate buy recency", () => {
  const trades = [
    activity(1, {
      id: "big",
      price: 0.9,
      shares: 10000,
      usd: 9000,
      eventAt: at - 18000,
    }),
    activity(1, {
      id: "sold",
      side: "SELL",
      shares: 9980,
      usd: 8982,
      eventAt: at - 1,
    }),
    ...[2, 3, 4].map((i) => activity(i, { price: 0.1, shares: 100, usd: 10 })),
  ];
  const c = buildCopyCandidates(trades, cohort, at)[0];
  close(c.avgEntry, 0.15);
  assert.equal(
    c.backers.find((b) => b.wallet === address(1)).lastTradeAt,
    at - 18000,
  );
  const hedged = buildCopyCandidates(
    [
      ...trades,
      activity(2, {
        id: "hedge",
        token: "456",
        outcome: "No",
        price: 0.9,
        shares: 100,
        usd: 90,
      }),
    ],
    cohort,
    at,
  )[0];
  assert.ok(!hedged.backers.some((w) => w.wallet === address(2)));
});
test("fees use collateral, honor exponent, accept explicit zero and reject unknown values", () => {
  close(copyFee(100, 0.3, { r: 0.07, e: 1 }), 1.47);
  close(copyFee(100, 0.7, { r: 0.07, e: 1 }), 1.47);
  close(copyFee(100, 0.3, { r: 0.07, e: 2 }), 0.3087);
  assert.equal(copyFee(100, 0.3, { r: 0, e: 1 }), 0);
  assert.equal(copyFee(100, 0.3, { r: null, e: 1 }), null);
  assert.equal(copyFee(100, 0.3, null), null);
});
test("entry fee-inclusive sizing walks depth, caps participation and preserves full received shares", () => {
  const r = priceCopyEntry(candidate(), book(), market, 31.97, at);
  assert.deepEqual(r.reasons, []);
  close(r.fill.shares, 100);
  close(r.fill.fee, 1.47);
  close(r.fill.slippage, 0.5);
  close(r.fill.cash, 31.97);
  const tiny = priceCopyEntry(
    candidate(),
    book(at, { asks: [[0.3, 40]] }),
    market,
    100,
    at,
  );
  assert.ok(tiny.reasons.length);
  for (const b of [
    book(at - 31),
    book(at, { bids: [[0.1, 1000]] }),
    book(at, { asks: [[0.5, 1000]] }),
    book(at, { token: "999" }),
  ])
    assert.ok(priceCopyEntry(candidate(), b, market, 5, at).reasons.length);
});
test("token order is validated against Gamma; reversed CLOB order cannot reverse payout index", () => {
  const g = [
    {
      conditionId: cond,
      clobTokenIds: '["123","456"]',
      outcomes: '["Yes","No"]',
      closed: false,
      acceptingOrders: true,
      enableOrderBook: true,
    },
  ];
  const c = {
    c: cond,
    t: [
      { t: "456", o: "No" },
      { t: "123", o: "Yes" },
    ],
    fd: { r: 0.05, e: 1 },
    mos: 5,
    mts: 0.01,
    ao: true,
    cbos: true,
  };
  assert.equal(
    normalizeCopyMarket(cond, c, g).tokens.find((t) => t.token === "123").index,
    0,
  );
  assert.throws(
    () => normalizeCopyMarket(cond, c, [{ ...g[0], outcomes: '["No","Yes"]' }]),
    /mapping/,
  );
  const b = normalizeCopyBook(
    "123",
    cond,
    {
      asset_id: "123",
      market: cond,
      timestamp: String(at * 1000),
      asks: [
        { price: ".6", size: "5" },
        { price: ".3", size: "10" },
      ],
      bids: [],
    },
    at,
  );
  assert.deepEqual(b.asks[0], [0.3, 10]);
  assert.equal(b.providerAt, at);
});
const resolution = (payouts = [1e6, 0], more = {}) => ({
  condition_id: cond,
  status: "resolved",
  payouts,
  resolved_at: new Date((at + 100) * 1000).toISOString(),
  resolution_source: "reported",
  transaction_hash: "",
  ...more,
});
test("only official micro-unit final payouts settle, including split outcomes and empty transaction hashes", () => {
  const p = { condition: cond, outcomeIndex: 0, openedAt: at + 62 };
  for (const [payouts, v] of [
    [[1e6, 0], 1],
    [[0, 1e6], 0],
    [[5e5, 5e5], 0.5],
  ])
    close(copyResolutionPayout(p, resolution(payouts), at + 101).perShare, v);
  for (const r of [
    resolution([1, 0]),
    resolution([1e6, 0], { status: "posed" }),
    resolution([1e6, 0], { condition_id: "wrong" }),
    resolution([1e6, 0], {
      resolved_at: new Date((at - 1) * 1000).toISOString(),
    }),
  ])
    assert.equal(copyResolutionPayout(p, r, at + 101), null);
  assert.equal(
    copyResolutionPayout({ ...p, outcomeIndex: 999 }, resolution(), at + 101),
    null,
  );
});
test("two separated complete scans required, duplicate processing creates no extra entry", () => {
  const first = advanceCopyStudy(state(), observation(at + 1));
  assert.equal(first.positions.length, 0);
  const early = advanceCopyStudy(first, observation(at + 5));
  assert.equal(early.positions.length, 0);
  const s = advanceCopyStudy(first, observation(at + 62));
  assert.equal(s.positions.length, 1);
  assert.ok(s.cash >= 95);
  const again = advanceCopyStudy(s, observation(at + 63));
  assert.equal(again.positions.length, 1);
  close(s.cash, again.cash);
  assert.deepEqual(advanceCopyStudy(s, observation(at + 62)), s);
  assert.equal(validCopyStudy(copyStudySnapshot(s)), true);
});
test("partial coverage resets confirmation; incomplete books never become a new entry", () => {
  const first = advanceCopyStudy(state(), observation(at + 1));
  const failed = advanceCopyStudy(
    first,
    observation(at + 62, { complete: false }),
  );
  assert.equal(failed.positions.length, 0);
  const next = advanceCopyStudy(failed, observation(at + 130));
  assert.equal(next.positions.length, 0);
  assert.equal(
    advanceCopyStudy(first, observation(at + 62, { books: {} })).positions
      .length,
    0,
  );
});
test("cash, fees and settlement reconcile after restart; repeat resolution credits exactly once", () => {
  const s = entered(),
    p = s.positions[0],
    closed = advanceCopyStudy(
      JSON.parse(JSON.stringify(s)),
      observation(at + 101, {
        candidates: [],
        resolutions: { [cond]: resolution() },
      }),
    );
  assert.equal(closed.closed.length, 1);
  close(closed.cash, 100 - p.cost + p.shares);
  close(closed.equity, closed.cash);
  const repeat = advanceCopyStudy(
    closed,
    observation(at + 102, {
      candidates: [],
      resolutions: { [cond]: resolution() },
    }),
  );
  close(repeat.cash, closed.cash);
  assert.equal(repeat.closed.length, 1);
});
test("stale marks retain value with an explicit unavailable state and prevent new entries", () => {
  const s = entered();
  const next = advanceCopyStudy(s, observation(at + 101, { books: {} }));
  assert.equal(next.equityComplete, false);
  assert.equal(next.positions[0].markStatus, "unavailable");
  close(next.positions[0].value, s.positions[0].value);
});
test("corrupted account balances, rules and duplicate positions are rejected, never silently repaired", () => {
  const s = entered();
  for (const change of [
    { cash: 1000 },
    { equity: 1000 },
    { rules: { ...COPY_RULES, stake: 50 } },
    { positions: [...s.positions, ...s.positions] },
  ])
    assert.throws(
      () => advanceCopyStudy({ ...s, ...change }, observation(at + 101)),
      /Invalid copy study/,
    );
  assert.equal(validateCopyStudyState(s), true);
});
test("a resolution predating entry is quarantined and does not credit invented profit", () => {
  const s = entered(),
    next = advanceCopyStudy(
      s,
      observation(at + 101, {
        resolutions: {
          [cond]: resolution([1e6, 0], {
            resolved_at: new Date((at + 1) * 1000).toISOString(),
          }),
        },
      }),
    );
  close(next.cash, s.cash);
  assert.equal(next.closed.length, 0);
  assert.equal(next.equityComplete, false);
  assert.match(next.positions[0].markReason, /predates/);
});
test("a tiny recent buy does not rejuvenate a large old buy", () => {
  const original = [
    activity(1, { id: "old", eventAt: at - 18000, shares: 1000, usd: 300 }),
    ...cohort.slice(1, 3).map((_, i) => activity(i + 2)),
  ];
  const before = buildCopyCandidates(original, cohort, at)[0].backers.find(
    (w) => w.wallet === address(1),
  ).weight;
  const after = buildCopyCandidates(
    [
      ...original,
      activity(1, { id: "new", eventAt: at - 1, shares: 1, usd: 0.3 }),
    ],
    cohort,
    at,
  )[0].backers.find((w) => w.wallet === address(1)).weight;
  assert.ok(after / before < 1.01);
});
test("the drawdown stop is recomputed after a fill before processing another candidate", () => {
  let s = state();
  s.peakEquity = 124.875;
  // 100 equity is just above 80% of the recorded peak; one spread/fee loss crosses it.
  const one = candidate(),
    two = {
      ...candidate(),
      id: cond + "2:456",
      condition: "0x" + "b".repeat(64),
      token: "456",
      eventSlug: "second-event",
    };
  const opts = (time) =>
    observation(time, {
      candidates: [one, two],
      books: {
        123: book(time),
        456: book(time, { token: "456", condition: two.condition }),
      },
      markets: {
        [cond]: market,
        [two.condition]: {
          ...market,
          condition: two.condition,
          tokens: [
            { token: "456", index: 0, outcome: "Yes" },
            { token: "789", index: 1, outcome: "No" },
          ],
        },
      },
    });
  s = advanceCopyStudy(s, opts(at + 1));
  s = advanceCopyStudy(s, opts(at + 62));
  assert.equal(s.positions.length, 1);
  assert.equal(s.entryPaused, true);
  assert.ok(s.lastDecisions[1].reasons.includes("Drawdown stop is active"));
});

test("persisted payout indices are bound to the exact stored entry token and outcome", () => {
  const s = entered();
  s.positions[0].outcomeIndex = 1;
  assert.throws(
    () =>
      advanceCopyStudy(
        s,
        observation(at + 101, { resolutions: { [cond]: resolution() } }),
      ),
    /persisted outcome identity/,
  );
});

test("daily decision journals recover a state-before-journal interruption exactly once", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { syncCopyDecisions } =
    await import("../scripts/collect-copy-study.mjs");
  const folder = await mkdtemp(tmpdir() + "/mm-copy-journal-");
  try {
    const s = entered();
    await writeFile(folder + "/state.json", JSON.stringify(s));
    const resumed = JSON.parse(await readFile(folder + "/state.json", "utf8"));
    await syncCopyDecisions(folder + "/journal", resumed.decisions);
    await syncCopyDecisions(folder + "/journal", resumed.decisions);
    const date = new Date(s.decisions[0].at * 1000).toISOString().slice(0, 10),
      file = folder + "/journal/" + date + ".jsonl";
    const records = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(records.length, s.decisions.length);
    assert.equal(new Set(records.map((d) => d.id)).size, records.length);
    await writeFile(file + ".tmp", "incomplete write");
    await syncCopyDecisions(folder + "/journal", resumed.decisions);
    assert.equal(
      (await readFile(file, "utf8")).trim().split("\n").length,
      records.length,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
