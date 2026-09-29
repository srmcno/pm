// Pure HTML builders for the BTC/ETH daily trend paper mirror. No DOM access
// at import time, so the same functions render the crypto page, the overview
// line and the tests. Real-money worker results are never shown here.
import {TREND_POLICY} from './trend-core.mjs';

export const TREND_TITLE='Live bot strategy: BTC/ETH daily trend (paper mirror)';
export const TREND_DELAY_SECONDS=1200;
const finite=Number.isFinite;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>finite(v)?v.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unavailable';
const pct=v=>finite(v)?`${v>0?'+':''}${(v*100).toFixed(2)}%`:'Unavailable';
const qty=v=>finite(v)?String(Number(v.toFixed(8))):'?';
const color=v=>v>0?'positive':v<0?'negative':'';
const when=v=>finite(v)&&v>0?new Date(v*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not recorded';
const utcDay=v=>finite(v)?new Date(v*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'Unknown date';
const coin=p=>String(p||'').replace('-USD','');
const empty=(title,note)=>`<div class="empty"><strong>${esc(title)}</strong>${esc(note)}</div>`;

const ACTIONS={enter:'Enter signal',hold:'Hold (long)',exit:'Exit signal',wait:'Wait (flat)'};
export function actionLabel(signal){
  if(!signal||signal.status!=='ready')return 'Signal unavailable';
  return (signal.retained?'Retained · ':'')+(ACTIONS[signal.action]||signal.action);
}
const DECISIONS={entered:'Paper entry recorded this cycle',exited:'Paper exit recorded this cycle',blocked:'Waiting on usable data',holding:'Holding',waiting:'No entry'};

export function trendState(s,now=Date.now()/1000){
  if(!s)return {delayed:false,age:null};
  const age=now-s.generatedAt;return {delayed:!(age<=TREND_DELAY_SECONDS),age};
}
export function trendReturns(s){
  const a=s.account,b=s.benchmark;
  return {equity:a.equity,ret:a.equity/s.initialCapital-1,drawdown:a.maxDrawdown,
    benchmarkEquity:b?.equity??null,benchmarkRet:b?b.equity/b.initialCapital-1:null,benchmarkDrawdown:b?.maxDrawdown??null,benchmarkStartedAt:b?.startedAt??null};
}

function productCard(s,signal){
  const position=s.account.positions.find(p=>p.product===signal.product),decision=(s.decisions||[]).find(d=>d.product===signal.product);
  const source=s.sources?.[signal.product]||{},ready=signal.status==='ready';
  const pill=actionLabel(signal),state=decision?`${DECISIONS[decision.status]||decision.status}`:'No decision recorded';
  const detail=signal.retained?`Latest read failed (${signal.error}). Showing the earlier reading from ${when(signal.fetchedAt)}; no paper action is taken on it.`:decision?.reason||signal.reason||signal.error||'';
  const book=source.book||{},candles=source.candles||{};
  const pos=position?`Paper position ${qty(position.quantity)} ${esc(coin(position.product))} · cost ${money(position.cost)} · mark ${money(position.markValue)}${position.markComplete===false?' (stale)':''}`:'No paper position';
  const bracket=position?`Stop ${money(position.stop)} · target ${money(position.target)}`:`Stop / target set at entry: 80% / 160% of signal close`;
  return `<article class="account-card trend-card"><div class="card-head"><div class="venue">${esc(signal.product)}</div><span class="pill">${esc(pill)}</span></div>
<div class="equity">${ready?money(signal.close):'—'}</div><div class="small-label">${ready?`Completed UTC daily close · ${esc(utcDay(signal.barTime))} · <span class="${color(signal.distance)}">${pct(signal.distance)}</span> vs ${TREND_POLICY.smaDays}-day SMA`:'No completed daily reading available'}</div>
<dl class="metrics"><div><dt>${TREND_POLICY.smaDays}-day SMA</dt><dd>${ready?money(signal.sma):'—'}</dd></div><div><dt>Enter above (+${TREND_POLICY.band*100}%)</dt><dd>${ready?money(signal.upper):'—'}</dd></div><div><dt>Exit below (−${TREND_POLICY.band*100}%)</dt><dd>${ready?money(signal.lower):'—'}</dd></div></dl>
<div class="account-state"><strong>${esc(state)}</strong><p>${esc(detail)}</p></div>
<div class="card-bottom"><span>${pos}</span><span>${bracket}</span></div>
<p class="fee-line">Candles fetched ${when(candles.fetchedAt)}${candles.status==='error'?` · latest candle read failed: ${esc(candles.error)}`:''}<br>Book ${when(book.receivedAt)}${finite(book.bestBid)?` · bid ${money(book.bestBid)} / ask ${money(book.bestAsk)}`:''}${book.status==='error'?` · latest book read failed: ${esc(book.error)}`:''}</p></article>`;
}

function ledgerRecord(r,open){
  const reason=open?(r.entryReasons||[]).join(' '):r.exitReason;
  return `<article class="record"><div><div class="record-title">${esc(r.product)} · ${open?'open':'closed'}</div><div class="record-meta">Bought ${qty(r.quantity)} at ${money(r.entryPrice)} (maker, fee ${money(r.entryFees)}) · ${when(r.openedAt)}${open?'':`<br>Sold at ${money(r.exitPrice)} (taker, fee ${money(r.exitFees)} + slippage ${money(r.exitSlippage)}) · ${when(r.closedAt)}`}</div><details><summary>Why</summary><p class="muted">${esc(reason)}${!open&&r.exitEvidence?` Evidence: ${esc(r.exitEvidence.source)} ${money(r.exitEvidence.observed)}${finite(r.exitEvidence.barTime)?` (bar ${esc(utcDay(r.exitEvidence.barTime))})`:''}; recorded at the ${when(r.exitEvidence.detectedAt)} cycle.`:''}</p></details></div><div class="record-money"><strong class="${open?'':color(r.pnl)}">${money(open?r.markValue:r.pnl)}</strong><small>${open?'liquidation mark':'net realized P&L'}</small></div></article>`;
}

// Full crypto-page section body. s may be undefined when nothing is published.
export function trendPanel(s,{now=Date.now()/1000,error=''}={}){
  if(!s)return empty('Paper mirror not published yet',`${error?error+'. ':''}No balances, signals or trades are invented. The first completed scheduled cycle will start the $1,000 book prospectively.`);
  const {delayed}=trendState(s,now),r=trendReturns(s),a=s.account;
  const status=delayed?`<p class="notice" role="status">Collection delayed: showing the last completed paper cycle from ${when(s.generatedAt)}, not a current market reading.</p>`:'';
  const errors=(s.errors||[]).length?`<p class="notice" role="status">${s.errors.length} public-source issue${s.errors.length===1?'':'s'} in the last cycle: ${esc(s.errors.map(e=>`${e.product} ${e.stage}: ${e.message}`).join('; '))}. Earlier good readings are kept with their original times and are not traded on.</p>`:'';
  const benchmark=finite(r.benchmarkRet)?`<strong class="${color(r.benchmarkRet)}">${pct(r.benchmarkRet)}</strong><span>BTC buy-and-hold, same costs · ${money(r.benchmarkEquity)}${r.benchmarkStartedAt&&r.benchmarkStartedAt!==s.startedAt?` · started ${when(r.benchmarkStartedAt)}`:' · same start'}</span>`:'<strong>Pending</strong><span>BTC benchmark starts at the first usable BTC book</span>';
  const cards=(s.signals||[]).length?s.signals.map(x=>productCard(s,x)).join(''):empty('No signals recorded','The last cycle recorded no daily readings.');
  const positions=a.positions.map(p=>ledgerRecord(p,true)),trades=[...a.trades].sort((x,y)=>y.closedAt-x.closedAt).map(t=>ledgerRecord(t,false));
  return `${status}${errors}<p class="muted trend-meta">Last paper cycle ${when(s.generatedAt)} · $1,000 book started ${when(s.startedAt)} · scheduled about every five minutes, best effort; not continuous quotes.</p>
<div class="tournament-summary trend-summary"><div><strong>${money(r.equity)}</strong><span>Mirror equity · <b class="${color(r.ret)}">${pct(r.ret)}</b> since start, marked at liquidation value after exit costs</span></div><div>${benchmark}</div><div><strong>${pct(r.drawdown)} / ${finite(r.benchmarkDrawdown)?pct(r.benchmarkDrawdown):'—'}</strong><span>Max drawdown: mirror / BTC hold</span></div><div><strong>${a.positions.length} open · ${a.trades.length} closed</strong><span>Realized paper P&amp;L ${money(a.realizedPnl)} · fees ${money(a.fees)} · cash ${money(a.cash)}</span></div></div>
<div class="account-grid trend-grid">${cards}</div>
<h3 class="trend-subhead">Paper mirror positions and trades</h3><div class="records">${[...positions,...trades].join('')||empty('No paper trades yet','Entries happen only when a completed daily close clears the entry band.')}</div>`;
}

// Compact overview line for the main page.
export function trendOverview(s,{now=Date.now()/1000}={}){
  if(!s)return empty('Paper mirror not published yet','No results are invented. The crypto page explains the rules and the historical study.');
  const {delayed}=trendState(s,now),r=trendReturns(s),a=s.account;
  const cell=x=>{
    const held=a.positions.some(p=>p.product===x.product);
    if(x.status!=='ready')return `<div><strong>${esc(coin(x.product))} · unavailable</strong><span>${esc(x.error||x.reason||'No completed daily reading')}</span></div>`;
    return `<div><strong>${esc(coin(x.product))} · ${esc(actionLabel(x))}</strong><span>Close ${money(x.close)} vs 100-day SMA ${money(x.sma)} (<b class="${color(x.distance)}">${pct(x.distance)}</b>) · bands ${money(x.lower)}–${money(x.upper)} · ${held?'paper long':'paper flat'}</span></div>`;
  };
  return `<div class="crypto-summary trend-overview">${(s.signals||[]).map(cell).join('')}<div><strong>${money(r.equity)} <b class="${color(r.ret)}">${pct(r.ret)}</b></strong><span>Mirror equity vs BTC buy-and-hold ${finite(r.benchmarkRet)?`<b class="${color(r.benchmarkRet)}">${pct(r.benchmarkRet)}</b>`:'pending'}</span></div><div><strong>${a.positions.length} open · ${a.trades.length} closed</strong><span>${delayed?'Collection delayed · last':'Paper'} cycle ${when(s.generatedAt)}</span></div></div>
<p class="footnote">Paper mirror only. The private Coinbase worker's real-money orders and results are not shown. Daily bars close at 00:00 UTC; scheduled cycles are best effort, not continuous quotes.</p>`;
}

export function trendActivityRows(s){
  if(!s)return [];
  return [...s.account.positions.map(p=>({...p,account:'trend-mirror',kind:'crypto',state:'open'})),...s.account.trades.map(t=>({...t,account:'trend-mirror',kind:'crypto',state:'closed'}))];
}

