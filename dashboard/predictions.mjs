import {normalizePolymarket,normalizeKalshi} from './prediction-venues.mjs?v=4.2.0';
import {publishedJson,publicationHealth} from './data-client.mjs?v=4.0.0';
import {VENUES,POLICY,planBet,fill,quoteValid} from './prediction-core.mjs?v=4.2.0';
import {automationReport} from './prediction-automation.mjs?v=4.3.0';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const venueName=v=>v==='polymarket'?'Polymarket US':'Kalshi';
const money=n=>Number.isFinite(n)?n.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unavailable';
const cents=n=>Number.isFinite(n)?`${(n*100).toFixed(1).replace(/\.0$/,'')}¢`:'No quote';
const pct=n=>Number.isFinite(n)?`${(n*100).toFixed(1)}%`:'Not estimated';
const ago=t=>{const a=Date.now()/1000-t;return !Number.isFinite(t)?'unknown age':a<0?'clock mismatch':a<60?`${Math.floor(a)}s ago`:a<3600?`${Math.floor(a/60)}m ago`:`${Math.floor(a/3600)}h ago`;};
const date=t=>Number.isFinite(t)?new Date(t*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Unknown close';
function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&['polymarket.us','kalshi.com'].includes(u.hostname)?u.href:null;}catch{return null;}}
export function mountPredictions(){
  let snapshot=null,busy=false,bookBusy=false,selected=null,side='yes',visible=12,tab='auto',exportUrl=null,disposed=false;
  const directBooks=new Map();
  function selectTab(next){
    if(!['auto','markets','accounts','method','readiness'].includes(next))return;tab=next;
    document.querySelectorAll('[data-pred-pane]').forEach(el=>el.hidden=el.dataset.predPane!==next);
    document.querySelectorAll('[role=tab][data-pred-tab]').forEach(el=>{const active=el.dataset.predTab===next;el.setAttribute('aria-selected',String(active));el.tabIndex=active?0:-1;});
  }
  function showNotice(message){$('prediction-notice').textContent=message;$('prediction-notice').hidden=!message;}
  async function refresh(){if(busy||disposed)return;busy=true;$('prediction-refresh').disabled=true;
    try{const d=await publishedJson('data/predictions.json',d=>d.schemaVersion===1&&d.mode==='paper'&&d.generatedAt>0&&Array.isArray(d.markets)&&VENUES.every(v=>d.accounts?.[v]?.initialCapital===100));
      if(!snapshot||d.generatedAt>=snapshot.generatedAt)snapshot=d;
      snapshot.markets=snapshot.markets.map(m=>(directBooks.get(m.id)?.observedAt||0)>m.observedAt?directBooks.get(m.id):m);
      if(!selected||!snapshot.markets.some(m=>m.id===selected)){
        const best=[...snapshot.decisions].sort((a,b)=>(b.plan.edge??-9)-(a.plan.edge??-9))[0];
        selected=best?.marketId||snapshot.markets[0]?.id||null;side=best?.side||'yes';
      }
      const transport=publicationHealth.get('data/predictions.json'),failures=snapshot.sources.filter(s=>['error','partial'].includes(s.status));
      showNotice([transport?.error?`Snapshot refresh: ${transport.error}`:'',...failures.map(s=>`${venueName(s.venue)}: ${s.error}`),...(snapshot.errors||[]).slice(0,2).map(e=>`${venueName(e.venue)} ${e.source}: ${e.message}`)].filter(Boolean).join(' '));render();
    }catch(e){showNotice(`Prediction snapshot unavailable: ${e.message}. No balance or trade is invented.`);}finally{busy=false;$('prediction-refresh').disabled=false;}}
  function renderAccounts(){
    $('prediction-accounts').innerHTML=VENUES.map(v=>{const a=snapshot.accounts[v],s=snapshot.sources.find(s=>s.venue===v),candidates=snapshot.decisions.filter(d=>d.venue===v&&d.plan.status==='candidate').length;
      return `<article class="prediction-account ${v}"><div class="venue-heading"><span class="venue-icon" aria-hidden="true">${v==='polymarket'?'P':'K'}</span><div><h3>${venueName(v)}</h3><p>INDEPENDENT PAPER ACCOUNT</p></div><span class="badge muted">$100 START</span></div><div class="account-balance"><strong>${money(a.equity)}</strong><span>${a.positions.length?'marked equity':'cash equity'}${a.markComplete===false?' · mark incomplete':''}</span></div><div class="account-details"><div><span>Available cash</span><b>${money(a.cash)}</b></div><div><span>Open positions</span><b>${a.positions.length}</b></div><div><span>Realized P&amp;L</span><b class="${a.realizedPnl<0?'negative':a.realizedPnl>0?'positive':''}">${money(a.realizedPnl)}</b></div></div><div class="account-status"><span>${automationReport(snapshot).find(r=>r.venue===v).status}</span><small>${s?.status==='error'?'Feed error':'Sample'} · ${ago(s?.observedAt)}</small></div></article>`;
    }).join('');
  }
  function renderAutomation(){
    const reports=automationReport(snapshot);
    const problem=reports.some(r=>r.delayed||['error','partial'].includes(r.source?.status));
    $('prediction-auto-status').textContent=problem?'Automatic desk: collection needs attention':
      reports.some(r=>snapshot.accounts[r.venue].halted)?'An account risk stop is active. See each venue below.':
      reports.some(r=>r.receipt?.opened.length)?'The bot recorded new paper entries':
      reports.some(r=>r.pending.length)?'The bot is checking its picks again':
      reports.some(r=>snapshot.accounts[r.venue].positions.length)?'The bot is managing open positions':
      'Scanning both venues. Cash held until a bet qualifies.';
    $('prediction-auto-time').textContent=`Last completed scan: ${date(snapshot.generatedAt)} · ${ago(snapshot.generatedAt)}. ${snapshot.markets.length} markets, ${snapshot.decisions.length} YES/NO decisions. Display checks for updates every minute.`;
    $('prediction-engines').innerHTML=reports.map(r=>{
      const a=snapshot.accounts[r.venue],study=snapshot.studies[r.venue],opened=r.receipt?.opened||[];
      const next=r.delayed||r.source?.status==='error'?'Waiting for a successful source collection; no stale quote may fund an entry.':
        a.halted?'New entries are stopped by the account risk limit. Existing positions remain tracked.':
        r.pending.length?'The next qualifying scan confirms these picks and sizes the paper entry automatically.':
        a.positions.length?'The bot marks positions and checks official settlements each cycle.':
        r.learning?'The bot records events and checks their final outcomes. Once the evidence and price checks pass, it chooses and opens paper bets automatically.':
        'The next scan checks both outcomes again and automatically takes any qualifying paper entry.';
      const picks=[...opened.map(p=>({...p,label:'Opened automatically'})),...r.pending.map(d=>({
        marketId:d.marketId,side:d.side,question:snapshot.markets.find(m=>m.id===d.marketId)?.question,
        cost:d.plan.fill?.cost,quantity:d.plan.fill?.quantity,label:'First scan passed · awaiting automatic confirmation'}))];
      return `<article class="panel prediction-engine" data-auto-venue="${r.venue}"><div class="between"><h3>${venueName(r.venue)}</h3><span class="badge ${r.delayed||r.source?.status==='error'||a.halted?'amber':'muted'}">${esc(r.status)}</span></div><p class="quiet">${r.checked} markets · ${r.outcomes} outcomes evaluated</p><p class="engine-next">${esc(next)}</p>${picks.map(p=>`<div class="automatic-pick"><p class="eyebrow">${esc(p.label)}</p><h4>${esc(p.question||p.marketId)}</h4><p><b>${esc(p.side.toUpperCase())}</b> · ${p.quantity} contracts · ${money(p.cost)} including costs</p><button class="text-button" data-pred-market="${esc(p.marketId)}" data-pred-side="${p.side}">Inspect bot decision ↗</button></div>`).join('')}<dl class="engine-metrics"><div><dt>Pending confirmation</dt><dd>${r.pending.length}</dd></div><div><dt>Open positions</dt><dd>${a.positions.length}</dd></div><div><dt>Events recorded</dt><dd>${study.observations}</dd></div><div><dt>Outcomes verified</dt><dd>${study.resolved}</dd></div></dl>${r.learning?'<p class="engine-hold">New entries are on hold while the bot gathers evidence. Existing positions stay managed; it is not waiting for your input.</p>':''}<details class="engine-reasons"><summary>Why the last scan held entries</summary><ul>${r.reasons.map(([reason,count])=>`<li>${esc(reason)} <span class="quiet">(${count} outcome checks)</span></li>`).join('')||'<li>No entry blocks recorded in the last scan.</li>'}</ul></details><p class="quiet small">Source read ${date(r.source?.observedAt)} · ${ago(r.source?.observedAt)}${r.source?.error?' · '+esc(r.source.error):''}</p></article>`;
    }).join('');
    const cycles=snapshot.automation?.recentCycles||[];
    $('prediction-activity').innerHTML=cycles.length?cycles.slice(-8).reverse().map(c=>`<article class="automation-cycle"><time>${date(c.at)}<span>${ago(c.at)}</span></time><div>${c.venues.map(v=>`<p><b>${venueName(v.venue)}</b> · ${v.checked} markets checked · ${v.opened.length} opened · ${v.settled.length} settled · ${v.pending} pending${v.halted?' · risk stop':''}${!v.opened.length&&!v.settled.length&&!v.pending?' · '+(v.positions?'positions monitored':'no qualifying entry'):''}</p>`).join('')}</div></article>`).join(''):'<p class="empty">The last scan’s decisions appear above. Detailed activity will appear after the next completed collector cycle.</p>';
  }
  function shownMarkets(){const query=$('prediction-search').value.trim().toLowerCase(),v=$('prediction-venue').value,sort=$('prediction-sort').value;
    return snapshot.markets.filter(m=>(v==='all'||m.venue===v)&&`${m.question} ${m.category}`.toLowerCase().includes(query)).sort((a,b)=>sort==='spread'?
      ((a.sides.yes.asks[0]?.[0]??2)-(a.sides.yes.bid??0))-((b.sides.yes.asks[0]?.[0]??2)-(b.sides.yes.bid??0)):(a.closeAt??Infinity)-(b.closeAt??Infinity));
  }
  function renderMarkets(){if(!snapshot)return;const rows=shownMarkets(),now=Date.now()/1000;
    $('prediction-count').textContent=`${rows.length} sampled markets · ${snapshot.decisions.filter(d=>d.plan.status==='candidate').length} paper candidates · scan ${ago(snapshot.generatedAt)}`;
    $('prediction-markets').innerHTML=rows.slice(0,visible).map(m=>{const valid=quoteValid(m,now),decision=snapshot.decisions.find(d=>d.marketId===m.id&&d.plan.status==='candidate');return `<article class="prediction-market ${selected===m.id?'active':''}" data-venue="${m.venue}"><div class="market-meta"><span class="venue-name">${venueName(m.venue)}</span><span>${esc(m.category)}</span></div><h3>${esc(m.question)}</h3><div class="prediction-odds">${['yes','no'].map(s=>`<button data-pred-market="${esc(m.id)}" data-pred-side="${s}" aria-label="Inspect ${s.toUpperCase()} on ${esc(m.question)}"><span>${s.toUpperCase()}</span><b>${cents(m.sides[s].asks[0]?.[0])}</b></button>`).join('')}</div><div class="market-foot"><span>Cutoff ${date(m.closeAt)}</span><span>${valid?'Book':'Quote'} ${ago(m.quoteAt)}</span></div><div class="market-decision">${snapshot.accounts[m.venue].positions.some(p=>p.marketId===m.id)?'Automatically opened paper position':decision?'Passed last scan; portfolio checks apply':valid?'No qualifying automatic entry':'Dated quote · bot refreshes before entry'}${m.sourceError?' · source error':''}</div></article>`;}).join('')||'<div class="prediction-empty"><h3>No matching markets</h3><p>Try another venue or a shorter search. Only real public snapshots appear here.</p></div>';
    $('prediction-more').hidden=visible>=rows.length;
  }
  function renderTicket(){if(!snapshot)return;const m=snapshot.markets.find(m=>m.id===selected);if(!m)return;
    const d=snapshot.decisions.find(d=>d.marketId===m.id&&d.side===side),f=d?.forecast,a=snapshot.accounts[m.venue],plan=planBet(m,side,f,a,Date.now()/1000),s=m.sides[side],url=safeUrl(m.url);
    $('prediction-ticket').innerHTML=`<div class="prediction-ticket-body"><p class="eyebrow">${venueName(m.venue)}</p><h4>${esc(m.question)}</h4><div class="ticket-side"><span class="badge ${plan.status==='candidate'?'good':'amber'}">${side.toUpperCase()} · ${plan.status==='candidate'?'PAPER EXPERIMENT':'WAIT'}</span><strong>${cents(s.asks[0]?.[0])}</strong></div><div class="ticket-detail"><span>Forecast probability</span><b>${pct(plan.probability)}</b></div><div class="ticket-detail"><span>Conservative probability</span><b>${pct(plan.lower)}</b></div><div class="ticket-detail"><span>Break-even after costs</span><b>${pct(plan.breakEven)}</b></div><div class="ticket-detail"><span>Conservative edge</span><b>${Number.isFinite(plan.edge)?cents(plan.edge):'Not established'}</b></div><div class="ticket-detail"><span>Inspection stake at this quote</span><b>${plan.status==='candidate'?money(plan.fill?.cost):'$0.00'}</b></div><ul class="ticket-reasons">${plan.reasons.map(r=>`<li>${esc(r)}</li>`).join('')||'<li>Eligible for the shared collector’s second-scan and portfolio checks.</li>'}</ul><p class="quiet small">${esc(m.feeSource)}. Costs also include a 1¢ per-contract slippage allowance. Book ${ago(m.quoteAt)}.</p><details class="ticket-rules"><summary>Contract rules &amp; source times</summary><p>${esc(m.rules||'Contract rules unavailable.')}</p><p>Entry cutoff: ${date(m.closeAt)} (${esc(m.cutoffKind)})<br>Contract expiry: ${date(m.expiryAt)}<br>Quote: ${date(m.quoteAt)}<br>Retrieved: ${date(m.observedAt)}<br>${esc(m.quoteTimeKind)}</p></details>${url?`<a class="button secondary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View market on ${venueName(m.venue)} ↗</a>`:''}</div>`;
    const body=$('prediction-ticket').querySelector('.prediction-ticket-body');
    const button=document.createElement('button');button.className='button secondary';button.textContent=bookBusy?'Reading public book…':'↻ Refresh this book';button.disabled=bookBusy;button.addEventListener('click',refreshBook);body.append(button);
    const status=document.createElement('p');status.className='quiet small';status.textContent=m.directError|| (m.directReadAt?'Book refreshed directly '+ago(m.directReadAt)+'. Shared paper balances update separately.':'Optional current quote for inspection. The bot refreshes its own entry books automatically.');body.append(status);
    renderScenario();
  }
  async function refreshBook(){
    const m=snapshot?.markets.find(m=>m.id===selected);if(!m||bookBusy)return;bookBusy=true;renderTicket();
    const read=async url=>{const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();};
    const e=encodeURIComponent;
    try{
      let fresh;
      if(m.venue==='polymarket'){
        const base='https://gateway.polymarket.us/v1',raw=(await read(`${base}/market/slug/${e(m.venueId)}`)).market;
        fresh=normalizePolymarket(raw,{id:m.eventId?.replace(/^pm:/,''),slug:m.eventSlug,seriesId:m.seriesId},await read(`${base}/markets/${e(m.venueId)}/book`),Date.now()/1000);
      }else{
        const base='https://api.elections.kalshi.com/trade-api/v2',raw=(await read(`${base}/markets/${e(m.venueId)}`)).market;
        const event=(await read(`${base}/events/${e(m.eventId)}`)).event;
        const [series,changes]=await Promise.all([read(`${base}/series/${e(event.series_ticker)}`),read(`${base}/events/fee_changes?event_ticker=${e(m.eventId)}&limit=1000`)]);
        fresh=normalizeKalshi(raw,event,series.series,!changes.cursor?changes.event_fee_changes:null,await read(`${base}/markets/${e(m.venueId)}/orderbook?depth=10`),Date.now()/1000);
      }
      fresh={...fresh,eventSlug:m.eventSlug,directReadAt:Date.now()/1000};directBooks.set(m.id,fresh);snapshot.markets=snapshot.markets.map(x=>x.id===m.id?fresh:x);
    }catch(error){m.directError=`Direct book refresh unavailable (${error.message}). Showing the dated shared snapshot.`;}
    finally{bookBusy=false;renderMarkets();renderTicket();}
  }
  function renderScenario(){const m=snapshot?.markets.find(m=>m.id===selected),el=$('prediction-probability'),unc=$('prediction-uncertainty');
    if(!m||!el.value){$('prediction-scenario-result').textContent='Enter a forecast to see break-even, expected value and hypothetical sizing.';return;}
    const p=Number(el.value)/100,u=Number(unc.value)/100;
    if(!el.checkValidity()||!unc.checkValidity()||!Number.isFinite(p)||!Number.isFinite(u)){$('prediction-scenario-result').textContent='Enter a probability from 1–99% and an error allowance from 1–30 points.';return;}
    const f={eligible:true,probability:p,lower:Math.max(0,p-u),upper:Math.min(1,p+u)},plan=planBet(m,side,f,snapshot.accounts[m.venue],Date.now()/1000);
    const q=Math.max(1,Math.ceil(m.minQuantity||1)),minFill=fill(m.sides[side].asks,q,m.feeRate),prob=side==='yes'?p:1-p;
    $('prediction-scenario-result').innerHTML=`<p><b>Conditional scenario only</b></p><div class="ticket-detail"><span>Expected value / contract</span><b>${minFill?money(prob-minFill.cost/q):'Unknown costs'}</b></div><div class="ticket-detail"><span>Break-even probability</span><b>${pct(plan.breakEven)}</b></div><div class="ticket-detail"><span>Hypothetical stake</span><b>${money(plan.fill?.cost||0)}</b></div><p class="quiet small">Uses your estimate, not a validated forecast. ${plan.reasons.length?esc(plan.reasons[0]):'The mathematical screen passes under your assumptions.'} Shared accounts are unchanged.</p>`;
  }
  function renderResults(){const accounts=Object.values(snapshot.accounts),trades=accounts.flatMap(a=>a.trades),positions=accounts.flatMap(a=>a.positions),pnl=accounts.reduce((n,a)=>n+a.realizedPnl,0);
    $('prediction-results').innerHTML=`<p class="prediction-result-summary"><b>${trades.length} settled trades</b> · realized P&amp;L <b>${money(pnl)}</b> · modeled entry fees <b>${money(accounts.reduce((n,a)=>n+a.fees,0))}</b></p>`;
    $('prediction-positions').innerHTML=[...positions,...trades.slice(-30).reverse()].map(p=>`<article class="prediction-position"><div class="market-meta"><span>${venueName(p.marketId.split(':')[0])} · ${p.side.toUpperCase()}</span><span>${p.closedAt?'SETTLED':'OPEN PAPER POSITION'}</span></div><h3>${esc(p.question)}</h3><dl><div><dt>Contracts</dt><dd>${p.quantity}</dd></div><div><dt>Cash used, including costs</dt><dd>${money(p.cost)}</dd></div><div><dt>${p.closedAt?'Final payout':'Net liquidation mark'}</dt><dd>${money(p.closedAt?p.payout:p.markValue)}</dd></div><div><dt>${p.closedAt?'Realized P&L':'Mark time'}</dt><dd>${p.closedAt?money(p.pnl):date(p.markAt)}</dd></div></dl></article>`).join('')||'<div class="prediction-empty"><h3>Both accounts are funded with paper cash.</h3><p>No qualifying entry has passed yet. The collector records fresh market observations and official outcomes, then tests whether a forecast deserves a small paper position.</p><button class="button secondary" data-pred-tab="method">See the entry requirements</button></div>';
    $('prediction-study').innerHTML=VENUES.map(v=>{const s=snapshot.studies[v];return `<article class="panel"><p class="eyebrow">${venueName(v)} · FORWARD STUDY</p><div class="study-metrics"><div><strong>${s.observations}</strong><span>Events recorded</span></div><div><strong>${s.resolved}</strong><span>Final outcomes</span></div><div><strong>${s.forecasts}</strong><span>Scored forecasts</span></div></div><p class="quiet small">Model Brier ${Number.isFinite(s.brier)?s.brier.toFixed(4):'not available'} · matching market baseline ${Number.isFinite(s.baselineBrier)?s.baselineBrier.toFixed(4):'not available'}. Lower is better. These overall counts do not replace the per-cohort entry checks.</p></article>`;}).join('');
  }
  function renderHealth(){const now=Date.now()/1000;$('prediction-health-cards').innerHTML=snapshot.sources.map(s=>`<article class="health-card"><div class="between"><h3>${venueName(s.venue)} predictions</h3><span class="badge ${s.status==='ok'&&now-s.observedAt<2700?'good':'amber'}">${s.status==='error'?'Source error':now-s.observedAt>=2700?'Delayed':s.status==='partial'?'Partial':'Updating'}</span></div><strong>${s.sampled} books sampled</strong><time>${date(s.observedAt)} · ${ago(s.observedAt)}</time><p>${esc(s.error||`${s.discovered} contracts discovered in a bounded sample. Quote timestamps remain separate from retrieval times.`)}</p><p>Paper collector ${ago(snapshot.generatedAt)}. Individual entry quotes expire after 90 seconds.</p></article>`).join('');}
  function render(){if(!snapshot)return;renderAutomation();renderAccounts();renderMarkets();renderTicket();renderResults();renderHealth();}
  $('predictions').addEventListener('click',event=>{const t=event.target.closest('[data-pred-tab]'),pick=event.target.closest('[data-pred-market]');if(t)selectTab(t.dataset.predTab);if(pick){selectTab('markets');selected=pick.dataset.predMarket;side=pick.dataset.predSide;renderMarkets();renderTicket();if(window.matchMedia?.('(max-width:1000px)').matches){$('prediction-planner').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth',block:'start'});$('prediction-planner').tabIndex=-1;$('prediction-planner').focus({preventScroll:true});}}});
  document.querySelectorAll('[role=tab][data-pred-tab]').forEach(el=>el.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...document.querySelectorAll('[role=tab][data-pred-tab]')],i=tabs.indexOf(el),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectTab(tabs[next].dataset.predTab);tabs[next].focus();}));
  for(const id of ['prediction-search','prediction-venue','prediction-sort'])$(id).addEventListener('input',()=>{visible=12;renderMarkets();});
  for(const id of ['prediction-probability','prediction-uncertainty'])$(id).addEventListener('input',renderScenario);
  $('prediction-more').addEventListener('click',()=>{visible+=12;renderMarkets();});$('prediction-refresh').addEventListener('click',refresh);
  $('health-refresh').addEventListener('click',refresh);
  $('prediction-export').addEventListener('click',()=>{if(!snapshot)return;if(exportUrl)URL.revokeObjectURL(exportUrl);exportUrl=URL.createObjectURL(new Blob([JSON.stringify({generatedAt:snapshot.generatedAt,version:snapshot.version,accounts:snapshot.accounts,studies:snapshot.studies},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=exportUrl;a.download='moffitt-prediction-paper-ledgers.json';document.body.append(a);a.click();a.remove();$('prediction-export-status').textContent='Export prepared for both $100 paper ledgers, including source time and strategy version.';});
  const timer=setInterval(refresh,60000),ageTimer=setInterval(()=>{if(snapshot){renderAutomation();renderMarkets();renderTicket();renderHealth();}},30000);
  window.addEventListener('pagehide',()=>{disposed=true;clearInterval(timer);clearInterval(ageTimer);if(exportUrl)URL.revokeObjectURL(exportUrl);},{once:true});
  selectTab(tab);refresh();
}
