// Public-book research only. A modeled gap never creates a fill or account credit.
export const CRYPTO_MODEL = "2026-09-13-crypto-depth-v2";
export const CRYPTO_FEES = {
  coinbase: {
    rate: 0.006,
    label: "Coinbase Exchange",
    source:
      "https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees",
  },
  kraken: {
    rate: 0.008,
    label: "Kraken Pro",
    source: "https://www.kraken.com/features/fee-schedule",
  },
};
export const FEE_REVIEWED_AT = "2026-09-13";
export const CRYPTO_ASSETS = [
  ["BTC", "XBTUSD", "bitcoin"],
  ["ETH", "ETHUSD", "ethereum"],
  ["SOL", "SOLUSD", "solana"],
  ["LINK", "LINKUSD", "chainlink"],
  ["AVAX", "AVAXUSD", "avalanche"],
  ["DOGE", "XDGUSD", "dogecoin"],
].map(([base, kraken, assetId]) => ({
  base,
  kraken,
  assetId,
  coinbase: `${base}-USD`,
}));
const finite = Number.isFinite;
const positive = (v) => finite(v) && v > 0;
const floor = (v, step) => Math.floor((v + step * 1e-8) / step) * step;
export function validLevels(rows) {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every((r) => Array.isArray(r) && r.length === 2 && r.every(positive))
  );
}
export function normalizeLevels(rows, side) {
  if (!Array.isArray(rows)) throw new Error("Missing order-book depth");
  const levels = rows.map((r) => [Number(r[0]), Number(r[1])]);
  if (!validLevels(levels)) throw new Error("Invalid order-book depth");
  return levels.sort((a, b) => (side === "asks" ? a[0] - b[0] : b[0] - a[0]));
}
export function walkQuantity(rows, quantity) {
  if (!validLevels(rows) || !positive(quantity)) return null;
  let left = quantity,
    value = 0;
  for (const [price, available] of rows) {
    const filled = Math.min(left, available);
    value += filled * price;
    left -= filled;
    if (left <= quantity * 1e-10)
      return { quantity, value, average: value / quantity };
  }
  return null;
}
function buyQuantity(rows, budget) {
  let left = budget,
    quantity = 0;
  for (const [price, available] of rows) {
    const spent = Math.min(left, price * available);
    quantity += spent / price;
    left -= spent;
    if (left <= budget * 1e-10) return quantity;
  }
  return null;
}
function bookProblems(book, now) {
  if (!book || !validLevels(book.bids) || !validLevels(book.asks))
    return ["Book depth unavailable"];
  const reasons = [];
  if (!finite(now)) reasons.push("Invalid evaluation time");
  if (
    !CRYPTO_ASSETS.some(
      (a) => a.base === book.base && a.assetId === book.assetId,
    )
  )
    reasons.push("Unknown asset identity");
  if (book.status !== "online") reasons.push("Market is not fully open");
  if (
    !finite(book.receivedAt) ||
    now - book.receivedAt > 30 ||
    book.receivedAt > now + 2
  )
    reasons.push("Book observation is stale or invalid");
  if (
    book.providerAt != null &&
    (!finite(book.providerAt) ||
      now - book.providerAt > 30 ||
      book.providerAt > now + 2)
  )
    reasons.push("Provider timestamp is stale or invalid");
  if (
    !positive(book.increment) ||
    !finite(book.minQuantity) ||
    !finite(book.minCost) ||
    book.minCost < 0 ||
    book.minQuantity < 0
  )
    reasons.push("Order limits unavailable");
  if (!finite(book.fee) || book.fee < 0 || book.fee >= 1)
    reasons.push("Fee unavailable");
  if (book.bids[0][0] >= book.asks[0][0])
    reasons.push("Locked or crossed source book");
  if (
    book.asks.some((r, i) => i && r[0] < book.asks[i - 1][0]) ||
    book.bids.some((r, i) => i && r[0] > book.bids[i - 1][0])
  )
    reasons.push("Unsorted book depth");
  return reasons;
}
export function compareCryptoBooks(
  buy,
  sell,
  {
    budget = 100,
    slippageBps = 5,
    now = Date.now() / 1000,
    quantity: requestedQuantity,
  } = {},
) {
  const result = {
    id: `${buy?.marketId || "missing"}:${sell?.marketId || "missing"}`,
    base: buy?.base,
    buyVenue: buy?.venue,
    sellVenue: sell?.venue,
    budget,
    slippageBps,
    modelVersion: CRYPTO_MODEL,
    executable: false,
    fundingVerified: false,
    observedAt: Math.min(buy?.receivedAt || 0, sell?.receivedAt || 0),
    reasons: [...bookProblems(buy, now), ...bookProblems(sell, now)],
    status: "held",
    books: [buy, sell].filter(Boolean),
  };
  if (
    !positive(budget) ||
    !finite(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 1000
  )
    result.reasons.push("Invalid sizing assumption");
  if (
    !buy?.assetId ||
    buy.assetId !== sell?.assetId ||
    buy.base !== sell?.base ||
    buy.quote !== "USD" ||
    sell?.quote !== "USD" ||
    buy.venue === sell?.venue
  )
    result.reasons.push("Asset or venue mismatch");
  if (Math.abs((buy?.receivedAt || 0) - (sell?.receivedAt || 0)) > 5)
    result.reasons.push("Book receipts are more than five seconds apart");
  if (result.reasons.length) return result;
  const slip = slippageBps / 10000;
  const step = commonQuantityStep(buy.increment, sell.increment);
  if (!positive(step))
    return { ...result, reasons: ["Incompatible quantity increments"] };
  const possible =
    requestedQuantity ?? buyQuantity(buy.asks, budget / (1 + buy.fee + slip));
  if (!possible)
    return {
      ...result,
      reasons: ["Insufficient ask depth for the selected budget"],
    };
  const quantity = floor(possible, step);
  if (
    requestedQuantity != null &&
    (!positive(requestedQuantity) ||
      Math.abs(quantity - requestedQuantity) > step * 1e-6)
  )
    return {
      ...result,
      reasons: ["Quantity does not meet both venue increments"],
    };
  const bought = walkQuantity(buy.asks, quantity),
    sold = walkQuantity(sell.bids, quantity);
  if (!bought || !sold)
    return {
      ...result,
      reasons: ["Insufficient depth for the same asset quantity on both legs"],
    };
  if (
    quantity < Math.max(buy.minQuantity, sell.minQuantity) ||
    bought.value < buy.minCost ||
    sold.value < sell.minCost
  )
    return { ...result, reasons: ["Below a venue order minimum"] };
  const buyFee = bought.value * buy.fee,
    sellFee = sold.value * sell.fee;
  const slippage = (bought.value + sold.value) * slip;
  const net = sold.value - bought.value - buyFee - sellFee - slippage;
  const totalBuyCost = bought.value + buyFee + bought.value * slip;
  if (totalBuyCost > budget + 1e-8)
    return { ...result, reasons: ["Quantity exceeds the cash budget"] };
  return {
    ...result,
    quantity,
    buyPrice: bought.average,
    sellPrice: sold.average,
    buyPrincipal: bought.value,
    sellPrincipal: sold.value,
    buyFee,
    sellFee,
    slippage,
    totalBuyCost,
    netSellProceeds: sold.value - sellFee - sold.value * slip,
    grossBps: (sold.value / bought.value - 1) * 10000,
    netBps: (net / totalBuyCost) * 10000,
    net,
    requiredGrossBps:
      ((1 + buy.fee + slip) / (1 - sell.fee - slip) - 1) * 10000,
    equalFeeCeiling:
      (sold.value - bought.value - slippage) / (sold.value + bought.value),
    depthImpact:
      bought.value -
      quantity * buy.asks[0][0] +
      (quantity * sell.bids[0][0] - sold.value),
    status: net > 0 ? "modeled-gap" : "costs-exceed-gap",
    reasons: [
      net > 0
        ? "Positive modeled gap; funding and simultaneous fills are unverified"
        : "Fees and slippage exceed the price gap",
    ],
  };
}
// Least common multiple on a decimal integer grid, not max(step): .002 and
// .003 require .006. Refuse precision outside the supported 1e-12 grid.
export function commonQuantityStep(a, b) {
  const scale = 1e12;
  const x = Math.round(a * scale),
    y = Math.round(b * scale);
  if (
    ![x, y].every((v) => Number.isSafeInteger(v) && v > 0) ||
    Math.abs(x / scale - a) > 1e-14 ||
    Math.abs(y / scale - b) > 1e-14
  )
    return null;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = (x / gcd(x, y)) * y;
  return Number.isSafeInteger(lcm) ? lcm / scale : null;
}
function quantityAtValue(rows, value) {
  let q = 0,
    left = value;
  for (const [p, size] of rows) {
    const take = Math.min(size, left / p);
    q += take;
    left -= take * p;
    if (left <= 1e-10) return q;
  }
  return Infinity;
}
export function optimizeCryptoRoute(buy, sell, options = {}) {
  const budget = options.budget ?? 100;
  const comparison = compareCryptoBooks(buy, sell, options);
  const base = {
    ...comparison,
    comparison,
    optimization: true,
    profitableQuantity: 0,
    profitableCapital: 0,
    candidatesChecked: 0,
  };
  // Validate independently of the full-budget depth requirement.
  if (
    !buy ||
    !sell ||
    bookProblems(buy, options.now ?? Date.now() / 1000).length ||
    bookProblems(sell, options.now ?? Date.now() / 1000).length
  )
    return base;
  const step = commonQuantityStep(buy.increment, sell.increment);
  if (!step || !positive(budget)) return base;
  const slip = (options.slippageBps ?? 5) / 10000;
  const total = (rows) => rows.reduce((s, r) => s + r[1], 0);
  const cap = floor(
    Math.min(
      total(buy.asks),
      total(sell.bids),
      quantityAtValue(buy.asks, budget / (1 + buy.fee + slip)),
    ),
    step,
  );
  const minimum = Math.max(
    buy.minQuantity,
    sell.minQuantity,
    quantityAtValue(buy.asks, buy.minCost),
    quantityAtValue(sell.bids, sell.minCost),
    step,
  );
  // Net dollars are piecewise linear. The optimum lies at a book breakpoint,
  // the budget/depth boundary, or the first valid lot beside those boundaries.
  const points = [cap, Math.ceil((minimum - step * 1e-8) / step) * step];
  for (const levels of [buy.asks, sell.bids]) {
    let q = 0;
    for (const [, size] of levels) {
      q += size;
      points.push(floor(q, step), floor(q, step) + step);
    }
  }
  const candidates = [
    ...new Set(points.filter((q) => positive(q) && q <= cap + step * 1e-7)),
  ]
    .map((quantity) =>
      compareCryptoBooks(buy, sell, { ...options, budget, quantity }),
    )
    .filter((r) => finite(r.net));
  const best = candidates.sort(
    (a, b) => b.net - a.net || a.quantity - b.quantity,
  )[0];
  if (!best) return { ...base, reasons: comparison.reasons };
  return {
    ...base,
    ...best,
    comparison,
    candidatesChecked: candidates.length,
    profitableQuantity: best.net > 0 ? best.quantity : 0,
    profitableCapital: best.net > 0 ? best.totalBuyCost : 0,
    status: best.net > 0 ? "modeled-gap" : "no-profitable-size",
    reasons:
      best.net > 0
        ? best.reasons
        : ["No profitable size within this budget and the recorded depth"],
  };
}
export function checkCryptoDelay(
  initial,
  buy,
  sell,
  { now = Date.now() / 1000 } = {},
) {
  const quantity =
    initial.profitableQuantity ||
    initial.comparison?.quantity ||
    initial.quantity;
  const before = initial.profitableQuantity
    ? initial
    : initial.comparison || initial;
  const delays = [
    buy?.receivedAt - before.books?.[0]?.receivedAt,
    sell?.receivedAt - before.books?.[1]?.receivedAt,
  ];
  const base = {
    quantity,
    initialNet: before.net ?? null,
    initialPositive: before.net > 0,
    minDelaySeconds: Math.min(...delays),
    maxDelaySeconds: Math.max(...delays),
    checkedAt: now,
    status: "unavailable",
    net: null,
    survived: false,
  };
  if (
    !positive(quantity) ||
    !delays.every((d) => finite(d) && d >= 1 && d <= 30)
  )
    return {
      ...base,
      reason: "Missing, repeated or excessively delayed follow-up books",
    };
  if (
    !before.books?.every((book, i) => {
      const next = [buy, sell][i];
      return (
        next &&
        ["marketId", "base", "quote", "assetId", "venue"].every(
          (k) => next[k] === book[k],
        )
      );
    })
  )
    return {
      ...base,
      reason: "Follow-up route identity differs from the original",
    };
  const next = compareCryptoBooks(buy, sell, {
    budget: before.budget,
    quantity,
    now,
    slippageBps: before.slippageBps ?? 5,
  });
  if (!finite(next.net)) return { ...base, reason: next.reasons.join("; ") };
  return {
    ...base,
    net: next.net,
    netChange: next.net - before.net,
    status:
      before.net > 0
        ? next.net > 0
          ? "survived"
          : "erased"
        : "initially-unprofitable",
    survived: before.net > 0 && next.net > 0,
    reason: "Same route and original quantity; no re-optimization",
  };
}
export function priceCryptoTriangle(
  legs,
  { budget = 100, slippageBps = 5, now = Date.now() / 1000 } = {},
) {
  const result = {
    id: legs.map((l) => `${l.book?.marketId}:${l.side}`).join(":"),
    path: ["USD"],
    budget,
    executable: false,
    status: "held",
    reasons: [],
    legs: [],
    observedAt: Math.min(...legs.map((l) => l.book?.receivedAt || 0)),
  };
  if (
    legs.length !== 3 ||
    !positive(budget) ||
    !finite(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 1000
  )
    return { ...result, reasons: ["Invalid triangle sizing"] };
  let asset = "USD",
    amount = budget;
  const slip = slippageBps / 10000;
  if (
    Math.max(...legs.map((l) => l.book?.receivedAt || 0)) - result.observedAt >
    5
  )
    result.reasons.push("Book receipts are more than five seconds apart");
  for (const { book, side } of legs) {
    result.reasons.push(...bookProblems(book, now));
    if (
      !["buy", "sell"].includes(side) ||
      book?.venue !== "kraken" ||
      asset !== (side === "buy" ? book?.quote : book?.base)
    )
      result.reasons.push("Triangle asset path does not join");
    if (result.reasons.length) return result;
    const qty =
      side === "buy"
        ? buyQuantity(book.asks, amount / (1 + book.fee + slip))
        : amount;
    if (!qty)
      return { ...result, reasons: ["Insufficient depth for a complete leg"] };
    const quantity = floor(qty, book.increment);
    const fill = walkQuantity(side === "buy" ? book.asks : book.bids, quantity);
    if (!fill || quantity < book.minQuantity || fill.value < book.minCost)
      return { ...result, reasons: ["Depth or order minimum blocks a leg"] };
    const fee = fill.value * book.fee,
      buffer = fill.value * slip;
    const spent = side === "buy" ? fill.value + fee + buffer : quantity;
    // Dust is disclosed but assigned zero value; it is not silently sold at a midpoint.
    result.legs.push({
      marketId: book.marketId,
      side,
      quantity,
      price: fill.average,
      fee,
      feeCurrency: book.quote,
      slippage: buffer,
      unspent: Math.max(0, amount - spent),
      inputAsset: asset,
    });
    asset = side === "buy" ? book.base : book.quote;
    amount = side === "buy" ? quantity : fill.value - fee - buffer;
    result.path.push(asset);
  }
  if (asset !== "USD")
    return { ...result, reasons: ["Triangle does not return to USD"] };
  return {
    ...result,
    proceeds: amount,
    net: amount - budget,
    netBps: (amount / budget - 1) * 10000,
    status: amount > budget ? "modeled-gap" : "costs-exceed-gap",
    reasons: [
      amount > budget
        ? "Positive modeled cycle; sequential fills are unverified"
        : "Costs exceed the cycle spread",
    ],
  };
}
export function validCryptoSnapshot(d) {
  return !!(
    d?.schemaVersion === 1 &&
    d.realEnabled === false &&
    finite(d.generatedAt) &&
    d.generatedAt <= Date.now() / 1000 + 60 &&
    Array.isArray(d.books) &&
    d.books.every(
      (b) =>
        b &&
        typeof b.marketId === "string" &&
        typeof b.base === "string" &&
        typeof b.quote === "string" &&
        ["coinbase", "kraken"].includes(b.venue) &&
        finite(b.receivedAt) &&
        validLevels(b.bids) &&
        validLevels(b.asks),
    ) &&
    Array.isArray(d.routes) &&
    d.routes.every(
      (r) =>
        r &&
        r.executable === false &&
        typeof r.id === "string" &&
        Array.isArray(r.reasons) &&
        (r.status === "held" || finite(r.net)),
    ) &&
    Array.isArray(d.triangles) &&
    d.triangles.every(
      (r) =>
        r &&
        r.executable === false &&
        Array.isArray(r.path) &&
        Array.isArray(r.reasons),
    ) &&
    Array.isArray(d.errors) &&
    d.errors.every(
      (e) => e && typeof e.source === "string" && typeof e.message === "string",
    ) &&
    Array.isArray(d.history) &&
    d.history.every(
      (s) =>
        s &&
        ["at", "routes", "priced", "positive"].every((k) => finite(s[k])) &&
        (s.bestNetBps == null || finite(s.bestNetBps)),
    )
  );
}
