// Equal-quantity, fully funded complementary contracts. No execution path.
import {
  fill,
  liquidation,
  numeric,
  round,
  POLICY,
} from "./prediction-core.mjs";
export const PAIR_VERSION = "2026-09-13-paired-contracts-v1";
const finite = Number.isFinite;
export function matchingIdentity(a, b) {
  const ids = (x) => [...(x?.participants || [])].sort();
  return !!(
    a?.kind === "full-game-moneyline" &&
    b?.kind === a.kind &&
    a.provider === "sportradar" &&
    b.provider === a.provider &&
    a.league === b.league &&
    finite(a.startAt) &&
    a.startAt === b.startAt &&
    ids(a).length === 2 &&
    ids(b).length === 2 &&
    new Set(ids(a)).size === 2 &&
    new Set(ids(b)).size === 2 &&
    ids(a).every(
      (id, i) => typeof id === "string" && id.length > 8 && id === ids(b)[i],
    ) &&
    ids(a).includes(a.yesId) &&
    ids(b).includes(b.yesId)
  );
}
export function evaluatePair(a, b, accounts, now) {
  if (!matchingIdentity(a.identity, b.identity) || a.venue === b.venue)
    return null;
  const same = a.identity.yesId === b.identity.yesId;
  const options = [
    ["yes", same ? "no" : "yes"],
    ["no", same ? "yes" : "no"],
  ];
  const reasons = [];
  if ([a, b].some((m) => m.status !== "open" || m.sourceError))
    reasons.push("Both contracts must be open and readable.");
  if (
    [a, b].some(
      (m) =>
        !finite(m.quoteAt) ||
        !finite(m.observedAt) ||
        now - m.quoteAt > 30 ||
        now - m.quoteAt < -2 ||
        now - m.observedAt > 30 ||
        now - m.observedAt < -2,
    )
  )
    reasons.push("Both books must be no more than 30 seconds old.");
  if (Math.abs(a.observedAt - b.observedAt) > 2)
    reasons.push("Book retrievals are more than two seconds apart.");
  if (now >= a.identity.startAt)
    reasons.push("The game has started; this pregame comparison is closed.");
  if ([a, b].some((m) => !finite(m.feeRate) || m.feeRate < 0 || m.feeRate > 1))
    reasons.push("Current fees are unavailable.");
  if ([a, b].some((m) => typeof m.rules !== "string" || !m.rules.trim()))
    reasons.push("Both complete contract rules must be available for review.");
  if (
    [a, b].some(
      (m) =>
        !accounts?.[m.venue] ||
        !finite(accounts[m.venue].cash) ||
        accounts[m.venue].cash < 0,
    )
  )
    reasons.push("Both venue cash balances are required.");
  if (
    [a, b].some(
      (m) =>
        accounts?.[m.venue]?.halted ||
        accounts?.[m.venue]?.markComplete === false,
    )
  )
    reasons.push("An account is halted or has an incomplete position mark.");
  const legs = [];
  for (const [sideA, sideB] of options) {
    const qa = Math.max(1, Math.ceil(numeric(a.minQuantity) || 1)),
      qb = Math.max(1, Math.ceil(numeric(b.minQuantity) || 1)),
      minimum = Math.max(qa, qb);
    for (let q = minimum; q <= 20; q++) {
      const fa = fill(a.sides?.[sideA]?.asks, q, a.feeRate),
        fb = fill(b.sides?.[sideB]?.asks, q, b.feeRate);
      if (!fa || !fb) continue;
      // Same 2% per-venue allocation as directional research; no cross-account cash netting.
      const budget = (m) => {
        const ac = accounts?.[m.venue];
        return Math.max(
          0,
          Math.min(
            ac?.cash || 0,
            (ac?.equity || 0) * POLICY.maxStakePct,
            (ac?.equity || 0) * POLICY.maxExposurePct -
              (ac?.positions || []).reduce((sum, p) => sum + p.cost, 0),
          ),
        );
      };
      if (fa.cost > budget(a) || fb.cost > budget(b)) continue;
      const cost = round(fa.cost + fb.cost),
        normalNet = round(q - cost);
      const unwindA = liquidation(
        a.sides?.[sideA]?.bids || [
          [a.sides?.[sideA]?.bid, a.sides?.[sideA]?.bidSize],
        ],
        q,
        a.feeRate,
      );
      const unwindB = liquidation(
        b.sides?.[sideB]?.bids || [
          [b.sides?.[sideB]?.bid, b.sides?.[sideB]?.bidSize],
        ],
        q,
        b.feeRate,
      );
      legs.push({
        quantity: q,
        cost,
        normalNet,
        normalNetPerContract: round(normalNet / q),
        fees: round(fa.fees + fb.fees),
        slippage: round(fa.slippage + fb.slippage),
        principal: round(fa.principal + fb.principal),
        legs: [
          { venue: a.venue, marketId: a.id, side: sideA, ...fa },
          { venue: b.venue, marketId: b.id, side: sideB, ...fb },
        ],
        failedHedgeLoss:
          unwindA && unwindB
            ? round(
                Math.max(
                  fa.cost - unwindA.proceeds,
                  fb.cost - unwindB.proceeds,
                ),
              )
            : null,
      });
    }
  }
  // Per-contract net makes quantities comparable. More size is not a better gap.
  legs.sort(
    (x, y) =>
      y.normalNetPerContract - x.normalNetPerContract ||
      x.quantity - y.quantity,
  );
  const best = legs[0] || null;
  if (!best)
    reasons.push(
      "No equal whole-contract package fits depth and both risk budgets.",
    );
  const settlement = {
    equivalent: false,
    reviewStatus: "unverified",
    minimumPayoutPerContract: 0,
    maximumPayoutPerContract: 2,
    reason:
      "A matching game does not prove equivalent settlement. Postponement, cancellation and other exceptional payouts require separate review on each venue.",
    scenarios: [
      { name: "Selected team wins normally", minimum: 1, maximum: 1 },
      { name: "Selected team loses normally", minimum: 1, maximum: 1 },
      {
        name: "Tie or other exceptional settlement (unverified)",
        minimum: 0,
        maximum: 2,
      },
    ],
  };
  return {
    version: PAIR_VERSION,
    id: [a.id, b.id].sort().join("|"),
    title: a.identity.title,
    league: a.identity.league,
    startAt: a.identity.startAt,
    observedAt: Math.min(a.observedAt, b.observedAt),
    fresh: reasons.length === 0,
    identityVerified: true,
    markets: [a, b],
    best,
    settlement,
    worstCaseNet: best ? round(-best.cost) : null,
    isArbitrage: false,
    executable: false,
    status: reasons.length
      ? "held"
      : best.normalNet <= 0
        ? "costs-exceed-payout"
        : "conditional-gap",
    reasons,
    executionNote:
      "Two venues cannot fill atomically. Unwind loss is a current-book estimate, not a bound during an outage.",
  };
}
