// Read-only analysis of the existing prediction paper state. It opens
// data/predictions/state.json for reading and never writes, resets, migrates or
// relabels any account, observation or settlement. Descriptive statistics only:
// observations are correlated (many contracts per game) and nothing here is a
// significance test, a trading signal or a claim about future performance.
//
//   node scripts/analyze-predictions.mjs [state.json] [--json]
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PREDICTION_VERSION,VENUES,wilson} from '../dashboard/prediction-core.mjs';
import {ENTRY_POLICY} from '../dashboard/prediction-entry.mjs';

const finite=Number.isFinite;
const mean=xs=>xs.length?xs.reduce((n,x)=>n+x,0)/xs.length:null;
function tstat(xs){
  if(xs.length<2)return null;
  const m=mean(xs),v=xs.reduce((n,x)=>n+(x-m)**2,0)/(xs.length-1);
  return v>0?m/Math.sqrt(v/xs.length):null;
}
const binary=v=>v===0||v===1;

// Resolved binary labels. An observation's own label wins; an unlabeled observation may take
// the official settlement recorded in the state. Fractional settlements are never binary labels.
export function labelled(state,venue){
  const out=[],stats={observations:0,unlabeled:0,fractional:0,fromSettlement:0,conflicts:0};
  for(const o of state.observations||[]){
    if(o.venue!==venue||o.version!==PREDICTION_VERSION||typeof o.eventId!=='string'||!finite(o.at)||!(o.baseline>0&&o.baseline<1))continue;
    stats.observations++;
    const s=state.settlements?.[o.marketId];
    let payout=o.resolvedAt!==null&&o.resolvedAt!==undefined?o.payout:null,resolvedAt=o.resolvedAt;
    if(payout===null&&s&&finite(s.yesPayout)){payout=s.yesPayout;resolvedAt=s.observedAt;if(binary(payout))stats.fromSettlement++;}
    if(payout!==null&&s&&finite(s.yesPayout)&&s.yesPayout!==o.payout&&o.resolvedAt!==null)stats.conflicts++;
    if(payout===null||!finite(resolvedAt)){stats.unlabeled++;continue;}
    if(!binary(payout)){stats.fractional++;continue;}
    out.push({...o,payout,resolvedAt});
  }
  return {rows:out,stats};
}
const earliestPerEvent=rows=>{const m=new Map();for(const o of [...rows].sort((a,b)=>a.at-b.at))if(!m.has(o.eventId))m.set(o.eventId,o);return [...m.values()];};

function band(rows,edges,value,outcome){
  return edges.slice(0,-1).map((lo,i)=>{
    const hi=edges[i+1],xs=rows.filter(o=>value(o)>=lo&&(value(o)<hi||(i===edges.length-2&&value(o)<=hi)));
    const wins=xs.reduce((n,o)=>n+outcome(o),0),w=wilson(wins,xs.length,1.96);
    return {label:`${Math.round(lo*100)}-${Math.round(hi*100)}%`,n:xs.length,meanMidpoint:mean(xs.map(value)),frequency:xs.length?wins/xs.length:null,
      diffPoints:xs.length?(wins/xs.length-mean(xs.map(value)))*100:null,brierMidpoint:mean(xs.map(o=>(value(o)-outcome(o))**2)),lower:xs.length?w.lower:null,upper:xs.length?w.upper:null};
  }).filter(b=>b.n);
}
// Calibration by price band: YES midpoint bands, and the favored side folded above 50%.
export function calibration(rows){
  const events=earliestPerEvent(rows);
  const yesEdges=Array.from({length:11},(_,i)=>i/10),favEdges=[.5,.55,.6,.65,.7,.75,.8,.85,.9,.95,1];
  return {events:events.length,
    yes:band(events,yesEdges,o=>o.baseline,o=>o.payout),
    favorite:band(events,favEdges,o=>Math.max(o.baseline,1-o.baseline),o=>o.baseline>=.5?o.payout:1-o.payout)};
}

// Walk-forward: score each observation with the experimental estimator using ONLY outcomes
// resolved before that observation was recorded, other events, same cohort and price bin.
export function walkForward(rows,{minCohort=ENTRY_POLICY.minCohort,minBin=ENTRY_POLICY.minBin,prior=ENTRY_POLICY.marketPriorWeight}={}){
  const byCohort=new Map();
  for(const o of rows){if(!byCohort.has(o.cohort))byCohort.set(o.cohort,[]);byCohort.get(o.cohort).push(o);}
  const scored=[];
  for(const o of [...rows].sort((a,b)=>a.at-b.at)){
    if(!Number.isInteger(o.bin))continue;
    const unique=new Map();
    for(const h of byCohort.get(o.cohort)||[])if(h.eventId!==o.eventId&&h.resolvedAt<=o.at&&h.resolvedAt>=h.at)unique.set(h.eventId,h);
    const hist=[...unique.values()],inBin=hist.filter(h=>h.bin===o.bin);
    if(hist.length<minCohort||inBin.length<minBin)continue;
    const estimate=(inBin.reduce((n,h)=>n+h.payout,0)+prior*o.baseline)/(inBin.length+prior);
    scored.push({estimate,baseline:o.baseline,payout:o.payout,eventId:o.eventId});
  }
  const events=[...new Map(scored.map(s=>[s.eventId,s])).values()];
  const diffs=events.map(s=>(s.estimate-s.payout)**2-(s.baseline-s.payout)**2);
  return {scored:events.length,brierEstimate:mean(events.map(s=>(s.estimate-s.payout)**2)),brierMidpoint:mean(events.map(s=>(s.baseline-s.payout)**2)),
    brierDelta:mean(diffs),t:tstat(diffs),estimateBetter:diffs.filter(d=>d<0).length,params:{minCohort,minBin,prior}};
}

// The existing paper trades: claimed model edge versus realized result, per contract.
export function tradeAudit(account){
  const trades=account?.trades||[];
  const rows=trades.map(t=>{
    const f=t.forecast||{},yesP=f.probability,mid=f.baseline;
    const modelSide=finite(yesP)?(t.side==='yes'?yesP:1-yesP):null,midSide=finite(mid)?(t.side==='yes'?mid:1-mid):null;
    return {pnl:t.pnl,perContract:t.pnl/t.quantity,claimed:finite(modelSide)?modelSide-t.cost/t.quantity:null,midSide,win:t.payout===t.quantity?1:0,binary:t.payout===0||t.payout===t.quantity};
  });
  const claimed=rows.filter(r=>r.claimed!==null),withMid=rows.filter(r=>r.midSide!==null&&r.binary);
  const best=Math.max(0,...rows.map(r=>r.pnl)),total=rows.reduce((n,r)=>n+r.pnl,0);
  return {n:rows.length,wins:rows.reduce((n,r)=>n+r.win,0),expectedWinsAtMidpoint:withMid.length?withMid.reduce((n,r)=>n+r.midSide,0):null,midpointRows:withMid.length,
    claimedEdgePerContract:mean(claimed.map(r=>r.claimed)),realizedPerContract:mean(rows.map(r=>r.perContract)),meanPnl:mean(rows.map(r=>r.pnl)),tPerTrade:tstat(rows.map(r=>r.pnl)),
    totalPnl:total,bestTradePnl:best,withoutBestTrade:total-best};
}

export function analyze(state){
  return {generatedFrom:{updatedAt:state.updatedAt??null,version:state.version??null,observations:(state.observations||[]).length,settlements:Object.keys(state.settlements||{}).length},
    venues:VENUES.map(venue=>{
      const {rows,stats}=labelled(state,venue);
      return {venue,labels:stats,calibration:calibration(rows),walkForward:walkForward(rows),trades:tradeAudit(state.accounts?.[venue])};
    })};
}

const f=(v,d=3)=>v===null||v===undefined||!finite(v)?'   n/a':v.toFixed(d).padStart(d+4);
const pad=(s,n)=>String(s).padEnd(n);
export function formatReport(r){
  const out=[`Prediction analysis (read-only). State updated ${r.generatedFrom.updatedAt?new Date(r.generatedFrom.updatedAt*1000).toISOString():'unknown'}; ${r.generatedFrom.observations} observations, ${r.generatedFrom.settlements} settlements.`,
    'Descriptive only: contracts on one game are correlated, and nothing below is a significance test or a forecast of future results.'];
  for(const v of r.venues){
    out.push('',`== ${v.venue} ==`,`Labels: ${v.labels.observations} current-version observations, ${v.calibration.events} resolved binary events (earliest per event); ${v.labels.unlabeled} unlabeled, ${v.labels.fractional} fractional, ${v.labels.fromSettlement} labeled from settlements only, ${v.labels.conflicts} label/settlement conflicts.`);
    for(const [title,rows] of [['Calibration by YES midpoint band',v.calibration.yes],['Calibration of the favored side (midpoint at least 50%)',v.calibration.favorite]]){
      out.push(title,`  ${pad('band',9)}${pad('n',6)}${pad('mid',8)}${pad('freq',8)}${pad('diff pp',9)}${pad('brier',8)}95% CI of freq`);
      for(const b of rows)out.push(`  ${pad(b.label,9)}${pad(b.n,6)}${pad(f(b.meanMidpoint),8)}${pad(f(b.frequency),8)}${pad(f(b.diffPoints,1),9)}${pad(f(b.brierMidpoint),8)}${f(b.lower)} to ${f(b.upper)}`);
    }
    const w=v.walkForward;
    out.push(`Walk-forward (experimental estimator: cohort>=${w.params.minCohort}, bin>=${w.params.minBin}, prior weight ${w.params.prior}; earlier outcomes only)`,
      w.scored?`  scored events ${w.scored}; Brier estimate ${f(w.brierEstimate,4)} vs market midpoint ${f(w.brierMidpoint,4)}; difference ${f(w.brierDelta,4)} (negative = estimate better), t ${f(w.t,2)}, estimate better on ${w.estimateBetter} of ${w.scored}`:'  no observation had enough earlier outcomes to score');
    const t=v.trades;
    out.push(`Existing paper trades (settled): n=${t.n}, wins ${t.wins}${t.expectedWinsAtMidpoint!==null?` vs ${t.expectedWinsAtMidpoint.toFixed(1)} expected at entry midpoints (n=${t.midpointRows})`:''}`,
      `  claimed edge/contract ${f(t.claimedEdgePerContract)}, realized P&L/contract ${f(t.realizedPerContract)}, mean P&L/trade ${f(t.meanPnl)}, t ${f(t.tPerTrade,2)}, total ${f(t.totalPnl,2)}, without best trade ${f(t.withoutBestTrade,2)}`);
  }
  return out.join('\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--'))||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/predictions/state.json');
  const result=analyze(JSON.parse(await readFile(file,'utf8')));
  console.log(args.includes('--json')?JSON.stringify(result,null,2):formatReport(result));
}
