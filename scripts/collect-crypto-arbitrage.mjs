import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRYPTO_ASSETS,
  CRYPTO_FEES,
  CRYPTO_MODEL,
  FEE_REVIEWED_AT,
  normalizeLevels,
  optimizeCryptoRoute,
  checkCryptoDelay,
  priceCryptoTriangle,
} from "../dashboard/crypto-arbitrage-core.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function get(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "MoffittMoney public-book research" },
    });
    if (r.ok) return r.json();
    if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    throw new Error(`HTTP ${r.status}`);
  }
}
const krakenResult = (d) => {
  if (!d || !Array.isArray(d.error) || d.error.length || !d.result)
    throw new Error(d?.error?.join("; ") || "Invalid Kraken response");
  return d.result;
};
const canonicalCurrency = (c) =>
  ({
    XXBT: "BTC",
    XBT: "BTC",
    XETH: "ETH",
    XXDG: "DOGE",
    XDG: "DOGE",
    ZUSD: "USD",
  })[c] || c;
export function verifyCryptoMarket(spec, info) {
  if (!info) throw new Error("Market definition unavailable");
  if (spec.venue === "coinbase") {
    if (
      info.id !== spec.symbol ||
      info.base_currency !== spec.base ||
      info.quote_currency !== spec.quote
    )
      throw new Error("Coinbase market identity mismatch");
    if (
      info.min_market_funds == null ||
      !Number.isFinite(Number(info.min_market_funds)) ||
      Number(info.min_market_funds) <= 0
    )
      throw new Error("Coinbase notional minimum unavailable");
  } else if (spec.venue === "kraken") {
    if (
      info.altname !== spec.symbol ||
      canonicalCurrency(info.base) !== spec.base ||
      canonicalCurrency(info.quote) !== spec.quote ||
      typeof info.key !== "string"
    )
      throw new Error("Kraken market identity mismatch");
  } else throw new Error("Unknown venue");
}
export function selectCryptoBook(spec, info, data) {
  if (spec.venue === "coinbase") return data;
  const result = krakenResult(data);
  if (Object.keys(result).length !== 1 || !Object.hasOwn(result, info.key))
    throw new Error("Kraken book identity mismatch");
  return result[info.key];
}
export async function collectCrypto(previous = {}) {
  const errors = [],
    metadata = new Map();
  const addError = (source, e) => errors.push({ source, message: e.message });
  try {
    const pairs = krakenResult(
      await get(
        "https://api.kraken.com/0/public/AssetPairs?pair=" +
          [...CRYPTO_ASSETS.map((a) => a.kraken), "ETHXBT", "SOLXBT"].join(","),
      ),
    );
    for (const [key, p] of Object.entries(pairs))
      metadata.set(p.altname, { ...p, key });
  } catch (e) {
    addError("Kraken market definitions", e);
  }
  // Fetch definitions before books so HTTP setup latency does not skew receipt times.
  const coinbaseInfo = new Map();
  for (let i = 0; i < CRYPTO_ASSETS.length; i += 3)
    await Promise.all(
      CRYPTO_ASSETS.slice(i, i + 3).map(async (a) => {
        try {
          coinbaseInfo.set(
            a.base,
            await get(
              `https://api.exchange.coinbase.com/products/${a.coinbase}`,
            ),
          );
        } catch (e) {
          addError(`Coinbase ${a.base} definition`, e);
        }
      }),
    );
  const requests = CRYPTO_ASSETS.flatMap((a) => [
    {
      venue: "coinbase",
      base: a.base,
      quote: "USD",
      assetId: a.assetId,
      symbol: a.coinbase,
    },
    {
      venue: "kraken",
      base: a.base,
      quote: "USD",
      assetId: a.assetId,
      symbol: a.kraken,
    },
  ]).concat(
    ["ETH", "SOL"].map((base) => ({
      venue: "kraken",
      base,
      quote: "BTC",
      assetId: base === "ETH" ? "ethereum" : "solana",
      symbol: base + "XBT",
    })),
  );
  async function readBooks(priorBooks) {
    const books = [];
    // Small fixed universe and bounded concurrency; no account or order endpoints.
    for (let i = 0; i < requests.length; i += 4)
      await Promise.all(
        requests.slice(i, i + 4).map(async (spec) => {
          const marketId = `${spec.venue}:${spec.symbol}`;
          try {
            const info =
              spec.venue === "coinbase"
                ? coinbaseInfo.get(spec.base)
                : metadata.get(spec.symbol);
            verifyCryptoMarket(spec, info);
            const data = await get(
              spec.venue === "coinbase"
                ? `https://api.exchange.coinbase.com/products/${spec.symbol}/book?level=2`
                : `https://api.kraken.com/0/public/Depth?pair=${spec.symbol}&count=50`,
            );
            const receivedAt = Date.now() / 1000;
            const book = selectCryptoBook(spec, info, data);
            if (!book) throw new Error("Missing book");
            const cb = spec.venue === "coinbase";
            const status = cb
              ? info.status === "online" &&
                !info.trading_disabled &&
                !info.cancel_only &&
                !info.post_only &&
                !info.limit_only
                ? "online"
                : "restricted"
              : info.status;
            if (
              !cb &&
              (!Number.isInteger(info.lot_decimals) ||
                info.lot_decimals < 0 ||
                info.lot_decimals > 12 ||
                info.lot_multiplier !== 1 ||
                info.ordermin == null ||
                info.costmin == null ||
                Number(info.ordermin) <= 0 ||
                Number(info.costmin) <= 0)
            )
              throw new Error("Kraken order limits unavailable");
            const increment = cb
              ? Number(info.base_increment)
              : 10 ** -Number(info.lot_decimals);
            const minQuantity = cb
              ? Number(info.base_min_size ?? 0)
              : Number(info.ordermin);
            const minCost = cb
              ? Number(info.min_market_funds)
              : Number(info.costmin);
            if (
              ![increment, minQuantity, minCost].every(Number.isFinite) ||
              increment <= 0 ||
              minQuantity < 0 ||
              minCost < 0
            )
              throw new Error("Invalid order limits");
            books.push({
              ...spec,
              marketId,
              status,
              receivedAt,
              providerAt: cb && data.time ? Date.parse(data.time) / 1000 : null,
              sequence: cb ? (data.sequence ?? null) : null,
              fee: CRYPTO_FEES[spec.venue].rate,
              increment,
              minQuantity,
              minCost,
              bids: normalizeLevels(book.bids, "bids").slice(0, 50),
              asks: normalizeLevels(book.asks, "asks").slice(0, 50),
            });
          } catch (e) {
            addError(marketId, e);
            const old = priorBooks?.find((b) => b.marketId === marketId);
            if (old)
              books.push({
                ...old,
                status: "source-error",
                sourceError: e.message,
              });
          }
        }),
      );
    return books;
  }
  const books = await readBooks(previous.books);
  const now = Date.now() / 1000,
    routes = [];
  for (const a of CRYPTO_ASSETS) {
    const cb = books.find((b) => b.venue === "coinbase" && b.base === a.base),
      kr = books.find(
        (b) => b.venue === "kraken" && b.base === a.base && b.quote === "USD",
      );
    for (const [buy, sell] of [
      [cb, kr],
      [kr, cb],
    ])
      if (buy && sell) routes.push(optimizeCryptoRoute(buy, sell, { now }));
  }
  const triangles = [];
  for (const base of ["ETH", "SOL"]) {
    const find = (base, quote) =>
      books.find(
        (b) => b.venue === "kraken" && b.base === base && b.quote === quote,
      );
    const btc = find("BTC", "USD"),
      cross = find(base, "BTC"),
      usd = find(base, "USD");
    if (btc && cross && usd) {
      triangles.push(
        priceCryptoTriangle(
          [
            { book: btc, side: "buy" },
            { book: cross, side: "buy" },
            { book: usd, side: "sell" },
          ],
          { now },
        ),
      );
      triangles.push(
        priceCryptoTriangle(
          [
            { book: usd, side: "buy" },
            { book: cross, side: "sell" },
            { book: btc, side: "sell" },
          ],
          { now },
        ),
      );
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const followUpBooks = await readBooks([]);
  const checkedAt = Date.now() / 1000;
  for (const r of routes) {
    const [buy, sell] = r.books.map((b) =>
      followUpBooks.find((next) => next.marketId === b.marketId),
    );
    r.delayCheck = checkCryptoDelay(r, buy, sell, { now: checkedAt });
  }
  const priced = routes.filter((r) => Number.isFinite(r.net));
  const receipt = {
    at: now,
    routes: routes.length,
    priced: priced.length,
    positive: priced.filter((r) => r.net > 0).length,
    bestNetBps: priced.length ? Math.max(...priced.map((r) => r.netBps)) : null,
    errors: errors.length,
    modelVersion: CRYPTO_MODEL,
    delayedChecked: routes.filter((r) => r.delayCheck.net != null).length,
    survived: routes.filter((r) => r.delayCheck.survived).length,
    results: routes.map((r) => ({
      id: r.id,
      status: r.status,
      quantity: r.quantity ?? null,
      profitableQuantity: r.profitableQuantity,
      net: r.net ?? null,
      comparisonNet: r.comparison?.net ?? null,
      delayCheck: r.delayCheck,
    })),
  };
  // Store observations, never invented trades or automatic profit credits.
  return {
    schemaVersion: 1,
    generatedAt: checkedAt,
    evaluatedAt: now,
    modelVersion: CRYPTO_MODEL,
    realEnabled: false,
    books,
    followUpBooks,
    routes: routes.map(({ books, comparison, ...r }) => ({
      ...r,
      comparison: comparison
        ? Object.fromEntries(
            Object.entries(comparison).filter(([key]) => key !== "books"),
          )
        : null,
    })),
    triangles,
    errors,
    fees: { reviewedAt: FEE_REVIEWED_AT, venues: CRYPTO_FEES },
    assumptions: {
      budget: 100,
      slippageBpsPerLeg: 5,
      feeCurrency: "quote",
      fundingVerified: false,
      rebalanceCostIncluded: false,
      note: "Separate funded inventories are required. REST receipts are observation times, not simultaneous fills. Rebalancing, transfers and account-specific fees are not verified.",
    },
    history: [...(previous.history || []), receipt].slice(-288),
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outputArg = process.argv.indexOf("--output");
  const output =
    outputArg < 0
      ? path.join(root, "dashboard/data/crypto-arbitrage.json")
      : path.resolve(process.argv[outputArg + 1]);
  let previous = {};
  try {
    previous = JSON.parse(await readFile(output, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const snapshot = await collectCrypto(previous);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output + ".tmp", JSON.stringify(snapshot) + "\n");
  await rename(output + ".tmp", output);
  console.log(JSON.stringify(snapshot.history.at(-1)));
  if (!snapshot.books.some((b) => b.status === "online")) process.exitCode = 1;
}
