import test from "node:test";
import assert from "node:assert/strict";
import {
  matchingIdentity,
  evaluatePair,
} from "../dashboard/prediction-arbitrage.mjs";
import { studyOutcomes } from "../dashboard/prediction-study.mjs";
import {
  liquidation,
  fill,
  newAccount,
  observe,
  forecast,
  PREDICTION_VERSION,
  planBet,
} from "../dashboard/prediction-core.mjs";
import {
  polymarketIdentity,
  kalshiIdentity,
} from "../scripts/predictions/arbitrage.mjs";
import { normalizeKalshi } from "../dashboard/prediction-venues.mjs";
const now = 1789330000;
const identity = () => ({
  kind: "full-game-moneyline",
  provider: "sportradar",
  league: "nfl",
  participants: ["provider-team-a", "provider-team-b"],
  yesId: "provider-team-a",
  startAt: now + 86400,
  title: "A vs B",
});
const market = (venue) => ({
  id: venue + ":game",
  venue,
  venueId: "game",
  eventId: "event",
  seriesId: "series",
  question: "A wins",
  identity: identity(),
  status: "open",
  rules: "Official contract rules",
  quoteAt: now,
  observedAt: now,
  closeAt: now + 86400,
  minQuantity: 1,
  feeRate: 0.07,
  sides: {
    yes: { bid: 0.39, bidSize: 20, bids: [[0.39, 20]], asks: [[0.4, 20]] },
    no: { bid: 0.59, bidSize: 20, bids: [[0.59, 20]], asks: [[0.6, 20]] },
  },
});
const accounts = () =>
  Object.fromEntries(
    ["polymarket", "kalshi"].map((v) => [v, newAccount(v, now)]),
  );
test("identity requires two distinct named provider IDs on both sides and the same scheduled start", () => {
  const a = identity(),
    b = identity();
  assert.equal(matchingIdentity(a, b), true);
  for (const bad of [
    { participants: [...b.participants, "extra-team-c"] },
    { participants: ["provider-team-a", "provider-team-a"] },
    { startAt: b.startAt + 60 },
    { yesId: "another-team" },
    { provider: "unknown" },
  ])
    assert.equal(matchingIdentity(a, { ...b, ...bad }), false);
});
test("both Kalshi team strikes are comparable without assuming array outcome order", () => {
  const a = market("polymarket"),
    b = market("kalshi");
  b.identity.yesId = "provider-team-b";
  b.sides.yes.asks = [[0.4, 10]];
  const p = evaluatePair(a, b, accounts(), now);
  assert.deepEqual(
    p.best.legs.map((l) => l.side),
    ["yes", "yes"],
  );
  assert.ok(p.best.normalNet > 0);
  assert.equal(p.executable, false);
  assert.equal(p.isArbitrage, false);
  assert.equal(p.settlement.minimumPayoutPerContract, 0);
  assert.equal(p.worstCaseNet, -p.best.cost);
});
test("a 98 cent package loses after actual modeled fees and both slippage charges", () => {
  const a = market("polymarket"),
    b = market("kalshi");
  a.feeRate = 0.06;
  b.feeRate = 0.035;
  a.sides.yes.asks = [[0.51, 1]];
  a.sides.no.asks = [];
  b.sides.no.asks = [[0.47, 1]];
  const p = evaluatePair(a, b, accounts(), now);
  assert.equal(p.best.principal, 0.98);
  assert.equal(p.best.fees, 0.03);
  assert.equal(p.best.slippage, 0.02);
  assert.equal(p.best.cost, 1.03);
  assert.equal(p.best.normalNet, -0.03);
  assert.equal(p.status, "costs-exceed-payout");
});
test("cash and depth cannot be borrowed across venues or from a missing balance", () => {
  const a = market("polymarket"),
    b = market("kalshi");
  for (const balances of [
    {},
    { ...accounts(), kalshi: { ...accounts().kalshi, cash: 0 } },
  ]) {
    const p = evaluatePair(a, b, balances, now);
    assert.equal(p.best, null);
    assert.equal(p.executable, false);
  }
  b.sides.no.asks = [[0.6, 0.5]];
  b.sides.yes.asks = [];
  assert.equal(evaluatePair(a, b, accounts(), now).best, null);
  const p = evaluatePair(a, market("kalshi"), accounts(), now);
  assert.ok(p.best.legs.every((l) => l.cost <= 2));
});
test("missing rules and stale, future or skewed book receipts are held", () => {
  for (const change of [
    { rules: "" },
    { quoteAt: now - 31 },
    { observedAt: now + 3 },
    { observedAt: now - 3 },
    { feeRate: null },
  ]) {
    const p = evaluatePair(
      market("polymarket"),
      { ...market("kalshi"), ...change },
      accounts(),
      now,
    );
    assert.equal(p.status, "held");
    assert.equal(p.fresh, false);
  }
  const p = evaluatePair(
    market("polymarket"),
    market("kalshi"),
    accounts(),
    now + 120,
  );
  assert.equal(p.status, "held");
});
test("liquidation traverses all bid depth with independently worked fees", () => {
  // 2 @ .60 + 1 @ .50 = 1.70, minus .04+.02 fees and .03 slippage.
  assert.deepEqual(
    liquidation(
      [
        [0.6, 2],
        [0.5, 2],
      ],
      3,
      0.07,
    ),
    { quantity: 3, proceeds: 1.61, fees: 0.06, slippage: 0.03 },
  );
  assert.equal(liquidation([[0.6, 2]], 3, 0.07), null);
  const m = market("kalshi");
  m.sides.yes.bidSize = 1;
  m.sides.yes.bids = [
    [0.39, 1],
    [0.38, 10],
  ];
  const plan = planBet(
    m,
    "yes",
    { eligible: true, probability: 0.8, lower: 0.7, upper: 0.9 },
    newAccount("kalshi", now),
    now,
  );
  assert.equal(plan.status, "candidate");
  assert.ok(plan.fill.quantity > 1);
});
test("learning records an event once per horizon but never repeatedly within one horizon", () => {
  const m = market("kalshi");
  m.closeAt = now + 2 * 86400;
  const first = observe([m], [], now);
  assert.equal(first.length, 1);
  const later = { ...m, observedAt: now + 600, quoteAt: now + 600 };
  assert.equal(observe([later], first, now + 600).length, 1);
  const next = { ...m, observedAt: now + 86400, quoteAt: now + 86400 };
  const crossed = observe([next], first, now + 86400);
  assert.equal(crossed.length, 2);
  assert.notEqual(crossed[0].cohort, crossed[1].cohort);
  assert.equal(crossed[1].observationPolicy, "one-event-per-horizon-v1");
});
test("outcome overview deduplicates events and excludes future, fractional and earlier-model labels", () => {
  const row = {
    version: PREDICTION_VERSION,
    venue: "kalshi",
    eventId: "a",
    cohort: "c",
    at: now - 100,
    baseline: 0.25,
    resolvedAt: now - 10,
    payout: 1,
  };
  const data = [
    row,
    { ...row, cohort: "d", at: now - 50, baseline: 0.75 },
    { ...row, eventId: "future", resolvedAt: now + 1 },
    { ...row, eventId: "fraction", payout: 0.5 },
    { ...row, eventId: "old", version: "old" },
  ];
  const s = studyOutcomes(data, now).venues.find((v) => v.venue === "kalshi");
  assert.equal(s.resolvedEvents, 1);
  assert.equal(s.cohorts, 2);
  assert.equal(s.bins[2].events, 1);
  assert.equal(s.bins[7].events, 0);
  assert.equal(s.bins[2].yesOutcomes, 1);
  assert.ok(s.bins[2].lower < 0.2);
});
test("Polymarket identity follows explicit long team, not the outcomes array", () => {
  const side = (long, name) => ({
    long,
    team: {
      name,
      league: "nfl",
      providerIds: [
        {
          provider: "PROVIDER_SPORTRADAR",
          providerId: "provider-team-" + name,
        },
      ],
    },
  });
  const raw = {
    sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE",
    gameStartTime: new Date((now + 86400) * 1000).toISOString(),
    outcomes: ["B", "A"],
    marketSides: [side(false, "B"), side(true, "A")],
  };
  assert.equal(polymarketIdentity(raw).yesId, "provider-team-A");
  assert.equal(
    polymarketIdentity({ ...raw, sportsMarketTypeV2: "SPREAD" }),
    null,
  );
});
test("Kalshi game entry time comes from the matching milestone, never estimated end", () => {
  const raw = {
      ticker: "KXNFLGAME-X-A",
      event_ticker: "KXNFLGAME-X",
      status: "active",
      notional_value_dollars: "1.0000",
      market_type: "binary",
      close_time: new Date((now + 90000) * 1000).toISOString(),
    },
    event = { series_ticker: "KXNFLGAME" },
    series = { fee_type: "quadratic", fee_multiplier: 1 },
    book = {
      orderbook_fp: { yes_dollars: [[".4", "10"]], no_dollars: [[".5", "10"]] },
    };
  const ms = {
    start_date: new Date((now + 86400) * 1000).toISOString(),
    details: { main_game_event_ticker: raw.event_ticker },
  };
  assert.equal(
    normalizeKalshi(raw, event, series, [], book, now, ms).closeAt,
    now + 86400,
  );
  assert.equal(
    normalizeKalshi(raw, event, series, [], book, now).closeAt,
    null,
  );
});

test("public GET retries transient failures once, without retrying missing contracts", async () => {
  const { get } = await import("../scripts/predictions/venues.mjs");
  let attempts = 0;
  const result = await get("https://example.com/book", async () => {
    attempts++;
    return attempts === 1
      ? new Response("", { status: 503 })
      : new Response('{"book":true}');
  });
  assert.deepEqual(result, { book: true });
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(
    get("https://example.com/missing", async () => {
      attempts++;
      return new Response("", { status: 404 });
    }),
    /HTTP 404/,
  );
  assert.equal(attempts, 1);
});

test("valid discovery pages survive a malformed later response from either venue", async (t) => {
  const { discoverPolymarket, discoverKalshi } =
    await import("../scripts/predictions/venues.mjs");
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url);
    let data;
    if (u.hostname === "gateway.polymarket.us") {
      data = u.searchParams.has("tagSlug")
        ? { events: [] }
        : u.searchParams.get("offset") === "0"
          ? {
              events: Array.from({ length: 100 }, (_, i) => ({
                id: "e" + i,
                markets: i ? [] : [{ slug: "valid", closed: false }],
              })),
            }
          : { error: "invalid page" };
    } else
      data = u.searchParams.has("cursor")
        ? { error: "invalid page" }
        : {
            markets: [
              {
                ticker: "valid",
                market_type: "binary",
                notional_value_dollars: "1.0000",
              },
            ],
            cursor: "next",
          };
    return new Response(JSON.stringify(data));
  });
  for (const discover of [discoverPolymarket, discoverKalshi]) {
    const result = await discover();
    assert.equal(result.rows.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Invalid/);
  }
});
