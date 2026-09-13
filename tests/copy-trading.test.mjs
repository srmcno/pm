import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validCopySnapshot,
  fetchWalletActivity,
} from "../dashboard/copy-core.mjs";
const wallet = "0x" + "1".repeat(40),
  now = 1700000000;
const row = (more = {}) => ({
  proxyWallet: wallet,
  type: "TRADE",
  transactionHash: "0x" + "a".repeat(64),
  asset: "1234",
  size: 10,
  usdcSize: 5,
  price: 0.5,
  outcomeIndex: 999,
  outcome: "Team A",
  title: "Team A vs Team B",
  timestamp: now - 30,
  side: "BUY",
  ...more,
});
const fetcher = (rows) => async () => ({ ok: true, json: async () => rows });
test("activity binds to the requested wallet and the named outcome, never index999", async () => {
  const d = await fetchWalletActivity(wallet, fetcher([row()]), now);
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].outcome, "Team A");
  for (const wrong of [
    { proxyWallet: "0x" + "2".repeat(40) },
    { type: "REDEEM" },
    { transactionHash: null },
    { asset: null },
    { size: 0 },
    { timestamp: now + 61 },
    { price: null },
  ]) {
    const r = await fetchWalletActivity(wallet, fetcher([row(wrong)]), now);
    assert.equal(r.rows.length, 0);
    assert.equal(r.omitted, 1);
  }
});
test("activity deduplicates repeated events but retains distinct fills and named outcomes", async () => {
  const d = await fetchWalletActivity(
    wallet,
    fetcher([
      row(),
      row(),
      row({ price: 0.6 }),
      row({ size: 11 }),
      row({ outcome: "Team B", asset: "5678" }),
    ]),
    now,
  );
  assert.equal(d.rows.length, 4);
});
test("invalid wallet, oversized responses and public-source errors are explicit", async () => {
  await assert.rejects(
    fetchWalletActivity("not-wallet", fetcher([]), now),
    /address/,
  );
  await assert.rejects(
    fetchWalletActivity(wallet, fetcher(Array.from({ length: 51 }, row)), now),
    /response/,
  );
  await assert.rejects(
    fetchWalletActivity(wallet, async () => ({ ok: false, status: 429 }), now),
    /429/,
  );
});
test("copy publication preserves complete ledger and starts at its verified funding baseline", () => {
  const d = JSON.parse(
    readFileSync(
      new URL("../dashboard/data/copy-trading.json", import.meta.url),
    ),
  );
  const raw = JSON.parse(
    readFileSync(new URL("../data/paper/state.json", import.meta.url)),
  );
  assert.equal(validCopySnapshot(d), true);
  assert.deepEqual(d.paper.closed, raw.closed);
  assert.deepEqual(d.paper.positions, raw.positions);
  assert.equal(d.paper.equityCurve[0].equity, raw.bankrollStart);
  assert.equal(d.paper.equityCurve[0].cash, raw.bankrollStart);
  assert.equal(d.paper.equityCurve[0].t, d.paper.curveStartAt);
  assert.ok(d.paper.curveStartAt >= d.paper.createdAt);
  assert.equal(d.paper.feeComplete, false);
  assert.equal(d.paper.settlementVerified, false);
  assert.equal(d.paper.status, "paused");
});
test("missing wallet percentages stay missing in publication", () => {
  const d = JSON.parse(
    readFileSync(
      new URL("../dashboard/data/copy-trading.json", import.meta.url),
    ),
  );
  const raw = JSON.parse(
    readFileSync(new URL("../data/analyzed.json", import.meta.url)),
  );
  for (const w of raw.wallets.filter((w) => w.winDayRate == null))
    assert.equal(
      d.analytics.wallets.find((v) => v.wallet === w.wallet).winDayRate,
      null,
    );
});
test("copy contracts reject real activation and malformed ledger rows", () => {
  const d = JSON.parse(
    readFileSync(
      new URL("../dashboard/data/copy-trading.json", import.meta.url),
    ),
  );
  assert.equal(validCopySnapshot({ ...d, realEnabled: true }), false);
  assert.equal(
    validCopySnapshot({ ...d, paper: { ...d.paper, closed: [{}] } }),
    false,
  );
});
