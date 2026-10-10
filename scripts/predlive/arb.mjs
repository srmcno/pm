// Pure, deterministic arbitrage detection for the private prediction worker.
// Every amount is an exact 18-place fixed-point integer (D/S from the Coinbase
// worker). No network access, clocks or randomness enter these functions.
import {createHash} from 'node:crypto';
import {D,S,mul} from '../live/risk.mjs';
import {matchingIdentity} from '../../dashboard/prediction-arbitrage.mjs';
import {effectiveKalshiFee} from '../../dashboard/prediction-venues.mjs';

export const ARB_VERSION='2026-10-10-locked-arbitrage-v1';
export const ONE=D('1'),CENT=D('0.01'),ZERO=0n;
// Books older than this (measured from the start of the retrieval request) are
// never traded. Venue book timestamps are not available on Kalshi.
export const MAX_BOOK_AGE_SECONDS=10;
// Cross-venue pairs trade only at this confidence. Identity-only matches (same
// teams and start, different rule text or settlement source) are refused.
export const MATCH_CONFIDENCE_ALLOWLIST=Object.freeze(['exact']);
// Fees in the venue's own rounding, plus a residual allowance for per-fill
// rounding. Kalshi aligns each fill to the member's balance grid and rebates
// accumulated rounding; Polymarket US banker's-rounds each fill but caps the
// order total at the banker's rounding of the cumulative exact fee. Rounding
// the cumulative exact fee UP to a cent bounds both; one additional cent per
// order covers any per-fill rounding residue the accumulator has not rebated.
export const ORDER_ROUNDING_ALLOWANCE=CENT;
const MAX_QUANTITY=5000n;
const SCALE=10n**18n;

const ceilCent=value=>{if(value<=0n)return 0n;return (value+CENT-1n)/CENT*CENT;};
const min=(...xs)=>xs.reduce((a,b)=>a<b?a:b);
export const hashText=text=>createHash('sha256').update(String(text??'')).digest('hex');

function decimal(value,label){
  if(typeof value==='bigint')return value;
  try{return D(typeof value==='number'?String(value):value);}catch{throw Error(`Invalid ${label}`);}
}
function price(value,label='price'){
  const p=decimal(value,label);
  if(p<=0n||p>=ONE)throw Error(`${label} must be strictly between 0 and 1`);
  return p;
}
// Whole contracts only. Fractional venue quantities are truncated, never rounded up.
function wholeQuantity(value){
  const q=decimal(value,'quantity');
  if(q<=0n)throw Error('Quantity must be positive');
  return q/SCALE;
}

/** Worst-case cash for buying `quantity` contracts with a limit of `limit`.
 * Cost per contract p + r·p(1-p) increases with p for any r<1, so filling every
 * contract at the limit is the maximum. */
export function legCostBound(quantity,limit,rate){
  const q=BigInt(quantity),p=price(limit,'limit'),r=decimal(rate,'fee rate');
  if(q<=0n)throw Error('Quantity must be positive');
  if(r<0n||r>=ONE)throw Error('Fee rate must be in [0,1)');
  const principal=q*p;
  const fee=(q*mul(mul(r,p),ONE-p));
  // +0.0001 covers per-fill ceil to $0.000001 on up to 100 fills.
  return ceilCent(principal+fee+(fee>0n?D('0.0001'):0n))+ORDER_ROUNDING_ALLOWANCE;
}
/** Venue fee only (for display and tests): cumulative exact fee rounded up to a cent. */
export function feeBound(quantity,limit,rate){
  const q=BigInt(quantity),p=price(limit,'limit'),r=decimal(rate,'fee rate');
  return ceilCent(q*mul(mul(r,p),ONE-p));
}

/** Levels: [[price,size]] (strings or numbers), any order. Returns ascending asks. */
export function normalizeAsks(levels){
  if(!Array.isArray(levels))return [];
  const out=[];
  for(const row of levels){
    const p=Array.isArray(row)?row[0]:row?.price,s=Array.isArray(row)?row[1]:row?.size;
    let pp,qq;try{pp=price(p);qq=wholeQuantity(s);}catch{continue;}
    if(qq>0n)out.push([pp,qq]);
  }
  out.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  return out;
}
/** Price needed to buy q contracts from ascending asks, or null if depth is short. */
export function limitFor(asks,quantity){
  let left=BigInt(quantity);
  for(const [p,size] of asks){left-=size;if(left<=0n)return p;}
  return null;
}
export function depth(asks){return asks.reduce((n,[,size])=>n+size,0n);}

export function bookFresh(book,now,maxAge=MAX_BOOK_AGE_SECONDS){
  return Number.isFinite(now)&&Number.isFinite(book?.requestAt)&&Number.isFinite(book?.receivedAt)&&
    book.requestAt<=book.receivedAt&&book.receivedAt<=now+1&&now-book.requestAt>=0&&now-book.requestAt<maxAge;
}

// Sports contracts are excluded by default (Oklahoma AG dispute, docs/FUNDING.md).
const SPORT_SERIES=/^KX(?:NFL|MLB|NBA|NHL|NCAA|NCAAF|NCAAB|WNBA|MLS|EPL|UFC|PGA|ATP|WTA|F1|NASCAR|SOCCER|TENNIS|GOLF|BOXING|MMA|CFB|CBB|LALIGA|SERIEA|BUNDESLIGA|UCL|EUROLEAGUE|IPL|CRICKET)/i;
export function isSports(book){
  if(book?.sports===true)return true;
  const category=String(book?.category??'').toLowerCase();
  if(/sport/.test(category))return true;
  return SPORT_SERIES.test(String(book?.seriesTicker??''))||SPORT_SERIES.test(String(book?.ticker??''));
}

/** Kalshi public market + orderbook_fp to an exact book. YES asks are the
 * complement of NO bids; NO asks are the complement of YES bids. */
export function kalshiBook({market,event,series,feeChanges,orderbook,requestAt,receivedAt}){
  const m=market??{},ob=orderbook?.orderbook_fp??orderbook??{};
  const bids=rows=>normalizeAsks(rows).sort((a,b)=>a[0]>b[0]?-1:a[0]<b[0]?1:0);
  const yesBids=bids(ob.yes_dollars),noBids=bids(ob.no_dollars);
  const flip=rows=>rows.map(([p,q])=>[ONE-p,q]).filter(([p])=>p>0n&&p<ONE).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  let rate=null;
  try{const r=series?effectiveKalshiFee(series,feeChanges,receivedAt):null;rate=Number.isFinite(r)&&r>=0&&r<1?S(D(r.toFixed(6))):null;}catch{rate=null;}
  let notional=null;try{notional=D(String(m.notional_value_dollars??''));}catch{}
  const close=Date.parse(m.close_time)/1000,expected=Date.parse(m.expected_expiration_time)/1000;
  return {venue:'kalshi',ticker:m.ticker,eventTicker:m.event_ticker??event?.event_ticker??null,seriesTicker:event?.series_ticker??series?.ticker??null,
    category:event?.category??null,title:[m.title,m.yes_sub_title].filter(Boolean).join(' · '),
    status:m.status==='active'&&m.market_type==='binary'&&notional===ONE?'open':'closed',
    rules:[m.rules_primary,m.rules_secondary].filter(Boolean).join('\n'),ruleHash:hashText([m.rules_primary,m.rules_secondary].filter(Boolean).join('\n')),
    closeAt:Number.isFinite(close)?close:null,expectedAt:Number.isFinite(expected)?expected:null,
    settlementSources:Array.isArray(event?.settlement_sources)?event.settlement_sources.map(s=>String(s?.url??s?.name??s)).sort():null,
    feeRate:rate,requestAt,receivedAt,
    asks:{yes:flip(noBids),no:flip(yesBids)},bids:{yes:yesBids,no:noBids}};
}
/** Polymarket US public market + book (YES instrument only). */
export function polymarketBook({market,event,book,requestAt,receivedAt}){
  const m=market??{},b=book?.marketData??{};
  const rows=list=>(list||[]).map(l=>[l?.px?.value,l?.qty]);
  const yesAsks=normalizeAsks(rows(b.offers)),yesBids=normalizeAsks(rows(b.bids)).sort((x,y)=>x[0]>y[0]?-1:x[0]<y[0]?1:0);
  const flip=list=>list.map(([p,q])=>[ONE-p,q]).filter(([p])=>p>0n&&p<ONE).sort((x,y)=>x[0]<y[0]?-1:x[0]>y[0]?1:0);
  let rate=null;try{const r=D(String(m.feeCoefficient));rate=r>=0n&&r<ONE?S(r):null;}catch{}
  const close=Date.parse(m.endDate)/1000;
  const sports=!!(m.sportsMarketTypeV2||m.marketSides?.some?.(s=>s?.team?.league));
  return {venue:'polymarket',ticker:m.slug,eventTicker:event?.id?`pm:${event.id}`:null,seriesTicker:event?.series?.[0]?.id??null,
    category:m.category??event?.category??null,sports,title:m.question??m.title??'',
    status:m.closed===false&&m.status==='MARKET_STATUS_OPEN'&&b.state==='MARKET_STATE_OPEN'?'open':'closed',
    rules:m.description??'',ruleHash:hashText(m.description??''),closeAt:Number.isFinite(close)?close:null,expectedAt:null,
    settlementSources:null,feeRate:rate,requestAt,receivedAt,
    asks:{yes:yesAsks,no:flip(yesBids)},bids:{yes:yesBids,no:flip(yesAsks)}};
}
/** Paper-collector normalized market (floats) to an exact book. */
export function fromPaperMarket(m){
  const asks=side=>normalizeAsks((m?.sides?.[side]?.asks||[]).map(([p,q])=>[String(p),String(q)]));
  let rate=null;try{rate=Number.isFinite(m?.feeRate)&&m.feeRate>=0&&m.feeRate<1?S(D(m.feeRate.toFixed(6))):null;}catch{}
  return {venue:m?.venue,ticker:m?.venueId,eventTicker:m?.eventId??null,seriesTicker:m?.seriesId??null,category:m?.category??null,
    sports:!!m?.identity,title:m?.question??'',status:m?.status,rules:m?.rules??'',ruleHash:m?.ruleHash??hashText(m?.rules),
    closeAt:m?.expiryAt??null,expectedAt:null,settlementSources:m?.settlementSources??null,feeRate:rate,
    requestAt:m?.requestStartedAt??m?.observedAt,receivedAt:m?.observedAt,identity:m?.identity??null,
    asks:{yes:asks('yes'),no:asks('no')}};
}

/** Evaluate an all-buy package whose legs together pay exactly $1 per set in
 * every outcome. Returns the best whole-contract size and its net edge. */
export function evaluatePackage(legs,{now,margin='0.01',maxTradeUsd='5',cash={},maxQuantity=MAX_QUANTITY}={}){
  const reasons=[],m=decimal(margin,'margin'),cap=decimal(maxTradeUsd,'trade cap');
  if(m<CENT)throw Error('Safety margin must be at least one cent per contract');
  if(!Array.isArray(legs)||legs.length<2||legs.length>40)return {ok:false,reasons:['A package needs 2 to 40 legs']};
  for(const leg of legs){
    if(!['yes','no'].includes(leg.outcome))return {ok:false,reasons:['Invalid outcome']};
    if(leg.book?.status!=='open')reasons.push('Every contract must be open');
    if(leg.book?.feeRate===null||leg.book?.feeRate===undefined)reasons.push('Current venue fee parameters are required');
    if(!bookFresh(leg.book,now))reasons.push(`Every book must be retrieved less than ${MAX_BOOK_AGE_SECONDS} seconds ago`);
  }
  const asks=legs.map(leg=>leg.book?.asks?.[leg.outcome]??[]);
  if(asks.some(a=>!a.length))return {ok:false,reasons:[...new Set([...reasons,'Every leg needs displayed asks'])]};
  const upper=min(maxQuantity,...asks.map(depth));
  // best: affordable within the trade cap and venue cash; open: ignoring both,
  // reported so the owner can see the size of gaps the limits prevented.
  let best=null,open=null;
  for(let q=1n;q<=upper;q++){
    let total=0n,marginal=ONE-m,feasible=true;const legCosts=[],venueCost={};
    for(let i=0;i<legs.length;i++){
      const limit=limitFor(asks[i],q);if(limit===null){feasible=false;break;}
      let cost,rate;try{rate=decimal(legs[i].book.feeRate,'fee rate');cost=legCostBound(q,limit,rate);}catch{feasible=false;break;}
      legCosts.push({limit,cost});total+=cost;venueCost[legs[i].book.venue]=(venueCost[legs[i].book.venue]??0n)+cost;
      marginal-=limit+mul(mul(rate,limit),ONE-limit);
    }
    if(!feasible)break;
    const gross=q*ONE-total,net=gross-q*m;
    if(!open||net*(open.quantity)>open.net*q)open={quantity:q,net,gross,total};
    const affordable=total<=cap&&Object.entries(venueCost).every(([venue,c])=>cash[venue]===undefined||c<=decimal(cash[venue],'cash'));
    if(net>0n&&affordable&&(!best||net>best.net))best={quantity:q,net,gross,total,legCosts};
    // Limits never fall as size grows. Once one more contract cannot add value,
    // or the cash bound is exceeded, larger sizes cannot qualify.
    if(marginal<=0n||total>cap)break;
  }
  if(!open)return {ok:false,reasons:[...new Set([...reasons,'No package fits displayed depth'])]};
  const summary={bestNetEdgePerContract:S(open.net/open.quantity),bestNetEdgeQuantity:open.quantity.toString(),bestNetEdge:S(open.net)};
  if(open.net<=0n)reasons.push('Net edge after fees and safety margin is not positive');
  else if(!best)reasons.push('No size fits the trade cap, venue cash and displayed depth');
  if(!best||reasons.length)return {ok:false,reasons:[...new Set(reasons)],...summary};
  const quantity=best.quantity;
  return {ok:true,reasons:[],...summary,quantity:quantity.toString(),costBound:S(best.total),netEdge:S(best.net),grossEdge:S(best.gross),
    netEdgePerContract:S(best.net/quantity),
    legs:legs.map((leg,i)=>({venue:leg.book.venue,ticker:leg.book.ticker,outcome:leg.outcome,quantity:quantity.toString(),limit:S(best.legCosts[i].limit),
      costBound:S(best.legCosts[i].cost),depthAtLimit:asks[i].filter(([p])=>p<=best.legCosts[i].limit).reduce((n,[,s])=>n+s,0n).toString(),feeRate:leg.book.feeRate}))};
}

function opportunity(type,legs,eligibility,options,locked){
  const evaluation=evaluatePackage(legs,options);
  const sports=legs.some(l=>isSports(l.book));
  const reasons=[...eligibility];
  if(sports&&options?.allowSports!==true)reasons.push('Sports contracts are excluded (PM_ALLOW_SPORTS=false)');
  const executable=evaluation.ok&&reasons.length===0;
  const key=legs.map(l=>`${l.book.venue}:${l.book.ticker}:${l.outcome}`).join('|');
  return {version:ARB_VERSION,type,id:hashText(`${type}|${key}`).slice(0,24),key,sports,
    venues:[...new Set(legs.map(l=>l.book.venue))],observedAt:Math.min(...legs.map(l=>l.book.requestAt)),
    // locked: every outcome pays exactly $1 per set. Only locked packages with
    // a positive net edge are arbitrage; others are reported, never counted.
    locked:locked===true,rawPositive:evaluation.ok||(evaluation.bestNetEdge!==undefined&&D(evaluation.bestNetEdge)>0n),
    positive:locked===true&&(evaluation.ok||(evaluation.bestNetEdge!==undefined&&D(evaluation.bestNetEdge)>0n)),
    executable,reasons:[...new Set([...reasons,...evaluation.reasons])],evaluation,
    legs:legs.map(l=>({venue:l.book.venue,ticker:l.book.ticker,outcome:l.outcome,eventTicker:l.book.eventTicker??null}))};
}

/** (a) Single-venue complement: buy YES and NO of one binary market. On a
 * single unified book this only appears when the book is crossed. */
export function complementOpportunity(book,options={}){
  const legs=[{book,outcome:'yes'},{book,outcome:'no'}];
  const scarcity=legs.map(l=>depth(l.book.asks?.[l.outcome]??[]));
  return opportunity('complement',scarcity[1]<scarcity[0]?legs.reverse():legs,[],options,true);
}

/** Match classification. 'exact' needs the existing identity matcher plus
 * identical contractual close times and identical non-empty settlement sources. */
export function classifyMatch(a,b){
  if(!matchingIdentity(a?.identity,b?.identity)||a.venue===b.venue)return 'none';
  const sources=x=>Array.isArray(x?.settlementSources)&&x.settlementSources.length?JSON.stringify([...x.settlementSources].sort()):null;
  const sameClose=Number.isFinite(a.closeAt)&&a.closeAt===b.closeAt;
  const sameSource=sources(a)!==null&&sources(a)===sources(b);
  return sameClose&&sameSource?'exact':'identity-only';
}
/** (b) Cross-venue: YES on one venue, NO on the other, same matched event. */
export function crossVenueOpportunities(a,b,options={}){
  const confidence=classifyMatch(a,b);
  if(confidence==='none')return [];
  const eligibility=[];
  if(!MATCH_CONFIDENCE_ALLOWLIST.includes(confidence))eligibility.push(`Match confidence '${confidence}' is not allowlisted: resolution sources or close times are not proven identical`);
  if(a.closeAt!==b.closeAt)eligibility.push('Contract close times differ');
  const same=a.identity.yesId===b.identity.yesId;
  const orientations=same?[['yes','no'],['no','yes']]:[['yes','yes'],['no','no']];
  return orientations.map(([sa,sb])=>{
    let legs=[{book:a,outcome:sa},{book:b,outcome:sb}];
    if(depth(b.asks?.[sb]??[])<depth(a.asks?.[sa]??[]))legs=legs.reverse();
    const result=opportunity('cross-venue',legs,eligibility,options,confidence==='exact');result.matchConfidence=confidence;return result;
  });
}
/** (c) Mutually exclusive event on one venue: buy YES on every outcome. The
 * venue only promises at most one YES; exactly one requires an explicitly
 * reviewed exhaustive series (an 'Other'/catch-all outcome in every event). */
export function multiOutcomeOpportunity(event,books,options={}){
  const eligibility=[];
  if(event?.mutually_exclusive!==true)return null;
  const tickers=(event.markets||[]).map(m=>m.ticker);
  if(tickers.length<2||tickers.length>40)return null;
  const byTicker=new Map(books.map(b=>[b.ticker,b]));
  if(tickers.some(t=>!byTicker.has(t)))eligibility.push('Every market in the event must have a fresh book');
  if(event.collateral_return_type!=='MECNET')eligibility.push('The venue does not mark the event as mutually exclusive (MECNET)');
  const exhaustive=Array.isArray(options.exhaustiveSeries)&&options.exhaustiveSeries.includes(event.series_ticker);
  if(!exhaustive)eligibility.push('Exhaustiveness is unverified: the venue guarantees at most one YES, not exactly one');
  const present=tickers.filter(t=>byTicker.has(t)).map(t=>byTicker.get(t));
  const closes=new Set(present.map(b=>b.closeAt));
  if(closes.size>1)eligibility.push('Outcome markets have different close times');
  if(present.length<2)return null;
  const legs=present.map(book=>({book,outcome:'yes'})).sort((x,y)=>{const a=depth(x.book.asks.yes),b=depth(y.book.asks.yes);return a<b?-1:a>b?1:0;});
  const result=opportunity('multi-outcome',legs,eligibility,options,exhaustive&&event.collateral_return_type==='MECNET'&&tickers.every(t=>byTicker.has(t)));result.eventTicker=event.event_ticker;result.seriesTicker=event.series_ticker;return result;
}
