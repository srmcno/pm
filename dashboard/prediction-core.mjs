// Shared, deterministic prediction research and paper accounting. Dollar amounts.
export const PREDICTION_VERSION = '2026-09-13-calibration-v2';
export const VENUES = ['polymarket', 'kalshi'];
export const POLICY = Object.freeze({initialCapital:100, maxStakePct:.02, maxExposurePct:.10,
  maxDrawdownPct:.10, kellyFraction:.25, minEdge:.03, maxSpread:.05,
  maxQuoteAge:90, minHours:6, maxDays:30, minCohort:100, minBin:50, minValidation:30});
const finite = Number.isFinite;
export const round = n => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
export const numeric = v => v === null || v === undefined || v === '' ? null : finite(Number(v)) ? Number(v) : null;
export const timestamp = v => {const n=Date.parse(v)/1000;return finite(n)?n:null;};
export function levels(rows) {
  return (rows||[]).map(r=>[numeric(r[0]),numeric(r[1])]).filter(([p,q])=>finite(p)&&p>0&&p<1&&finite(q)&&q>0).sort((a,b)=>a[0]-b[0]);
}
export function quoteValid(m, now) {
  return !m?.sourceError && m?.status==='open' && finite(m.quoteAt) && now-m.quoteAt>=-5 && now-m.quoteAt<=POLICY.maxQuoteAge &&
    finite(m.observedAt) && now-m.observedAt>=-5 && now-m.observedAt<=POLICY.maxQuoteAge;
}
export function fee(rate, price, quantity) {
  if (!finite(rate)||rate<0||rate>1||!finite(price)||price<0||price>1||!finite(quantity)||quantity<0) return null;
  // Conservative estimate: round UP to a cent per modeled fill, no rebates.
  return Math.max(0,Math.ceil((rate*quantity*price*(1-price)-1e-10)*100)/100);
}
export function fill(asks, quantity, feeRate) {
  if (!Number.isInteger(quantity)||quantity<1) return null;
  let left=quantity, principal=0, fees=0, worst=0;
  for(const [p,available] of levels(asks)) {
    const q=Math.min(left,available),f=fee(feeRate,p,q);if(f===null)return null;
    principal+=q*p;fees+=f;worst=p;left=round(left-q);if(left<=0)break;
  }
  if(left>0)return null;
  const slippage=quantity*.01;
  return {quantity,principal:round(principal),fees:round(fees),slippage:round(slippage),
    cost:round(principal+fees+slippage),average:round(principal/quantity),limitPrice:worst};
}
export function wilson(wins,n,z=2.576) {
  if(!n)return {lower:0,upper:1};
  const p=wins/n,zz=z*z,d=1+zz/n,c=(p+zz/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+zz/(4*n*n))/d;
  return {lower:Math.max(0,c-h),upper:Math.min(1,c+h)};
}
export function cohort(m, now) {
  const hours=(m.closeAt-now)/3600;
  const horizon=hours<=24?'6-24h':hours<=72?'1-3d':hours<=168?'3-7d':'7-30d';
  return `${m.venue}:${m.seriesId}:${horizon}`;
}
export function midpoint(m) {
  const bid=m.sides?.yes?.bid,ask=m.sides?.yes?.asks?.[0]?.[0];
  return finite(bid)&&finite(ask)&&bid>0&&ask<1&&ask>=bid?(bid+ask)/2:null;
}
export function forecast(m, observations, now) {
  const p=midpoint(m),key=cohort(m,now),bin=finite(p)?Math.min(9,Math.floor(p*10)):null;
  const unique=new Map();
  for(const o of observations||[])if(o.version===PREDICTION_VERSION&&o.cohort===key&&o.eventId!==m.eventId&&
    finite(o.resolvedAt)&&o.resolvedAt<=now&&o.resolvedAt>=o.at&&[0,1].includes(o.payout))unique.set(o.eventId,o);
  const history=[...unique.values()],rows=history.filter(o=>o.bin===bin),wins=rows.reduce((n,o)=>n+o.payout,0);
  const validation=history.filter(o=>finite(o.prediction)&&o.prediction>=0&&o.prediction<=1&&finite(o.baseline));
  const score=xs=>xs.length?xs.reduce((n,o)=>n+(o.prediction-o.payout)**2-(o.baseline-o.payout)**2,0)/xs.length:null;
  const brierDelta=score(validation),enough=history.length>=POLICY.minCohort&&rows.length>=POLICY.minBin;
  const bounds=wilson(wins,rows.length);
  // A full 10-point bin is heterogeneous. Apply an extra 10-point margin.
  const margin=.10;
  return {version:PREDICTION_VERSION,cohort:key,bin,baseline:p,samples:history.length,binSamples:rows.length,
    validation:validation.length,brierDelta,probability:enough?(wins+.5)/(rows.length+1):null,
    lower:enough?Math.max(0,bounds.lower-margin):null,upper:enough?Math.min(1,bounds.upper+margin):null,
    eligible:enough&&validation.length>=POLICY.minValidation&&brierDelta<-.002};
}
export function planBet(m, side, estimate, account, now) {
  const reasons=[],s=m?.sides?.[side];
  if(!s||!['yes','no'].includes(side))return {status:'held',reasons:['Choose an outcome.']};
  if(!quoteValid(m,now))reasons.push('Fresh executable book required (90-second limit).');
  if(!m.rules||!m.seriesId||!m.eventId)reasons.push('Contract rules and event identity required.');
  const hours=(m.closeAt-now)/3600;
  if(!finite(hours)||hours<POLICY.minHours||hours>POLICY.maxDays*24)reasons.push('Entry window is 6 hours to 30 days before scheduled close.');
  const ask=s.asks?.[0]?.[0],spread=finite(ask)&&finite(s.bid)?ask-s.bid:null;
  if(!finite(spread)||spread<0||spread>POLICY.maxSpread)reasons.push('Two-sided spread must be at most 5¢.');
  if(!finite(m.feeRate))reasons.push('Current fee parameters required.');
  if(!estimate?.eligible)reasons.push(`Collecting evidence: ${estimate?.samples||0}/100 cohort outcomes, ${estimate?.binSamples||0}/50 similar-price outcomes, ${estimate?.validation||0}/30 prior forecasts.`);
  const p=side==='yes'?estimate?.probability:finite(estimate?.probability)?1-estimate.probability:null;
  const lower=side==='yes'?estimate?.lower:finite(estimate?.upper)?1-estimate.upper:null;
  if(!finite(p)||!finite(lower))reasons.push('No supported probability estimate yet.');
  if(account.markComplete===false)reasons.push('An open position needs a fresh mark.');
  if(account.halted)reasons.push('Account drawdown stop reached.');
  if((account.positions||[]).some(x=>x.eventId===m.eventId))reasons.push('This event already has an open position.');
  const minQty=Math.max(1,Math.ceil(m.minQuantity||1)),one=fill(s.asks,minQty,m.feeRate);
  if(!one)reasons.push('Displayed depth cannot fill the minimum order.');
  const unit=one?one.cost/minQty:null;
  if(finite(lower)&&finite(unit)&&lower-unit<POLICY.minEdge)reasons.push('Conservative edge after costs is below 3¢ per contract.');
  const fullKelly=finite(lower)&&finite(unit)&&unit<1?Math.max(0,(lower-unit)/(1-unit)):0;
  const exposure=(account.positions||[]).reduce((n,x)=>n+x.cost,0);
  const budget=Math.max(0,Math.min(account.cash,account.equity*POLICY.maxStakePct,
    account.equity*POLICY.maxExposurePct-exposure,account.equity*POLICY.kellyFraction*fullKelly));
  let modeled=null;
  if(unit>0)for(let q=Math.min(200,Math.floor(s.bidSize||0),Math.floor(budget/Math.max(.001,ask)));q>=minQty;q--){
    const f=fill(s.asks,q,m.feeRate);if(f&&f.cost<=budget+1e-8&&finite(lower)&&lower-f.cost/q>=POLICY.minEdge){modeled=f;break;}
  }
  if(!modeled)reasons.push('No whole-contract stake fits the risk budget and two-sided depth.');
  return {status:reasons.length?'held':'candidate',side,reasons,probability:p,lower,breakEven:unit,
    edge:finite(lower)&&finite(unit)?round(lower-unit):null,budget:round(budget),fill:modeled};
}
export function newAccount(venue, now) {
  return {venue,mode:'paper',startedAt:now,initialCapital:100,cash:100,equity:100,peak:100,
    realizedPnl:0,fees:0,positions:[],trades:[],pending:{},halted:false,markComplete:true,updatedAt:now};
}
export function validateAccount(a, venue) {
  const fail=()=>{throw new Error(`Invalid ${venue} paper account; refusing to reset it.`);};
  if(a?.venue!==venue||a.mode!=='paper'||a.initialCapital!==100||!Array.isArray(a.positions)||!Array.isArray(a.trades)||
    !a.pending||typeof a.pending!=='object'||Array.isArray(a.pending)||typeof a.halted!=='boolean'||typeof a.markComplete!=='boolean')fail();
  for(const key of ['cash','equity','peak','fees','startedAt','updatedAt'])if(!finite(a[key])||a[key]<0)fail();
  if(!finite(a.realizedPnl)||a.peak<=0)fail();
  for(const p of Object.values(a.pending))if(!finite(p?.at)||p.at<=0)fail();
  const ids=new Set();
  for(const p of [...a.positions,...a.trades]){
    if(typeof p.id!=='string'||ids.has(p.id)||!p.marketId?.startsWith(venue+':')||!p.eventId||!['yes','no'].includes(p.side)||
      !Number.isInteger(p.quantity)||p.quantity<1)fail();ids.add(p.id);
    for(const key of ['cost','principal','fees','slippage','entry','openedAt','quoteAt','markAt','markValue','feeRate'])if(!finite(p[key])||p[key]<0)fail();
    if(p.markValue>p.quantity||p.feeRate>1||Math.abs(p.cost-p.principal-p.fees-p.slippage)>.0001)fail();
  }
  for(const t of a.trades)if(!finite(t.payout)||t.payout<0||t.payout>t.quantity||!finite(t.pnl)||
    !finite(t.closedAt)||t.closedAt<t.openedAt||Math.abs(t.pnl-t.payout+t.cost)>.0001)fail();
  const all=[...a.positions,...a.trades],costs=all.reduce((n,t)=>n+t.cost,0),payout=a.trades.reduce((n,t)=>n+t.payout,0);
  if(Math.abs(100-costs+payout-a.cash)>.0001||Math.abs(a.fees-all.reduce((n,t)=>n+t.fees,0))>.0001||
    Math.abs(a.realizedPnl-a.trades.reduce((n,t)=>n+t.pnl,0))>.0001||
    Math.abs(a.equity-a.cash-a.positions.reduce((n,p)=>n+p.markValue,0))>.0001)fail();
  return a;
}
export function advanceAccount(previous, markets, decisions, settlements, now) {
  const a=structuredClone(previous);validateAccount(a,a.venue);a.markComplete=true;
  a.positions=a.positions.filter(p=>{
    const resolved=settlements[p.marketId];
    if(!resolved||!finite(resolved.yesPayout)||resolved.yesPayout<0||resolved.yesPayout>1||!finite(resolved.observedAt)||resolved.observedAt>now||resolved.observedAt<p.openedAt)return true;
    const payout=round(p.quantity*(p.side==='yes'?resolved.yesPayout:1-resolved.yesPayout));
    const trade={...p,payout,pnl:round(payout-p.cost),closedAt:resolved.observedAt,resolutionSource:resolved.source};
    a.cash=round(a.cash+payout);a.realizedPnl=round(a.realizedPnl+trade.pnl);a.trades.push(trade);return false;
  });
  for(const p of a.positions){
    const m=markets.find(m=>m.id===p.marketId),bid=m?.sides?.[p.side]?.bid,bidSize=m?.sides?.[p.side]?.bidSize;
    if(m&&quoteValid(m,now)&&finite(bid)&&bid>=0&&finite(bidSize)&&bidSize>=p.quantity&&fee(m.feeRate,bid,p.quantity)!==null){
      p.markValue=round(Math.max(0,bid*p.quantity-fee(m.feeRate,bid,p.quantity)-p.quantity*.01));p.markAt=m.quoteAt;
    }else a.markComplete=false;
  }
  a.equity=round(a.cash+a.positions.reduce((n,p)=>n+(p.markValue||0),0));
  if(a.markComplete){a.peak=Math.max(a.peak,a.equity);if(a.equity<=a.peak*(1-POLICY.maxDrawdownPct))a.halted=true;}
  const pending={};
  const ranked=[...decisions].filter(d=>d.venue===a.venue).sort((x,y)=>(y.plan.edge??-9)-(x.plan.edge??-9));
  for(const d of ranked){
    const m=markets.find(m=>m.id===d.marketId);if(!m)continue;
    const plan=planBet(m,d.side,d.forecast,a,now),key=`${m.id}:${d.side}`;
    if(plan.status!=='candidate'||a.trades.some(t=>t.marketId===m.id))continue;
    const prior=a.pending[key];pending[key]={at:now};
    if(!prior||now-prior.at<60||now-prior.at>1800)continue;
    const f=plan.fill;if(!f||f.cost>a.cash)continue;
    a.cash=round(a.cash-f.cost);a.fees=round(a.fees+f.fees);
    const bid=m.sides[d.side].bid,markValue=round(Math.max(0,bid*f.quantity-fee(m.feeRate,bid,f.quantity)-f.quantity*.01));
    a.positions.push({id:`${key}:${now}`,marketId:m.id,eventId:m.eventId,question:m.question,side:d.side,
      quantity:f.quantity,cost:f.cost,principal:f.principal,fees:f.fees,slippage:f.slippage,entry:f.average,
      openedAt:now,quoteAt:m.quoteAt,closeAt:m.closeAt,markAt:m.quoteAt,markValue,forecast:d.forecast,
      feeRate:m.feeRate,version:PREDICTION_VERSION,url:m.url,intent:orderIntent(m,d.side,f),rules:m.rules});
    a.equity=round(a.cash+a.positions.reduce((n,p)=>n+p.markValue,0));delete pending[key];
  }
  a.pending=pending;a.updatedAt=now;return validateAccount(a,a.venue);
}
export function observe(markets, old, now) {
  const next=[...old],seen=new Set(old.filter(o=>o.version===PREDICTION_VERSION).map(o=>`${o.venue}:${o.eventId}`));
  for(const m of markets){
    const key=`${m.venue}:${m.eventId}`,p=midpoint(m),hours=(m.closeAt-now)/3600;
    if(seen.has(key)||!m.seriesId||!quoteValid(m,now)||!finite(p)||hours<POLICY.minHours||hours>POLICY.maxDays*24)continue;
    const f=forecast(m,old,now);seen.add(key);
    next.push({id:m.id,marketId:m.id,venue:m.venue,eventId:m.eventId,seriesId:m.seriesId,cohort:f.cohort,bin:f.bin,
      at:now,quoteAt:m.quoteAt,baseline:p,prediction:f.probability,trainingCount:f.binSamples,version:PREDICTION_VERSION,
      closeAt:m.closeAt,rules:m.rules,venueId:m.venueId,resolvedAt:null,payout:null});
  }
  return next;
}
export function orderIntent(m, side, modeled, mode='paper') {
  if(mode!=='paper')throw new Error('Real execution is locked. A separate authenticated server adapter and explicit activation are required.');
  if(!m||!['yes','no'].includes(side)||!modeled||!Number.isInteger(modeled.quantity)||modeled.quantity<1)throw new Error('Invalid paper order intent');
  return {mode:'paper',venue:m.venue,marketId:m.venueId,side,quantity:modeled.quantity,limitPrice:modeled.limitPrice,
    maxCash:modeled.cost,quoteAt:m.quoteAt,version:PREDICTION_VERSION};
}
