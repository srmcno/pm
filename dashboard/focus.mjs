import {publishedJson,publicationHealth} from './data-client.mjs';
import {validPredictions} from './app-schema.mjs';
import {VENUES} from './prediction-core.mjs';
import {venueSummary,ledgerRows,toCsv} from './focus-model.mjs';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number.isFinite(v)?v.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Not available';
const when=v=>Number.isFinite(v)?new Date(v*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not recorded';
const venueName=v=>v==='polymarket'?'Polymarket US':'Kalshi';
const empty=(title,detail)=>`<div class="empty"><strong>${esc(title)}</strong>${esc(detail)}</div>`;
let snapshot,busy=false,limit=60;
try {document.documentElement.dataset.theme=localStorage.getItem('mm-theme-v5')||'light';} catch {}
function route(){
  const raw=location.hash.slice(1),first=raw.split('/')[0];
  if(['copy','crypto','research','desk'].includes(first)){
    location.replace(`archive-workspace.html#${raw}`);return;
  }
  const page=first==='trades'?'activity':['overview','activity','archive'].includes(first)?first:'overview';
  document.querySelectorAll('[data-view]').forEach(el=>el.hidden=el.dataset.view!==page);
  document.querySelectorAll('[data-page]').forEach(el=>{
    if(el.dataset.page===page)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
  });
  const titles={overview:['Your paper accounts','Positions, results and what the collector is doing now.'],activity:['Account activity','Actual paper entries and official settlements.'],archive:['Tools & archive','The full research workspace, without the clutter on your main screen.']};
  $('page-title').textContent=titles[page][0];$('page-subtitle').textContent=titles[page][1];
  document.title=`Moffitt Money | ${page==='archive'?'Archive':page==='activity'?'Activity':'Overview'}`;
}
function accountCard(v){
  const r=venueSummary(snapshot,v),a=r.account;
  const count=a.positions.length+a.trades.length;
  const label=snapshot.entryPolicy?'Experimental paper':'Paper account';
  return `<article class="account-card"><div class="card-head"><div class="venue"><span class="venue-icon" aria-hidden="true">${v==='polymarket'?'P':'K'}</span>${venueName(v)}</div><span class="pill">${label}</span></div><div class="equity">${money(a.equity)}</div><div class="small-label">Paper equity · started with ${money(a.initialCapital)}</div><dl class="metrics"><div><dt>Available cash</dt><dd>${money(a.cash)}</dd></div><div><dt>Realized P&amp;L</dt><dd class="${a.realizedPnl>0?'positive':a.realizedPnl<0?'negative':''}">${money(a.realizedPnl)}</dd></div><div><dt>Entries recorded</dt><dd>${count}</dd></div></dl><div class="account-state"><strong>${esc(r.status)}</strong><p>${esc(r.detail)}</p></div><div class="card-bottom"><span>${a.positions.length} open · ${a.trades.length} settled</span><span>${r.checked} market${r.checked===1?'':'s'} checked${r.partial?' · partial scan':''}</span></div></article>`;
}
function record(r){
  const settled=r.status==='settled',value=settled?r.pnl:r.cost;
  const policy=r.forecast?.entryStage==='experimental'?'Experimental paper':r.forecast?.entryStage==='calibration-screen'?'Calibration-screened paper':'Paper';
  return `<article class="record"><div><div class="record-title">${esc(r.question||r.contractQuestion||r.marketId)}</div><div class="record-meta">${venueName(r.venue)} · ${esc((r.side||'').toUpperCase())} × ${r.quantity} · ${settled?'Settled':'Opened'} ${when(settled?r.closedAt:r.openedAt)} · ${policy}</div></div><div class="record-money"><strong class="${settled?(value>=0?'positive':'negative'):''}">${money(value)}</strong><small>${settled?'realized P&L':'entry cost'}</small></div></article>`;
}
function filteredRows(){return ledgerRows(snapshot).filter(r=>($('activity-venue').value==='all'||r.venue===$('activity-venue').value)&&($('activity-state').value==='all'||r.status===$('activity-state').value));}
function renderActivity(){
  if(!snapshot)return;
  const rows=filteredRows();$('ledger-count').textContent=`${rows.length} recorded ${rows.length===1?'position':'positions'} · each venue has its own account`;
  $('ledger').innerHTML=rows.length?rows.slice(0,limit).map(record).join(''):empty('No entries in this view','Scans and research observations are not counted as bets.');
  $('load-more').hidden=rows.length<=limit;
  const cycles=[...(snapshot.automation?.recentCycles||[])].sort((a,b)=>b.at-a.at).slice(0,20);
  $('cycles').innerHTML=cycles.length?cycles.map(c=>`<div class="record"><div><div class="record-title">${when(c.at)}</div><div class="record-meta">${c.venues.map(v=>`${venueName(v.venue)}: ${v.checked} checked, ${v.opened.length} opened, ${v.settled.length} settled, ${v.pending||0} pending`).map(esc).join('<br>')}</div></div></div>`).join(''):empty('No cycle receipts yet','The first completed collector receipt will appear here.');
}
function renderMarkets(){
  if(!snapshot||!$('market-details').open)return;
  const decisions=snapshot.decisions||[],byMarket=new Map();
  for(const d of decisions){const old=byMarket.get(d.marketId);if(!old||(d.plan?.edge??-9)>(old.plan?.edge??-9))byMarket.set(d.marketId,d);}
  const rows=[...byMarket.values()].sort((a,b)=>Number(b.plan.status==='candidate')-Number(a.plan.status==='candidate')||(b.plan.edge??-9)-(a.plan.edge??-9));
  const markets=new Map(snapshot.markets.map(m=>[m.id,m]));
  $('market-list').innerHTML=rows.length?rows.map(d=>{
    const m=markets.get(d.marketId),f=d.forecast;
    const label=d.plan.status==='candidate'?'Qualified in last scan':f?.entryStage==='warmup'?'Paper warmup':'Entry held';
    const reason=d.plan.reasons?.join(' ')||'The collector applies confirmation and account-level checks before recording a position.';
    return `<article class="record"><div><div class="record-title">${esc(m?.displayTitle||m?.question||d.marketId)}</div><div class="record-meta">${venueName(d.venue)} · ${esc(label)} · ${esc(f?.entryStage==='experimental'?'Experimental estimate, not validated':'Paper evaluation')}</div><details><summary>Why this decision?</summary><p class="muted">${esc(reason)}</p></details></div></article>`;
  }).join(''):empty('No market decisions','Read the venue status above for the latest collection state.');
}
function render(){
  $('account-grid').innerHTML=VENUES.map(accountCard).join('');
  $('scan-time').textContent=`Last completed scan: ${when(snapshot.generatedAt)}`;
  const positions=ledgerRows(snapshot).filter(p=>p.status==='open');
  $('positions').innerHTML=positions.length?positions.slice(0,6).map(record).join(''):empty('No open positions','The account cards show whether each venue is warming up, confirming an entry, or held by another condition.');
  $('market-count').textContent=`(${snapshot.markets.length})`;
  $('policy-label').textContent=snapshot.entryPolicy?`Paper policy: ${snapshot.entryPolicy.version}`:'Awaiting the first updated policy receipt';
  $('export').disabled=false;renderActivity();renderMarkets();
}
async function load(){
  if(busy)return;busy=true;$('refresh').disabled=true;$('refresh').textContent='Refreshing';
  try{
    snapshot=await publishedJson('data/predictions.json',validPredictions);
    const health=publicationHealth.get('data/predictions.json');
    $('notice').hidden=!health?.error;
    $('notice').textContent=health?.error?`Showing ${health.source==='retained'?'the newer retained':'the available'} snapshot. Latest refresh: ${health.error}`:'';
    render();
  }catch(error){
    $('notice').hidden=false;$('notice').textContent=`Prediction data could not be loaded: ${error.message}. No balance has been reset.`;
    if(!snapshot)$('account-grid').innerHTML=empty('Account data unavailable','Use Refresh to try the published sources again.');
  }finally{busy=false;$('refresh').disabled=false;$('refresh').textContent='Refresh';}
}
$('refresh').addEventListener('click',load);
$('theme').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('mm-theme-v5',next);}catch{}});
for(const id of ['activity-venue','activity-state'])$(id).addEventListener('change',()=>{limit=60;renderActivity();});
$('load-more').addEventListener('click',()=>{limit+=60;renderActivity();});
$('market-details').addEventListener('toggle',renderMarkets);
$('export').addEventListener('click',()=>{
  if(!snapshot)return;
  const url=URL.createObjectURL(new Blob([toCsv(filteredRows())],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='moffitt-money-prediction-ledger.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
addEventListener('hashchange',route);
route();load();setInterval(()=>{if(document.visibilityState==='visible')load();},60000);
