import { createHash } from "node:crypto";
import {
  BASE,
  get,
  discoverPolymarket,
  normalizePolymarket,
  normalizeKalshi,
} from "./venues.mjs";
import {
  PAIR_VERSION,
  evaluatePair,
} from "../../dashboard/prediction-arbitrage.mjs";
const enc = encodeURIComponent,
  hash = (text) =>
    createHash("sha256")
      .update(text || "")
      .digest("hex");
const leagues = {
  nfl: { series: "KXNFLGAME", type: "football_team" },
  mlb: { series: "KXMLBGAME", type: "baseball_team" },
};
const provider = (team) =>
  team?.providerIds?.find((p) => p.provider === "PROVIDER_SPORTRADAR")
    ?.providerId;
export function polymarketIdentity(raw) {
  const yes = raw.marketSides?.find((s) => s.long === true)?.team,
    no = raw.marketSides?.find((s) => s.long === false)?.team;
  if (
    raw.sportsMarketTypeV2 !== "SPORTS_MARKET_TYPE_MONEYLINE" ||
    !leagues[yes?.league] ||
    no?.league !== yes.league ||
    !provider(yes) ||
    !provider(no)
  )
    return null;
  return {
    kind: "full-game-moneyline",
    provider: "sportradar",
    league: yes.league,
    participants: [provider(yes), provider(no)],
    yesId: provider(yes),
    startAt: Date.parse(raw.gameStartTime) / 1000,
    title: `${yes.name} vs ${no.name}`,
    labels: { [provider(yes)]: yes.name, [provider(no)]: no.name },
  };
}
export function kalshiIdentity(raw, milestone, targets, league) {
  const type = leagues[league]?.type,
    detail = milestone?.details;
  if (
    !type ||
    detail?.league?.toLowerCase() !== league ||
    detail.main_game_event_ticker !== raw.event_ticker
  )
    return null;
  const ids = [detail.away_team_id, detail.home_team_id],
    yes = raw.custom_strike?.[type];
  if (
    !ids.includes(yes) ||
    ids.some(
      (id) =>
        targets[id]?.id !== id ||
        targets[id]?.type !== type ||
        targets[id]?.details?.league?.toLowerCase() !== league ||
        !targets[id]?.source_id,
    )
  )
    return null;
  return {
    kind: "full-game-moneyline",
    provider: "sportradar",
    league,
    participants: ids.map((id) => targets[id].source_id),
    yesId: targets[yes].source_id,
    startAt: Date.parse(milestone.start_date) / 1000,
    milestoneId: milestone.id,
    title: milestone.title,
    evidence: {
      milestone: `${BASE.kalshi}/milestones?related_event_ticker=${enc(raw.event_ticker)}`,
      targets: ids.map((id) => `${BASE.kalshi}/structured_targets/${enc(id)}`),
    },
  };
}
export async function collectPairs(
  accounts,
  deadline = Date.now() / 1000 + 180,
) {
  if (Date.now() / 1000 >= deadline)
    throw new Error("Paired scan deferred: collection time budget exhausted.");
  const errors = [],
    pairs = [],
    cache = new Map(),
    startedAt = Date.now() / 1000;
  const cached = async (url) => {
    if (!cache.has(url)) cache.set(url, get(url));
    return cache.get(url);
  };
  const discovery = await discoverPolymarket();
  errors.push(
    ...(discovery.errors || []).map((message) => ({
      source: "Polymarket discovery",
      message,
    })),
  );
  const pm = discovery.rows
    .map((r) => ({ ...r, identity: polymarketIdentity(r.raw) }))
    .filter(
      (r) =>
        r.identity &&
        r.identity.startAt > startedAt &&
        r.identity.startAt < startedAt + 7 * 86400,
    )
    .sort((a, b) => a.identity.startAt - b.identity.startAt)
    .slice(0, 24);
  const matched = new Set(),
    games = new Set();
  for (const [league, config] of Object.entries(leagues)) {
    if (Date.now() / 1000 > deadline) break;
    try {
      const krows = [];
      let cursor = "";
      for (let page = 0; page < 2; page++) {
        const d = await get(
          `${BASE.kalshi}/markets?series_ticker=${config.series}&status=open&limit=200${cursor ? "&cursor=" + enc(cursor) : ""}`,
        );
        if (!Array.isArray(d.markets))
          throw new Error("Invalid moneyline discovery response");
        krows.push(...d.markets);
        if (!d.cursor || d.cursor === cursor) break;
        cursor = d.cursor;
      }
      const events = [...new Set(krows.map((r) => r.event_ticker))].slice(
        0,
        48,
      );
      for (let i = 0; i < events.length && Date.now() / 1000 < deadline; i += 4)
        await Promise.all(
          events.slice(i, i + 4).map(async (eventId) => {
            try {
              const ms = await get(
                `${BASE.kalshi}/milestones?limit=10&related_event_ticker=${enc(eventId)}`,
              );
              if (ms.cursor) throw new Error("Milestone page incomplete");
              const milestones = (ms.milestones || []).filter(
                (m) => m.details?.main_game_event_ticker === eventId,
              );
              if (milestones.length !== 1) return;
              const milestone = milestones[0],
                at = Date.parse(milestone.start_date) / 1000;
              const sameTime = pm.filter(
                (p) =>
                  p.identity.league === league && p.identity.startAt === at,
              );
              if (!sameTime.length) return;
              const ids = [
                  milestone.details.away_team_id,
                  milestone.details.home_team_id,
                ],
                targets = {};
              await Promise.all(
                ids.map(async (id) => {
                  targets[id] = (
                    await cached(`${BASE.kalshi}/structured_targets/${enc(id)}`)
                  ).structured_target;
                }),
              );
              for (const kr of krows.filter(
                (r) => r.event_ticker === eventId,
              )) {
                if (Date.now() / 1000 >= deadline) break;
                const ki = kalshiIdentity(kr, milestone, targets, league);
                if (!ki) continue;
                const pr = sameTime.find((p) =>
                  ki.participants.every((id) =>
                    p.identity.participants.includes(id),
                  ),
                );
                const pairId = pr && `${pr.raw.slug}|${kr.ticker}`;
                if (!pr || matched.has(pairId)) continue;
                matched.add(pairId);
                games.add(pr.raw.slug);
                const [ev, ser, fees] = await Promise.all([
                  cached(`${BASE.kalshi}/events/${enc(eventId)}`),
                  cached(`${BASE.kalshi}/series/${config.series}`),
                  cached(
                    `${BASE.kalshi}/events/fee_changes?event_ticker=${enc(eventId)}&limit=1000`,
                  ),
                ]);
                if (fees.cursor)
                  throw new Error("Fee override page incomplete");
                const [praw, kraw] = await Promise.all([
                  get(`${BASE.polymarket}/market/slug/${enc(pr.raw.slug)}`),
                  get(`${BASE.kalshi}/markets/${enc(kr.ticker)}`),
                ]);
                const requestStartedAt = Date.now() / 1000;
                const [a, b] = await Promise.all([
                  get(
                    `${BASE.polymarket}/markets/${enc(pr.raw.slug)}/book`,
                  ).then((book) =>
                    normalizePolymarket(
                      praw.market,
                      pr.event,
                      book,
                      Date.now() / 1000,
                    ),
                  ),
                  get(
                    `${BASE.kalshi}/markets/${enc(kr.ticker)}/orderbook?depth=10`,
                  ).then((book) =>
                    normalizeKalshi(
                      kraw.market,
                      ev.event,
                      ser.series,
                      fees.event_fee_changes,
                      book,
                      Date.now() / 1000,
                      milestone,
                    ),
                  ),
                ]);
                a.identity = polymarketIdentity(praw.market);
                b.identity = kalshiIdentity(
                  kraw.market,
                  milestone,
                  targets,
                  league,
                );
                a.ruleHash = hash(a.rules);
                b.ruleHash = hash(b.rules);
                a.requestStartedAt = b.requestStartedAt = requestStartedAt;
                const result = evaluatePair(a, b, accounts, Date.now() / 1000);
                if (result) pairs.push(result);
              }
            } catch (e) {
              errors.push({ eventId, message: e.message });
            }
          }),
        );
    } catch (e) {
      errors.push({ league, message: e.message });
    }
  }
  // Keep the original book times and reevaluate age after the whole bounded scan.
  const publishedAt = Date.now() / 1000;
  const dated = pairs
    .map((p) => evaluatePair(...p.markets, accounts, publishedAt))
    .filter(Boolean);
  return {
    version: PAIR_VERSION,
    generatedAt: publishedAt,
    startedAt,
    pairs: dated.sort(
      (a, b) =>
        (b.best?.normalNetPerContract ?? -9) -
        (a.best?.normalNetPerContract ?? -9),
    ),
    scope: {
      leagues: Object.keys(leagues),
      polymarketGames: pm.length,
      matchedGames: games.size,
      matchedContracts: matched.size,
      maxPolymarketGames: 24,
      maxKalshiEventsPerLeague: 48,
      description:
        "Bounded upcoming full-game NFL and MLB moneylines. Provider team IDs and exact starts match; both team-strike books and complementary outcome orientations are checked.",
    },
    errors,
    realEnabled: false,
    status: pairs.length ? (errors.length ? "partial" : "ok") : "unavailable",
  };
}
