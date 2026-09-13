// Deterministic public-data simulation. This module contains no order API.
export const COPY_MODEL = "2026-09-13-copy-forward-v1";
export const COPY_RULES = Object.freeze({
  bankroll: 100,
  stake: 5,
  maxExposure: 30,
  maxEventExposure: 10,
  minBackers: 3,
  minEffectiveBackers: 2.5,
  minDominance: 0.8,
  windowHours: 6,
  halfLifeHours: 3,
  confirmationSeconds: 60,
  maxConfirmationGap: 900,
  maxSpread: 0.05,
  maxDrift: 0.03,
  minPrice: 0.05,
  maxPrice: 0.95,
  slippagePerShare: 0.005,
  participation: 0.1,
  drawdownStop: 0.2,
  maxWallets: 20,
});
const finite = Number.isFinite;
const positive = (n) => finite(n) && n > 0;
const clamp = (n) => Math.max(0, Math.min(1, n));
const round = (n) => Math.round(n * 1e5) / 1e5;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const hex = (s, n) =>
  typeof s === "string" && new RegExp(`^0x[0-9a-f]{${n}}$`, "i").test(s);
const token = (s) => typeof s === "string" && /^[0-9]{1,100}$/.test(s);
export function rankCopyWallets(analytics) {
  return analytics.wallets
    .map((w) => {
      const reasons = [],
        h = w.pnlDaily || [];
      const valid =
        h.length > 1 &&
        h.every(
          (p, i) => finite(p.t) && finite(p.p) && (!i || p.t > h[i - 1].t),
        );
      const changes = valid ? h.slice(1).map((p, i) => p.p - h[i].p) : [];
      const pnl = valid ? h.at(-1).p - h[0].p : 0;
      const blocks = [0, 1, 2].map((i) =>
        sum(changes.slice(-60 + i * 20, -60 + (i + 1) * 20 || undefined)),
      );
      const positiveBlocks = blocks.filter((n) => n > 0).length;
      if (w.truncated) reasons.push("Incomplete trade history");
      if (["Market maker / HFT", "Crypto scalper"].includes(w.archetype))
        reasons.push("Execution style unsuitable for delayed copying");
      if (
        !valid ||
        changes.length < 60 ||
        h.at(-1)?.t - h[0]?.t < 60 * 86400 ||
        h.some((p, i) => i && p.t - h[i - 1].t > 2 * 86400)
      )
        reasons.push("Insufficient continuous daily history");
      if (!positive(pnl) || !finite(w.maxDrawdown90))
        reasons.push("Positive P&L and drawdown evidence required");
      if (changes.filter((n) => Math.abs(n) > 1).length < 20)
        reasons.push("Fewer than 20 material P&L days");
      if (
        !finite(w.top5EventShare) ||
        w.top5EventShare < 0 ||
        w.top5EventShare > 0.75
      )
        reasons.push(
          "Top five events exceed 75% of volume or coverage unknown",
        );
      if (
        !finite(w.bothSidesShare) ||
        w.bothSidesShare < 0 ||
        w.bothSidesShare >= 0.35
      )
        reasons.push("Excessive or unknown two-sided trading");
      if (!finite(w.distinctEvents) || w.distinctEvents < 20)
        reasons.push("Fewer than 20 distinct events");
      if (
        !positive(w.activeDays) ||
        !finite(w.trades90) ||
        !finite(w.volume90) ||
        !positive(w.medianTradeUsd)
      )
        reasons.push("Trading activity metrics missing");
      if (w.volume90 / Math.abs(pnl) >= 250 && w.trades90 / w.activeDays >= 100)
        reasons.push("High-turnover thin-margin trading");
      if (positiveBlocks < 2)
        reasons.push("Gains did not persist across two of three recent blocks");
      const components = {
        pathEfficiency: clamp(pnl / (sum(changes.map(Math.abs)) || 1)),
        drawdownRecovery: clamp(pnl / (pnl + Math.abs(w.maxDrawdown90) || 1)),
        persistence: positiveBlocks / 3,
        breadth: clamp(1 - (w.top5EventShare ?? 1)),
      };
      const score = Object.values(components).every(finite)
        ? round(25 * sum(Object.values(components)))
        : 0;
      return {
        wallet: w.wallet.toLowerCase(),
        name: w.name,
        eligible: !reasons.length,
        score,
        reasons,
        components,
        positiveBlocks,
        blockPnl: blocks,
        materialDays: changes.filter((n) => Math.abs(n) > 1).length,
        medianTradeUsd: w.medianTradeUsd,
        category:
          Object.entries(w.categoryVol || {}).sort(
            (a, b) => b[1] - a[1],
          )[0]?.[0] || "Other",
      };
    })
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score ||
        a.wallet.localeCompare(b.wallet),
    );
}
export function parseCopyTrade(t, wallet, observedAt, start, end) {
  if (
    !t ||
    t.type !== "TRADE" ||
    t.is_combo === true ||
    !hex(t.proxy_wallet, 40) ||
    t.proxy_wallet.toLowerCase() !== wallet.toLowerCase() ||
    !hex(t.condition_id, 64) ||
    !hex(t.transaction_hash, 64) ||
    !token(t.token_id) ||
    !["BUY", "SELL"].includes(t.side) ||
    !positive(t.timestamp) ||
    t.timestamp < start ||
    t.timestamp > end ||
    t.timestamp > observedAt + 2 ||
    !finite(t.price) ||
    t.price < 0 ||
    t.price > 1 ||
    !positive(t.size) ||
    !finite(t.usdc_size) ||
    t.usdc_size < 0 ||
    t.usdc_size > t.size * 2 + 0.02 ||
    typeof t.title !== "string" ||
    typeof t.outcome !== "string" ||
    !t.outcome.trim()
  )
    return null;
  const id = [
    wallet.toLowerCase(),
    t.transaction_hash,
    t.token_id,
    t.side,
    t.timestamp,
    t.price,
    t.size,
    t.usdc_size,
  ].join(":");
  return {
    id,
    wallet: wallet.toLowerCase(),
    condition: t.condition_id.toLowerCase(),
    token: t.token_id,
    eventAt: t.timestamp,
    firstObservedAt: observedAt,
    side: t.side,
    price: t.price,
    shares: t.size,
    usd: t.size * t.price,
    reportedCash: t.usdc_size,
    outcome: t.outcome,
    title: t.title,
    eventSlug: t.event_slug || "",
    outcomeIndex: t.outcome_index,
  };
}
export function buildCopyCandidates(trades, cohort, at, rules = COPY_RULES) {
  const wallets = new Map(cohort.map((w) => [w.wallet, w])),
    groups = new Map();
  const seen = new Set();
  for (const t of trades) {
    if (
      seen.has(t.id) ||
      !wallets.has(t.wallet) ||
      t.eventAt > at ||
      t.firstObservedAt > at ||
      t.eventAt < at - rules.windowHours * 3600
    )
      continue;
    seen.add(t.id);
    const key = t.condition + ":" + t.token;
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        condition: t.condition,
        token: t.token,
        title: t.title,
        outcome: t.outcome,
        eventSlug: t.eventSlug,
        outcomeIndex: t.outcomeIndex,
        byWallet: new Map(),
      });
    const group = groups.get(key);
    if (!group.byWallet.has(t.wallet))
      group.byWallet.set(t.wallet, {
        ...wallets.get(t.wallet),
        buyShares: 0,
        buyUsd: 0,
        sellShares: 0,
        lastTradeAt: 0,
        decayedBuyShares: 0,
      });
    const w = group.byWallet.get(t.wallet);
    if (t.side === "BUY") {
      w.buyShares += t.shares;
      w.buyUsd += t.usd;
      w.decayedBuyShares +=
        t.shares * 2 ** (-(at - t.eventAt) / (rules.halfLifeHours * 3600));
      w.lastTradeAt = Math.max(w.lastTradeAt, t.eventAt);
    } else w.sellShares += t.shares;
  }
  const candidates = [...groups.values()].map((g) => {
    const backers = [];
    for (const w of g.byWallet.values()) {
      const other = sum(
        [...groups.values()]
          .filter((o) => o.condition === g.condition && o.token !== g.token)
          .map((o) => o.byWallet.get(w.wallet))
          .filter(Boolean)
          .map((o) => Math.max(0, o.buyShares - o.sellShares)),
      );
      const netShares = Math.max(0, w.buyShares - w.sellShares - other),
        avgPrice = w.buyUsd / w.buyShares;
      const netUsd = netShares * avgPrice;
      if (!positive(netUsd) || netUsd < 10) continue;
      const weight =
        Math.min(1, netUsd / Math.max(10, w.medianTradeUsd)) *
        (0.5 + (0.5 * w.score) / 100) *
        (w.decayedBuyShares / w.buyShares);
      backers.push({
        wallet: w.wallet,
        name: w.name,
        netShares,
        netUsd,
        avgPrice,
        buyShares: w.buyShares,
        buyUsd: w.buyUsd,
        lastTradeAt: w.lastTradeAt,
        weight,
      });
    }
    const weight = sum(backers.map((b) => b.weight));
    return {
      ...g,
      byWallet: undefined,
      backers,
      weight,
      backerCount: backers.length,
      effectiveBackers: weight
        ? (weight * weight) / sum(backers.map((b) => b.weight * b.weight))
        : 0,
      avgEntry: backers.length
        ? sum(backers.map((b) => b.netShares * b.avgPrice)) /
          sum(backers.map((b) => b.netShares))
        : null,
    };
  });
  return candidates
    .filter((c) => c.backerCount >= 2)
    .map((c) => {
      const opposition = sum(
        candidates
          .filter((o) => o.condition === c.condition && o.token !== c.token)
          .map((o) => o.weight),
      );
      const dominance = c.weight / (c.weight + opposition || 1),
        reasons = [];
      if (c.backerCount < rules.minBackers)
        reasons.push("Needs three backing wallets");
      if (c.effectiveBackers < rules.minEffectiveBackers)
        reasons.push("Buying is too concentrated in a few wallets");
      if (dominance < rules.minDominance)
        reasons.push("Opposing flow is too strong");
      return { ...c, dominance, reasons, qualified: !reasons.length };
    })
    .sort(
      (a, b) =>
        Number(b.qualified) - Number(a.qualified) ||
        b.weight - a.weight ||
        a.id.localeCompare(b.id),
    );
}
export function copyFee(shares, price, fd) {
  if (
    !finite(shares) ||
    shares < 0 ||
    !finite(price) ||
    price < 0 ||
    price > 1 ||
    !fd ||
    !finite(fd.r) ||
    fd.r < 0 ||
    fd.r > 1 ||
    !finite(fd.e) ||
    fd.e < 0 ||
    fd.e > 10
  )
    return null;
  return round(shares * fd.r * (price * (1 - price)) ** fd.e);
}
export function validateCopyBook(b, market, at, { entry = true } = {}) {
  const reasons = [];
  if (
    !b ||
    !market ||
    b.condition !== market.condition ||
    !market.tokens?.some((t) => t.token === b.token)
  )
    return ["Market or outcome identity unavailable"];
  if (
    !finite(b.receivedAt) ||
    !finite(b.providerAt) ||
    at - b.receivedAt > 30 ||
    at - b.providerAt > 30 ||
    b.receivedAt > at + 2 ||
    b.providerAt > at + 2
  )
    reasons.push("Book is stale or has invalid timestamps");
  for (const side of ["asks", "bids"])
    if (
      !Array.isArray(b[side]) ||
      b[side].some(
        (r, i) =>
          !Array.isArray(r) ||
          r.length !== 2 ||
          !positive(r[0]) ||
          r[0] >= 1 ||
          !positive(r[1]) ||
          (i &&
            (side === "asks"
              ? r[0] < b[side][i - 1][0]
              : r[0] > b[side][i - 1][0])),
      )
    )
      reasons.push("Invalid or unsorted depth");
  if (!b.bids?.length || (entry && !b.asks?.length))
    reasons.push("Book side is empty");
  if (b.bids?.length && b.asks?.length && b.bids[0][0] >= b.asks[0][0])
    reasons.push("Locked or crossed book");
  if (copyFee(1, 0.5, market.fee) == null)
    reasons.push("Current fee curve unavailable");
  if (
    entry &&
    (!market.accepting ||
      !positive(market.minShares) ||
      !positive(market.tick) ||
      market.tokens.length !== 2)
  )
    reasons.push("Market is closed or order limits unavailable");
  return reasons;
}
function fillCopyLevels(levels, quantity, fee, buffer, side) {
  let left = quantity,
    principal = 0,
    fees = 0;
  const fills = [];
  for (const [price, size] of levels) {
    const shares = Math.min(size, left);
    if (shares <= 0) break;
    const f = copyFee(shares, price, fee);
    if (f == null) return null;
    fills.push({ price, shares, fee: f });
    principal += shares * price;
    fees += f;
    left -= shares;
    if (left < 1e-8) break;
  }
  if (left > 1e-8) return null;
  const slippage = quantity * buffer;
  return {
    shares: quantity,
    principal,
    fee: round(fees),
    slippage,
    average: principal / quantity,
    cash:
      side === "buy"
        ? principal + fees + slippage
        : Math.max(0, principal - fees - slippage),
    fills,
  };
}
export function priceCopyEntry(
  candidate,
  book,
  market,
  budget,
  at,
  rules = COPY_RULES,
) {
  const reasons = validateCopyBook(book, market, at);
  if (reasons.length) return { reasons };
  const top = book.asks[0][0],
    spread = top - book.bids[0][0];
  if (top < rules.minPrice || top > rules.maxPrice)
    reasons.push("Price outside the study range");
  if (spread > rules.maxSpread + 1e-9)
    reasons.push("Spread exceeds five cents");
  if (!positive(budget) || !finite(candidate.avgEntry))
    reasons.push("Sizing or backer entry unavailable");
  if (reasons.length) return { reasons };
  // Limit each level to 10% participation, then solve fee-inclusive cash sizing.
  const levels = book.asks.map(([p, q]) => [p, q * rules.participation]);
  let low = 0,
    high = Math.floor(
      Math.min(sum(levels.map((r) => r[1])), budget / top) * 1e4,
    ),
    best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2),
      fill = mid
        ? fillCopyLevels(
            levels,
            mid / 1e4,
            market.fee,
            rules.slippagePerShare,
            "buy",
          )
        : null;
    if (!mid || (fill && fill.cash <= budget + 1e-9)) {
      best = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  const quantity = best / 1e4;
  if (quantity < market.minShares)
    return { reasons: ["Depth, budget or venue minimum prevents entry"] };
  const fill = fillCopyLevels(
    levels,
    quantity,
    market.fee,
    rules.slippagePerShare,
    "buy",
  );
  if (!fill || fill.cash > budget + 1e-8)
    return { reasons: ["Fee-inclusive size exceeds available cash"] };
  if (fill.average - candidate.avgEntry > rules.maxDrift + 1e-9)
    reasons.push("Entry has moved more than three cents above backers");
  if (
    fill.fills.at(-1).price > rules.maxPrice ||
    fill.fills.at(-1).price + rules.slippagePerShare >= 1
  )
    reasons.push("Depth exceeds the price limit");
  return { reasons, fill, spread };
}
export function copyResolutionPayout(position, resolution, at) {
  if (
    !resolution ||
    resolution.condition_id?.toLowerCase() !== position.condition ||
    resolution.status !== "resolved" ||
    !["reported", "derived"].includes(resolution.resolution_source) ||
    !["0", "1"].includes(String(position.outcomeIndex)) ||
    !Array.isArray(resolution.payouts) ||
    resolution.payouts.length !== 2 ||
    !resolution.payouts.every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 1e6,
    ) ||
    sum(resolution.payouts) !== 1e6 ||
    !finite(Date.parse(resolution.resolved_at)) ||
    Date.parse(resolution.resolved_at) / 1000 > at + 2 ||
    Date.parse(resolution.resolved_at) / 1000 < position.openedAt
  )
    return null;
  return {
    perShare: resolution.payouts[position.outcomeIndex] / 1e6,
    resolvedAt: Date.parse(resolution.resolved_at) / 1000,
  };
}
export function createCopyStudy(analytics, sourceHash, at) {
  if (
    !finite(at) ||
    !finite(analytics.generatedAt) ||
    analytics.generatedAt > at
  )
    throw new Error("Ranking must precede study creation");
  const ranking = rankCopyWallets(analytics),
    cohort = ranking.filter((w) => w.eligible).slice(0, COPY_RULES.maxWallets);
  return {
    schemaVersion: 1,
    modelVersion: COPY_MODEL,
    realEnabled: false,
    mode: "simulation",
    createdAt: at,
    updatedAt: at,
    rules: { ...COPY_RULES },
    source: { analyticsAt: analytics.generatedAt, sha256: sourceHash },
    ranking,
    cohort,
    cash: COPY_RULES.bankroll,
    positions: [],
    closed: [],
    usedConditions: [],
    candidates: [],
    confirmations: {},
    decisions: [],
    counters: {
      scans: 0,
      completeScans: 0,
      candidates: 0,
      entries: 0,
      holds: {},
    },
    errors: [],
    coverage: [],
    equity: COPY_RULES.bankroll,
    equityComplete: true,
    peakEquity: COPY_RULES.bankroll,
    entryPaused: false,
    curve: [{ at, equity: COPY_RULES.bankroll, cash: COPY_RULES.bankroll }],
  };
}
export function validateCopyStudyState(s) {
  const fail = (message) => {
    throw new Error("Invalid copy study: " + message);
  };
  if (
    !s ||
    s.modelVersion !== COPY_MODEL ||
    s.realEnabled !== false ||
    s.mode !== "simulation"
  )
    fail("model or execution mode");
  if (
    !s.rules ||
    Object.keys(s.rules).length !== Object.keys(COPY_RULES).length ||
    Object.entries(COPY_RULES).some(([k, v]) => s.rules[k] !== v)
  )
    fail("frozen rules changed");
  if (
    !finite(s.createdAt) ||
    !finite(s.updatedAt) ||
    s.updatedAt < s.createdAt ||
    !finite(s.source?.analyticsAt) ||
    s.source.analyticsAt > s.createdAt ||
    !/^[a-f0-9]{64}$/.test(s.source.sha256)
  )
    fail("source provenance");
  if (
    !Array.isArray(s.cohort) ||
    !s.cohort.length ||
    s.cohort.length > COPY_RULES.maxWallets ||
    new Set(s.cohort.map((w) => w.wallet)).size !== s.cohort.length ||
    s.cohort.some(
      (w) =>
        !hex(w.wallet, 40) ||
        !finite(w.score) ||
        w.score < 0 ||
        w.score > 100 ||
        !positive(w.medianTradeUsd),
    )
  )
    fail("cohort");
  if (
    !Array.isArray(s.positions) ||
    !Array.isArray(s.closed) ||
    !positive(s.peakEquity) ||
    !finite(s.cash) ||
    s.cash < 0
  )
    fail("account values");
  const all = [...s.positions, ...s.closed];
  if (
    new Set(all.map((p) => p.id)).size !== all.length ||
    new Set(all.map((p) => p.condition)).size !== all.length
  )
    fail("duplicate positions");
  if (
    !Array.isArray(s.usedConditions) ||
    new Set(s.usedConditions).size !== all.length ||
    all.some((p) => !s.usedConditions.includes(p.condition))
  )
    fail("condition ledger");
  for (const p of all) {
    const receipt = p.entryReceipt,
      mapped = receipt?.market?.tokens?.find((t) => t.token === p.token);
    if (
      !hex(p.condition, 64) ||
      !token(p.token) ||
      p.id !== p.condition + ":" + p.token ||
      receipt?.market?.condition !== p.condition ||
      receipt?.book?.condition !== p.condition ||
      receipt?.book?.token !== p.token ||
      !mapped ||
      mapped.outcome !== p.outcome ||
      mapped.index !== p.outcomeIndex
    )
      fail("persisted outcome identity");
    if (
      !positive(p.shares) ||
      !positive(p.cost) ||
      !finite(p.entryPrice) ||
      !finite(p.entryFee) ||
      p.entryFee < 0 ||
      !finite(p.entrySlippage) ||
      p.entrySlippage < 0 ||
      !finite(p.openedAt) ||
      p.openedAt < s.createdAt ||
      p.openedAt > s.updatedAt ||
      Math.abs(
        p.cost - (p.entryPrice * p.shares + p.entryFee + p.entrySlippage),
      ) > 1e-6
    )
      fail("entry accounting");
  }
  for (const p of s.positions)
    if (!finite(p.value) || p.value < 0 || p.value > p.shares + 1e-6)
      fail("open marks");
  for (const p of s.closed)
    if (
      !finite(p.proceeds) ||
      p.proceeds < 0 ||
      p.proceeds > p.shares + 1e-6 ||
      !finite(p.pnl) ||
      Math.abs(p.pnl - (p.proceeds - p.cost)) > 1e-6
    )
      fail("settled accounting");
  for (const p of s.closed) {
    const resolution = copyResolutionPayout(p, p.resolution, p.settledAt);
    if (
      !resolution ||
      p.settledAt > s.updatedAt ||
      Math.abs(p.proceeds - p.shares * resolution.perShare) > 1e-6
    )
      fail("settlement evidence");
  }
  const cash =
    COPY_RULES.bankroll -
    sum(all.map((p) => p.cost)) +
    sum(s.closed.map((p) => p.proceeds));
  if (
    Math.abs(cash - s.cash) > 1e-6 ||
    !finite(s.equity) ||
    Math.abs(s.equity - (s.cash + sum(s.positions.map((p) => p.value)))) > 1e-6
  )
    fail("cash or equity reconciliation");
  return true;
}
export function advanceCopyStudy(previous, observation) {
  validateCopyStudyState(previous);
  const s = structuredClone(previous),
    {
      at,
      complete,
      candidates = [],
      books = {},
      markets = {},
      resolutions = {},
      errors = [],
      coverage = [],
    } = observation;
  if (s.modelVersion !== COPY_MODEL || s.realEnabled !== false)
    throw new Error("Incompatible or unsafe study state");
  if (!finite(at) || at <= s.updatedAt) return s;
  const r = s.rules;
  s.updatedAt = at;
  s.errors = errors;
  s.coverage = coverage;
  s.counters.scans++;
  if (complete) s.counters.completeScans++;
  for (const p of [...s.positions]) {
    const resolution = resolutions[p.condition];
    if (
      resolution?.status === "resolved" &&
      Date.parse(resolution.resolved_at) / 1000 < p.openedAt
    ) {
      p.markStatus = "unavailable";
      p.markReason = "Resolution predates entry; provenance conflict";
      s.errors.push({ source: p.title, message: p.markReason });
      continue;
    }
    const payout = copyResolutionPayout(p, resolution, at);
    if (payout) {
      const proceeds = p.shares * payout.perShare;
      s.cash += proceeds;
      s.closed.push({
        ...p,
        settledAt: at,
        resolvedAt: payout.resolvedAt,
        payout: payout.perShare,
        proceeds,
        pnl: proceeds - p.cost,
        resolution: resolutions[p.condition],
      });
      s.positions = s.positions.filter((q) => q.id !== p.id);
      continue;
    }
    const b = books[p.token],
      m = markets[p.condition];
    const problems = validateCopyBook(b, m, at, { entry: false });
    const mark = problems.length
      ? null
      : fillCopyLevels(b.bids, p.shares, m.fee, r.slippagePerShare, "sell");
    if (mark) {
      p.value = mark.cash;
      p.markedAt = b.receivedAt;
      p.markStatus = "current";
      p.markReceipt = { book: b, fee: m.fee };
    } else {
      p.markStatus = "unavailable";
      p.markReason = problems[0] || "Insufficient liquidation depth";
    }
  }
  const value = () => s.cash + sum(s.positions.map((p) => p.value));
  s.equityComplete = s.positions.every((p) => p.markStatus === "current");
  if (s.equityComplete) {
    s.peakEquity = Math.max(s.peakEquity, value());
    if (value() <= s.peakEquity * (1 - r.drawdownStop)) s.entryPaused = true;
  }
  const confirmations = {},
    decisions = [];
  for (const c of candidates) {
    const reasons = [...c.reasons],
      last = s.confirmations[c.id];
    const continuing =
      complete &&
      c.qualified &&
      last &&
      at - last.lastAt <= r.maxConfirmationGap;
    const confirmation = {
      firstAt: continuing ? last.firstAt : at,
      lastAt: at,
      scans: continuing ? last.scans + 1 : 1,
    };
    if (complete && c.qualified) confirmations[c.id] = confirmation;
    if (!complete) reasons.push("Incomplete wallet coverage; entries held");
    if (!continuing || at - confirmation.firstAt < r.confirmationSeconds)
      reasons.push("Awaiting confirmation in a later complete scan");
    if (s.entryPaused) reasons.push("Drawdown stop is active");
    if (!s.equityComplete)
      reasons.push("An open position has no current liquidation mark");
    if (s.usedConditions.includes(c.condition))
      reasons.push("This condition has already been copied");
    const eventExposure = sum(
      s.positions.filter((p) => p.eventSlug === c.eventSlug).map((p) => p.cost),
    );
    const exposure = sum(s.positions.map((p) => p.cost));
    const budget = Math.min(
      r.stake,
      s.cash,
      r.maxExposure - exposure,
      r.maxEventExposure - eventExposure,
    );
    if (!c.eventSlug) reasons.push("Event identity unavailable");
    if (budget < 1) reasons.push("Cash or exposure limit reached");
    let priced;
    if (!reasons.length) {
      const market = markets[c.condition];
      const mapped = market?.tokens?.find(
        (t) => t.token === c.token && t.outcome === c.outcome,
      );
      if (!mapped || ![0, 1].includes(mapped.index))
        reasons.push("Verified token-to-payout mapping unavailable");
      else {
        priced = priceCopyEntry(c, books[c.token], market, budget, at, r);
        reasons.push(...priced.reasons);
        if (!reasons.length) {
          const f = priced.fill,
            position = {
              id: c.id,
              condition: c.condition,
              token: c.token,
              title: c.title,
              outcome: c.outcome,
              outcomeIndex: mapped.index,
              eventSlug: c.eventSlug,
              shares: f.shares,
              cost: f.cash,
              entryPrice: f.average,
              entryFee: f.fee,
              entrySlippage: f.slippage,
              openedAt: at,
              value: 0,
              markedAt: at,
              markStatus: "current",
              entryReceipt: {
                book: books[c.token],
                market,
                fill: f,
                backers: c.backers,
                confirmedSince: confirmation.firstAt,
              },
            };
          const mark = fillCopyLevels(
            books[c.token].bids,
            f.shares,
            market.fee,
            r.slippagePerShare,
            "sell",
          );
          if (!mark)
            reasons.push("Insufficient depth to mark the copied position");
          else {
            position.value = mark.cash;
            s.cash -= f.cash;
            s.positions.push(position);
            s.usedConditions.push(c.condition);
            s.counters.entries++;
            if (value() <= s.peakEquity * (1 - r.drawdownStop))
              s.entryPaused = true;
          }
        }
      }
    }
    const decision = {
      id: `${at}:${c.id}`,
      at,
      condition: c.condition,
      token: c.token,
      title: c.title,
      outcome: c.outcome,
      backerCount: c.backerCount,
      effectiveBackers: c.effectiveBackers,
      avgEntry: c.avgEntry,
      status: reasons.length ? "held" : "simulated-entry",
      reasons,
      cost: reasons.length ? null : priced.fill.cash,
    };
    decisions.push(decision);
    for (const reason of new Set(reasons))
      s.counters.holds[reason] = (s.counters.holds[reason] || 0) + 1;
  }
  s.confirmations = confirmations;
  s.candidates = candidates;
  s.lastDecisions = decisions;
  s.decisions = [...s.decisions, ...decisions].slice(-500);
  s.counters.candidates += decisions.length;
  s.equity = value();
  s.curve = [
    ...s.curve,
    { at, equity: s.equity, cash: s.cash, complete: s.equityComplete },
  ].slice(-2016);
  if (s.cash < -1e-7 || !finite(s.equity))
    throw new Error("Simulation accounting invariant failed");
  validateCopyStudyState(s);
  return s;
}
