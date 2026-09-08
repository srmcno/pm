// Shared by the browser, collector, simulator, and offline tests.
// All prices and sizes are spot USD. Scores are rules, never probabilities.
export const VERSION = '3.0.0';
export const MODEL_VERSION = '2026-09-08-scanner-v2';
export const PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LINK-USD', 'AVAX-USD', 'DOGE-USD'];
export const DEFAULTS = Object.freeze({equity: 1000, riskPct: 1.5, feeBps: 60,
  slippageBps: 10, maxWeight: 0.25, minNetR: 1.25, minNotional: 10});
export const finite = n => typeof n === 'number' && Number.isFinite(n);
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export function ageSeconds(t, now = Date.now() / 1000) {
  return finite(t) && t > 0 && t <= now + 5 ? Math.max(0, now - t) : Infinity;
}
export function quoteUsable(q, now = Date.now() / 1000, maxAge = 30) {
  return !!q && finite(q.bid) && finite(q.ask) && q.bid > 0 && q.ask >= q.bid &&
    ageSeconds(q.at, now) <= maxAge && (q.ask / q.bid - 1) <= 0.02;
}
export function candles(rows, now = Date.now() / 1000, seconds = 3600) {
  const seen = new Map();
  for (const r of rows || []) {
    if (!Array.isArray(r) || r.length < 6 || !r.every(finite)) continue;
    const [t, l, h, o, c, v] = r;
    if (t > 0 && t + seconds <= now && l > 0 && h >= Math.max(o, c) &&
        l <= Math.min(o, c) && o > 0 && c > 0 && v >= 0) seen.set(t, {t, o, h, l, c, v});
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}
export function ema(values, period) {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((s, n) => s + n, 0) / period;
  const k = 2 / (period + 1);
  for (const n of values.slice(period)) value += k * (n - value);
  return value;
}
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const ranges = bars.slice(1).map((b, i) => Math.max(b.h - b.l,
    Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c)));
  let value = ranges.slice(0, period).reduce((s, n) => s + n, 0) / period;
  for (const n of ranges.slice(period)) value = (value * (period - 1) + n) / period;
  return value;
}
export function positionPlan({entry, stop, target, askSize = null}, overrides = {}) {
  const p = {...DEFAULTS, ...overrides};
  const invalid = [entry, stop, target, p.equity, p.riskPct, p.feeBps, p.slippageBps,
    p.maxWeight, p.minNetR, p.minNotional].some(n => !finite(n));
  if (invalid || stop <= 0 || entry <= stop || target <= entry || p.equity <= 0 ||
      p.riskPct <= 0 || p.riskPct > 3 || p.feeBps < 0 || p.feeBps > 300 ||
      p.slippageBps < 0 || p.slippageBps > 200 || p.maxWeight <= 0 || p.maxWeight > 1) {
    return {eligible: false, reason: 'Enter valid prices, capital, fees, and risk (up to 3%).'};
  }
  const fee = p.feeBps / 10000, slip = p.slippageBps / 10000;
  const entryFill = entry * (1 + slip), costPerUnit = entryFill * (1 + fee);
  const stopFill = stop * (1 - slip), targetFill = target * (1 - slip);
  const lossPerUnit = costPerUnit - stopFill * (1 - fee);
  const gainPerUnit = targetFill * (1 - fee) - costPerUnit;
  const maxRisk = p.equity * p.riskPct / 100;
  const byRisk = maxRisk / lossPerUnit;
  const byCapital = p.equity * p.maxWeight / costPerUnit;
  const byDepth = finite(askSize) && askSize > 0 ? askSize * 0.1 : Infinity;
  const quantity = Math.floor(Math.min(byRisk, byCapital, byDepth) * 1e8) / 1e8;
  const notional = quantity * entryFill, riskUsd = quantity * lossPerUnit;
  const rewardUsd = quantity * gainPerUnit, netR = gainPerUnit / lossPerUnit;
  const feesUsd = quantity * fee * (entryFill + stopFill);
  const eligible = notional >= p.minNotional && netR >= p.minNetR;
  return {eligible, quantity, notional, cashRequired: quantity * costPerUnit,
    riskUsd, rewardUsd, netR, feesUsd, entryFill, stopFill, targetFill,
    breakEven: costPerUnit / ((1 - fee) * (1 - slip)),
    breakEvenWinRate: gainPerUnit > 0 ? lossPerUnit / (lossPerUnit + gainPerUnit) : 1,
    limitedBy: byDepth <= Math.min(byRisk, byCapital) ? 'visible ask depth' : byRisk < byCapital ? 'risk budget' : 'position cap',
    reason: eligible ? 'Cost and size checks passed' : notional < p.minNotional ?
      'Position below minimum after risk and depth limits' : 'Too little reward after fees and slippage'};
}
export function analyzeMarket(m, overrides = {}, now = Date.now() / 1000) {
  const b = candles(m.candles, now).slice(-300), p = {...DEFAULTS, ...overrides};
  const out = {product: m.product, status: 'waiting', strategy: 'No setup', score: 0,
    reasons: [], source: 'Coinbase Exchange', at: m.quote?.at || 0, bars: b,
    eligibility: 'U.S. spot access depends on your account and state'};
  if (b.length < 60) return {...out, status: 'unavailable', reasons: ['At least 60 completed hourly candles required']};
  const recent = b.slice(-60);
  if (recent.some((v, i) => i && v.t - recent[i - 1].t !== 3600)) {
    return {...out, status: 'unavailable', reasons: ['Hourly history has gaps; setup withheld']};
  }
  const last = b.at(-1), prev = b.at(-2), closes = b.map(v => v.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), prev20 = ema(closes.slice(0, -1), 20);
  const a = atr(b), high = Math.max(...b.slice(-21, -1).map(v => v.h));
  const volume = b.slice(-21, -1).reduce((s, v) => s + v.v, 0) / 20;
  const rvol = volume > 0 ? last.v / volume : 0;
  const bullish = last.c > e50 && e20 > e50;
  const breakout = bullish && last.c > high && rvol >= 1.5;
  const reclaim = bullish && prev.c <= prev20 && last.c > e20 && rvol >= 1.1 && last.c - e20 <= a;
  Object.assign(out, {regime: bullish ? 'Uptrend' : 'Defensive', atr: a, ema20: e20,
    ema50: e50, relativeVolume: rvol, trigger: high, signalAt: last.t + 3600,
    setup: breakout ? 'breakout' : reclaim ? 'reclaim' : null,
    strategy: breakout ? 'Volume breakout' : reclaim ? 'Trend reclaim' : 'No setup',
    modelVersion: MODEL_VERSION,
    score: Math.round(clamp((bullish ? 35 : 0) + Math.min(rvol, 3) * 10 +
      (breakout ? 30 : reclaim ? 25 : 0), 0, 95))});
  if (!a || a <= 0) return {...out, status: 'unavailable', reasons: ['Invalid volatility estimate']};
  if (ageSeconds(last.t + 3600, now) > 3900) return {...out, status: 'stale', reasons: ['Completed candle history is stale']};
  if (!quoteUsable(m.quote, now)) return {...out, status: 'stale', reasons: ['Fresh two-sided quote required (30-second limit)']};
  if (m.tradingDisabled || m.status !== 'online') return {...out, status: 'unavailable', reasons: ['Product is not currently online']};
  if (!breakout && !reclaim) return {...out, reasons: [bullish ?
    'Waiting for a volume-confirmed breakout or EMA reclaim' : 'Trend filter is defensive; stay in cash']};
  const entry = m.quote.ask;
  if (entry - last.c > 0.75 * a || entry < last.c - a) return {...out,
    reasons: ['Price has moved too far from the confirmed signal; do not chase']};
  const stop = Math.min(last.c - 2 * a, last.l - 0.1 * a);
  const target = last.c + 3 * (last.c - stop);
  const plan = positionPlan({entry, stop, target, askSize: m.quote.askSize}, p);
  return {...out, strategy: breakout ? 'Volume breakout' : 'Trend reclaim',
    status: plan.eligible ? 'candidate' : 'cost-blocked', entry, stop, target, plan,
    reasons: [plan.reason, 'Unvalidated research setup; paper execution only'],
    id: `${m.product}:${last.t}:${breakout ? 'breakout' : 'reclaim'}`};
}
export function evaluateToken(pair, now = Date.now() / 1000) {
  const number = x => x !== null && x !== undefined && x !== '' && finite(Number(x)) && Number(x) >= 0 ? Number(x) : null;
  const liquidity = number(pair.liquidity?.usd);
  const ageHours = ageSeconds(Number(pair.pairCreatedAt || 0) / 1000, now) / 3600;
  const buys = number(pair.txns?.h1?.buys), sells = number(pair.txns?.h1?.sells);
  const volume = number(pair.volume?.h1);
  const rawChange = pair.priceChange?.h1;
  const change = rawChange != null && finite(Number(rawChange)) ? Number(rawChange) : null;
  const rules = [];
  const rule = (name, actual, threshold, passed, reason) => rules.push({name, actual, threshold,
    passed: actual !== null && !!passed, state: actual === null ? 'unknown' : passed ? 'pass' : 'excluded', reason});
  rule('Venue', pair.dexId || null, 'Solana Pump.fun or PumpSwap', pair.chainId === 'solana' && ['pumpfun','pumpswap'].includes(pair.dexId), 'Not a verified Pump venue pair');
  rule('Liquidity', liquidity, 'At least $100,000 reported', liquidity >= 100000, liquidity === null ? 'Liquidity not reported' : 'Under $100,000 reported liquidity');
  rule('Pool history', finite(ageHours) ? ageHours : null, 'At least 24 hours', ageHours >= 24, finite(ageHours) ? 'Less than 24 hours of pool history' : 'Pool creation date not reported');
  const activity = buys !== null && sells !== null ? buys + sells : null;
  rule('Hourly activity', activity, 'At least 100 transactions', activity >= 100, activity === null ? 'Hourly activity not reported' : 'Thin hourly transaction activity');
  rule('Hourly sells', sells, 'At least 20 sells', sells >= 20, sells === null ? 'Hourly sells not reported' : 'Too little observed selling');
  const ratio = liquidity > 0 && volume !== null ? volume / liquidity : null;
  rule('Volume / liquidity', ratio, 'No more than 5 times per hour', ratio <= 5, ratio === null ? 'Volume / liquidity cannot be assessed' : 'Unusual volume relative to liquidity');
  rule('One-hour move', change, 'Between -30% and +80%', change >= -30 && change <= 80, change === null ? 'One-hour change not reported' : 'Extreme one-hour move');
  const blocks = rules.filter(r => !r.passed).map(r => r.reason);
  return {address: pair.baseToken?.address || '', symbol: pair.baseToken?.symbol || '?',
    name: pair.baseToken?.name || '', pair: pair.pairAddress, dex: pair.dexId,
    liquidity, ageHours: finite(ageHours) ? ageHours : null, buys, sells, volume, change,
    price: number(pair.priceUsd), blocks, rules,
    status: !blocks.length ? 'review' : rules.some(r => r.state === 'unknown') ? 'incomplete' : 'filtered',
    // A traded sell and reported liquidity prove neither sellability nor legal eligibility.
    checks: ['Mint and freeze authorities unverified', 'Holder concentration unverified',
      'Sell simulation unverified', 'Pool liquidity ownership unverified', 'U.S. account eligibility unverified'],
    executionAllowed: false};
}

// Deterministic paper accounting. New entries require a candidate on TWO
// distinct scans. No historical fill is invented when a trigger was missed.
export function advancePaper(previous, markets, now = Date.now() / 1000, options = {}) {
  const model = {...DEFAULTS, ...options};
  const p = previous ? structuredClone(previous) : {version: VERSION, start: 1000,
    cash: 1000, positions: [], closed: [], pending: [], equity: 1000, peak: 1000,
    curve: [], startedAt: now, day: '', dayStart: 1000};
  if (p.updatedAt >= now) return p;
  const fresh = markets.filter(m => quoteUsable(m.quote, now));
  const freshByProduct = new Map(fresh.map(m => [m.product, m]));
  const fee = model.feeBps / 10000, slip = model.slippageBps / 10000;
  const priorEquity = p.equity;
  const markEquity = () => p.cash + p.positions.reduce((s, x) => s + x.quantity * x.mark * (1 - fee), 0);
  for (const x of p.positions) {
    const m = freshByProduct.get(x.product);
    if (m) { x.mark = m.quote.bid * (1 - slip); x.markAt = m.quote.at; }
  }
  p.equity = markEquity();
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  if (p.day !== day) { p.day = day; p.dayStart = priorEquity; p.dailyHalt = false; }
  p.peak = Math.max(p.peak, p.equity);
  if (p.equity <= p.dayStart * 0.95) p.dailyHalt = true;
  if (p.equity <= p.peak * 0.85) p.drawdownHalt = true;
  let halted = p.dailyHalt || p.drawdownHalt;
  const hasStaleExposure = p.positions.some(x => !freshByProduct.has(x.product));
  for (const x of [...p.positions]) {
    const m = freshByProduct.get(x.product);
    if (!m) continue;
    const history = candles(m.candles, now).filter(b => b.t >= x.openedAt && b.t + 3600 > (x.checkedThrough || 0));
    const stopTouched = history.some(b => b.l <= x.stop);
    const hitStop = m.quote.bid <= x.stop || stopTouched;
    const hitTarget = m.quote.bid >= x.target;
    const timedOut = now - x.openedAt >= 48 * 3600;
    if (hitStop || hitTarget || halted || timedOut) {
      // Stops win an ambiguous OHLC bar. Gaps can fill worse than the stop.
      const ref = hitStop ? Math.min(x.stop, m.quote.bid) : m.quote.bid;
      const exit = ref * (1 - slip), proceeds = x.quantity * exit * (1 - fee);
      p.cash += proceeds;
      p.closed.push({...x, exit, closedAt: now, pnl: proceeds - x.cost,
        exitFee: x.quantity * exit * fee, reason: hitStop ? 'Stop / adverse gap' :
          halted ? 'Portfolio loss halt' : timedOut ? '48-hour time exit' : 'Target observed'});
      p.positions = p.positions.filter(q => q.id !== x.id);
    } else if (history.length) x.checkedThrough = history.at(-1).t + 3600;
  }
  p.equity = markEquity();
  // An adverse stop fill can breach a limit after the initial mark.
  if (p.equity <= p.dayStart * 0.95) p.dailyHalt = true;
  if (p.equity <= p.peak * 0.85) p.drawdownHalt = true;
  halted = p.dailyHalt || p.drawdownHalt;
  const oldPending = new Map(p.pending.map(x => [x.id, x]));
  const pending = [];
  for (const m of fresh) {
    if (halted || hasStaleExposure || p.positions.some(x => x.product === m.product) || p.positions.length >= 3) continue;
    const signal = analyzeMarket(m, {...model, equity: p.equity}, now);
    if (Array.isArray(options.strategies) && !options.strategies.includes(signal.setup)) continue;
    if (signal.status !== 'candidate' || p.closed.some(x => x.id === signal.id)) continue;
    const old = oldPending.get(signal.id);
    if (!old || now - old.at > 900) { pending.push({id: signal.id, at: now}); continue; }
    if (now - old.at < 30) { pending.push(old); continue; }
    const plan = signal.plan;
    const existingRisk = p.positions.reduce((s, x) => s + Math.max(0,
      x.quantity * (x.mark * (1 - fee) - x.stop * (1 - slip) * (1 - fee))), 0);
    if (plan.cashRequired > p.cash || existingRisk + plan.riskUsd > p.equity * 0.03) continue;
    p.cash -= plan.cashRequired;
    p.positions.push({id: signal.id, product: m.product, strategy: signal.strategy,
      quantity: plan.quantity, entry: plan.entryFill, stop: signal.stop, target: signal.target,
      openedAt: now, cost: plan.cashRequired, entryFee: plan.notional * fee,
      mark: m.quote.bid * (1 - slip), markAt: m.quote.at});
  }
  p.pending = pending;
  p.equity = markEquity();
  p.updatedAt = now;
  p.staleMarks = p.positions.filter(x => !freshByProduct.has(x.product)).map(x => x.product);
  p.curve.push({t: now, equity: p.equity});
  p.curve = p.curve.slice(-2016);
  // Closed trades are deliberately never truncated: duplicate-signal protection
  // and lifetime statistics depend on the whole ledger.
  return p;
}
