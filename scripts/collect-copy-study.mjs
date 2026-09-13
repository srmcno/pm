import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPY_MODEL,
  createCopyStudy,
  parseCopyTrade,
  buildCopyCandidates,
  advanceCopyStudy,
  validateCopyStudyState,
} from "./copy-study-core.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function publicGet(url) {
  if (
    ![
      "data-api.polymarket.com",
      "clob.polymarket.com",
      "gamma-api.polymarket.com",
    ].includes(new URL(url).hostname)
  )
    throw new Error("Unexpected public source");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "MoffittMoney forward research" },
    });
    if (response.ok) {
      const text = await response.text();
      if (text.length > 8e6) throw new Error("Public response too large");
      return JSON.parse(text);
    }
    if (!attempt && (response.status === 429 || response.status >= 500)) {
      await new Promise((r) => setTimeout(r, 750));
      continue;
    }
    throw new Error(`HTTP ${response.status}`);
  }
}
export async function collectCopyActivity(wallet, start, end, get = publicGet) {
  const trades = [],
    cursors = new Set();
  let cursor,
    duplicates = 0;
  const ids = new Set();
  for (let page = 0; page < 8; page++) {
    const query = new URLSearchParams({
      user: wallet,
      type: "TRADE",
      start: String(start),
      end: String(end),
      limit: "500",
      sort_by: "TIMESTAMP",
      sort_direction: "DESC",
    });
    if (cursor) query.set("cursor", cursor);
    const d = await get("https://data-api.polymarket.com/v2/activity?" + query);
    const observedAt = Date.now() / 1000;
    if (
      !Array.isArray(d?.data) ||
      d.data.length > 500 ||
      typeof d.pagination?.has_more !== "boolean"
    )
      throw new Error("Invalid activity page");
    for (const raw of d.data) {
      const t = parseCopyTrade(raw, wallet, observedAt, start, end);
      if (!t) throw new Error("Invalid trade row; coverage is incomplete");
      if (ids.has(t.id)) {
        duplicates++;
        continue;
      }
      ids.add(t.id);
      trades.push(t);
    }
    if (!d.pagination.has_more)
      return {
        wallet,
        trades,
        complete: true,
        pages: page + 1,
        duplicates,
        receivedAt: observedAt,
      };
    cursor = d.pagination.next_cursor;
    if (
      typeof cursor !== "string" ||
      !cursor ||
      cursor.length > 8192 ||
      cursors.has(cursor)
    )
      throw new Error("Missing or repeated activity cursor");
    cursors.add(cursor);
  }
  throw new Error("Activity exceeds the bounded 4000-trade scan; entries held");
}
const parseArray = (v) => (typeof v === "string" ? JSON.parse(v) : v);
export function normalizeCopyMarket(condition, clob, gamma) {
  if (!Array.isArray(gamma) || gamma.length !== 1)
    throw new Error("Market definition ambiguous");
  const g = gamma[0],
    tokens = parseArray(g.clobTokenIds),
    outcomes = parseArray(g.outcomes);
  if (
    clob?.c?.toLowerCase() !== condition ||
    g.conditionId?.toLowerCase() !== condition ||
    !Array.isArray(tokens) ||
    tokens.length !== 2 ||
    new Set(tokens).size !== 2 ||
    !tokens.every((t) => typeof t === "string" && /^\d{1,100}$/.test(t)) ||
    !Array.isArray(outcomes) ||
    outcomes.length !== 2 ||
    new Set(outcomes).size !== 2 ||
    !outcomes.every((o) => typeof o === "string" && o) ||
    !Array.isArray(clob.t) ||
    clob.t.length !== 2 ||
    !tokens.every(
      (t, i) =>
        clob.t.filter((c) => c.t === t && c.o === outcomes[i]).length === 1,
    )
  )
    throw new Error("Condition, token or payout-index mapping mismatch");
  // Gamma's outcome/token arrays define outcome indices; CLOB array order is ignored.
  return {
    condition,
    tokens: tokens.map((token, index) => ({
      token,
      index,
      outcome: outcomes[index],
    })),
    fee: clob.fd,
    accepting:
      clob.ao === true &&
      g.closed === false &&
      g.acceptingOrders === true &&
      g.enableOrderBook === true,
    minShares: Number(clob.mos),
    tick: Number(clob.mts),
    receivedAt: Date.now() / 1000,
    mappingSource:
      "Gamma clobTokenIds/outcomes corroborated by exact CLOB token and outcome",
  };
}
export function normalizeCopyBook(
  token,
  condition,
  d,
  receivedAt = Date.now() / 1000,
) {
  if (
    d?.asset_id !== token ||
    d.market?.toLowerCase() !== condition ||
    (typeof d.timestamp !== "string" && typeof d.timestamp !== "number")
  )
    throw new Error("Book identity mismatch");
  const side = (levels, asc) => {
    if (!Array.isArray(levels) || levels.length > 5000)
      throw new Error("Invalid depth");
    const rows = levels.map((l) => [Number(l.price), Number(l.size)]);
    if (
      rows.some(
        (r) => !r.every(Number.isFinite) || r[0] <= 0 || r[0] >= 1 || r[1] <= 0,
      )
    )
      throw new Error("Invalid book level");
    return rows.sort((a, b) => (asc ? a[0] - b[0] : b[0] - a[0])).slice(0, 100);
  };
  return {
    token,
    condition,
    receivedAt,
    providerAt: Number(d.timestamp) / 1000,
    hash: d.hash || null,
    asks: side(d.asks, true),
    bids: side(d.bids, false),
  };
}
async function batches(items, fn, size = 3) {
  for (let i = 0; i < items.length; i += size)
    await Promise.all(items.slice(i, i + size).map(fn));
}
export async function collectCopyStudy(state, get = publicGet) {
  validateCopyStudyState(state);
  const end = Math.floor(Date.now() / 1000),
    start = end - state.rules.windowHours * 3600;
  const errors = [],
    coverage = [],
    fresh = [];
  await batches(state.cohort, async (w) => {
    try {
      const result = await collectCopyActivity(w.wallet, start, end, get);
      fresh.push(...result.trades);
      coverage.push({
        ...result,
        trades: undefined,
        count: result.trades.length,
      });
    } catch (e) {
      errors.push({ source: `Activity: ${w.name}`, message: e.message });
      coverage.push({ wallet: w.wallet, complete: false, count: 0 });
    }
  });
  const complete =
    coverage.length === state.cohort.length &&
    coverage.every((c) => c.complete);
  // Only a completely read wallet replaces its window. Preserve first-observed
  // timestamps across overlap reads; incomplete activity cannot qualify entries.
  const old = new Map((state.activity || []).map((t) => [t.id, t]));
  const activity = fresh.map((t) =>
    old.has(t.id)
      ? { ...t, firstObservedAt: old.get(t.id).firstObservedAt }
      : t,
  );
  const candidates = buildCopyCandidates(
    activity,
    state.cohort,
    Date.now() / 1000,
    state.rules,
  );
  const markets = {},
    books = {},
    resolutions = {};
  const wanted = new Map(
    [
      ...state.positions,
      ...candidates.filter((c) => c.qualified).slice(0, 12),
    ].map((p) => [p.token, p]),
  );
  await batches(
    [...new Set([...wanted.values()].map((p) => p.condition))],
    async (condition) => {
      try {
        const [c, g] = await Promise.all([
          get(`https://clob.polymarket.com/clob-markets/${condition}`),
          get(
            `https://gamma-api.polymarket.com/markets?condition_ids=${condition}`,
          ),
        ]);
        markets[condition] = normalizeCopyMarket(condition, c, g);
      } catch (e) {
        errors.push({ source: `Market ${condition}`, message: e.message });
      }
      if (state.positions.some((p) => p.condition === condition)) {
        try {
          const d = await get(
            `https://data-api.polymarket.com/v2/resolutions?condition=${condition}`,
          );
          if (
            !Array.isArray(d?.data) ||
            d.data.length > 1 ||
            d.data.some((r) => r.condition_id?.toLowerCase() !== condition)
          )
            throw new Error("Resolution identity mismatch");
          resolutions[condition] = d.data[0] || null;
        } catch (e) {
          errors.push({
            source: `Resolution ${condition}`,
            message: e.message,
          });
        }
      }
    },
  );
  // Books come after activity and metadata; fills use current asks, never wallet prints.
  await batches([...wanted.values()], async (p) => {
    try {
      books[p.token] = normalizeCopyBook(
        p.token,
        p.condition,
        await get(`https://clob.polymarket.com/book?token_id=${p.token}`),
      );
    } catch (e) {
      errors.push({ source: `Book: ${p.title}`, message: e.message });
    }
  });
  const next = advanceCopyStudy(state, {
    at: Date.now() / 1000,
    complete,
    candidates,
    books,
    markets,
    resolutions,
    errors,
    coverage,
  });
  next.activity = activity;
  next.activityWindow = { start, end, complete };
  return next;
}
export function copyStudySnapshot(state) {
  validateCopyStudyState(state);
  const { activity, confirmations, usedConditions, ...snapshot } = state;
  const concise = ({ entryReceipt, markReceipt, resolution, ...p }) => p;
  return {
    ...snapshot,
    generatedAt: state.updatedAt,
    positions: state.positions.map(concise),
    closed: state.closed.map(concise),
    status: state.entryPaused
      ? "drawdown-stop"
      : state.activityWindow?.complete
        ? "observing"
        : "coverage-held",
    note: "Public Polymarket international activity; simulated fills, no order connection. Rankings and rules are frozen at study creation.",
  };
}
async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value) + "\n");
  await rename(file + ".tmp", file);
}
export async function syncCopyDecisions(directory, decisions) {
  const groups = new Map();
  for (const d of decisions) {
    const date = new Date(d.at * 1000).toISOString().slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(d);
  }
  for (const [date, rows] of groups) {
    const file = path.join(directory, date + ".jsonl");
    let existing = [];
    try {
      existing = (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const seen = new Set(existing.map((d) => d.id)),
      missing = rows.filter((d) => !seen.has(d.id));
    if (!missing.length) continue;
    await mkdir(directory, { recursive: true });
    // Replace a complete daily journal atomically; interrupted writes leave the
    // prior journal intact. The next run reconciles from committed state first.
    await writeFile(
      file + ".tmp",
      [...existing, ...missing].map((d) => JSON.stringify(d)).join("\n") + "\n",
    );
    await rename(file + ".tmp", file);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arg = (name, fallback) =>
    process.argv.includes(name)
      ? path.resolve(process.argv[process.argv.indexOf(name) + 1])
      : path.join(root, fallback);
  const file = arg("--state", "data/copy-forward/state.json"),
    output = arg("--output", "dashboard/data/copy-study.json");
  await mkdir(path.dirname(file), { recursive: true });
  if (process.env.MOFFITT_COPY_LOCK_HELD !== "1") {
    const result = spawnSync(
      "python3",
      [
        path.join(root, "scripts/copy-study-lock.py"),
        file + ".flock",
        process.execPath,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  {
    let state;
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const raw = await readFile(path.join(root, "data/analyzed.json"), "utf8");
      state = createCopyStudy(
        JSON.parse(raw),
        createHash("sha256").update(raw).digest("hex"),
        Date.now() / 1000,
      );
      await atomic(file, state);
    }
    if (state.modelVersion !== COPY_MODEL)
      throw new Error("Study migration required; existing account preserved");
    const journal = path.join(path.dirname(file), "decisions");
    await syncCopyDecisions(journal, state.decisions);
    const next = await collectCopyStudy(state);
    // State is the canonical ledger. Publishing can be safely retried from it.
    await atomic(file, next);
    await atomic(output, copyStudySnapshot(next));
    await syncCopyDecisions(journal, next.decisions);
    console.log(
      JSON.stringify({
        status: next.activityWindow.complete ? "complete" : "coverage-held",
        wallets: next.cohort.length,
        covered: next.coverage.filter((c) => c.complete).length,
        candidates: next.candidates.length,
        positions: next.positions.length,
        cash: next.cash,
        equity: next.equity,
        errors: next.errors,
      }),
    );
    if (!next.activityWindow.complete) process.exitCode = 1;
  }
}
