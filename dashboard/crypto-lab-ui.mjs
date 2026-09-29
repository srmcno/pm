// Pure HTML builders for the paper Strategy Lab, plus a guarded browser mount.
// The builders touch no DOM, so the same functions render the crypto page and
// the tests. Nothing here talks to the private Coinbase worker; the lab never
// shows real-money orders or results.
import {publishedJson,publicationHealth} from './data-client.mjs';
import {validLabSnapshot,LAB_PRODUCTS,LAB_BOOK} from './crypto-lab-core.mjs';

export const LAB_TITLE='Strategy Lab';
export const LAB_LABEL='Paper experiments. Not the live bot. Results so far are short-window and not evidence of an edge.';
export const LAB_DELAY_SECONDS=1200;
const finite=Number.isFinite;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>finite(v)?v.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unavailable';
const pct=v=>finite(v)?`${v>0?'+':''}${(v*100).toFixed(2)}%`:'Unavailable';
const points=v=>finite(v)?`${v>0?'+':''}${(v*100).toFixed(2)} pts`:'Unavailable';
const qty=v=>finite(v)?String(Number(v.toFixed(8))):'?';
const color=v=>v>0?'positive':v<0?'negative':'';
const when=v=>finite(v)&&v>0?new Date(v*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not recorded';
const utcDay=v=>finite(v)?new Date(v*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'Unknown date';
const coin=p=>String(p||'').replace('-USD','');
const empty=(title,note)=>`<div class="empty"><strong>${esc(title)}</strong>${esc(note)}</div>`;
const LEDGER_LIMIT=30;

const ACTIONS={enter:'Enter signal',hold:'Hold (long)',exit:'Exit signal',wait:'Wait (flat)'};
export function labActionLabel(signal){
  if(!signal||signal.status!=='ready')return 'Signal unavailable';
  return (signal.retained?'Retained · ':'')+(ACTIONS[signal.action]||signal.action);
}
const STATES={long:'Long',flat:'Flat'};

export function labState(s,now=Date.now()/1000){
  if(!s)return {delayed:false,age:null,days:null};
  const age=now-s.generatedAt;
  return {delayed:!(age<=LAB_DELAY_SECONDS),age,days:Math.max(0,(s.generatedAt-s.startedAt)/86400)};
}
export function labReturns(book){
  const a=book.account,k=book.benchmark,ret=a.equity/LAB_BOOK.initialCapital-1,benchmarkRet=k.equity/k.initialCapital-1;
  return {equity:a.equity,ret,benchmarkEquity:k.equity,benchmarkRet,delta:ret-benchmarkRet,drawdown:a.maxDrawdown,benchmarkDrawdown:k.maxDrawdown,
    fees:a.fees,slippage:a.slippage,cash:a.cash,open:a.positions.length,closed:a.trades.length,entries:a.positions.length+a.trades.length};
}

function levelsText(book,x){
  if(book.kind==='hold')return 'No signal: bought once, never sold';
  const parts=[];
  if(book.kind==='sma'&&finite(x.indicator))parts.push(`SMA${book.params.days} ${money(x.indicator)}`);
  if(book.kind==='supertrend'&&finite(x.indicator))parts.push(`Supertrend line ${money(x.indicator)}`);
  const hi=book.kind==='donchian'?`${book.params.entryDays}-day high `:'',lo=book.kind==='donchian'?`${book.params.exitDays}-day low `:'';
  parts.push(`enter above ${hi}${money(x.enterLevel)}`,`exit below ${lo}${money(x.exitLevel)}`);
  return parts.join(' · ');
}

function signalRow(book,x,sources){
  const position=book.account.positions.find(p=>p.product===x.product),ready=x.status==='ready';
  const source=sources?.[x.product]||{},candles=source.candles||{};
  const state=ready?(STATES[x.state]||x.state):'No reading';
  const closeText=ready?`${finite(x.close)?`Close ${money(x.close)} · `:''}${levelsText(book,x)}`:'No completed daily reading available';
  const bar=ready&&finite(x.barTime)?`Bar ${utcDay(x.barTime)} (UTC) · fetched ${when(x.fetchedAt)}`:`Candles fetched ${when(x.fetchedAt??candles.fetchedAt)}`;
  const note=x.retained?`Latest read failed (${x.error}). Showing the earlier reading from ${when(x.fetchedAt)}; no paper trade is made on it.`
    :!ready?(x.error||x.reason||''):'';
  // The reading is recorded before that cycle's paper trade, so say when the trade has since happened.
  const acted=ready&&x.action==='exit'&&!position?' · paper exit recorded':ready&&x.action==='enter'&&position?' · paper entry recorded':'';
  const pos=position?`Paper long ${qty(position.quantity)} ${coin(position.product)} · mark ${money(position.markValue)}${position.markComplete===false?' (stale)':''}`:'Paper flat';
  return `<li class="lab-signal"><div class="lab-sig-head"><strong>${esc(coin(x.product))}</strong><span class="lab-state ${esc(x.state)}">${esc(state)}</span><span class="lab-act">${esc(labActionLabel(x)+acted)}</span></div>
<div class="lab-sig-meta">${esc(closeText)}</div><div class="lab-sig-meta">${esc(bar)} · ${esc(pos)}</div>${note?`<div class="lab-sig-note">${esc(note)}</div>`:''}</li>`;
}

function ledgerRecord(r,open){
  const reason=open?(r.entryReasons||[]).join(' '):r.exitReason;
  return `<article class="record"><div><div class="record-title">${esc(r.product)} · ${open?'open':'closed'}${r.entryKind==='initial'?' · initial entry':''}</div><div class="record-meta">Bought ${qty(r.quantity)} at ${money(r.entryPrice)} (maker, fee ${money(r.entryFees)}) · ${when(r.openedAt)}${open?'':`<br>Sold at ${money(r.exitPrice)} (taker, fee ${money(r.exitFees)} + slippage ${money(r.exitSlippage)}) · ${when(r.closedAt)}`}</div><details><summary>Why</summary><p class="muted">${esc(reason)}${!open&&r.exitEvidence?` Evidence: ${esc(r.exitEvidence.source)} ${money(r.exitEvidence.observed)}${finite(r.exitEvidence.barTime)?` (bar ${esc(utcDay(r.exitEvidence.barTime))})`:''}; recorded at the ${when(r.exitEvidence.detectedAt)} cycle.`:''}</p></details></div><div class="record-money"><strong class="${open?'':color(r.pnl)}">${money(open?r.markValue:r.pnl)}</strong><small>${open?'liquidation mark':'net realized P&amp;L'}</small></div></article>`;
}

export function bookCard(s,book){
  const r=labReturns(book),held=book.account.positions.length,total=LAB_PRODUCTS.length;
  const pill=book.kind==='hold'?`Benchmark · ${held} of ${total} held`:held?`${held} of ${total} long`:'Flat';
  const rows=book.signals.length?book.signals.map(x=>signalRow(book,x,s.sources)).join(''):`<li class="lab-signal">${empty('No signals recorded','The last cycle recorded no daily readings.')}</li>`;
  const positions=book.account.positions.map(p=>ledgerRecord(p,true)),trades=[...book.account.trades].sort((x,y)=>y.closedAt-x.closedAt);
  const shown=[...positions,...trades.slice(0,LEDGER_LIMIT).map(t=>ledgerRecord(t,false))];
  const decisions=(book.decisions||[]).map(d=>`${coin(d.product)}: ${d.reason}`);
  return `<article class="account-card lab-card" data-book="${esc(book.id)}"><div class="card-head"><div class="venue">${esc(book.name)}</div><span class="pill">${esc(pill)}</span></div>
<div class="equity">${money(r.equity)}</div><div class="small-label"><b class="${color(r.ret)}">${pct(r.ret)}</b> since start, marked at liquidation value after exit costs</div>
<dl class="metrics lab-metrics"><div><dt>vs hold-3</dt><dd class="${color(r.delta)}">${book.kind==='hold'?'Reference':points(r.delta)}</dd></div><div><dt>Max drawdown</dt><dd>${pct(r.drawdown)}</dd></div>
<div><dt>Entries · closed</dt><dd>${r.entries} · ${r.closed}</dd></div><div><dt>Fees paid</dt><dd>${money(r.fees)}</dd></div></dl>
<p class="lab-rule">${esc(book.rule)}</p>
<ul class="lab-signals" aria-label="${esc(book.name)} per-coin signals">${rows}</ul>
<p class="fee-line">Hold-3 benchmark ${money(r.benchmarkEquity)} (<span class="${color(r.benchmarkRet)}">${pct(r.benchmarkRet)}</span>, max drawdown ${pct(r.benchmarkDrawdown)}), same start and costs. Cash ${money(r.cash)}.</p>
<details class="lab-ledger"><summary>Paper positions, trades and last decisions (${r.entries})</summary>${decisions.length?`<p class="muted">Last cycle: ${esc(decisions.join(' · '))}</p>`:''}<div class="records">${shown.join('')||empty('No paper trades yet','Entries happen only when a completed daily close satisfies this rule.')}</div>${trades.length>LEDGER_LIMIT?`<p class="muted">Showing the latest ${LEDGER_LIMIT} of ${trades.length} closed trades; the published snapshot keeps all of them.</p>`:''}</details></article>`;
}

// Section body. s may be undefined when nothing is published.
export function labPanel(s,{now=Date.now()/1000,error=''}={}){
  if(!s)return empty('Strategy Lab not published yet',`${error?error+'. ':''}No balances, signals or trades are invented. The first completed scheduled cycle will start every $1,000 paper book prospectively.`);
  const {delayed,days}=labState(s,now);
  const status=delayed?`<p class="notice" role="status">Collection delayed: showing the last completed lab cycle from ${when(s.generatedAt)}, not a current market reading.</p>`:'';
  const errors=(s.errors||[]).length?`<p class="notice" role="status">${s.errors.length} public-source issue${s.errors.length===1?'':'s'} in the last cycle: ${esc([...new Set(s.errors.map(e=>`${coin(e.product)} ${e.stage}${e.bookId?` (${e.bookId})`:''}: ${e.message}`))].join('; '))}. Earlier good readings are kept with their original times and are not traded on.</p>`:'';
  const hold=s.books.find(b=>b.kind==='hold'),hr=hold?labReturns(hold):null;
  const cards=s.books.map(b=>bookCard(s,b)).join('');
  return `${status}${errors}<p class="muted lab-meta">Last lab cycle ${when(s.generatedAt)} · ${s.books.length} separate $1,000 paper books started ${when(s.startedAt)} · scheduled about every five minutes, best effort; not continuous quotes.</p>
<div class="tournament-summary lab-summary"><div><strong>${finite(days)?days.toFixed(1):'?'} days</strong><span>of forward data. A short window: results are noise until many trades and months have passed.</span></div><div><strong>${s.books.length} books · 3 coins</strong><span>BTC, ETH and SOL, long only, one third of book equity per coin while long</span></div>${hr?`<div><strong>${money(hr.benchmarkEquity)} <b class="${color(hr.benchmarkRet)}">${pct(hr.benchmarkRet)}</b></strong><span>Hold-3 benchmark, same costs and start</span></div>`:''}<div><strong>0.50% / 1.00%</strong><span>maker entry assumed filled / taker exit fee plus slippage reserve</span></div></div>
<div class="account-grid lab-grid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Browser mount. Runs only when the crypto page provides #lab-books.
// ---------------------------------------------------------------------------
async function mount(){
  const root=document.getElementById('lab-books');if(!root)return;
  const notice=document.getElementById('lab-notice');
  let snapshot,error='',busy=false;
  const render=()=>{root.innerHTML=labPanel(snapshot,{error});};
  async function load(){
    if(busy)return;busy=true;
    try{snapshot=await publishedJson('data/crypto-lab.json',validLabSnapshot);error='';}catch(e){error=e.message;}
    const health=publicationHealth.get('data/crypto-lab.json');
    if(notice){const text=snapshot&&health?.error?`Strategy Lab uses ${health.source} data: ${health.error}`:'';notice.hidden=!text;notice.textContent=text;}
    render();busy=false;
  }
  document.getElementById('refresh')?.addEventListener('click',load);
  await load();
  setInterval(()=>{if(document.visibilityState==='visible')load();},60000);
}
if(typeof document!=='undefined')mount();
