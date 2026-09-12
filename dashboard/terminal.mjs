import {assessEvidence,applyEvidence,summarizeTrades,POLICY_VERSION} from './outcomes.mjs?v=4.1.0';
import {publishedJson, publicationHealth} from './data-client.mjs?v=4.0.0';
import {PRODUCTS, DEFAULTS, VERSION, MODEL_VERSION, ageSeconds, quoteUsable, analyzeMarket} from './market-core.mjs?v=3.1.3';
const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names = {BTC:'Bitcoin', ETH:'Ethereum', SOL:'Solana', LINK:'Chainlink', AVAX:'Avalanche', DOGE:'Dogecoin'};
const money = (n, maximumFractionDigits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', {style:'currency',currency:'USD',maximumFractionDigits}) : 'Unavailable';
const price = n => money(n, n > 10 ? 2 : n > 1 ? 4 : 6);
const signed = n => `${n > 0 ? '+' : ''}${money(n)}`;
const since = t => {const a = ageSeconds(t); return !Number.isFinite(a) ? 'unknown age' : a < 60 ? `${Math.floor(a)}s ago` : a < 3600 ? `${Math.floor(a/60)}m ago` : `${Math.floor(a/3600)}h ago`;};
const stamp = t => t > 0 ? new Date(t * 1000).toLocaleString() : 'not available';
const badge = (label, cls = 'muted') => `<span class="badge ${cls}">${escape(label)}</span>`;
const stateLabel = {candidate:'Paper candidate', waiting:'Watching', stale:'Live quote needed', unavailable:'Unavailable', 'cost-blocked':'Cost blocked', 'evidence-held':'Evidence held'};
let markets = PRODUCTS.map(product => ({product, candles: [], status:'unavailable'}));
let snapshot = null, signals = [], selected = 'BTC-USD', paused = false;
let ws = null, reconnect = null, attempts = 0, disposed = false, lastChart = '', snapshotBusy = false, directBusy = false;
let restBusy = false, snapshotError = '', historyError = '', modelError = '';
let backtest = null, backtestBusy = false, lastHistoryAttempt = 0;
let exportUrl = null;
try { const saved = JSON.parse(localStorage.getItem('mm-model-v3') || 'null');
  if (saved) for (const [id, key] of [['capital','equity'],['risk','riskPct'],['fee','feeBps'],['slippage','slippageBps']]) {
    const el = $(id), n = saved[key];
    if (Number.isFinite(n) && n >= Number(el.min) && n <= Number(el.max)) el.value = n;
  }
  const theme = localStorage.getItem('mm-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
function model() {
  const p = {...DEFAULTS};
  modelError = '';
  for (const [id, key] of [['capital','equity'],['risk','riskPct'],['fee','feeBps'],['slippage','slippageBps']]) {
    const el = $(id), n = el.valueAsNumber;
    if (!el.checkValidity() || !Number.isFinite(n)) modelError = 'Enter valid model settings before using a position plan.';
    p[key] = n;
  }
  return p;
}
async function get(url, timeout = 10000) {
  const r = await fetch(url, {cache:'no-store', signal:AbortSignal.timeout(timeout)});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function mergeMarket(next) {
  const i = markets.findIndex(m => m.product === next.product);
  if (i < 0) return;
  const prev = markets[i];
  const quote = prev.quote && (prev.quote.at || 0) > (next.quote?.at || 0) ? prev.quote : next.quote || prev.quote;
  const recent = (rows) => Math.max(0, ...(rows || []).map(r => Number(r[0]) || 0));
  markets[i] = {...prev, ...next, quote, candles: recent(prev.candles) > recent(next.candles) ? prev.candles : next.candles || prev.candles};
}
async function loadSnapshot() {
  if (snapshotBusy) return;
  snapshotBusy = true;
  try {
    const data = await publishedJson('data/opportunities.json', d => Array.isArray(d.markets) && d.generatedAt > 0 && d.version === VERSION);
    if (!Array.isArray(data.markets) || !data.generatedAt || data.version !== VERSION) throw new Error('Incompatible or missing snapshot');
    if (snapshot && snapshot.generatedAt > data.generatedAt) { snapshotError = 'The source returned an older snapshot. Keeping the newer loaded record.'; return; }
    snapshot = data; data.markets.forEach(mergeMarket); snapshotError = '';
    renderPaper(); renderTokens();
  } catch (e) { snapshotError = `Shared ledger unavailable (${e.message}). Public quotes can still connect.`; }
  finally { snapshotBusy = false; render(); }
}
async function loadHistories(force = false) {
  if (directBusy || disposed || (paused && !force)) return;
  const lastHour = Math.floor(Date.now()/3600000)*3600 - 3600;
  const needed = markets.filter(m => force || !m.candles.some(r => r[0] === lastHour));
  if (!needed.length || (!force && Date.now()-lastHistoryAttempt<120000)) return;
  lastHistoryAttempt = Date.now();
  directBusy = true;
  let failures = 0;
  try {
    for (let i = 0; i < needed.length; i += 2) {
      await Promise.all(needed.slice(i,i+2).map(async ({product}) => {
        try {
          const base = `https://api.exchange.coinbase.com/products/${product}`;
          const info = await get(base);
          const rows = await get(`${base}/candles?granularity=3600`);
          if (!Array.isArray(rows)) throw new Error('Invalid candles');
          mergeMarket({product, status:info.status, tradingDisabled:!!info.trading_disabled,
            candles:rows, fetchedAt:Date.now()/1000});
        } catch { failures++; }
      }));
    }
    historyError = failures ? `${failures} market histories could not refresh directly. Last available candles retain their original dates.` : '';
  } finally { directBusy = false; render(); }
}
async function restQuotes(force = false) {
  if (restBusy || disposed || (paused && !force)) return;
  const missing = markets.filter(m => !quoteUsable(m.quote));
  if (!missing.length) return;
  restBusy = true;
  try {
    await Promise.all(missing.map(async m => {
      try {
        const t = await get(`https://api.exchange.coinbase.com/products/${m.product}/ticker`, 7000);
        mergeMarket({product:m.product, quote:{bid:Number(t.bid),ask:Number(t.ask),price:Number(t.price),
          at:Date.parse(t.time)/1000, receivedAt:Date.now()/1000, source:'Coinbase Exchange REST'}});
      } catch { /* Keep original quote timestamp; it ages out visibly. */ }
    }));
  } finally { restBusy = false; render(); }
}
function connect() {
  if (paused || disposed || ws) return;
  clearTimeout(reconnect);
  const socket = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws = socket;
  const connectTimeout = setTimeout(() => { if(socket.readyState === WebSocket.CONNECTING) socket.close(); },12000);
  socket.onopen = () => { clearTimeout(connectTimeout); attempts = 0; socket.send(JSON.stringify({type:'subscribe',product_ids:PRODUCTS,channels:['ticker','heartbeat']})); render(); };
  socket.onmessage = e => {
    try {
      const t = JSON.parse(e.data);
      if (t.type !== 'ticker' || !PRODUCTS.includes(t.product_id)) return;
      const at = Date.parse(t.time)/1000;
      if (!Number.isFinite(at)) return;
      mergeMarket({product:t.product_id,quote:{bid:Number(t.best_bid),ask:Number(t.best_ask),
        price:Number(t.price), askSize:Number(t.best_ask_size) || null,
        at,receivedAt:Date.now()/1000,source:'Coinbase Exchange WebSocket'}});
    } catch { /* Unrelated/invalid messages cannot become quotes. */ }
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    clearTimeout(connectTimeout);
    if (ws !== socket) return;
    ws = null; render();
    if (!paused && !disposed) reconnect = setTimeout(connect, Math.min(60000,1000 * 2 ** Math.min(attempts++,6)));
  };
}
function disconnect() { clearTimeout(reconnect); const socket = ws; ws = null; socket?.close(); }
function render() {
  const p = model(), evidence = assessEvidence(backtest);
  signals = markets.map(m => applyEvidence(analyzeMarket(m, p), evidence));
  const fresh = markets.filter(m => quoteUsable(m.quote));
  const streamed = fresh.filter(m => String(m.quote.source || '').includes('WebSocket')).length;
  const quoted = markets.filter(m => Number.isFinite(m.quote?.at));
  const newest = quoted.length ? Math.max(...quoted.map(m=>m.quote.at)) : 0;
  const delayed = !fresh.length && newest > 0;
  const label = paused ? 'Live requests paused' : streamed ? `${streamed}/${PRODUCTS.length} streaming` :
    fresh.length ? `${fresh.length}/${PRODUCTS.length} live REST` : delayed ? 'Delayed snapshot' : 'Connecting / no quotes';
  $('connection').textContent = label;
  $('connection').className = `badge ${fresh.length && !paused ? 'good' : 'amber'}`;
  $('connection-detail').textContent = paused ? 'Live requests are paused. The shared snapshot can still update.' : streamed ?
    'Direct Coinbase quotes. Entry checks expire after 30 seconds without a fresh quote.' : fresh.length ?
    'Live public REST quotes are refreshing. The WebSocket feed will be used when available.' : delayed ?
    `Live quotes have not connected. Last saved quote: ${since(newest)}. Chart setups remain visible; new entry plans require a fresh quote.` :
    'Connecting to Coinbase. No price or trade is invented while the source is unavailable.';
  $('clock').textContent = new Date().toLocaleTimeString('en-US', {hour12:false,timeZone:'UTC'}) + ' UTC';
  renderHealth(); renderOutcomeOverview();
  const notice = [snapshotError, markets.every(m=>m.candles.length<60) ? historyError : '', modelError].filter(Boolean).join(' ');
  $('notice').hidden = !notice; $('notice').textContent = notice;
  updateRegion('ticker', markets.map((m,i) => {
    const s = signals[i], q = m.quote, last = s.bars?.at(-1)?.c;
    const change = last && q?.price ? (q.price/last-1)*100 : null;
    const live = quoteUsable(q);
    return `<button class="ticker-card ${selected === m.product ? 'active' : ''}" data-product="${m.product}" aria-label="Inspect ${m.product}"><span class="ticker-name">${m.product.split('-')[0]} <span class="${live ? 'positive' : 'quiet'}">${live ? '●' : '○'}</span></span><strong>${price(q?.price)}</strong><small class="${live && change !== null ? change>=0 ? 'positive' : 'negative' : 'quiet'}">${live && change!==null ? `${change>=0?'+':''}${change.toFixed(2)}% vs 1h close` : `Quote ${since(q?.at)}`}</small></button>`;
  }).join(''));
  const text = $('search').value.toLowerCase(), only = $('only-candidates').checked;
  const shown = signals.filter(s => (s.product.toLowerCase().includes(text) || s.strategy.toLowerCase().includes(text)) && (!only || !!s.setup));
  $('scan-count').textContent = `${signals.filter(s=>s.status==='candidate').length} paper-eligible · ${signals.filter(s=>s.status==='evidence-held').length} held by evidence · ${signals.filter(s=>s.setup).length} chart setups`;
  updateRegion('setups', shown.map(s => {
    const m = markets.find(x=>x.product===s.product), live=quoteUsable(m.quote);
    return `<tr><td><strong>${escape(s.product.replace('-',' / '))}</strong><small>${escape(s.strategy)}</small></td><td>${price(m.quote?.price)}<small>${live?'Quote ': 'Delayed · '}${since(m.quote?.at)}</small></td><td><span class="${s.regime==='Uptrend'?'positive':'quiet'}">${escape(s.regime||'Unknown')}</span></td><td>${Number.isFinite(s.relativeVolume)?s.relativeVolume.toFixed(2)+'×':'—'}</td><td>${badge(stateLabel[s.status],s.status==='candidate'?'good':['stale','evidence-held'].includes(s.status)?'amber':'muted')}</td><td><button class="row-action" data-product="${s.product}" aria-label="Inspect ${s.product} plan">Inspect ↗</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No markets match. Waiting is a valid strategy.</td></tr>');
  renderPlan(); renderChart();

}
function renderPlan() {
  const s = signals.find(s=>s.product===selected);
  if (!s) return;
  let content = `<div class="plan-heading"><strong>${escape(selected.replace('-',' / '))}</strong>${badge(stateLabel[s.status],s.status==='candidate'?'good':'muted')}</div>`;
  if (s.hypotheticalPlan) content += '<p class="plan-explain">Hypothetical sizing only. Recorded outcomes hold new paper entries for this strategy.</p>';
  if (modelError) content += `<p class="plan-explain">${escape(modelError)}</p>`;
  else if (s.plan && Number.isFinite(s.plan.netR)) {
    const p = s.plan;
    content += `<div class="plan-rows"><div><span>Entry reference</span><b>${price(s.entry)}</b></div><div><span>Stop trigger</span><b class="negative">${price(s.stop)}</b></div><div><span>Price target</span><b class="positive">${price(s.target)}</b></div><div><span>Net reward / risk</span><b>${p.netR.toFixed(2)}R</b></div><div><span>Modeled cash needed</span><b>${money(p.cashRequired)}</b></div><div><span>Loss at modeled stop</span><b class="negative">${money(p.riskUsd)}</b></div></div><p class="plan-tagline">${p.quantity.toFixed(6)} units · limited by ${escape(p.limitedBy)}<br>Fee-adjusted breakeven: ${price(p.breakEven)}<br>Required win rate: ${(p.breakEvenWinRate*100).toFixed(1)}% (not a forecast)</p>`;
  } else {
    content += `<p class="plan-explain">${escape(s.reasons[0] || 'No qualifying entry.')}</p><div class="plan-rows"><div><span>20-hour high</span><b>${price(s.trigger)}</b></div><div><span>Hourly ATR</span><b>${price(s.atr)}</b></div><div><span>20-hour EMA</span><b>${price(s.ema20)}</b></div><div><span>50-hour EMA</span><b>${price(s.ema50)}</b></div></div>`;
  }
  content += `<ul class="plan-reasons">${(s.plan ? s.reasons : s.reasons.slice(1)).map(r=>`<li>${escape(r)}</li>`).join('')}</ul><p class="plan-tagline">Candle through ${escape(stamp(s.signalAt))}. A stop is a trigger, not a guaranteed fill. This plan cannot place a trade.</p>`;
  $('plan').innerHTML = content;
}
function renderChart() {
  const s = signals.find(s=>s.product===selected), m = markets.find(m=>m.product===selected);
  $('chart-title').textContent = `${names[selected.split('-')[0]]} / USD`;
  $('chart-price').textContent = price(m?.quote?.price);
  $('chart-regime').textContent = s?.regime || 'Unavailable';
  $('chart-regime').className = `badge ${s?.regime==='Uptrend'?'good':'muted'}`;
  $('chart-asof').textContent = 'Last completed candle: ' + stamp(s?.signalAt);
  const b = s?.bars?.slice(-72) || [];
  const signature = `${selected}:${b.at(-1)?.t}:${b.at(-1)?.c}:${document.documentElement.dataset.theme}`;
  if (signature===lastChart) return;
  lastChart=signature;
  if(b.length<2) {$('chart').innerHTML='<p class="empty">No completed candle history is available.</p>';return;}
  const w=800,h=225,left=10,right=78,top=17,bottom=25;
  const lo=Math.min(...b.map(v=>v.l)),hi=Math.max(...b.map(v=>v.h)),range=Math.max(hi-lo,hi*.003);
  const x=i=>left+i/(b.length-1)*(w-left-right), y=n=>top+(hi-n)/range*(h-top-bottom);
  const d=b.map((v,i)=>`${i?'L':'M'}${x(i).toFixed(2)},${y(v.c).toFixed(2)}`).join(' ');
  const grid=Array.from({length:4},(_,i)=>{const value=hi-range*i/3,yy=y(value);return `<line x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="${w-right+12}" y="${yy+4}" fill="var(--quiet)" font-size="10">${escape(price(value))}</text>`;}).join('');
  const labels=[0,Math.floor((b.length-1)/2),b.length-1].map(i=>`<text x="${x(i)}" y="${h-3}" text-anchor="${i===0?'start':i===b.length-1?'end':'middle'}" fill="var(--quiet)" font-size="10">${escape(new Date(b[i].t*1000).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric'}))}</text>`).join('');
  const trigger = Number.isFinite(s.trigger) && s.trigger<=hi && s.trigger>=lo ? `<line x1="${left}" y1="${y(s.trigger)}" x2="${w-right}" y2="${y(s.trigger)}" stroke="var(--gold)" stroke-dasharray="5 5" opacity=".7"/>` : '';
  $('chart').innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escape(selected)} last ${b.length} completed hourly closes"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--teal)" stop-opacity=".18"/><stop offset="100%" stop-color="var(--teal)" stop-opacity="0"/></linearGradient></defs>${grid}${trigger}<path d="${d} L${x(b.length-1)},${h-bottom} L${left},${h-bottom} Z" fill="url(#area)"/><path d="${d}" stroke="var(--teal)" stroke-width="2" fill="none"/>${labels}</svg>`;
}
function renderPaper() {
  const p=snapshot?.paper;
  if(!p) return;
  const closed=p.closed||[],wins=closed.filter(x=>x.pnl>0).length, pnl=p.equity-p.start;
  const metrics=[['SIMULATED EQUITY',money(p.equity),`${signed(pnl)} since ${stamp(p.startedAt)}`],['CASH AVAILABLE',money(p.cash),'Fixed model; planner settings do not change it'],['CLOSED TRADES',String(closed.length),closed.length?`${wins} wins · ${(wins/closed.length*100).toFixed(1)}% observed win rate`:'No performance claim before observed results'],['OPEN RISK',String(p.positions?.length||0)+' positions',p.drawdownHalt?'Drawdown halt active':p.dailyHalt?'Daily loss halt active':'3% combined modeled risk cap']];
  $('paper-metrics').innerHTML=metrics.map(([label,value,sub])=>`<div class="metric"><span>${label}</span><strong>${escape(value)}</strong><small>${escape(sub)}</small></div>`).join('');
  renderEquity('paper-curve',p.curve,'Forward paper equity');
  const observed=summarizeTrades(closed);
  const policy=p.entryPolicy;
  $('paper-entry-status').textContent=policy?.version===POLICY_VERSION ? policy.state==='held'?'New entries held':'Paper entry gate active' : 'New gate awaiting collector scan';
  $('paper-outcome-note').textContent=`${closed.length} closed trades. ${closed.length ? 'Average realized result '+signed(observed.expectancy)+' per closed trade; '+money(observed.fees)+' recorded entry/exit fees.' : 'No realized payoff statistics yet.'} The curve shows retained scan history and includes open-position marks. ${policy?.reason||'The collector will apply the new evidence gate on its next successful run.'}`;
  const rows=[...(p.positions||[]).map(x=>({...x,open:true})),...closed.slice(-10).reverse()];
  $('paper-rows').innerHTML=rows.map(x=>{
    const gain=x.open?x.quantity*x.mark*(1-DEFAULTS.feeBps/10000)-x.cost:x.pnl;
    return `<tr><td><strong>${escape(x.product)}</strong><small>${escape(x.strategy)}</small></td><td>${badge(x.open?'Open · paper':'Closed · paper',x.open?'amber':'muted')}</td><td>${price(x.entry)}</td><td>${price(x.open?x.mark:x.exit)}<small>${escape(stamp(x.open?x.markAt:x.closedAt))}</small></td><td class="${gain>=0?'positive':'negative'}">${signed(gain)}</td><td>${x.open?'Stop '+price(x.stop):escape(x.reason)}</td></tr>`;
  }).join('')||'<tr><td colspan="6" class="empty">No trades yet. The model waits for fresh data and a setup that survives the next scan.</td></tr>';
  $('paper-note').textContent=`Simulated fills include ${DEFAULTS.feeBps} bps fees and ${DEFAULTS.slippageBps} bps slippage per side. ${p.staleMarks?.length?'Stale marks retained for '+p.staleMarks.join(', ')+'. ':''}P&L includes the purchase fee and estimated selling costs, so an unchanged price begins below breakeven. ${p.pending?.length || 0} setups await a confirming scan. Scheduled scans can miss intrahour moves; losses can exceed planned risk.`;
}
function renderTokens() {
  const tokens=snapshot?.tokens||[], filter=$('token-filter').value;
  const passed=tokens.filter(t=>t.status==='review').length;
  const missing=tokens.filter(t=>t.status==='incomplete').length;
  const shown=tokens.map((t,i)=>({t,i})).filter(({t})=>filter==='all'||t.status===filter);
  $('token-summary').textContent=`${passed} pass market rules · ${tokens.length-passed-missing} excluded · ${missing} missing data`;
  $('tokens').innerHTML=shown.map(({t,i})=>{
    const label=t.status==='review'?'Market screen passed':t.status==='incomplete'?'Missing data':'Excluded';
    const reason=t.status==='review'?'Security and eligibility still unverified':(t.status==='incomplete'?(t.rules||[]).find(r=>r.state==='unknown')?.reason:null)||(t.blocks||[])[0]||'Criteria not met';
    return `<tr><td><strong>${escape(t.symbol)}</strong><small>${escape(t.dex)} · ${Number.isFinite(t.ageHours)?t.ageHours<1?'under 1h':t.ageHours.toFixed(0)+'h old':'age not reported'}</small></td><td>${Number.isFinite(t.liquidity)?money(t.liquidity,0):'Not reported'}</td><td class="${t.change>=0?'positive':'negative'}">${Number.isFinite(t.change)?(t.change>0?'+':'')+t.change.toFixed(1)+'%':'Not reported'}</td><td>${t.buys??'?'} / ${t.sells??'?'}</td><td>${badge(label,t.status==='review'?'amber':'muted')}<div class="token-reason">${escape(reason)}</div></td><td><button class="row-action" data-token="${i}" aria-label="Review ${escape(t.symbol)} checks">Details ↗</button></td></tr>`;
  }).join('')||`<tr><td colspan="6" class="empty">${tokens.length ? filter==='review' ? 'No tokens currently meet every market rule in this sample. This is a screening outcome, not a system error.' : 'No sampled tokens match this category.' : 'No Pump pools are available in the current discovery sample.'}</td></tr>`;
  $('show-all-tokens').hidden=shown.length>0 || tokens.length===0 || filter==='all';
  const sourceIssue=(snapshot?.errors||[]).some(e=>e.source.startsWith('DEX'));
  $('token-asof').textContent=`Sample updated ${since(snapshot?.tokenUpdatedAt)}. ${tokens.length} observed Pump pools. At least $100,000 reported liquidity, 24 hours of history, 100 hourly transactions and 20 sells are required. ${sourceIssue?'A discovery source did not refresh; source timestamps are retained. ':''}The sample includes paid promotions and does not rank safety or predict returns.`;
}
async function loadBacktest() {
  if(backtestBusy)return;backtestBusy=true;
  try{
    const data=await publishedJson('data/scanner-backtest.json', d => d.modelVersion === MODEL_VERSION && Array.isArray(d.runs) && d.runs.length > 0);
    if(data.modelVersion!==MODEL_VERSION || !Array.isArray(data.runs) || !data.runs.length)throw new Error('A replay of the current model is required');
    backtest=data;renderBacktest();renderOutcomes();render();
  }catch(e){
    if(!backtest){$('backtest-summary').textContent='Historical results for the current scanner have not loaded. Code tests alone are not evidence of profitability.';$('backtest-rows').innerHTML='<tr><td colspan="7" class="empty">The latest completed replay will appear here when published.</td></tr>';}
  }finally{backtestBusy=false;}
}
function renderBacktest(){
  if(!backtest)return;
  const r=backtest.runs[0], percent=n=>Number.isFinite(n)?n.toFixed(2)+'%':'Not available';
  const losing=r.returnPct<0;
  $('strategy-evidence').textContent=losing ? `Research only: the current scanner lost ${Math.abs(r.returnPct).toFixed(2)}% in the 90-day replay after modeled costs. It has not demonstrated a profitable edge. See the backtests below.` : 'Research only: a positive historical sample does not establish a profitable edge. Review the backtests and limitations below.';
  $('strategy-evidence').classList.toggle('failed-evidence',losing);
  $('backtest-summary').classList.toggle('failed-evidence',losing);
  $('backtest-summary').textContent=`${r.assessment}. ${new Date(backtest.start*1000).toISOString().slice(0,10)} to ${new Date(backtest.end*1000).toISOString().slice(0,10)} (UTC), across ${backtest.products.length} markets. ${backtest.dataIssues?.length?"Data gaps affect the full-universe replay; a high-coverage comparison is included. ":""}This is a fixed-rule historical replay, not live profit or a forecast.`;
  const metrics=[['90-DAY NET RETURN',percent(r.returnPct),'After all modeled costs'],['MAX DRAWDOWN',percent(r.maxDrawdownPct),'Loss from the preceding equity peak'],['COMPLETED TRADES',String(r.trades),`${r.forcedExits} end-of-window liquidations`],['FEES PAID',money(r.feesUsd),'Spread and slippage are additional modeled costs']];
  $('backtest-metrics').innerHTML=metrics.map(([label,value,sub],i)=>`<div class="metric"><span>${label}</span><strong class="${i<2 && value.startsWith('-')?'negative':''}">${escape(value)}</strong><small>${escape(sub)}</small></div>`).join('');
  $('backtest-rows').innerHTML=backtest.runs.map(x=>`<tr><td><strong>${escape(x.name)}</strong></td><td class="${x.returnPct>=0?'positive':'negative'}">${percent(x.returnPct)}</td><td>${percent(x.maxDrawdownPct)}</td><td>${x.trades}</td><td>${percent(x.winRatePct)}</td><td>${money(x.feesUsd)}</td><td>${percent(x.benchmarkReturnPct)}</td></tr>`).join('');
  const coverage=Math.min(...Object.values(backtest.quality).map(x=>x.fiveMinute.pct));
  $('backtest-note').textContent=`Default replay: 60 bps fees and 10 bps slippage per side, plus a modeled 10 bps bid/ask spread. Five-minute data coverage: ${coverage.toFixed(2)}% or better. Buy and hold has greater exposure. The 30-day slices each start fresh; they are not added together. No Pump.fun backtest or profitability claim is provided.`;
}
function choose(product) { if(!PRODUCTS.includes(product))return;selected=product;$('product').value=product;render(); }
document.addEventListener('click', e=>{
  const market=e.target.closest('[data-product]');if(market){choose(market.dataset.product);if(market.classList.contains('row-action')){$('plan-title').tabIndex=-1;$('plan-title').focus();$('plan-title').scrollIntoView({block:'center',behavior:'smooth'});}}
  const token=e.target.closest('[data-token]');if(token){
    const t=snapshot?.tokens?.[Number(token.dataset.token)];if(!t)return;
    const valid=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.pair||'');
    $('token-detail').hidden=false;
    const rules=t.rules||[];
    const observed=r=>r.actual===null?'Not reported':r.name==='Liquidity'?money(r.actual,0):typeof r.actual==='number'?r.actual.toFixed(r.name==='Pool history'||r.name==='Volume / liquidity'||r.name==='One-hour move'?1:0):r.actual;
    const checks=rules.length?`<div class="table-scroll"><table class="check-table"><thead><tr><th>Market rule</th><th>Observed</th><th>Required</th><th>Outcome</th></tr></thead><tbody>${rules.map(r=>`<tr><td>${escape(r.name)}</td><td>${escape(observed(r))}</td><td>${escape(r.threshold)}</td><td>${escape(r.state==='pass'?'Met':r.state==='unknown'?'Unknown':'Not met')}</td></tr>`).join('')}</tbody></table></div>`:`<ul>${(t.blocks||[]).map(x=>`<li>${escape(x)}</li>`).join('')}</ul>`;
    $('token-detail').innerHTML=`<strong>${escape(t.name)} · ${escape(t.symbol)}</strong><p>Mint: ${escape(t.address)}</p>${checks}<p>Separate security and access checks:</p><ul>${(t.checks||[]).map(x=>`<li>${escape(x)}</li>`).join('')}</ul><p>Execution is disabled. Passing market rules does not establish token safety, sellability, or U.S. eligibility.</p>${valid?`<a href="https://dexscreener.com/solana/${t.pair}" target="_blank" rel="noopener noreferrer">Inspect public pool data ↗</a>`:''}`;
  }
});
$('token-filter').addEventListener('change',renderTokens);
$('show-all-tokens').addEventListener('click',()=>{$('token-filter').value='all';renderTokens();});
$('product').addEventListener('change',e=>choose(e.target.value));
for(const id of ['search','only-candidates'])$(id).addEventListener('input',render);
for(const id of ['capital','risk','fee','slippage'])$(id).addEventListener('input',()=>{const p=model();if(!modelError)try{localStorage.setItem('mm-model-v3',JSON.stringify(p));}catch{}render();});
$('theme').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('mm-theme',next);}catch{}renderChart();});
$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'Resume live':'Pause live';if(paused)disconnect();else{connect();restQuotes();loadHistories();}render();});
$('refresh').addEventListener('click',async()=>{$('refresh').disabled=true;try{connect();await Promise.allSettled([loadSnapshot(),loadHistories(true),restQuotes(true),loadBacktest()]);}finally{$('refresh').disabled=false;}});
$('export').addEventListener('click',()=>{
  const p=snapshot?.paper;if(!p){$('export-status').textContent='The paper ledger has not loaded yet.';return;}
  const rows=[['product','strategy','state','opened_utc','closed_utc','quantity','entry_usd','exit_usd','net_pnl_usd','reason'],
    ...(p.positions||[]).map(x=>[x.product,x.strategy,'open',new Date(x.openedAt*1000).toISOString(),'',x.quantity,x.entry,'','','Open paper position']),
    ...(p.closed||[]).map(x=>[x.product,x.strategy,'closed',new Date(x.openedAt*1000).toISOString(),new Date(x.closedAt*1000).toISOString(),x.quantity,x.entry,x.exit,x.pnl,x.reason])];
  const csv=rows.map(row=>row.map(x=>{const s=String(x??'');return '"'+(/^[=+@\t\r]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
  $('csv-preview').value=csv;$('export-fallback').hidden=false;$('export-fallback').open=true;
  $('export-status').textContent='CSV ready. Choose Download CSV or copy the preview below.';
  const download=$('download-csv');download.hidden=true;
  try {
    if(exportUrl)URL.revokeObjectURL(exportUrl);
    exportUrl=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    download.href=exportUrl;download.download=`Moffitt-Money-paper-${new Date().toISOString().slice(0,10)}.csv`;download.hidden=false;
  } catch {$('export-status').textContent='CSV ready to copy below. This browser could not prepare a download.';}
});
$('copy-csv').addEventListener('click',async()=>{
  $('export-fallback').open=true;$('csv-preview').focus();$('csv-preview').select();
  $('export-status').textContent='CSV selected. Use your device’s Copy command if automatic copying is unavailable.';
  try{await Promise.race([navigator.clipboard.writeText($('csv-preview').value),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Clipboard unavailable')),2000))]);$('export-status').textContent='CSV copied.';}catch{}
});
// Keep the socket alive in background and embedded tabs. Hidden-tab status
// is not evidence that the user cannot see the app in an embedded browser.
document.addEventListener('visibilitychange',()=>{if(!document.hidden){connect();loadSnapshot();restQuotes();loadHistories();}render();});
window.addEventListener('pagehide',()=>{disposed=true;disconnect();});
window.addEventListener('pageshow',()=>{if(disposed){disposed=false;connect();}});
setInterval(()=>{if(!disposed){render();if(!paused){connect();restQuotes();}}},15000);
setInterval(()=>{if(!document.hidden && !disposed)render();},3000);
setInterval(()=>{if(!disposed){loadSnapshot();loadHistories();}},60000);
setInterval(()=>{if(!disposed)loadBacktest();},300000);
window.addEventListener('online',()=>{connect();loadSnapshot();restQuotes();loadHistories();});


function renderOutcomeOverview() {
  const policy=assessEvidence(backtest), base=backtest?.runs?.find(r=>r.name==='Combined · 90 days');
  const paper=snapshot?.paper;
  $('outcome-verdict').textContent=!backtest?'Evidence required before entry':policy.state==='held'?'New paper entries are held':'Paper-research gate passed';
  const items=[['Historical result',base?base.returnPct.toFixed(2)+'%':'Not loaded',base?`${base.trades} closed trades in the 90-day replay`:'Awaiting a matching replay',base?.returnPct<0],['Forward result',paper?signed(paper.equity-paper.start):'Not loaded',paper?`${paper.closed.length} closed · ${paper.positions.length} open · simulated`:'Awaiting the shared book',paper&&paper.equity<paper.start],['Strategy decision',policy.state==='held'?'Needs revision':'Paper only',policy.allowedStrategies.length?`${policy.allowedStrategies.length} strategies pass the checks`:'No strategy passes the outcome checks',false]];
  $('outcome-overview').innerHTML=items.map(([label,value,note,negative])=>`<div><span>${escape(label)}</span><strong class="${negative?'negative':''}">${escape(value)}</strong><small>${escape(note)}</small></div>`).join('');
}
function renderEquity(id, points, label) {
  const rows=(Array.isArray(points)?points:[]).filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.equity));
  if(rows.length<2){$(id).innerHTML='<p class="empty">At least two recorded equity points are needed to draw this curve.</p>';return;}
  const stride=Math.max(1,Math.ceil(rows.length/250));
  const sampled=rows.filter((_,i)=>i%stride===0||i===rows.length-1);
  const width=900,height=230,left=76,right=20,top=20,bottom=36;
  const lo=Math.min(...rows.map(p=>p.equity)),hi=Math.max(...rows.map(p=>p.equity)),pad=Math.max((hi-lo)*.15,1),min=lo-pad,max=hi+pad;
  const first=rows[0].t,last=rows.at(-1).t;
  const x=t=>left+(t-first)/Math.max(1,last-first)*(width-left-right),y=n=>top+(max-n)/(max-min)*(height-top-bottom);
  const line=sampled.map((p,i)=>`${i?'L':'M'}${x(p.t).toFixed(2)},${y(p.equity).toFixed(2)}`).join(' ');
  const ticks=Array.from({length:4},(_,i)=>{const value=max-(max-min)*i/3;return `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--line)"/><text x="${left-12}" y="${y(value)+5}" text-anchor="end" fill="var(--quiet)" font-size="14">${escape(money(value,0))}</text>`;}).join('');
  const date=t=>new Date(t*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const color=rows.at(-1).equity<rows[0].equity?'var(--red)':'var(--teal)';
  $(id).innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}: ${escape(money(rows[0].equity))} to ${escape(money(rows.at(-1).equity))}, ${date(first)} through ${date(last)}"><title>${escape(label)}</title>${ticks}<path d="${line}" fill="none" stroke="${color}" stroke-width="2.5"/><circle cx="${x(last)}" cy="${y(rows.at(-1).equity)}" r="4" fill="${color}"/><text x="${left}" y="${height-5}" fill="var(--quiet)" font-size="14">${date(first)}</text><text x="${width-right}" y="${height-5}" text-anchor="end" fill="var(--quiet)" font-size="14">${date(last)}</text></svg>`;
}
function renderOutcomes() {
  if(!backtest)return;
  const base=backtest.runs.find(r=>r.name==='Combined · 90 days'),policy=assessEvidence(backtest),s=summarizeTrades(base?.ledger);
  if(!base)return;
  $('strategy-reviews').innerHTML=policy.strategies.map(r=>`<article class="strategy-review"><div class="between"><h3>${escape(r.name)}</h3>${badge(r.status==='needs-revision'?'Needs revision':r.allowed?'Paper eligible':'Insufficient evidence',r.allowed?'good':'amber')}</div><strong class="${r.returnPct<0?'negative':''}">${Number.isFinite(r.returnPct)?r.returnPct.toFixed(2)+'%':'Unavailable'}</strong><p>${r.trades} trades · ${Number.isFinite(r.profitFactor)?r.profitFactor.toFixed(2):'Unknown'} profit factor</p><p class="quiet">${escape(r.reason)}</p></article>`).join('');
  renderEquity('historical-curve',base.curve,'Historical model equity');
  const halt=base.drawdownHalt&&base.ledger?.length?Math.max(...base.ledger.map(t=>t.closedAt)):null;
  $('historical-curve-note').textContent=`${money(base.finalEquity)} ending equity. ${halt?'The loss halt left this book in cash after '+new Date(halt*1000).toLocaleDateString()+'. ':''}The three 30-day scenarios restart their books and are not additive. Equity is sampled from the recorded hourly curve.`;
  const max=Math.max(1,...s.exits.map(x=>Math.abs(x.pnl)));
  const attribution=s.exits.map(e=>`<div class="attribution-row"><div class="between"><span>${escape(e.reason)} <small>(${e.trades})</small></span><b class="${e.pnl<0?'negative':'positive'}">${signed(e.pnl)}</b></div><div class="attribution-track"><span style="width:${Math.abs(e.pnl)/max*100}%;background:${e.pnl<0?'var(--red)':'var(--teal)'}"></span></div></div>`).join('');
  $('outcome-diagnosis').innerHTML=`<div class="payoff-comparison"><div><span>Observed win rate</span><strong>${s.winRate?.toFixed(1)??'Unknown'}%</strong></div><div><span>Win rate needed at observed payoffs</span><strong>${s.empiricalBreakeven?.toFixed(1)??'Unknown'}%</strong></div></div><p class="small quiet">Average winner ${money(s.averageWin)}; average loss ${money(s.averageLoss)}. These describe past closed trades and are not forecasts.</p><div class="diagnostic-fact"><span>Average realized result / trade</span><b class="negative">${signed(s.expectancy)}</b></div><div class="diagnostic-fact"><span>Recorded fees</span><b>${money(s.fees)}</b></div><div class="diagnostic-fact"><span>Same trades with recorded fees added back</span><b class="${s.beforeRecordedFees<0?'negative':'positive'}">${signed(s.beforeRecordedFees)}</b></div><p class="small quiet">The fee add-back keeps spread and slippage. It is not a zero-fee strategy replay.</p><h4>Net result by exit</h4>${attribution}`;
  $('evidence-checks').innerHTML=policy.checks.map(c=>`<div class="evidence-check"><span aria-hidden="true" class="${c.pass?'positive':'negative'}">${c.pass?'✓':'×'}</span><span>${escape(c.label)}</span><small>${c.pass?'Met':'Not met'}</small></div>`).join('')+`<p class="gate-decision">${escape(policy.reason)}</p><p class="small quiet">Research policy: 30 trades and 1.15 profit factor are chosen screening thresholds, not statistical proof or permission for real trading. Supporting reports must match the model, costs and chronological windows.</p>`;
}
async function loadExperiments() {
  try {
    const data=await publishedJson('data/outcome-experiments.json',d=>d.modelVersion===MODEL_VERSION&&Array.isArray(d.runs));
    const names={baseline:'Original rules','net-r-two':'Minimum net reward / risk: 2.0','seven-day-exit':'Time exit: 7 days'};
    $('experiments').innerHTML=`<table><thead><tr><th>Rule set</th><th>90-day return</th><th>First / middle / last 30 days</th><th>Trades</th><th>Decision</th></tr></thead><tbody>${Object.entries(names).map(([id,name])=>{const all=data.runs.filter(r=>r.variant===id),full=all.find(r=>r.window==='Full 90 days'),slices=all.filter(r=>r.window!=='Full 90 days');if(!full)return '';return `<tr><td><strong>${escape(name)}</strong></td><td class="${full.returnPct<0?'negative':'positive'}">${full.returnPct.toFixed(2)}%</td><td>${slices.map(r=>r.returnPct.toFixed(2)+'%').join(' / ')}</td><td>${full.trades}</td><td>${badge(id==='baseline'?'Needs revision':'Not adopted','amber')}</td></tr>`;}).join('')}</tbody></table>`;
  } catch { $('experiments').innerHTML='<p class="empty">The saved rule comparison could not load. Current entry checks still use the matching baseline replay.</p>'; }
}

function updateRegion(id, html) {
  const el = $(id), active = document.activeElement;
  const product = el.contains(active) ? active?.dataset?.product : null;
  if (el.innerHTML === html) return;
  el.innerHTML = html;
  if (product) el.querySelector(`[data-product="${product}"]`)?.focus({preventScroll:true});
}
function renderHealth() {
  const scanAt = snapshot?.generatedAt, bookAt = snapshot?.paper?.updatedAt;
  const scanAge = ageSeconds(scanAt), bookAge = ageSeconds(bookAt);
  const scanSource = publicationHealth.get('data/opportunities.json');
  const recentLabel = (at, limit) => !at ? 'Not loaded' : ageSeconds(at) > limit ? 'Delayed · ' + since(at) : since(at);
  $('scan-freshness').textContent = recentLabel(scanAt, 1200);
  $('scan-freshness').className = scanAge <= 1200 ? 'positive' : 'negative';
  $('ledger-freshness').textContent = recentLabel(bookAt, 1200);
  $('ledger-freshness').className = bookAge <= 1200 ? 'positive' : 'negative';
  const quoteCount = markets.filter(m => quoteUsable(m.quote)).length;
  const sourceLabel = scanSource?.source === 'repository' ? 'Latest repository snapshot' : scanSource?.source === 'bundled' ? 'Bundled fallback; latest source could not load' : scanSource?.source === 'retained' ? 'Retained newer record; source refresh failed or went backward' : 'Source not loaded';
  const cards = [
    ['Live market quotes', paused ? 'Paused' : quoteCount ? 'Receiving' : 'Unavailable', `${quoteCount} of ${PRODUCTS.length} fresh quotes`, 0, 'A quote is usable for entry checks for 30 seconds. A new scan does not refresh the original quote time.', quoteCount && !paused],
    ['Shared opportunity scan', !scanAt ? 'Unavailable' : scanAge > 1200 ? 'Delayed' : (snapshot?.errors?.length ? 'Partial source errors' : 'Recent'), scanAt ? since(scanAt) : 'Waiting for data', scanAt, sourceLabel + '. Checked every minute while this page is open.', scanAge <= 1200 && !snapshot?.errors?.length],
    ['Forward paper ledger', !bookAt ? 'Unavailable' : bookAge > 1200 ? 'Delayed' : 'Recent', bookAt ? since(bookAt) : 'Waiting for data', bookAt, 'Shared scheduled simulation. Live quotes do not update its recorded fills or equity.', bookAge <= 1200],
    ['Token discovery sample', !snapshot?.tokenUpdatedAt ? 'Unavailable' : ageSeconds(snapshot.tokenUpdatedAt) > 1200 ? 'Delayed' : 'Recent', snapshot?.tokenUpdatedAt ? since(snapshot.tokenUpdatedAt) : 'Waiting for data', snapshot?.tokenUpdatedAt, 'Discovery sample with its own collection time. Missing security checks remain unresolved.', ageSeconds(snapshot?.tokenUpdatedAt) <= 1200],
    ['Scanner historical replay', backtest ? 'Historical study' : 'Unavailable', backtest ? `${new Date(backtest.start * 1000).toLocaleDateString()} to ${new Date(backtest.end * 1000).toLocaleDateString()}` : 'Waiting for report', backtest?.generatedAt, 'Fixed research window. Its original date is expected and does not indicate a disconnected quote feed.', !!backtest],
    ['Legacy research', 'Archived', 'Collection retired September 8', 0, 'Earlier stocks, arbitrage and offshore wallet experiments are preserved as historical records. Use Markets for the active scanner.', false]
  ];
  $('health-cards').innerHTML = cards.map(([title, status, value, at, note, ok]) => `<article class="health-card"><div class="between"><h3>${escape(title)}</h3>${badge(status,ok ? 'good' : 'amber')}</div><strong>${escape(value)}</strong>${at ? `<time datetime="${new Date(at*1000).toISOString()}">${escape(stamp(at))}</time>` : ''}<p>${escape(note)}</p></article>`).join('');
  const problems = [...(snapshot?.errors || []).map(e => `${e.source}: ${e.message}`)];
  if (scanSource?.source === 'bundled') problems.push('Latest repository data could not load. Showing the bundled snapshot with its original date.');
  if (scanSource?.source === 'retained') problems.push(scanSource.error || 'The most recent loaded record is being retained.');
  if (snapshotError) problems.push(snapshotError);
  if (historyError) problems.push(historyError);
  $('source-errors').innerHTML = problems.length ? `<ul>${problems.map(e=>`<li>${escape(e)}</li>`).join('')}</ul>` : snapshot ? '<p>No source errors were reported by the latest loaded scan.</p>' : '<p>Snapshot has not loaded yet.</p>';
  if (snapshot) $('paper-asof').textContent = `${bookAge > 1200 ? 'Delayed snapshot' : 'Snapshot'} · ${since(bookAt)} · ${stamp(bookAt)}`;
}
const views = {
  markets: ['Market overview', 'Live prices, completed-hour setups, and the cost of taking a position.'],
  paper: ['Paper performance', 'Follow the shared model, its positions, and its results after costs.'],
  discovery: ['Token radar', 'Review the observed pools and see exactly which screening rules they meet.'],
  backtests: ['Outcomes & decisions', 'See what worked, what failed, and why a new paper entry is allowed or held.'],
  health: ['Data health', 'Check each source separately. Fresh prices and fresh paper results are different.']
};
function showView(view, moveFocus = false) {
  if (!Object.hasOwn(views, view)) view = 'markets';
  for (const el of document.querySelectorAll('[data-page]')) el.hidden = el.dataset.page !== view;
  for (const el of document.querySelectorAll('[data-view]')) {
    const active = el.dataset.view === view;
    el.classList.toggle('selected',active);
    if (active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  }
  $('view-title').textContent = views[view][0];
  $('view-description').textContent = views[view][1];
  document.title = `Moffitt Money | ${views[view][0]}`;
  if (moveFocus) { $('view-title').tabIndex=-1; $('view-title').focus({preventScroll:true}); window.scrollTo({top:0,behavior:'instant'}); }
}
window.addEventListener('hashchange',()=>showView(location.hash.slice(1),true));
$('health-refresh').addEventListener('click',()=>$('refresh').click());
showView(location.hash.slice(1));
get('build-info.json?t='+Date.now()).then(info=>{$('site-build').textContent=`Site release ${info.version} · Published build ${new Date(info.builtAt).toLocaleString()}. Market data updates independently.`;}).catch(()=>{$('site-build').textContent='Moffitt Money 4.0. Market data updates independently of the interface.';});
// Optional page-scoped agent access to the same visible research state.
if (document.modelContext?.registerTool) {
  const lifetime = new AbortController();
  const register = tool => { try { Promise.resolve(document.modelContext.registerTool(tool,{signal:lifetime.signal})).catch(()=>{}); } catch {} };
  register({name:'read_market_research',title:'Read market research',description:'Read the displayed research signals and original data timestamps; never places an order.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({selected,generatedAt:snapshot?.generatedAt||null,signals:signals.map(s=>({product:s.product,status:s.status,strategy:s.strategy,reasons:s.reasons})),sources:[...publicationHealth.entries()]})});
  register({name:'inspect_market',title:'Inspect a market',description:'Select a supported market in the visible research workspace and show its existing position model.',inputSchema:{type:'object',properties:{product:{type:'string',enum:PRODUCTS}},required:['product'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:input=>{if(!input||!PRODUCTS.includes(input.product))throw new Error('Choose a supported USD market');choose(input.product);location.hash='markets';showView('markets');const s=signals.find(s=>s.product===selected);return{product:selected,status:s?.status,reasons:s?.reasons};}});
  window.addEventListener('pagehide',()=>lifetime.abort(),{once:true});
}

render();connect();loadSnapshot();loadHistories();restQuotes();loadBacktest();loadExperiments();
