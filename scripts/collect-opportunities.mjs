import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {assessEvidence, applyEvidence} from '../dashboard/outcomes.mjs';
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
// Discovery endpoints must not age otherwise usable execution quotes out.
const evaluatedAt = Date.now() / 1000;
const previous = await read(ledgerPath, null);
let evidenceReport = null;
try { evidenceReport = await read(path.join(root, 'dashboard/data/scanner-backtest.json'), null); }
catch (error) { errors.push({source:'Strategy evidence',message:'Replay report could not be read; new entries held. Existing positions still use their exit rules.'}); }
const entryPolicy = assessEvidence(evidenceReport, evaluatedAt);
const paper = advancePaper(previous, markets, evaluatedAt, {strategies:entryPolicy.allowedStrategies});
paper.entryPolicy = entryPolicy;
let tokens = old.tokens || [], tokenUpdatedAt = old.tokenUpdatedAt || 0;
let discovery = old.discovery || {};
try {
  const feeds = ['token-profiles/latest/v1','token-profiles/recent-updates/v1','token-boosts/top/v1'];
  const responses = await Promise.allSettled(feeds.map(feed => get('https://api.dexscreener.com/'+feed)));
  const profiles = [], sources = [];
  responses.forEach((r,i)=>{
    if(r.status==='fulfilled' && Array.isArray(r.value)){profiles.push(...r.value);sources.push(feeds[i]);}
    else errors.push({source:'DEX Screener '+feeds[i],message:r.reason?.message || 'Invalid profile response'});
  });
  if(!sources.length)throw new Error('All discovery lists unavailable');
  const retained=tokens.map(t=>t.address);
  const addresses = [...new Set([...retained,...profiles.filter(x => x.chainId === 'solana').map(x => x.tokenAddress)])]
    .filter(x=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)).slice(0,120);
  if (addresses.length) {
    const pairs=[];
    for(let i=0;i<addresses.length;i+=30){
      const batch=await get(`https://api.dexscreener.com/tokens/v1/solana/${addresses.slice(i,i+30).join(',')}`);
      if(!Array.isArray(batch))throw new Error('Invalid token pair response');
      pairs.push(...batch);
    }
    const byToken = new Map();
    for (const pair of pairs.filter(x => ['pumpfun', 'pumpswap'].includes(x.dexId))) {
      const x = evaluateToken(pair);
      if (!byToken.has(x.address) || (byToken.get(x.address).liquidity ?? -1) < (x.liquidity ?? -1)) byToken.set(x.address, x);
    }
    tokens = [...byToken.values()].sort((a, b) => a.blocks.length - b.blocks.length || (b.liquidity ?? -1) - (a.liquidity ?? -1)).slice(0,60);
  } else tokens = [];
  tokenUpdatedAt = Date.now() / 1000;
  discovery={sources,addressesRequested:addresses.length,tokensReturned:tokens.length,
    note:'Latest and updated profiles, top paid boosts, and previously observed tokens. This is a discovery sample, not a complete market ranking or endorsement.'};
} catch (e) { errors.push({source: 'DEX Screener', message: e.message}); }
const now = Date.now() / 1000;
const payload = {version: VERSION, generatedAt: now, evaluatedAt, markets, tokens, tokenUpdatedAt, discovery, errors,
  signals: markets.map(m => applyEvidence(analyzeMarket(m, {}, evaluatedAt), entryPolicy)).map(({bars, ...s}) => s),
  paper, policy: {reviewedAt: '2026-09-08', country: 'US', leverage: false,
    excluded: ['MEXC', 'Polymarket offshore'], pumpExecution: false},
  notes: ['Quotes require a provider timestamp under 30 seconds to qualify for entry.',
    'Scheduled snapshots are delayed. The browser connects directly for streaming quotes.',
    'Research strategies have no established expected return or calibrated win probability.',
    'DEX Screener profiles are a discovery sample, not every token or proof of safety.']};
await atomic(ledgerPath, paper);
await atomic(snapshotPath, payload);
console.log(JSON.stringify({markets: markets.length, current: markets.filter(m => evaluatedAt - (m.quote?.at || 0) < 30).length,
  tokens: tokens.length, errors, paperEquity: paper.equity}));
// Publish failed-source diagnostics too. A partial outage must not silently
// republish an old timestamp as a successful scan.
if (!markets.some(m => evaluatedAt - (m.quote?.at || 0) < 30 && m.status === 'online')) process.exitCode = 1;
