const n=Number.isFinite;
const version='2026-09-13-etf-monthly-v1';
const symbols=['SPY','EFA','IEF','GLD','VNQ'];
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x);
const numeric=(r,keys)=>r&&keys.every(k=>n(r[k]));
const dated=r=>r?.modelVersion===version&&n(r.generatedAt)&&r.generatedAt>0&&r.generatedAt<=Date.now()/1000+60;
export function validateResearch(r){
  return !!(dated(r)&&date(r.sourceAsOf)&&symbols.every(s=>r.sources?.[s]&&n(r.sources[s].bars)&&/^[a-f0-9]{64}$/.test(r.sources[s].sha256))&&
    Array.isArray(r.runs)&&r.runs.length>=15&&r.runs.every(v=>typeof v.name==='string'&&date(v.start)&&date(v.end)&&numeric(v,['capital','cagrPct','finalEquity','maxDrawdownPct','trades','feesUsd','spreadUsd','slippageUsd','dividendUsd'])&&v.capital>0&&Array.isArray(v.curve)&&v.curve.length>1&&v.curve.every(p=>date(p.date)&&n(p.equity)))&&
    numeric(r.uncertainty,['lowerPct','upperPct','samples'])&&Array.isArray(r.blocks)&&r.blocks.every(v=>date(v.start)&&date(v.end)&&['trend','hold','spy'].includes(v.mode)&&numeric(v,['cagrPct','maxDrawdownPct']))&&
    Array.isArray(r.checks)&&r.checks.every(c=>typeof c.label==='string'&&typeof c.pass==='boolean')&&r.runs.some(v=>v.name==='$5 monthly overhead'));
}
export function validatePaper(r){
  if(!dated(r)||r.mode!=='simulation'||r.realEnabled!==false)return false;
  if(r.account===null)return r.status==='source-error'&&typeof r.error==='string';
  return !!(date(r.sourceAsOf)&&n(r.createdAt)&&numeric(r.account,['initial','cash','equity','receivablesUsd'])&&Array.isArray(r.account.positions)&&r.account.positions.every(p=>symbols.includes(p.symbol)&&numeric(p,['qty','mark','value']))&&
    Array.isArray(r.signals)&&r.signals.every(s=>symbols.includes(s.symbol)&&n(s.weight)&&typeof s.aboveTrend==='boolean'&&date(s.signalDate))&&
    (!r.pending||(numeric(r.pending,['decisionAt','eligibleOpen'])&&r.pending.decisionAt<r.pending.eligibleOpen&&date(r.pending.eligibleSession)))&&
    Array.isArray(r.ledger)&&r.ledger.every(t=>date(t.date)&&symbols.includes(t.symbol)&&['buy','sell'].includes(t.side)&&numeric(t,['qty','fill','fees','decisionAt']))&&
    Array.isArray(r.readiness)&&r.readiness.every(c=>typeof c.label==='string'&&typeof c.pass==='boolean'));
}
