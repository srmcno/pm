import {publishedJson,publicationHealth} from './data-client.mjs';
import {validCompetitionSnapshot,STRATEGIES,FEE_PROFILE} from './crypto-strategies-core.mjs';
import {validPredictions} from './app-schema.mjs';
const $=id=>document.getElementById(id),finite=Number.isFinite;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>finite(v)?v.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unavailable';
const pct=v=>finite(v)?`${v>0?'+':''}${(v*100).toFixed(2)}%`:'Unavailable';
const bps=v=>finite(v)?`${v.toFixed(1)} bps`:'—';
const compact=v=>finite(v)?Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(v):'—';
const when=v=>finite(v)?new Date(v*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not recorded';
const color=v=>v>0?'positive':v<0?'negative':'';
const empty=(title,note)=>`<div class="empty"><strong>${esc(title)}</strong>${esc(note)}</div>`;
let data,predictions,busy=false,limit=50,loadErrors=[];
try{document.documentElement.dataset.theme=localStorage.getItem('mm-theme-v6')||localStorage.getItem('mm-theme-v5')||'light';}catch{}
function page(){return location.hash==='#activity'?'activity':location.hash==='#retired'?'retired':'crypto';}
function route(){
  const p=page();for(const v of ['crypto','activity','retired'])$(v+'-view').hidden=p!==v;
  for(const v of ['crypto','activity','archive'])$(v+'-nav').removeAttribute('aria-current');
  $(p==='retired'?'archive-nav':p+'-nav').setAttribute('aria-current','page');
  $('title').textContent={crypto:'Crypto Tournament',activity:'Account activity',retired:'Retired strategies'}[p];
  $('subtitle').textContent={crypto:'Eight independent paper hypotheses compete after fees, spread, depth and slippage.',activity:'Recorded paper positions across separate prediction and crypto accounts.',retired:'Original losses, sample sizes and retirement decisions are preserved.'}[p];
  document.title=`Moffitt Money | ${$('title').textContent}`;if(data)render();if(p==='activity'&&!predictions&&!busy)load();
}
function accountName(id){return STRATEGIES.find(s=>s.id===id)?.name||({polymarket:'Polymarket US',kalshi:'Kalshi'}[id])||id;}
function ensureFilters(){
  const select=$('account-filter'),value=select.value;select.innerHTML='<option value="all">All accounts</option>'+STRATEGIES.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')+'<option value="polymarket">Polymarket US</option><option value="kalshi">Kalshi</option>';select.value=[...select.options].some(o=>o.value===value)?value:'all';
}
function allRows(){
  const crypto=Object.entries(data?.accounts||{}).flatMap(([id,a])=>[...(a.positions||[]).map(p=>({...p,account:id,kind:'crypto',state:'open'})),...(a.trades||[]).map(p=>({...p,account:id,kind:'crypto',state:'closed'}))]);
  const pred=Object.entries(predictions?.accounts||{}).flatMap(([id,a])=>[...(a.positions||[]).map(p=>({...p,account:id,kind:'prediction',state:'open'})),...(a.trades||[]).map(p=>({...p,account:id,kind:'prediction',state:'closed'}))]);
  return [...crypto,...pred].sort((a,b)=>(b.closedAt||b.openedAt||0)-(a.closedAt||a.openedAt||0));
}
function record(r){
  const closed=r.state==='closed',title=r.kind==='crypto'?r.product:r.question||r.marketId;
  const details=r.kind==='crypto'?`<details><summary>Entry and exit costs</summary><p class="muted">${esc((r.entryReasons||[]).join(' '))}<br>Entry ${money(r.entryPrice)} · stop ${money(r.stop)} · target ${money(r.target)}<br>Entry fee ${money(r.entryFees)} + slippage ${money(r.entrySlippage)}${closed?`<br>Exit fee ${money(r.exitFees)} + slippage ${money(r.exitSlippage)} · ${esc(r.exitReason)}`:''}<br>${esc(r.feeProfile||FEE_PROFILE.id)}</p></details>`:'';
  return `<article class="record"><div><div class="record-title">${esc(title)}</div><div class="record-meta">${esc(accountName(r.account))} · ${esc(r.side)} × ${finite(r.quantity)?Number(r.quantity.toFixed(6)):'?'} · ${closed?'Closed':'Opened'} ${when(r.closedAt||r.openedAt)}</div>${details}</div><div class="record-money"><strong class="${closed?color(r.pnl):''}">${money(closed?r.pnl:r.cost)}</strong><small>${closed?'net realized P&L':'entry cost'}</small></div></article>`;
}
function accountCard(a,rank){
  const pending=Object.keys(a.pending||{}).length,decisions=(data.decisions||[]).filter(d=>d.strategyId===a.id),delayed=Date.now()/1000-data.generatedAt>1200;
  let status=a.status==='retired'?'Retired':a.status==='risk-paused'?'Risk paused':delayed?'Collection delayed':!a.markComplete?'Position price unavailable':pending?'Confirming paper entries':a.positions.length?'Managing positions':'Scanning coin movement';
  let detail=a.retirement?.reason||(!a.markComplete?'An open position needs a fresh book before any new entries.':pending?`${pending} setup${pending===1?'':'s'} passed one scan; entries need a second qualifying scan.`:a.positions.length?'Stops, targets and reversals are checked against observed books.':'No entry met every setup, cost and risk check in the last scan.');
  if(delayed)detail='Showing the last completed cycle, not a current market scan.';
  const strategy=STRATEGIES.find(s=>s.id===a.id),label=a.status==='established'?'Established paper':a.status==='retired'?'Retired':'Experimental paper';
  return `<article class="account-card"><div class="card-head"><div class="venue"><span class="rank">#${rank}</span> ${esc(a.name)}</div><span class="pill ${a.status==='established'?'status-established':''}">${label}</span></div><div class="equity">${money(a.equity)}</div><div class="small-label">Equity · ${money(a.equity-a.initialCapital)} total P&L including open marks</div><dl class="metrics"><div><dt>Realized P&L</dt><dd class="${color(a.realizedPnl)}">${money(a.realizedPnl)}</dd></div><div><dt>Cash</dt><dd>${money(a.cash)}</dd></div><div><dt>Fee drag</dt><dd>${money(a.fees)}</dd></div></dl><div class="account-state"><strong>${esc(status)}</strong><p>${esc(detail)}</p></div><div class="card-bottom"><span>${a.positions.length} open · ${a.trades.length} closed</span><span>${decisions.length} market decisions</span></div><details class="strategy-details"><summary>Hypothesis and evidence</summary><p>${esc(strategy?.description||'Strategy definition unavailable.')}</p><p>${a.stats?.trades?`${a.stats.wins} wins, ${a.stats.losses} losses; net expectancy ${money(a.stats.expectancy)} per closed trade; profit factor ${finite(a.stats.profitFactor)?a.stats.profitFactor.toFixed(2):'not meaningful yet'}.`:'No closed-trade evidence yet. Activity is not proof of an edge.'}</p></details></article>`;
}
function renderUniverse(){
  const u=data.universe||{},selected=u.selected??data.markets.length,discovered=u.discovered??selected;
  $('universe-summary').innerHTML=`<div><strong>${selected} / ${discovered}</strong><span>selected / eligible USD markets</span></div><div><strong>${Object.keys(data.accounts||{}).length}</strong><span>independent strategy bankrolls</span></div><div><strong>${(data.feeProfile?.takerRate*100||.9).toFixed(2)}%</strong><span>taker fee charged per fill</span></div><div><strong>${(data.feeProfile?.makerRate*100||.5).toFixed(2)}%</strong><span>maker reference, not credited</span></div>`;
  $('universe-note').textContent=`${u.ranking||'USD notional, spread and visible depth'} · ${selected} selected`;
}
function renderCrypto(){
  renderUniverse();const active=Object.values(data.accounts).filter(a=>a.status!=='retired').sort((a,b)=>b.equity-a.equity||a.name.localeCompare(b.name));
  $('strategies').innerHTML=active.length?active.map((a,i)=>accountCard(a,i+1)).join(''):empty('No active strategies','All strategies are retired. Their losses and reasons remain in Archive.');
  $('updated').textContent=`Last completed scan: ${when(data.generatedAt)}`;
  const positions=allRows().filter(r=>r.kind==='crypto'&&r.state==='open');$('positions').innerHTML=positions.length?positions.map(record).join(''):empty('No open crypto positions','The tournament enters only observed qualifying setups after modeled costs.');
  const markets=[...(data.markets||[])].sort((a,b)=>((b.quoteVolume24h||0)-(a.quoteVolume24h||0))||a.product.localeCompare(b.product));
  $('coin-board').innerHTML='<div class="coin-row coin-head"><div>Coin / close</div><span>1h</span><span>6h</span><span>24h</span><span class="liquidity">24h volume</span><div class="coin-state">Tournament state</div></div>'+markets.map(m=>{
    const ds=(data.decisions||[]).filter(d=>d.product===m.product&&data.accounts[d.strategyId]?.status!=='retired');
    const activeDecision=ds.find(d=>d.status==='entered')||ds.find(d=>d.status==='confirming')||ds.find(d=>d.status==='held'),candidates=ds.filter(d=>['entered','confirming'].includes(d.status)).length;
    const label=m.status==='unavailable'?'Data unavailable':activeDecision?.status==='entered'?'Paper entry recorded':activeDecision?.status==='confirming'?`${candidates} setup${candidates===1?'':'s'} confirming`:activeDecision?.status==='held'?'Cost / risk hold':'No qualifying setup';
    return `<div class="coin-row"><div><strong>${esc(m.product.replace('-USD',''))}</strong><small>${money(m.price)} · ${bps(m.spreadBps)}</small></div><span class="${color(m.change1)}">${pct(m.change1)}</span><span class="${color(m.change6)}">${pct(m.change6)}</span><span class="${color(m.change24)}">${pct(m.change24)}</span><span class="liquidity">${compact(m.quoteVolume24h)}</span><div class="coin-state">${esc(label)}</div></div>`;
  }).join('');
  const visible=(data.decisions||[]).filter(d=>data.accounts[d.strategyId]?.status!=='retired').sort((a,b)=>Number(['entered','confirming'].includes(b.status))-Number(['entered','confirming'].includes(a.status))||(b.score??-Infinity)-(a.score??-Infinity)).slice(0,120);
  $('decisions').innerHTML=visible.length?visible.map(d=>`<article class="record"><div><div class="record-title">${esc(d.product)} · ${esc(accountName(d.strategyId))}</div><p class="muted">${esc(d.status)}: ${esc((d.reasons||[]).join(' '))}</p>${d.plan?`<div class="record-meta">Planned cost ${money(d.plan.cost)} · modeled stop risk ${money(d.plan.risk)} · reward ${money(d.plan.reward)} · taker-cost profile applied.</div>`:''}</div></article>`).join(''):empty('No strategy decisions loaded','The next completed collector cycle will publish decision receipts.');
}
function filteredRows(){return allRows().filter(r=>($('account-filter').value==='all'||r.account===$('account-filter').value)&&($('state-filter').value==='all'||r.state===$('state-filter').value));}
function renderActivity(){const rows=filteredRows();$('activity-count').textContent=`${rows.length} recorded positions. Bankrolls remain separate.${!predictions?' Prediction ledger unavailable.':''}${!data?' Crypto ledger unavailable.':''}`;$('activity-records').innerHTML=rows.length?rows.slice(0,limit).map(record).join(''):empty('No recorded positions in this view','Scans and research observations are not counted as trades.');$('more').hidden=rows.length<=limit;$('export').disabled=!data&&!predictions;}
function renderRetired(){
  const old=data.retired||[],newly=Object.values(data.accounts||{}).filter(a=>a.status==='retired');
  $('retired-list').innerHTML=old.map(a=>`<article class="archive-card"><small>RETIRED LEGACY MODEL</small><h3>${esc(a.name)}</h3><p>${esc(a.reason)}</p><p><strong>Forward paper: ${money(a.forward?.net)}</strong> across ${a.forward?.trades||0} closed trades.</p><p>Dated replay: ${money(a.replay?.net)} across ${a.replay?.trades||0} trades. Replay and forward results are not added together.</p></article>`).join('')+newly.map(a=>`<article class="archive-card"><small>RETIRED ${esc(when(a.retirement?.at))}</small><h3>${esc(a.name)}</h3><p>${esc(a.retirement?.reason)}</p><p>${money(a.realizedPnl)} net realized across ${a.trades.length} closed trades.</p></article>`).join('');
  if(!old.length&&!newly.length)$('retired-list').innerHTML=empty('No retirement receipt loaded','The original spot ledger remains available below.');const a=data.legacyAccount;$('legacy-total').textContent=a?`Original spot account: ${money(a.equity)} remaining from ${money(a.initialCapital)}. ${a.closed} closed trades. No reset or transfer into the tournament.`:'';
}
function render(){ensureFilters();if(data){renderCrypto();renderRetired();$('policy').textContent=`${data.version} · ${data.feeProfile?.id||FEE_PROFILE.id}`;}renderActivity();}
async function load(){
  if(busy)return;busy=true;$('refresh').disabled=true;loadErrors=[];
  const tasks=[publishedJson('data/crypto-strategies.json',validCompetitionSnapshot).then(x=>{data=x;}).catch(e=>{loadErrors.push(`Crypto: ${e.message}. The first completed tournament scan may not be published yet.`);})];
  if(page()==='activity')tasks.push(publishedJson('data/predictions.json',validPredictions).then(x=>{predictions=x;}).catch(e=>{loadErrors.push(`Predictions: ${e.message}`);}));
  await Promise.all(tasks);
  for(const file of ['data/crypto-strategies.json',...(page()==='activity'?['data/predictions.json']:[])]){const h=publicationHealth.get(file);if(h?.error)loadErrors.push(`${file.includes('crypto')?'Crypto':'Predictions'} uses ${h.source} data: ${h.error}`);}
  if(data?.errors?.length)loadErrors.push(`${data.errors.length} public-source warning(s); affected products are excluded or retained stale without creating entries.`);
  $('notice').hidden=!loadErrors.length;$('notice').textContent=[...new Set(loadErrors)].join(' ');if(!data)$('strategies').innerHTML=empty('Tournament data not available','No balances or trades are invented. Refresh reads the published collector result.');render();busy=false;$('refresh').disabled=false;
}
function csv(rows){const keys=['account','kind','state','product','question','side','quantity','cost','entryFees','entrySlippage','proceeds','exitFees','exitSlippage','pnl','feeProfile','openedAt','closedAt'];const cell=v=>{let x=String(v??'');if(typeof v==='string'&&/^\s*[=+@-]/.test(x))x="'"+x;return '"'+x.replaceAll('"','""')+'"';};return [keys.join(','),...rows.map(r=>keys.map(k=>cell(r[k])).join(','))].join('\r\n');}
$('refresh').onclick=load;$('theme').onclick=()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('mm-theme-v6',theme);}catch{}};
for(const id of ['account-filter','state-filter'])$(id).onchange=()=>{limit=50;renderActivity();};$('more').onclick=()=>{limit+=50;renderActivity();};
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([csv(filteredRows())],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='moffitt-money-account-ledger.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
addEventListener('hashchange',route);route();load();setInterval(()=>{if(document.visibilityState==='visible')load();},60000);
