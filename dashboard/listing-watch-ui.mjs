// Pure HTML builders for the Listing Watch section, plus a small self-mounting
// loader for crypto.html. No DOM access at import time, so tests can render the
// same functions. Public Coinbase observations only: no orders, no credentials.
import {HISTORICAL_STUDY,AVOID_DAYS,SOURCE_KEYS,validListingWatchSnapshot} from './listing-watch-core.mjs';
import {publishedJson,publicationHealth} from './data-client.mjs';

export const LISTING_WATCH_TITLE='Listing Watch';
export const LISTING_WATCH_DELAY_SECONDS=1200;
const FILE='data/listing-watch.json';
const finite=Number.isFinite;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iso=t=>new Date(t*1000).toISOString().replace(/\.\d{3}Z$/,'Z');
const clock=t=>new Date(t*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const when=t=>finite(t)&&t>0?`<time datetime="${iso(t)}" title="${iso(t)}">${esc(clock(t))}</time>`:'Not recorded';
const sign=v=>finite(v)?`${v>0?'+':v<0?'−':''}${Math.abs(v*100).toFixed(1)}%`:'—';
const tone=v=>v>0?'positive':v<0?'negative':'';
const empty=(title,note)=>`<div class="empty"><strong>${esc(title)}</strong>${esc(note)}</div>`;
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
const list=a=>Array.isArray(a)&&a.length?a.join(', '):'';
const incidentLink=id=>/^[A-Za-z0-9]{4,40}$/.test(String(id))?`<a href="https://status.exchange.coinbase.com/incidents/${esc(id)}" target="_blank" rel="noopener noreferrer">status page</a>`:'';

export function listingWatchState(s,now=Date.now()/1000){
  if(!s)return {delayed:false,age:null};
  const age=now-s.generatedAt;
  return {delayed:!(age<=LISTING_WATCH_DELAY_SECONDS),age};
}

const FLAG_LABEL={auction_mode:'auction mode',limit_only:'limit-only',cancel_only:'cancel-only',post_only:'post-only',trading_disabled:'trading disabled',
  status_message:'status message',new:'"new" flag',is_disabled:'disabled flag',view_only:'view-only'};
export function describeTransition(t){
  const where=t.src==='brokerage'?'Advanced Trade: ':'';
  if(t.field==='first-seen')return `${where}first seen as ${t.to}`;
  if(t.field==='presence')return t.to==='absent'?`${where}left the feed`:`${where}back in the feed`;
  if(t.field==='status')return `status ${t.from} → ${t.to}`;
  if(typeof t.to==='boolean')return `${where}${FLAG_LABEL[t.field]||t.field} ${t.to?'on':'off'}`;
  return `${where}${FLAG_LABEL[t.field]||t.field}: ${t.from||'none'} → ${t.to||'none'}`;
}
const STATE_TEXT={ok:'Read OK',error:'Read failed',pending:'Not read yet',idle:'Idle'};
export function sourceRow(key,x){
  const state=x?.status||'pending',label=x?.label||key;
  const good=finite(x?.lastOkAt)?`Last successful read ${when(x.lastOkAt)}${finite(x.count)&&key!=='candles'?` · ${plural(x.count,key==='status'?'incident':'product')}`:''}`:'No successful read recorded yet';
  const detail=state==='error'
    ?`<span class="lw-err">Latest read failed${finite(x.lastErrorAt)?` at ${when(x.lastErrorAt)}`:''}: ${esc(x.lastError||'source unavailable')}. ${finite(x.lastOkAt)?'The earlier good data is kept with its original times.':'Nothing is shown for this source.'}</span>`
    :state==='idle'?'<span>No launch window is open, so no candle range was requested.</span>':'';
  return `<div class="lw-source lw-${esc(state)}"><strong>${esc(label)}</strong><span class="pill lw-state-${esc(state)}">${STATE_TEXT[state]||esc(state)}</span><span class="lw-meta">${good}${detail?`<br>${detail}`:''}</span></div>`;
}

function candleText(c){
  if(!c)return 'No candle plan recorded';
  if(c.status==='skipped')return `Candles not captured: ${esc(c.reason||'not eligible')}`;
  if(c.status==='pending')return 'Candles start after the first observed non-auction trading state';
  const ranges=(c.covered||[]).map(([a,b])=>`${when(a)} to ${when(b)}`).join('; ')||'no range read yet';
  const state=esc({collecting:'Collecting',complete:'Complete',incomplete:'Window closed with gaps'}[c.status]||c.status);
  const first=c.first?` · first trade open ${esc(c.first.open)} at ${when(c.first.at)}`:'';
  return `${state}: ${plural(c.count||0,'candle')} for ${when(c.windowStart)} to ${when(c.windowEnd)}${first}<br>Ranges read: ${ranges}${c.trimmed?'<br>Older rows were trimmed from state; they remain in the repository history.':''}${c.lastError?`<br><span class="lw-err">Latest candle read failed: ${esc(c.lastError)}</span>`:''}`;
}
export function launchRecord(l){
  const phases=(l.phases||[]).map(p=>`${esc(p.phase)} ${when(p.at)}`).join(' → ')||'no Exchange phase recorded yet';
  const between=l.startedInProgress?' (already listed before trading; its first appearance was not observed)':finite(l.firstSeenSince)?` (it appeared after ${when(l.firstSeenSince)})`:'';
  const seen=Object.entries(l.seenAt||{}).map(([k,t])=>`${k==='brokerage'?'Advanced Trade':'Exchange'} ${when(t)}`).join(' · ');
  const late=finite(l.lateSeconds)?`<br><span class="lw-err">Detected late: Advanced Trade dated it ${when(l.brokerageNewAt)}, about ${Math.round(l.lateSeconds/60)} minutes before this collector saw it.</span>`:'';
  const status=l.candles?.status||'none';
  const badge=`${esc(status)}${finite(l.candles?.count)&&l.candles.count?` · ${plural(l.candles.count,'candle')}`:''}`;
  return `<article class="record lw-launch"><div><div class="record-title">${esc(l.id)} · ${l.kind==='asset-launch'?'new asset':'new pair'}${l.startedInProgress?' · in progress at start':''} <span class="pill lw-pill">${badge}</span></div>
<div class="record-meta">${l.startedInProgress?'First read':'First seen'} ${when(l.firstSeenAt)}${between}<br>Seen by: ${seen||'unknown'}<br>Phases observed: ${phases}${late}</div>
<details><summary>1-minute candles</summary><p class="lw-meta">${candleText(l.candles)}</p></details></div></article>`;
}
export function transitionRecord(t){
  const gap=finite(t.since)?`changed between ${when(t.since)} and ${when(t.at)}`:`read at ${when(t.at)}`;
  return `<article class="record lw-change"><div><div class="record-title">${esc(t.id)} · ${esc(describeTransition(t))}</div><div class="record-meta">${gap}</div></div></article>`;
}
export function watchRecord(w,now=Date.now()/1000){
  const what=list(w.products)||list(w.assets)||'Unnamed',up=w.status==='upcoming',due=up&&finite(w.effectiveAt)&&w.effectiveAt<=now;
  const effective=finite(w.effectiveAt)?`effective about ${when(w.effectiveAt)}`:w.effectiveDate?`effective ${esc(w.effectiveDate)}, time not stated`:'effective date not stated';
  const scope=w.scope==='pairs'?'Named pairs only.':'Asset-wide notice.';
  return `<article class="record lw-watch ${up?'lw-upcoming':''}"><div><div class="record-title">${esc(what)} <span class="pill lw-pill">${due?'Due':up?'Upcoming':'Effective'}</span></div><div class="record-meta">${esc(w.incident)}<br>Notice ${when(w.noticeAt)} · ${effective}${finite(w.executedAt)?` · trading disabled ${when(w.executedAt)}`:''}<br>${due?'Stated time passed, not yet confirmed by an update. ':up?'Flagged avoid. ':'Recently effective. '}${scope} ${incidentLink(w.incidentId)}</div></div></article>`;
}
export function statusListingRecord(x){
  const steps=[['Announced',x.announcedAt],['Auction',x.auctionAt],['Limit-only',x.limitOnlyAt],['Full trading',x.fullTradingAt]].filter(([,t])=>finite(t)).map(([n,t])=>`${n} ${when(t)}`).join(' → ');
  return `<article class="record"><div><div class="record-title">${esc(list(x.products)||list(x.assets)||x.incident)} <span class="pill lw-pill">Observed in status feed</span></div><div class="record-meta">${esc(x.incident)} · no prices<br>${steps}${x.reentry?'<br>Re-entered auction later':''} · ${incidentLink(x.incidentId)}</div></div></article>`;
}

export function studyBox(study=HISTORICAL_STUDY){
  const cell=r=>`<div><strong><b class="${tone(r.mean)}">${sign(r.mean)}</b> mean · <b class="${tone(r.median)}">${sign(r.median)}</b> median · ${Math.round(r.win*100)}% win</strong><span>${esc(r.hold)}</span></div>`;
  return `<div class="study-box lw-study" aria-labelledby="lw-study-title"><small>${esc(study.label)}</small><h3 id="lw-study-title">Buying at a Coinbase launch, after fees</h3>
<p>${esc(study.sample)} Every figure already includes a ${(study.feesRoundTrip*100).toFixed(1)}% round-trip taker fee.</p>
<div class="cost-grid">${study.rows.map(cell).join('')}</div>
<p class="muted">${esc(study.phases)}</p>
<ul class="lw-notes">${study.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`;
}

// Full section body. s may be undefined when nothing is published.
export function listingWatchPanel(s,{now=Date.now()/1000,error='',health=null}={}){
  const disclosure=`<p class="lw-disclosure"><strong>Observation only.</strong> This section records what Coinbase does when it lists or delists assets, so listing-based ideas can be tested honestly later. It places no orders, opens no paper positions and uses no credentials. Reads are scheduled about every five minutes, best effort; they are not continuous quotes, so every change is shown with the interval in which it happened.</p>`;
  if(!s)return `${disclosure}${empty('Listing Watch not published yet',`${error?error+'. ':''}No launches, transitions or notices are invented. The first completed scheduled run creates the first snapshot; earlier listings are not backfilled.`)}${studyBox()}`;
  const {delayed}=listingWatchState(s,now),c=s.counts||{};
  const stale=delayed?`<p class="notice" role="status">Collection delayed: showing the last completed observation from ${when(s.generatedAt)}, not a current reading.</p>`:'';
  const retained=health?.error&&health.source!=='repository'?`<p class="notice" role="status">Listing Watch is using ${esc(health.source)} data: ${esc(health.error)}. The newer loaded record is kept.</p>`:'';
  const sources=`<div class="lw-sources" role="list">${SOURCE_KEYS.map(k=>sourceRow(k,s.sources?.[k])).join('')}</div>`;
  const summary=`<div class="tournament-summary lw-summary"><div><strong>${c.assetLaunches??0} new asset${c.assetLaunches===1?'':'s'}</strong><span>${plural(c.launches??0,'product')} first seen since ${when(s.startedAt)} · ${c.candleLaunches??0} with 1-minute candles</span></div><div><strong>${c.transitions??0} changes</strong><span>state transitions logged, each with its read interval</span></div><div><strong>${c.watchlistUpcoming??0} upcoming</strong><span>suspension notices · ${c.watchlistEffective??0} recently effective</span></div><div><strong>${c.exchangeProducts??0} + ${c.brokerageUsdProducts??0}</strong><span>Exchange products + Advanced Trade USD products tracked</span></div></div>`;
  const launches=(s.launches||[]).length?`<div class="records">${s.launches.slice(0,4).map(launchRecord).join('')}</div>${s.launches.length>4?`<details class="details"><summary>${s.launches.length-4} more launches</summary><div class="records">${s.launches.slice(4).map(launchRecord).join('')}</div></details>`:''}`
    :empty('No launch captured yet',`Only products first seen after collection began ${clock(s.startedAt)} count as launches. Products already listed at that time form the baseline and nothing before it is backfilled.`);
  const tr=s.transitions||[];
  const transitions=tr.length?`<div class="records">${tr.slice(0,6).map(transitionRecord).join('')}</div>${tr.length>6?`<details class="details"><summary>${tr.length-6} more changes</summary><div class="records">${tr.slice(6).map(transitionRecord).join('')}</div></details>`:''}`
    :empty('No state change observed yet','Auction, limit-only, status and trading-disabled changes appear here once the collector observes one.');
  const watch=(s.watchlist||[]).length?`<div class="records">${s.watchlist.map(w=>watchRecord(w,now)).join('')}</div>`
    :empty('No suspension or delisting notice in the feed','This reflects the status feed as last read, not a guarantee that none exists.');
  const listings=(s.statusListings||[]).length?`<details class="details"><summary>Recent listings seen in the status feed (${s.statusListings.length})</summary><p class="lw-meta">Times from Coinbase status updates, with no prices. Observed in status feed, not by this collector's candles.</p><div class="records">${s.statusListings.map(statusListingRecord).join('')}</div></details>`:'';
  return `${disclosure}${stale}${retained}${sources}<p class="lw-meta">Last collection ${when(s.generatedAt)} · collector started ${when(s.startedAt)}${finite(c.exchangeBaselineAt)?` · baseline of existing products taken ${when(c.exchangeBaselineAt)}`:''}</p>${summary}
<h3 class="lw-subhead">Recent launches</h3>${launches}
<h3 class="lw-subhead">Recent state changes</h3>${transitions}
<h3 class="lw-subhead">Delisting and suspension watchlist</h3>${watch}
<p class="lw-meta">A product is flagged <em>avoid</em> when it has a suspension notice, is trading-disabled, cancel-only or delisted, or was first seen less than ${AVOID_DAYS} days ago.</p>${listings}${studyBox(s.study||HISTORICAL_STUDY)}`;
}

// ---- self-mounting loader for crypto.html (skipped in Node and when the section is absent)
let snapshot,loadError='',busy=false;
async function load(el){
  if(busy)return;busy=true;
  try{
    snapshot=await publishedJson(FILE,x=>validListingWatchSnapshot(x));loadError='';
  }catch(e){loadError=e.message;}
  const health=publicationHealth.get(FILE);
  el.innerHTML=listingWatchPanel(snapshot,{error:loadError,health:snapshot?health:null});
  busy=false;
}
export function mountListingWatch(doc=globalThis.document){
  const el=doc?.getElementById('listing-watch-body');
  if(!el)return false;
  load(el);
  doc.getElementById('refresh')?.addEventListener('click',()=>load(el));
  setInterval(()=>{if(doc.visibilityState==='visible')load(el);},60000);
  return true;
}
if(typeof document!=='undefined')mountListingWatch();
