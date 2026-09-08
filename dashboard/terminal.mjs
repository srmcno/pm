import {PRODUCTS, DEFAULTS, VERSION, ageSeconds, quoteUsable, analyzeMarket} from './market-core.mjs?v=3.0.0';
const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names = {BTC:'Bitcoin', ETH:'Ethereum', SOL:'Solana', LINK:'Chainlink', AVAX:'Avalanche', DOGE:'Dogecoin'};
const money = (n, maximumFractionDigits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', {style:'currency',currency:'USD',maximumFractionDigits}) : 'Unavailable';
const price = n => money(n, n > 10 ? 2 : n > 1 ? 4 : 6);
const signed = n => `${n > 0 ? '+' : ''}${money(n)}`;
const since = t => {const a = ageSeconds(t); return !Number.isFinite(a) ? 'unknown age' : a < 60 ? `${Math.floor(a)}s ago` : a < 3600 ? `${Math.floor(a/60)}m ago` : `${Math.floor(a/3600)}h ago`;};
const stamp = t => t > 0 ? new Date(t * 1000).toLocaleString() : 'not available';
const badge = (label, cls = 'muted') => `<span class="badge ${cls}">${escape(label)}</span>`;
const stateLabel = {candidate:'Paper candidate', waiting:'Watching', stale:'Stale data', unavailable:'Unavailable', 'cost-blocked':'Cost blocked'};
let markets = PRODUCTS.map(product => ({product, candles: [], status:'unavailable'}));
let snapshot = null, signals = [], selected = 'BTC-USD', paused = false;
let ws = null, reconnect = null, attempts = 0, disposed = false, lastChart = '', snapshotBusy = false, directBusy = false;
let restBusy = false, snapshotError = '', historyError = '', modelError = '';
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
    const data = await get(`data/opportunities.json?t=${Date.now()}`);
    if (!Array.isArray(data.markets) || !data.generatedAt || data.version !== VERSION) throw new Error('Incompatible or missing snapshot');
    snapshot = data; data.markets.forEach(mergeMarket); snapshotError = '';
    renderPaper(); renderTokens();
  } catch (e) { snapshotError = `Shared ledger unavailable (${e.message}). Public quotes can still connect.`; }
  finally { snapshotBusy = false; render(); }
}
async function loadHistories() {
  if (directBusy || paused || document.hidden) return;
  directBusy = true;
  let failures = 0;
  try {
    for (let i = 0; i < PRODUCTS.length; i += 2) {
      await Promise.all(PRODUCTS.slice(i,i+2).map(async product => {
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
async function restQuotes() {
  if (restBusy || paused || document.hidden) return;
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
  if (paused || document.hidden || disposed || ws) return;
  clearTimeout(reconnect);
  const socket = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  ws = socket;
  socket.onopen = () => { attempts = 0; socket.send(JSON.stringify({type:'subscribe',product_ids:PRODUCTS,channels:['ticker','heartbeat']})); render(); };
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
    if (ws !== socket) return;
    ws = null; render();
    if (!paused && !document.hidden && !disposed) reconnect = setTimeout(connect, Math.min(60000,1000 * 2 ** Math.min(attempts++,6)));
  };
}
function disconnect() { clearTimeout(reconnect); const socket = ws; ws = null; socket?.close(); }
function render() {
  const p = model();
  signals = markets.map(m => analyzeMarket(m, p));
  const fresh = markets.filter(m => quoteUsable(m.quote));
  const streamed = fresh.filter(m => m.quote.source.includes('WebSocket')).length;
  const label = paused ? 'Paused' : document.hidden ? 'Background' : streamed ? `${streamed}/${PRODUCTS.length} streaming` : fresh.length ? 'REST quotes' : 'Offline / stale';
  $('connection').textContent = label;
  $('connection').className = `badge ${fresh.length && !paused ? 'good' : 'amber'}`;
  $('connection-detail').textContent = paused ? 'Live requests paused. Displayed quotes retain their timestamps.' : streamed ?
    'Direct Coinbase quotes. Entry checks expire after 30 seconds without a fresh quote.' : fresh.length ?
    'Using public REST quotes. This connection is polling, not streaming.' :
    'No qualifying live quotes. New paper candidates are withheld until fresh data arrives.';
  $('clock').textContent = new Date().toLocaleTimeString('en-US', {hour12:false,timeZone:'UTC'}) + ' UTC';
  const notice = [snapshotError, historyError, modelError].filter(Boolean).join(' ');
  $('notice').hidden = !notice; $('notice').textContent = notice;
  $('ticker').innerHTML = markets.map((m,i) => {
    const s = signals[i], q = m.quote, last = s.bars?.at(-1)?.c;
    const change = last && q?.price ? (q.price/last-1)*100 : null;
    const live = quoteUsable(q);
    return `<button class="ticker-card ${selected === m.product ? 'active' : ''}" data-product="${m.product}" aria-label="Inspect ${m.product}"><span class="ticker-name">${m.product.split('-')[0]} <span class="${live ? 'positive' : 'quiet'}">${live ? '●' : '○'}</span></span><strong>${price(q?.price)}</strong><small class="${live && change !== null ? change>=0 ? 'positive' : 'negative' : 'quiet'}">${live && change!==null ? `${change>=0?'+':''}${change.toFixed(2)}% vs 1h close` : `Quote ${since(q?.at)}`}</small></button>`;
  }).join('');
  const text = $('search').value.toLowerCase(), only = $('only-candidates').checked;
  const shown = signals.filter(s => (s.product.toLowerCase().includes(text) || s.strategy.toLowerCase().includes(text)) && (!only || s.status==='candidate'));
  $('scan-count').textContent = `${signals.filter(s=>s.status==='candidate').length} candidates / ${PRODUCTS.length} markets`;
  $('setups').innerHTML = shown.map(s => {
    const m = markets.find(x=>x.product===s.product), live=quoteUsable(m.quote);
    return `<tr><td><strong>${escape(s.product.replace('-',' / '))}</strong><small>${escape(s.strategy)}</small></td><td>${price(m.quote?.price)}<small>${live?'Quote ': 'Stale · '}${since(m.quote?.at)}</small></td><td><span class="${s.regime==='Uptrend'?'positive':'quiet'}">${escape(s.regime||'Unknown')}</span></td><td>${Number.isFinite(s.relativeVolume)?s.relativeVolume.toFixed(2)+'×':'—'}</td><td>${badge(stateLabel[s.status],s.status==='candidate'?'good':s.status==='stale'?'amber':'muted')}</td><td><button class="row-action" data-product="${s.product}" aria-label="Inspect ${s.product} plan">Inspect ↗</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No markets match. Waiting is a valid strategy.</td></tr>';
  renderPlan(); renderChart();
  if (snapshot) $('paper-asof').textContent = 'Snapshot ' + since(snapshot.paper?.updatedAt);
}
function renderPlan() {
  const s = signals.find(s=>s.product===selected);
  if (!s) return;
  let content = `<div class="plan-heading"><strong>${escape(selected.replace('-',' / '))}</strong>${badge(stateLabel[s.status],s.status==='candidate'?'good':'muted')}</div>`;
  if (modelError) content += `<p class="plan-explain">${escape(modelError)}</p>`;
  else if (s.plan && Number.isFinite(s.plan.netR)) {
    const p = s.plan;
    content += `<div class="plan-rows"><div><span>Entry reference</span><b>${price(s.entry)}</b></div><div><span>Stop trigger</span><b class="negative">${price(s.stop)}</b></div><div><span>Price target</span><b class="positive">${price(s.target)}</b></div><div><span>Net reward / risk</span><b>${p.netR.toFixed(2)}R</b></div><div><span>Modeled cash needed</span><b>${money(p.cashRequired)}</b></div><div><span>Loss at modeled stop</span><b class="negative">${money(p.riskUsd)}</b></div></div><p class="plan-tagline">${p.quantity.toFixed(6)} units · limited by ${escape(p.limitedBy)}<br>Fee-adjusted breakeven: ${price(p.breakEven)}<br>Required win rate: ${(p.breakEvenWinRate*100).toFixed(1)}% (not a forecast)</p>`;
  } else {
    content += `<p class="plan-explain">${escape(s.reasons[0] || 'No qualifying entry.')}</p><div class="plan-rows"><div><span>20-hour high</span><b>${price(s.trigger)}</b></div><div><span>Hourly ATR</span><b>${price(s.atr)}</b></div><div><span>20-hour EMA</span><b>${price(s.ema20)}</b></div><div><span>50-hour EMA</span><b>${price(s.ema50)}</b></div></div>`;
  }
  content += `<ul class="plan-reasons">${s.reasons.map(r=>`<li>${escape(r)}</li>`).join('')}</ul><p class="plan-tagline">Candle through ${escape(stamp(s.signalAt))}. A stop is a trigger, not a guaranteed fill. This plan cannot place a trade.</p>`;
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
  const rows=[...(p.positions||[]).map(x=>({...x,open:true})),...closed.slice(-10).reverse()];
  $('paper-rows').innerHTML=rows.map(x=>{
    const gain=x.open?x.quantity*x.mark*(1-DEFAULTS.feeBps/10000)-x.cost:x.pnl;
    return `<tr><td><strong>${escape(x.product)}</strong><small>${escape(x.strategy)}</small></td><td>${badge(x.open?'Open · paper':'Closed · paper',x.open?'amber':'muted')}</td><td>${price(x.entry)}</td><td>${price(x.open?x.mark:x.exit)}<small>${escape(stamp(x.open?x.markAt:x.closedAt))}</small></td><td class="${gain>=0?'positive':'negative'}">${signed(gain)}</td><td>${x.open?'Stop '+price(x.stop):escape(x.reason)}</td></tr>`;
  }).join('')||'<tr><td colspan="6" class="empty">No trades yet. The model waits for fresh data and a setup that survives the next scan.</td></tr>';
  $('paper-note').textContent=`Simulated fills include ${DEFAULTS.feeBps} bps fees and ${DEFAULTS.slippageBps} bps slippage per side. ${p.staleMarks?.length?'Stale marks retained for '+p.staleMarks.join(', ')+'. ':''}Scheduled scans can miss intrahour moves. Stops take priority in ambiguous completed bars; losses can exceed planned risk.`;
}
function renderTokens() {
  const tokens=snapshot?.tokens||[];
  $('tokens').innerHTML=tokens.map((t,i)=>`<tr><td><strong>${escape(t.symbol)}</strong><small>${escape(t.dex)} · ${t.ageHours===null?'age unknown':t.ageHours.toFixed(0)+'h old'}</small></td><td>${money(t.liquidity,0)}</td><td class="${t.change>=0?'positive':'negative'}">${t.change>0?'+':''}${t.change.toFixed(1)}%</td><td>${t.buys} / ${t.sells}</td><td>${badge(t.blocks.length?`${t.blocks.length} filters failed`:'Further review',t.blocks.length?'muted':'amber')}</td><td><button class="row-action" data-token="${i}" aria-label="Review ${escape(t.symbol)} checks">Checks ↗</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">No Pump venue pairs in the latest available discovery sample. No substitute tokens are fabricated.</td></tr>';
  $('token-asof').textContent=`Sample ${since(snapshot?.tokenUpdatedAt)}. At least $100,000 reported liquidity, 24h age, 100 hourly trades and 20 sells required for review. Mint authority, holders and sellability remain unverified.`;
}
function choose(product) { if(!PRODUCTS.includes(product))return;selected=product;$('product').value=product;render(); }
document.addEventListener('click', e=>{
  const market=e.target.closest('[data-product]');if(market)choose(market.dataset.product);
  const token=e.target.closest('[data-token]');if(token){
    const t=snapshot?.tokens?.[Number(token.dataset.token)];if(!t)return;
    const valid=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.pair||'');
    $('token-detail').hidden=false;
    $('token-detail').innerHTML=`<strong>${escape(t.name)} · ${escape(t.symbol)}</strong><p>Mint: ${escape(t.address)}</p><ul>${[...t.blocks,...t.checks].map(x=>`<li>${escape(x)}</li>`).join('')}</ul><p>Execution is disabled. A successful historical sell does not guarantee you can sell now. Pump fees vary by pool and are not included in a spot trade plan.</p>${valid?`<a href="https://dexscreener.com/solana/${t.pair}" target="_blank" rel="noopener noreferrer">Inspect public pool data ↗</a>`:''}`;
  }
});
$('product').addEventListener('change',e=>choose(e.target.value));
for(const id of ['search','only-candidates'])$(id).addEventListener('input',render);
for(const id of ['capital','risk','fee','slippage'])$(id).addEventListener('input',()=>{const p=model();if(!modelError)try{localStorage.setItem('mm-model-v3',JSON.stringify(p));}catch{}render();});
$('theme').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('mm-theme',next);}catch{}renderChart();});
$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'Resume live':'Pause live';if(paused)disconnect();else{connect();restQuotes();loadHistories();}render();});
$('refresh').addEventListener('click',async()=>{$('refresh').disabled=true;try{await Promise.allSettled([loadSnapshot(),loadHistories(),restQuotes()]);}finally{$('refresh').disabled=false;}});
$('export').addEventListener('click',()=>{
  const p=snapshot?.paper;if(!p)return;
  const rows=[['product','strategy','state','opened_utc','closed_utc','quantity','entry_usd','exit_usd','net_pnl_usd','reason'],
    ...(p.positions||[]).map(x=>[x.product,x.strategy,'open',new Date(x.openedAt*1000).toISOString(),'',x.quantity,x.entry,'','','Open paper position']),
    ...(p.closed||[]).map(x=>[x.product,x.strategy,'closed',new Date(x.openedAt*1000).toISOString(),new Date(x.closedAt*1000).toISOString(),x.quantity,x.entry,x.exit,x.pnl,x.reason])];
  const csv=rows.map(row=>row.map(x=>{const s=String(x??'');return '"'+(/^[=+@\t\r]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`Moffitt-Money-paper-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)disconnect();else{connect();loadSnapshot();restQuotes();loadHistories();}render();});
window.addEventListener('pagehide',()=>{disposed=true;disconnect();});
window.addEventListener('pageshow',()=>{if(disposed){disposed=false;connect();}});
setInterval(()=>{if(!document.hidden){render();if(!paused)restQuotes();}},15000);
setInterval(()=>{if(!document.hidden)render();},3000);
setInterval(()=>{if(!document.hidden){loadSnapshot();loadHistories();}},60000);
render();connect();loadSnapshot();loadHistories();restQuotes();
