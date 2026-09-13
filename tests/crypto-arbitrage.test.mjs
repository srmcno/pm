import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareCryptoBooks,
  priceCryptoTriangle,
  walkQuantity,
  validCryptoSnapshot,
} from "../dashboard/crypto-arbitrage-core.mjs";
import {
  verifyCryptoMarket,
  selectCryptoBook,
} from "../scripts/collect-crypto-arbitrage.mjs";
const now = 1700000000;
const book = (venue = "coinbase", more = {}) => ({
  venue,
  marketId: venue + ":BTCUSD",
  base: "BTC",
  quote: "USD",
  assetId: "bitcoin",
  receivedAt: now,
  providerAt: null,
  status: "online",
  fee: venue === "coinbase" ? 0.006 : 0.008,
  increment: 0.001,
  minQuantity: 0.001,
  minCost: 0.5,
  bids: [[99, 20]],
  asks: [[100, 20]],
  ...more,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test("same quantity, both quote fees and independently worked net result", () => {
  const r = compareCryptoBooks(
    book(),
    book("kraken", { bids: [[103, 20]], asks: [[104, 20]] }),
    { budget: 100.6, slippageBps: 0, now },
  );
  near(r.quantity, 1);
  near(r.buyPrincipal, 100);
  near(r.sellPrincipal, 103);
  near(r.buyFee, 0.6);
  near(r.sellFee, 0.824);
  near(r.net, 1.576);
  assert.equal(r.executable, false);
  assert.equal(r.fundingVerified, false);
});
test("depth impact is already in walked prices and not charged a second time", () => {
  const r = compareCryptoBooks(
    book("coinbase", {
      asks: [
        [100, 0.25],
        [101, 10],
      ],
    }),
    book("kraken", { bids: [[103, 10]], asks: [[104, 10]] }),
    { budget: 100.75 * 1.006, slippageBps: 0, now },
  );
  near(r.quantity, 1);
  near(r.depthImpact, 0.75);
  near(r.net, 103 - 100.75 - 100.75 * 0.006 - 103 * 0.008);
});
test("full requested depth is necessary on both legs", () => {
  assert.equal(walkQuantity([[100, 0.5]], 1), null);
  const r = compareCryptoBooks(
    book(),
    book("kraken", { bids: [[103, 0.05]], asks: [[104, 10]] }),
    { budget: 100, now },
  );
  assert.equal(r.status, "held");
  assert.equal(r.net, undefined);
});
test("old or invalid provider and receipt times, skew, fees and order minimums hold", () => {
  for (const changes of [
    { providerAt: now - 31 },
    { providerAt: now + 3 },
    { providerAt: NaN },
    { receivedAt: now - 31 },
    { receivedAt: now + 3 },
    { receivedAt: now - 6 },
    { fee: null },
    { minCost: -1 },
    { minQuantity: 2 },
    { status: "source-error" },
  ]) {
    const r = compareCryptoBooks(book("coinbase", changes), book("kraken"), {
      budget: 100,
      now,
    });
    assert.equal(r.status, "held", JSON.stringify(changes));
  }
  assert.equal(
    compareCryptoBooks(book(), book("kraken"), { now: NaN }).status,
    "held",
  );
});
test("symbols, canonical asset IDs and quote identity must match", () => {
  for (const changes of [
    { base: "ETH" },
    { assetId: "wrapped-bitcoin" },
    { quote: "USDT" },
    { venue: "coinbase" },
  ])
    assert.equal(
      compareCryptoBooks(book(), book("kraken", changes), { now }).status,
      "held",
    );
});
const triangle = () => [
  {
    book: book("kraken", {
      marketId: "kraken:BTCUSD",
      fee: 0,
      increment: 0.000001,
      bids: [[999, 10]],
      asks: [[1000, 10]],
    }),
    side: "buy",
  },
  {
    book: book("kraken", {
      marketId: "kraken:ETHXBT",
      base: "ETH",
      quote: "BTC",
      assetId: "ethereum",
      fee: 0,
      increment: 0.000001,
      minCost: 0,
      bids: [[0.0199, 100]],
      asks: [[0.02, 100]],
    }),
    side: "buy",
  },
  {
    book: book("kraken", {
      marketId: "kraken:ETHUSD",
      base: "ETH",
      assetId: "ethereum",
      fee: 0,
      increment: 0.000001,
      bids: [[21, 100]],
      asks: [[21.1, 100]],
    }),
    side: "sell",
  },
];
test("triangle completes USD → BTC → ETH → USD with three actual depth walks", () => {
  const r = priceCryptoTriangle(triangle(), {
    budget: 100,
    slippageBps: 0,
    now,
  });
  near(r.proceeds, 105);
  near(r.net, 5);
  assert.deepEqual(r.path, ["USD", "BTC", "ETH", "USD"]);
  assert.equal(r.executable, false);
  const legs = triangle();
  legs[1].book.asks = [[0.02, 1]];
  assert.equal(priceCryptoTriangle(legs, { budget: 100, now }).status, "held");
});
test("all triangle fees and slippage lower proceeds without crediting unused dust", () => {
  const legs = triangle();
  for (const l of legs) l.book.fee = 0.008;
  const r = priceCryptoTriangle(legs, { budget: 100, slippageBps: 5, now });
  const upper =
    (100 / (1 + 0.008 + 0.0005) / 1000 / (1 + 0.008 + 0.0005) / 0.02) *
    21 *
    (1 - 0.008 - 0.0005);
  assert.ok(r.proceeds <= upper && r.proceeds > upper - 0.03);
  assert.ok(r.legs.every((l) => l.fee > 0 && l.unspent >= 0));
});
test("public adapters verify returned product identity, pair key and mandatory notional minimum", () => {
  const spec = {
    venue: "coinbase",
    symbol: "BTC-USD",
    base: "BTC",
    quote: "USD",
  };
  const info = {
    id: "BTC-USD",
    base_currency: "BTC",
    quote_currency: "USD",
    min_market_funds: "1",
  };
  assert.doesNotThrow(() => verifyCryptoMarket(spec, info));
  assert.throws(
    () => verifyCryptoMarket(spec, { ...info, id: "ETH-USD" }),
    /identity/,
  );
  assert.throws(
    () => verifyCryptoMarket(spec, { ...info, min_market_funds: null }),
    /minimum/,
  );
  const ks = { venue: "kraken", symbol: "XBTUSD", base: "BTC", quote: "USD" },
    ki = { altname: "XBTUSD", base: "XXBT", quote: "ZUSD", key: "XXBTZUSD" };
  assert.doesNotThrow(() => verifyCryptoMarket(ks, ki));
  assert.throws(
    () => selectCryptoBook(ks, ki, { error: [], result: { XETHZUSD: {} } }),
    /identity/,
  );
  assert.deepEqual(
    selectCryptoBook(ks, ki, { error: [], result: { XXBTZUSD: { bids: [] } } }),
    { bids: [] },
  );
});
test("published current snapshot has priced observations and no executions or paper credits", () => {
  const d = JSON.parse(
    readFileSync(
      new URL("../dashboard/data/crypto-arbitrage.json", import.meta.url),
    ),
  );
  assert.equal(validCryptoSnapshot(d), true);
  assert.ok(d.books.length > 0);
  assert.equal("paper" in d, false);
  assert.ok(d.routes.every((r) => r.executable === false));
});
