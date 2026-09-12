import { DEFAULTS, MODEL_VERSION } from './market-core.mjs';
export const POLICY_VERSION = '2026-09-12-outcomes-v1';
const finite = Number.isFinite;

export function summarizeTrades(trades = []) {
  const rows = (Array.isArray(trades)?trades:[]).filter(t => t && finite(t.pnl));
  const wins = rows.filter(t => t.pnl > 0), losses = rows.filter(t => t.pnl < 0);
  const net = rows.reduce((s,t) => s+t.pnl,0);
  const fees = rows.reduce((s,t) => s+(finite(t.entryFee)?t.entryFee:0)+(finite(t.exitFee)?t.exitFee:0),0);
  const grossWins = wins.reduce((s,t)=>s+t.pnl,0), grossLosses = -losses.reduce((s,t)=>s+t.pnl,0);
  const averageWin = wins.length ? grossWins/wins.length : null;
  const averageLoss = losses.length ? grossLosses/losses.length : null;
  const byExit = new Map();
  for (const t of rows) {
    const reason = t.reason || 'Unspecified';
    const previous = byExit.get(reason) || {reason,trades:0,pnl:0};
    previous.trades++;previous.pnl+=t.pnl;byExit.set(reason,previous);
  }
  return {trades:rows.length,wins:wins.length,losses:losses.length,net,fees,
    beforeRecordedFees:net+fees,winRate:rows.length ? wins.length/rows.length*100 : null,
    expectancy:rows.length ? net/rows.length : null,averageWin,averageLoss,
    // These are observed payoff sizes, not the planner's theoretical target.
    empiricalBreakeven:averageWin!==null && averageLoss!==null ? averageLoss/(averageWin+averageLoss)*100 : null,
    profitFactor:grossLosses ? grossWins/grossLosses : null,
    exits:[...byExit.values()].sort((a,b)=>a.pnl-b.pnl)};
}

function matchingRun(run,start,end,overrides={}) {
  if(!run || run.start!==start || run.end!==end || !Array.isArray(run.ledger) || run.trades!==run.ledger.length ||
    !Object.entries({...DEFAULTS,...overrides}).every(([k,v])=>run.settings?.[k]===v))return false;
  if(!run.ledger.every(t=>t&&finite(t.pnl)&&finite(t.openedAt)&&finite(t.closedAt)&&t.openedAt>=start&&t.closedAt>=t.openedAt&&t.closedAt<=end))return false;
  const stats=summarizeTrades(run.ledger), close=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<.01;
  return close(run.returnPct,stats.net/10)&&close(run.finalEquity,1000+stats.net)&&close(run.feesUsd,stats.fees)&&
    (stats.profitFactor===null?run.profitFactor===null:close(run.profitFactor,stats.profitFactor));
}

export function assessEvidence(report, now=Date.now()/1000) {
  const policy={version:POLICY_VERSION,modelVersion:MODEL_VERSION,reviewedAt:now,
    reportAt:report?.generatedAt||null,allowedStrategies:[],state:'held',strategies:[],checks:[]};
  const valid = report?.modelVersion===MODEL_VERSION && finite(report.generatedAt) &&
    report.generatedAt<=now+5 && finite(report.end) && report.end<=now && Array.isArray(report.runs);
  const runs=valid?report.runs.filter(r=>r&&typeof r==='object'):[];
  const baseline = runs.find(r=>r.name==='Combined · 90 days');
  const matching = valid && report.end-report.start===90*86400 && matchingRun(baseline,report.start,report.end);
  if (!matching) return {...policy,reason:'A completed replay of the current model and cost settings is required.'};
  const stress = runs.find(r=>r.name==='Higher costs');
  const slices = ['First 30 days','Middle 30 days','Last 30 days'].map(name=>runs.find(r=>r.name===name));
  const coverageFor=products=>Array.isArray(products)&&products.length ? Math.min(...products.map(p=>Math.min(report.quality?.[p]?.fiveMinute?.pct??0,report.quality?.[p]?.hourly?.pct??0))) : 0;
  const coverage = coverageFor(report.products);
  const qualityRun = runs.find(r=>r.name==='High-coverage markets only');
  const qualityValid=matchingRun(qualityRun,report.start,report.end)&&Array.isArray(qualityRun.products)&&qualityRun.products.every(p=>report.products?.includes(p))&&coverageFor(qualityRun.products)>=98;
  policy.checks = [
    {label:'Combined replay profitable after costs',pass:finite(baseline.returnPct)&&baseline.returnPct>0},
    {label:'Combined profit factor at least 1.15',pass:finite(baseline.profitFactor)&&baseline.profitFactor>=1.15},
    {label:'At least 30 combined completed trades',pass:baseline.trades>=30},
    {label:'Higher-cost replay profitable',pass:matchingRun(stress,report.start,report.end,{feeBps:100,slippageBps:25})&&stress.returnPct>0},
    {label:'All three chronological slices profitable',pass:slices.every((r,i)=>matchingRun(r,report.start+i*30*86400,report.start+(i+1)*30*86400)&&r.returnPct>0)},
    {label:'At least 98% hourly and scan coverage, or profitable high-coverage comparison',pass:finite(coverage)&&(coverage>=98||(qualityValid&&qualityRun.returnPct>0))}
  ];
  for (const id of ['breakout','reclaim']) {
    const candidate=runs.find(r=>Array.isArray(r.settings?.strategies)&&r.settings.strategies.length===1&&r.settings.strategies[0]===id);
    const run=matchingRun(candidate,report.start,report.end)?candidate:null;
    const stats=summarizeTrades(run?.ledger);
    const negative=finite(run?.returnPct)&&run.returnPct<=0;
    const passes=run?.trades>=30&&finite(run.returnPct)&&run.returnPct>0&&finite(run.profitFactor)&&run.profitFactor>=1.15&&policy.checks.every(c=>c.pass);
    policy.strategies.push({id,name:id==='breakout'?'Volume breakout':'Trend reclaim',
      status:negative?'needs-revision':passes?'paper-eligible':'insufficient-evidence',
      allowed:!!passes,returnPct:run?.returnPct??null,trades:run?.trades??0,profitFactor:run?.profitFactor??null,stats,
      reason:negative?'Lost money in its standalone replay after modeled costs.':passes?'Meets the documented paper-research gate; future returns remain unknown.':'The sample or robustness checks do not support a new paper entry.'});
    if(passes)policy.allowedStrategies.push(id);
  }
  policy.state=policy.allowedStrategies.length?'paper-eligible':'held';
  policy.reason=policy.allowedStrategies.length?'Only strategies passing every research gate can open new paper positions.':'New paper entries held. The recorded outcomes do not support either strategy.';
  return policy;
}

export function applyEvidence(signal, policy) {
  if(signal.status!=='candidate')return signal;
  if(policy.allowedStrategies.includes(signal.setup))return signal;
  const evidence=policy.strategies.find(s=>s.id===signal.setup);
  return {...signal,status:'evidence-held',evidenceStatus:evidence?.status||'unavailable',
    reasons:[evidence?.reason||policy.reason,...signal.reasons],hypotheticalPlan:true};
}
