import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PRODUCTS, VERSION, analyzeMarket, evaluateToken, advancePaper} from '../dashboard/market-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = path.join(root, 'dashboard/data/opportunities.json');
const ledgerPath = path.join(root, 'data/opportunities/paper.json');
const read = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) {
  if (e.code === 'ENOENT') return fallback;
  throw new Error(`Refusing to overwrite unreadable state: ${file}`, {cause: e});
}};
async function atomic(file, value) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file + '.tmp', JSON.stringify(value) + '\n');
  await rename(file + '.tmp', file);
}
async function get(url) {
  const r = await fetch(url, {headers: {'User-Agent': 'MoffittMoney/3.0 (public market research)'},
    signal: AbortSignal.timeout(12000)});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const old = await read(snapshotPath, {markets: [], tokens: []});
const errors = [], markets = [];
// Two products concurrently, respecting the public API's rate budget.
for (let i = 0; i < PRODUCTS.length; i += 2) {
  const batch = await Promise.all(PRODUCTS.slice(i, i + 2).map(async product => {
    try {
      const base = `https://api.exchange.coinbase.com/products/${product}`;
      const info = await get(base);
      const rows = await get(`${base}/candles?granularity=3600`);
      const ticker = await get(`${base}/ticker`);
      if (!Array.isArray(rows) || !rows.length) throw new Error('Empty candle response');
      return {product, status: info.status, tradingDisabled: !!info.trading_disabled,
        candles: rows, fetchedAt: Date.now() / 1000,
        quote: {bid: Number(ticker.bid), ask: Number(ticker.ask), price: Number(ticker.price),
          at: Date.parse(ticker.time) / 1000, source: 'Coinbase Exchange REST',
          receivedAt: Date.now() / 1000},
        minSize: Number(info.base_min_size), increment: Number(info.base_increment)};
    } catch (e) {
      errors.push({source: product, message: e.message});
      return old.markets.find(m => m.product === product) || {product, candles: [], status: 'unavailable'};
    }
  }));
  markets.push(...batch);
}
let tokens = old.tokens || [], tokenUpdatedAt = old.tokenUpdatedAt || 0;
try {
  const profiles = await get('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(profiles)) throw new Error('Invalid token profile response');
  const addresses = [...new Set(profiles.filter(x => x.chainId === 'solana' &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.tokenAddress)).map(x => x.tokenAddress))].slice(0, 30);
  if (addresses.length) {
    const pairs = await get(`https://api.dexscreener.com/tokens/v1/solana/${addresses.join(',')}`);
    if (!Array.isArray(pairs)) throw new Error('Invalid token pair response');
    const byToken = new Map();
    for (const pair of pairs.filter(x => ['pumpfun', 'pumpswap'].includes(x.dexId))) {
      const x = evaluateToken(pair);
      if (!byToken.has(x.address) || byToken.get(x.address).liquidity < x.liquidity) byToken.set(x.address, x);
    }
    tokens = [...byToken.values()].sort((a, b) => a.blocks.length - b.blocks.length || b.liquidity - a.liquidity).slice(0, 20);
  } else tokens = [];
  tokenUpdatedAt = Date.now() / 1000;
} catch (e) { errors.push({source: 'DEX Screener', message: e.message}); }
const now = Date.now() / 1000;
const previous = await read(ledgerPath, null);
const paper = advancePaper(previous, markets, now);
const payload = {version: VERSION, generatedAt: now, markets, tokens, tokenUpdatedAt, errors,
  signals: markets.map(m => analyzeMarket(m, {}, now)).map(({bars, ...s}) => s),
  paper, policy: {reviewedAt: '2026-09-08', country: 'US', leverage: false,
    excluded: ['MEXC', 'Polymarket offshore'], pumpExecution: false},
  notes: ['Quotes require a provider timestamp under 30 seconds to qualify for entry.',
    'Scheduled snapshots are delayed. The browser connects directly for streaming quotes.',
    'Research strategies have no established expected return or calibrated win probability.',
    'DEX Screener profiles are a discovery sample, not every token or proof of safety.']};
await atomic(ledgerPath, paper);
await atomic(snapshotPath, payload);
console.log(JSON.stringify({markets: markets.length, current: markets.filter(m => now - (m.quote?.at || 0) < 30).length,
  tokens: tokens.length, errors, paperEquity: paper.equity}));
// Publish failed-source diagnostics too. A partial outage must not silently
// republish an old timestamp as a successful scan.
if (!markets.some(m => now - (m.quote?.at || 0) < 30 && m.status === 'online')) process.exitCode = 1;
