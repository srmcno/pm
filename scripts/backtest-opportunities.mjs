import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PRODUCTS, DEFAULTS, MODEL_VERSION, candles, advancePaper} from '../dashboard/market-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400, STEP = 300;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = t => new Date(t * 1000).toISOString();
const digest = b => createHash('sha256').update(b).digest('hex');
async function atomic(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  await writeFile(file + '.tmp', value);
  await rename(file + '.tmp', file);
}
async function fetchSeries(product, granularity, start, end) {
  const rows = new Map();
  for (let at = start; at < end; at += 299 * granularity) {
    const to = Math.min(end, at + 299 * granularity);
    const url = new URL(`https://api.exchange.coinbase.com/products/${product}/candles`);
    url.search = new URLSearchParams({granularity:String(granularity),start:iso(at),end:iso(to)});
    let batch;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url, {signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error(`${product}: HTTP ${response.status}`);
        batch = await response.json();
        if (!Array.isArray(batch)) throw new Error('Invalid candle response');
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await pause(1000 * 2 ** attempt);
      }
    }
    for (const b of candles(batch, end, granularity)) {
      if (b.t >= at && b.t < to) rows.set(b.t, [b.t,b.l,b.h,b.o,b.c,b.v]);
    }
    await pause(220);
  }
  return [...rows.values()].sort((a,b) => a[0]-b[0]);
}
export function coverage(rows, start, end, step) {
  const expected = Math.floor((end-start)/step);
  const observed = new Set(rows.filter(r=>r[0]>=start && r[0]<end).map(r=>r[0])).size;
  return {expected, observed, missing:expected-observed, pct:expected ? 100*observed/expected : 0};
}
export async function collectHistory(days=90) {
  const end = Math.floor(Date.now()/1000/DAY)*DAY, start=end-days*DAY;
  const series = {}, quality = {};
  let cursor=0;
  await Promise.all([0,1].map(async () => {
    while (cursor < PRODUCTS.length) {
      const product = PRODUCTS[cursor++];
      const hours = await fetchSeries(product, 3600, start-300*3600, end);
      const scans = await fetchSeries(product, STEP, start, end);
      series[product]={hours,scans};
      quality[product]={hourly:coverage(hours,start,end,3600),fiveMinute:coverage(scans,start,end,STEP)};
      console.log(JSON.stringify({collected:product,...quality[product]}));
    }
  }));
  const highCoverageProducts=PRODUCTS.filter(p=>quality[p].fiveMinute.pct>=98 && quality[p].hourly.pct>=98);
  if(!highCoverageProducts.length)throw new Error('No market has sufficient historical coverage for comparison.');
  const dataIssues=PRODUCTS.filter(p=>!highCoverageProducts.includes(p)).map(p=>
    `${p}: ${quality[p].fiveMinute.pct.toFixed(2)}% five-minute coverage. Missing scans remain missing.`);
  return {schema:1,provider:'Coinbase Exchange',collectedAt:Date.now()/1000,start,end,days,
    series:Object.fromEntries(PRODUCTS.map(p=>[p,series[p]])),quality,highCoverageProducts,dataIssues};
}
// Quotes use the first traded price in the current five-minute interval.
// Only hourly candles already completed at that timestamp enter the model.
// Spread is an explicit assumption; historical order books are not available.
export function replay(data, {start=data.start,end=data.end,cadence=STEP,spreadBps=10,...options}={}) {
  const model={...DEFAULTS,...options}, fee=model.feeBps/10000, slip=model.slippageBps/10000;
  const products=PRODUCTS.filter(p=>data.series[p]), index={}, scanMaps={};
  for(const product of products){index[product]=0;scanMaps[product]=new Map(data.series[product].scans.map(r=>[r[0],r]));}
  let p=null, peak=1000, maxDrawdown=0, exposed=0, steps=0, missing=0;
  const curve=[];
  for(let at=start;at<end;at+=cadence){
    const markets=[];
    for(const product of products){
      const {hours}=data.series[product], row=scanMaps[product].get(at);
      if(!row){missing++;continue;}
      while(index[product]<hours.length && hours[index[product]][0]+3600<=at)index[product]++;
      const mid=row[3], half=spreadBps/20000;
      markets.push({product,status:'online',candles:hours.slice(Math.max(0,index[product]-300),index[product]),
        quote:{bid:mid*(1-half),ask:mid*(1+half),price:mid,at,source:'Historical five-minute open; modeled spread'}});
    }
    // The curve is output only, never used to decide trades. Keep it outside
    // the cloned book so repeated replays do not copy thousands of points.
    if(p)p.curve=[];
    p=advancePaper(p,markets,at,model);
    peak=Math.max(peak,p.equity);maxDrawdown=Math.min(maxDrawdown,p.equity/peak-1);
    steps++;if(p.positions.length)exposed++;
    if(at%3600===0)curve.push({t:at,equity:p.equity});
  }
  let forcedExits=0;
  for(const x of p.positions){
    const last=data.series[x.product].scans.filter(r=>r[0]>=start && r[0]+STEP<=end).at(-1);
    const exit=(last ? last[4]*(1-spreadBps/20000)*(1-slip) : x.mark);
    const proceeds=x.quantity*exit*(1-fee);
    p.cash+=proceeds;
    p.closed.push({...x,exit,closedAt:end,pnl:proceeds-x.cost,exitFee:x.quantity*exit*fee,reason:'End-of-window liquidation'});
    forcedExits++;
  }
  p.positions=[];p.equity=p.cash;
  maxDrawdown=Math.min(maxDrawdown,p.equity/peak-1);curve.push({t:end,equity:p.equity});
  const wins=p.closed.filter(x=>x.pnl>0), losses=p.closed.filter(x=>x.pnl<0);
  const grossWins=wins.reduce((s,x)=>s+x.pnl,0),grossLoss=-losses.reduce((s,x)=>s+x.pnl,0);
  const fees=p.closed.reduce((s,x)=>s+(x.entryFee||0)+(x.exitFee||0),0);
  const benchmarkParts=products.map(product=>{
    const rows=data.series[product].scans.filter(r=>r[0]>=start && r[0]+STEP<=end);
    if(!rows.length)return null;
    return rows.at(-1)[4]*(1-spreadBps/20000)*(1-slip)*(1-fee) /
      (rows[0][3]*(1+spreadBps/20000)*(1+slip)*(1+fee))-1;
  }).filter(v=>v!==null);
  const benchmark=benchmarkParts.reduce((s,x)=>s+x,0)/benchmarkParts.length*100;
  return {start,end,days:(end-start)/DAY,settings:{...model,cadenceSeconds:cadence,spreadBps},
    returnPct:(p.equity/1000-1)*100,finalEquity:p.equity,maxDrawdownPct:maxDrawdown*100,
    trades:p.closed.length,wins:wins.length,losses:losses.length,
    winRatePct:p.closed.length ? wins.length/p.closed.length*100 : null,
    profitFactor:grossLoss ? grossWins/grossLoss : null,feesUsd:fees,
    exposurePct:steps ? exposed/steps*100 : 0,forcedExits,missingQuotes:missing,
    drawdownHalt:!!p.drawdownHalt,benchmarkReturnPct:benchmark,
    assessment:p.equity<1000 ? 'Lost money after modeled costs' : p.closed.length<30 ?
      'Insufficient trade sample' : 'Positive in this sample; not validated',curve,
    ledger:p.closed.map(({id,product,strategy,openedAt,closedAt,entry,exit,quantity,pnl,entryFee,exitFee,reason})=>
      ({id,product,strategy,openedAt,closedAt,entry,exit,quantity,pnl,entryFee,exitFee,reason}))};
}
export function runReport(data) {
  const scenarios=[['Combined · 90 days',{}],['Breakout only',{strategies:['breakout']}],
    ['Reclaim only',{strategies:['reclaim']}],['Higher costs',{feeBps:100,slippageBps:25}],
    ['15-minute scans',{cadence:900}],
    ['First 30 days',{end:data.start+30*DAY}],
    ['Middle 30 days',{start:data.start+30*DAY,end:data.start+60*DAY}],
    ['Last 30 days',{start:data.start+60*DAY}]];
  const runs=scenarios.map(([name,options])=>{const result=replay(data,options);console.log(JSON.stringify({name,returnPct:result.returnPct,trades:result.trades}));return {name,...result};});
  const highCoverageProducts=data.highCoverageProducts||Object.keys(data.series);
  if(highCoverageProducts.length<Object.keys(data.series).length){
    const comparison={...data,series:Object.fromEntries(highCoverageProducts.map(p=>[p,data.series[p]]))};
    runs.push({name:'High-coverage markets only',products:highCoverageProducts,...replay(comparison)});
  }
  return {schema:1,modelVersion:MODEL_VERSION,generatedAt:Date.now()/1000,start:data.start,end:data.end,
    provider:data.provider,products:Object.keys(data.series),quality:data.quality,runs,
    dataIssues:data.dataIssues||[],highCoverageProducts,
    methodology:['Fixed rules with no parameter search or selection of the best result.',
      'Actual five-minute opens drive scheduled scans. Only completed hourly candles inform entries.',
      'Two distinct scans confirm an entry. The same paper-account function controls sizing, fees, halts and exits.',
      'Default costs: 60 bps fees and 10 bps slippage per side, plus an assumed 10 bps bid/ask spread.',
      'End-of-window positions are liquidated with modeled costs. Three 30-day slices each start with $1,000.',
      'The benchmark equally holds all six assets with the same modeled costs. It has higher exposure than this strategy.'],
    limitations:['This is a historical scan replay, not tick or order-book execution. Intrabar events and actual spread/depth are unknown.',
      'Missing five-minute intervals are skipped, never filled with invented prices. Missing hourly history can suppress signals.',
      'The present six-asset universe was fixed before this replay; delisted assets are not included.',
      'Ninety days and correlated crypto markets cannot establish a durable edge. These are not calibrated forecasts.',
      'No historical Pump.fun strategy was tested. Current token profiles cannot reconstruct failed or vanished tokens.']};
}
function markdown(report) {
  const n=x=>x===null?'n/a':x.toFixed(2);
  return `# Scanner historical replay\n\n${iso(report.start)} through ${iso(report.end)}. Model ${report.modelVersion}.\n\n`+
    '| Scenario | Net return | Max drawdown | Trades | Win rate | Profit factor | Fees | Buy and hold |\n|---|---:|---:|---:|---:|---:|---:|---:|\n'+
    report.runs.map(r=>`| ${r.name} | ${n(r.returnPct)}% | ${n(r.maxDrawdownPct)}% | ${r.trades} | ${n(r.winRatePct)}% | ${n(r.profitFactor)} | $${n(r.feesUsd)} | ${n(r.benchmarkReturnPct)}% |`).join('\n')+
    '\n\n## Data coverage\n\n'+Object.entries(report.quality).map(([p,q])=>`- ${p}: ${q.fiveMinute.pct.toFixed(4)}% of five-minute intervals, ${q.fiveMinute.missing} missing. Hourly coverage ${q.hourly.pct.toFixed(2)}%.`).join('\n')+
    '\n\n'+(report.dataIssues.length?'The full-universe replay is data-limited. The high-coverage comparison includes '+report.highCoverageProducts.join(', ')+'. No prices were filled into the gaps.':'All markets have at least 98% coverage.')+
    '\n\n## Method\n\n'+report.methodology.map(s=>'- '+s).join('\n')+'\n\n## Limits\n\n'+report.limitations.map(s=>'- '+s).join('\n')+
    '\n\nInputs: `data/opportunities/backtest-inputs.json.gz`. SHA-256: `'+report.inputSha256+'`.\n'+
    '\nSource: [Coinbase candle API](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles).\n';
}
async function main(){
  const input=path.join(root,'data/opportunities/backtest-inputs.json.gz');
  let bytes,data;
  if(process.argv.includes('--collect')){
    data=await collectHistory();bytes=gzipSync(JSON.stringify(data));await atomic(input,bytes);
  }else{bytes=await readFile(input);data=JSON.parse(gunzipSync(bytes));}
  const report=runReport(data);report.inputSha256=digest(bytes);
  await atomic(path.join(root,'dashboard/data/scanner-backtest.json'),JSON.stringify(report)+'\n');
  await atomic(path.join(root,'reports/scanner-backtest.md'),markdown(report));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
