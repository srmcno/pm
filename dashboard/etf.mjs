import { publishedJson, publicationHealth } from './data-client.mjs';
import { validateResearch, validatePaper } from './etf-schema.mjs';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => Number.isFinite(n) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n) : 'Unavailable';
const pct = n => Number.isFinite(n) ? `${n.toFixed(2)}%` : 'Unavailable';
const time = n => Number.isFinite(n) ? new Date(n*1000).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Not recorded';
const metric = (label, value) => `<div class="etf-metric"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`;
let report, paper;
try { document.documentElement.dataset.theme = localStorage.getItem('mm-etf-theme') || 'dark'; } catch {}
$('theme').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme=theme;try{localStorage.setItem('mm-etf-theme',theme);}catch{}});

function renderChart() {
  if (!report) return;
  const selected=report.runs[Number($('scenario').value)] || report.runs[0];
  const series=[{run:selected,color:'#4db6c7'}, {run:report.runs[1],color:'#d7ac60'}, ...($('show-spy').checked?[{run:report.runs[2],color:'#b29cdb'}]:[])];
  const max=Math.max(...series.flatMap(s=>s.run.curve.map(p=>p.equity/s.run.capital*1000)),1000)*1.08;
  const W=Math.max(320,$('chart').clientWidth),H=W<500?250:310,L=65,R=20,T=16,B=38, floor=0, count=selected.curve.length;
  const x=i=>L+i/(count-1)*(W-L-R), y=v=>T+(max-v)/(max-floor)*(H-T-B);
  const grid=[0,1,2,3,4].map(i=>{const val=max/4*i;return `<line x1="${L}" y1="${y(val)}" x2="${W-R}" y2="${y(val)}" stroke="currentColor" opacity=".13"/><text x="${L-10}" y="${y(val)+4}" text-anchor="end">$${Math.round(val).toLocaleString()}</text>`;}).join('');
  const paths=series.map(s=>`<path d="${s.run.curve.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(2)},${y(p.equity/s.run.capital*1000).toFixed(2)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.5"><title>${esc(s.run.name)}: ${money(s.run.finalEquity/s.run.capital*1000)} per $1,000</title></path>`).join('');
  $('chart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(selected.name)} compared with buy-and-hold, monthly values per $1,000 starting capital"><title>${esc(selected.name)} historical portfolio value</title>${grid}${paths}<text x="${L}" y="${H-6}">${esc(selected.start)}</text><text x="${W-R}" y="${H-6}" text-anchor="end">${esc(selected.end)}</text></svg>`;
}
function renderResearch() {
  const r=report.runs[0], overhead=report.runs.find(r=>r.name==='$5 monthly overhead');
  $('history-period').textContent=`${r.start} to ${r.end}`;
  $('verdict').textContent=`The fixed rule earned ${pct(r.cagrPct)} annualized after modeled trading costs, with a ${pct(r.maxDrawdownPct)} worst drawdown. It earned less than both hold benchmarks. This supports a forward simulation experiment; it does not establish an advantage in future returns.`;
  const prior=$('scenario').value;
  $('scenario').innerHTML=report.runs.map((r,i)=>`<option value="${i}">${esc(r.name)}</option>`).join('');
  if(prior)$('scenario').value=prior;
  $('scenarios').innerHTML=report.runs.map((r,i)=>`<tr class="${i===0?'primary':''}"><td>${esc(r.name)}${r.capital!==1000?`<br><small>Starts with ${money(r.capital)}</small>`:''}</td><td class="${r.cagrPct<0?'negative':''}">${pct(r.cagrPct)}</td><td>${money(r.finalEquity)}</td><td>${pct(r.maxDrawdownPct)}</td><td>${r.trades}</td></tr>`).join('');
  const u=report.uncertainty;
  $('uncertainty').textContent=`The 95% bootstrap interval for annualized log-return difference versus the five-ETF hold is ${pct(u.lowerPct)} to ${pct(u.upperPct)}. It includes zero and negative outcomes. Historical outperformance is not established. ${u.samples.toLocaleString()} paired samples use 12-month blocks; the final partial month is excluded.`;
  $('blocks').innerHTML=report.blocks.map(r=>`<tr><td>${esc(r.start)} to ${esc(r.end)}</td><td>${esc({trend:'Monthly trend',hold:'Five-ETF hold',spy:'SPY hold'}[r.mode])}</td><td>${pct(r.cagrPct)}</td><td>${pct(r.maxDrawdownPct)}</td></tr>`).join('');
  $('checks').innerHTML=report.checks.map(c=>`<li><span class="status-word">${c.pass?'Passed':'Held'}</span>${esc(c.label)}</li>`).join('');
  $('cost-breakdown').innerHTML=metric('Regulatory fees, entire test',money(r.feesUsd))+metric('Modeled spread cost',money(r.spreadUsd))+metric('Modeled slippage cost',money(r.slippageUsd))+metric('Distributions accrued',money(r.dividendUsd));
  $('overhead-warning').textContent=`Operating costs matter: adding $5 per month to the $1,000 account changes the historical annualized result to ${pct(overhead.cagrPct)}, ending at ${money(overhead.finalEquity)}. The free-operation assumption must be true for the base result to apply.`;
  $('input-evidence').textContent=`Five archived source responses contain ${report.sources.SPY.bars.toLocaleString()} daily observations per fund, with SHA-256 hashes. Last completed source session: ${report.sourceAsOf}. Daily calendar coverage, distribution cash flows and split handling are checked. Research generation: ${time(report.generatedAt)}.`;
  renderChart();
}
function renderPaper() {
  const a=paper.account;
  $('paper-status').textContent=paper.error?'SOURCE CHECK FAILED':paper.pending?'AWAITING NEXT FILL':'MONITORING';
  if(!a){$('account').innerHTML='<p>Account unavailable. The previous ledger has not been reset.</p>'; $('pending').textContent=paper.error||'Awaiting a successful source check.';return;}
  $('account').innerHTML=metric('Simulated equity',money(a.equity))+metric('Cash available',money(a.cash))+metric('Forward gain / loss',money(a.equity-a.initial))+metric('Unpaid distributions',money(a.receivablesUsd));
  $('pending').textContent=paper.error?`Update failed: ${paper.error}. Showing the preserved account as of ${paper.sourceAsOf}.`:paper.pending?`Decision recorded ${time(paper.pending.decisionAt)}. Earliest eligible fill: ${paper.pending.eligibleSession} at the U.S. market open. The fill is reported after a completed daily price is available.`:'No order is waiting. Existing shares are held until the next monthly decision.';
  $('signals').innerHTML=paper.signals.map(s=>`<div class="etf-signal ${s.weight?'held':''}"><strong>${esc(s.symbol)} · ${Math.round(s.weight*100)}%</strong><small>${s.aboveTrend?'Above monthly trend':'Sleeve held in cash'}</small></div>`).join('');
  $('source-time').textContent=`Paper account began ${time(paper.createdAt)}. Last accounted session: ${paper.sourceAsOf}. Update checked ${time(paper.generatedAt)}. Signal uses ${paper.signals[0]?.signalDate||'unavailable'}. ${publicationHealth.get('data/etf-paper.json')?.source==='bundled'?'Bundled snapshot fallback.':''}`;
  $('positions').innerHTML=a.positions.length?`<p>${a.positions.map(p=>`${esc(p.symbol)}: ${p.qty.toFixed(6)} shares, marked ${money(p.value)}`).join(' · ')}</p>`:'<p>No positions have filled yet. The $1,000 is simulation money.</p>';
  $('paper-trades').innerHTML=paper.ledger.length?paper.ledger.slice(-50).reverse().map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.symbol)}</td><td>${esc(t.side)}</td><td>${t.qty.toFixed(6)}</td><td>${money(t.fill)}</td><td>${money(t.fees)}</td><td>${esc(time(t.decisionAt))}</td></tr>`).join(''):'<tr><td colspan="7">No forward fills yet. Historical transactions are kept separately below.</td></tr>';
  $('readiness-checks').innerHTML=paper.readiness.map(c=>`<li><span class="status-word">${c.pass?'Recorded':'Not complete'}</span>${esc(c.label)}</li>`).join('');
}
async function refresh() {
  const results=await Promise.allSettled([
    publishedJson('data/etf-research.json',validateResearch),
    publishedJson('data/etf-paper.json',validatePaper)
  ]);
  const errors=[];
  if(results[0].status==='fulfilled'){report=results[0].value;renderResearch();}else errors.push('Historical results could not load.');
  if(results[1].status==='fulfilled'){paper=results[1].value;renderPaper();}else errors.push('Paper account could not load.');
  for(const file of ['data/etf-research.json','data/etf-paper.json']){const health=publicationHealth.get(file);if(health?.source==='bundled'||health?.source==='retained')errors.push(`${file.includes('research')?'Research':'Paper'}: ${health.source} snapshot; latest repository request failed or returned older data.`);}
  $('load-status').textContent=errors.length?errors.join(' '):'Research and paper records loaded. Simulated fills and historical tests are separate; real execution is off.';
}
$('scenario').addEventListener('change',renderChart);$('show-spy').addEventListener('change',renderChart);
$('export-paper').addEventListener('click',()=>{
  if(!paper?.ledger)return;
  const fields=['date','symbol','side','qty','reference','fill','notional','fees','signalDate','decisionAt','fillAt','observedAt'];
  const csv=[fields.join(','),...paper.ledger.map(t=>fields.map(k=>`"${String(t[k]??'').replaceAll('"','""')}"`).join(','))].join('\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'})),link=document.createElement('a');link.href=url;link.download='etf-forward-paper.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
new ResizeObserver(renderChart).observe($('chart'));
await refresh();setInterval(refresh,60000);
