// Pure HTML builders for the Prediction Lab plus a guarded browser mount. The builders
// touch no DOM, so the overview page and the tests render identical markup. Nothing here
// arms an order; the Lab is paper only and separate from the two $100 accounts.
import {publishedJson,publicationHealth} from './data-client.mjs';
import {validLabSnapshot,LAB_LABEL,LAB_DELAY_SECONDS} from './prediction-lab-core.mjs';

const finite=Number.isFinite;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>finite(v)?v.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Not available';
const when=v=>finite(v)&&v>0?new Date(v*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not recorded';
const day=v=>finite(v)&&v>0?new Date(v*1000).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Not recorded';
const pct=v=>finite(v)?`${(v*100).toFixed(1)}%`:'n/a';
const color=v=>v>0?'positive':v<0?'negative':'';
const empty=(title,note)=>`<div class="empty"><strong>${esc(title)}</strong>${esc(note)}</div>`;
const VENUE={polymarket:'Polymarket US',kalshi:'Kalshi'};
const ROLE={candidate:'Candidate rule',control:'Control',shadow:'Shadow of existing policy'};
const CRITERION_STATE={true:'met',false:'not met',null:'not assessed yet'};

export function labDelay(s,now=Date.now()/1000){return {age:finite(s?.generatedAt)?now-s.generatedAt:null,delayed:!(now-s?.generatedAt<=LAB_DELAY_SECONDS)};}

function criteriaList(ev){
  return `<ul class="lab-criteria" aria-label="Promotion screen progress">${ev.criteria.map(c=>`<li class="lab-crit ${c.pass===true?'pass':c.pass===false?'fail':'pending'}"><span>${esc(c.label)}</span><b>${esc(c.value)}</b><small>${CRITERION_STATE[c.pass]}</small></li>`).join('')}</ul>`;
}
function sourceLines(a,generatedAt){
  const s=a.sourceState||{},lines=[];
  const bad=s.status==='error'||s.status==='stale';
  if(bad)lines.push(`<p class="notice lab-alert" role="status"><strong>Source ${s.status==='stale'?'delayed':'error'}.</strong> ${esc(s.message||'The existing collector data is unavailable.')} No new entries were made; earlier records keep their original times.</p>`);
  else if(s.status==='partial'&&s.message)lines.push(`<p class="notice lab-alert" role="status"><strong>Partial source.</strong> ${esc(s.message)}</p>`);
  if(s.staleMarks>0||s.markFailures>0)lines.push(`<p class="notice lab-alert" role="status">${s.staleMarks} open position${s.staleMarks===1?'':'s'} await${s.staleMarks===1?'s':''} a fresh book or official settlement. Equity uses the last valid liquidation marks, not current quotes.</p>`);
  if(a.pause)lines.push(`<p class="notice lab-alert" role="status"><strong>Entries paused.</strong> ${esc(a.pause.text||'')} Started ${when(a.pause.startedAt)}.</p>`);
  return lines.join('');
}
function positionRow(p,settled){
  const value=settled?p.pnl:p.cost;
  return `<article class="record"><div><div class="record-title">${esc(p.question||p.marketId)}</div><div class="record-meta">${esc((p.side||'').toUpperCase())} × ${p.quantity} at ${money(p.entry)} · ${settled?`Settled ${when(p.closedAt)}`:`Opened ${when(p.openedAt)}`} · book retrieved ${when(p.observedAt)}${p.venueQuoteAt&&p.venueQuoteAt!==p.observedAt?` (venue book time ${when(p.venueQuoteAt)})`:''} · modeled costs ${money((p.fees||0)+(p.slippage||0))}</div></div><div class="record-money"><strong class="${settled?color(value):''}">${money(value)}</strong><small>${settled?'net P&amp;L after costs':'entry cost'}</small></div></article>`;
}
export function accountBlock(book,a,generatedAt,multi){
  const ev=a.evidence,p=ev.picks,pn=Math.round(ev.progress*100);
  const stats=p.n?`<p class="lab-stats">Picks settled ${p.n}: won ${pct(p.winRate)} against ${pct(p.meanMidpoint)} implied by entry midpoints. Midpoint Brier ${finite(p.brierMidpoint)?p.brierMidpoint.toFixed(3):'n/a'}, log loss ${finite(p.logLossMidpoint)?p.logLossMidpoint.toFixed(3):'n/a'}.${p.modelN?` Shadow model Brier ${p.brierModel.toFixed(3)} (n=${p.modelN}).`:''} Modeled costs ${money(ev.costs)}${finite(ev.costDrag)?` (${pct(ev.costDrag)} of entry cost)`:''}.</p>`:'';
  return `<section class="lab-acct" data-venue="${esc(a.venue)}">${multi?`<h4 class="lab-venue">${esc(VENUE[a.venue])} account</h4>`:`<p class="lab-venue-line">${esc(VENUE[a.venue])} · separate $100 shadow account</p>`}
<div class="equity">${money(a.equity)}</div><div class="small-label">Paper equity at liquidation marks · started with ${money(a.initialCapital)} on ${day(a.startedAt)}</div>
<dl class="metrics lab-metrics"><div><dt>Open · settled</dt><dd>${a.open} · ${a.settled}</dd></div><div><dt>Net P&amp;L (settled)</dt><dd class="${color(a.realizedPnl)}">${money(a.realizedPnl)}</dd></div><div><dt>Fees paid</dt><dd>${money(a.fees)}</dd></div></dl>
<div class="lab-evidence"><strong>${esc(ev.status)}</strong>
<div class="lab-progress" role="progressbar" aria-valuemin="0" aria-valuemax="50" aria-valuenow="${Math.min(50,ev.events)}" aria-label="Settled events toward the 50 needed"><i style="width:${pn}%"></i></div>
<p class="muted lab-count">${ev.events} of 50 settled events · ${ev.weeks} of 3 distinct weeks. A screen to pass, not a claim of an edge.</p>${criteriaList(ev)}${stats}</div>
${sourceLines(a,generatedAt)}
<p class="lab-source">Existing collector's ${esc(VENUE[a.venue])} scan ${when(a.sourceState?.observedAt)} · Lab run ${when(a.updatedAt)}${a.lastCycle?` · last run opened ${a.lastCycle.opened}, settled ${a.lastCycle.settled}`:''}</p>
<details class="lab-ledger"><summary>${esc(VENUE[a.venue])} positions and results (${a.open+a.settled})</summary><div class="records">${[...a.positions.map(x=>positionRow(x,false)),...a.trades.slice(0,20).map(x=>positionRow(x,true))].join('')||empty('No entries yet','A shadow book only enters when a fresh book passes its frozen rule.')}</div>${ev.bySport.length?`<p class="muted">By sport (settled): ${esc(ev.bySport.map(r=>`${r.key} ${r.settled} settled, ${money(r.pnl)}`).join(' · '))}</p>`:''}</details></section>`;
}
export function bookCard(book,generatedAt){
  const multi=book.accounts.length>1;
  const params=Object.entries(book.params).filter(([,v])=>typeof v!=='object').map(([k,v])=>`${k}=${v}`).join(' · ');
  return `<article class="account-card lab-card" data-book="${esc(book.id)}"><div class="card-head"><div class="venue"><span class="venue-icon" aria-hidden="true">L</span>${esc(book.title)}</div><span class="pill">${esc(ROLE[book.role]||book.role)}</span></div>
<p class="lab-id">${esc(book.id)} · rule v${book.version}${book.ruleHash?` · frozen ${esc(book.ruleHash.slice(0,10))}`:''}</p>
${book.frozenError?`<p class="notice lab-alert" role="status"><strong>Rule frozen check failed.</strong> ${esc(book.frozenError)}</p>`:''}
${book.accounts.map(a=>accountBlock(book,a,generatedAt,multi)).join('')}
<details class="lab-rule"><summary>Pre-registered rule and parameters</summary><p>${esc(book.rule)}</p><p class="muted">${esc(params)}</p></details></article>`;
}
export function labPanel(s,{now=Date.now()/1000,error=''}={}){
  if(!s)return empty('Prediction Lab not published yet',`${error?error+'. ':''}No balances, entries or results are invented. The first completed scheduled run starts every $100 shadow book prospectively.`);
  const {delayed}=labDelay(s,now);
  const status=delayed?`<p class="notice" role="status">Collection delayed: showing the last completed Lab run from ${when(s.generatedAt)}, not a current reading.</p>`:'';
  const errors=(s.errors||[]).length?`<p class="notice" role="status">${s.errors.length} issue${s.errors.length===1?'':'s'} in the last run: ${esc([...new Set(s.errors.map(e=>`${e.venue||e.bookId||'lab'} ${e.stage}: ${e.message}`))].slice(0,3).join('; '))}. Earlier records keep their original times.</p>`:'';
  return `${status}${errors}<div class="lab-grid">${s.books.map(b=>bookCard(b,s.generatedAt)).join('')}</div>
<p class="footnote">Promotion screen (${esc(s.screen?.version||'')}): ${esc(s.screen?.text||'')} Started ${day(s.startedAt)}. Runs after the existing collector about every ten minutes, best effort; these are not continuous quotes. Shadow books use the same fee, rounding and slippage costs as the real paper accounts and never change them.</p>`;
}

// ---------------------------------------------------------------------------
// Browser mount. Runs only when the overview page provides #prediction-lab-books.
// ---------------------------------------------------------------------------
async function mount(){
  const root=document.getElementById('prediction-lab-books');if(!root)return;
  const notice=document.getElementById('prediction-lab-notice'),time=document.getElementById('prediction-lab-time');
  let snapshot,error='',busy=false;
  const render=()=>{
    root.innerHTML=labPanel(snapshot,{error});
    if(time)time.textContent=snapshot?`Last Lab run: ${when(snapshot.generatedAt)}`:'Not published yet';
  };
  async function load(){
    if(busy)return;busy=true;
    try{snapshot=await publishedJson('data/prediction-lab.json',validLabSnapshot);error='';}catch(e){error=e.message;}
    const health=publicationHealth.get('data/prediction-lab.json');
    if(notice){const text=snapshot&&health?.error?`Prediction Lab shows ${health.source==='retained'?'the newer retained':'the available'} snapshot. Latest refresh: ${health.error}`:'';notice.hidden=!text;notice.textContent=text;}
    render();busy=false;
  }
  document.getElementById('refresh')?.addEventListener('click',load);
  await load();
  setInterval(()=>{if(document.visibilityState==='visible')load();},60000);
}
export {LAB_LABEL};
if(typeof document!=='undefined')mount();
