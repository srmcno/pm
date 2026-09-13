const finite = Number.isFinite;
const address = (v) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const array = (a, check) => Array.isArray(a) && a.every(check);
export function validCopySnapshot(d) {
  const p = d?.paper;
  return !!(
    d?.schemaVersion === 1 &&
    d.realEnabled === false &&
    finite(d.generatedAt) &&
    finite(d.analytics?.observedAt) &&
    array(
      d.analytics.wallets,
      (w) =>
        w &&
        address(w.wallet) &&
        typeof w.name === "string" &&
        typeof w.tracked === "boolean" &&
        array(
          w.history,
          (p) => Array.isArray(p) && p.length === 2 && p.every(finite),
        ),
    ) &&
    finite(d.consensus?.observedAt) &&
    array(
      d.consensus.signals,
      (s) =>
        s &&
        typeof s.title === "string" &&
        array(
          s.backers,
          (b) =>
            b &&
            address(b.wallet) &&
            typeof b.name === "string" &&
            finite(b.netUsd),
        ),
    ) &&
    p &&
    p.status === "paused" &&
    p.feeComplete === false &&
    p.settlementVerified === false &&
    [
      "equity",
      "cash",
      "bankrollStart",
      "updatedAt",
      "realizedPnl",
      "createdAt",
    ].every((k) => finite(p[k])) &&
    array(
      p.positions,
      (t) => t && typeof t.question === "string" && finite(t.costUsd),
    ) &&
    array(
      p.closed,
      (t) => t && typeof t.question === "string" && finite(t.pnl),
    ) &&
    array(
      p.equityCurve,
      (c) => finite(c.t) && c.t >= p.createdAt && finite(c.equity),
    )
  );
}
export async function fetchWalletActivity(
  wallet,
  fetcher = fetch,
  now = Date.now() / 1000,
) {
  if (!address(wallet)) throw new Error("Invalid wallet address");
  if (!finite(now)) throw new Error("Invalid evaluation time");
  const response = await fetcher(
    `https://data-api.polymarket.com/activity?user=${wallet}&type=TRADE&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`,
    { signal: AbortSignal.timeout(10000) },
  );
  if (!response.ok)
    throw new Error(`Public activity unavailable (HTTP ${response.status})`);
  const data = await response.json();
  if (!Array.isArray(data) || data.length > 50)
    throw new Error("Invalid activity response");
  const rows = [],
    seen = new Set();
  let omitted = 0;
  for (const t of data) {
    // Use the named outcome and token identity, never the API's occasional 999 sentinel.
    if (
      !t ||
      !address(t.proxyWallet) ||
      t.proxyWallet.toLowerCase() !== wallet.toLowerCase() ||
      t.type !== "TRADE" ||
      !/^0x[0-9a-f]{64}$/i.test(t.transactionHash) ||
      typeof t.asset !== "string" ||
      !/^[0-9]{1,100}$/.test(t.asset) ||
      !finite(t.size) ||
      t.size <= 0 ||
      !["BUY", "SELL"].includes(t.side) ||
      !finite(t.timestamp) ||
      t.timestamp > now + 60 ||
      t.timestamp <= 0 ||
      !finite(t.price) ||
      t.price < 0 ||
      t.price > 1 ||
      !finite(t.usdcSize) ||
      t.usdcSize < 0 ||
      typeof t.outcome !== "string" ||
      !t.outcome.trim() ||
      typeof t.title !== "string"
    ) {
      omitted++;
      continue;
    }
    const key = [
      t.transactionHash,
      t.asset,
      t.side,
      t.timestamp,
      t.usdcSize,
      t.price,
      t.size,
      t.outcome,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      at: t.timestamp,
      side: t.side,
      title: t.title,
      outcome: t.outcome,
      price: t.price,
      amount: t.usdcSize,
    });
  }
  return {
    rows: rows.sort((a, b) => b.at - a.at),
    omitted,
    receivedAt: Date.now() / 1000,
  };
}
