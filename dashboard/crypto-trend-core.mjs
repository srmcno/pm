// Public paper mirror of the daily BTC/ETH trend rules that the private
// Coinbase worker runs. Deterministic and unauthenticated: it never submits an
// order, never reads private balances or fills, and never shares a ledger with
// the eleven-account tournament. Real-money worker results are not published.
import {TREND_POLICY,trendSignal,normalizeDaily} from './trend-core.mjs';
import {FEE_PROFILE,POLICY,usableBook,walkBook} from './crypto-strategies-core.mjs';

export const TREND_BOOK_VERSION='2026-09-29-trend-paper-v1';
export const TREND_BOOK=Object.freeze({
  version:TREND_BOOK_VERSION,kind:'crypto-trend-paper-mirror',policyId:TREND_POLICY.id,
  initialCapital:1000,
  // Mirrors the worker's ~49% of equity per product while long.
  allocation:.49,
  // Entry: resting limit at the observed best bid, assumed to fill as maker.
  // Exit: taker, walking the observed bids plus the tournament slippage reserve.
  makerRate:FEE_PROFILE.makerRate,takerRate:FEE_PROFILE.takerRate,slippageRate:POLICY.slippageRate,
  // Native crash stop: triggered at 80% of the entry signal close, modeled as
  // filled no better than 95% of the trigger (the live bracket's limit haircut).
  stopFillFraction:.95,
  quantityIncrement:1e-8,minNotional:10,maxQuoteAge:POLICY.maxQuoteAge,
  benchmarkProduct:'BTC-USD',
  curveSpacing:3600,curveLimit:2160,dailyLimit:1100,cycleLimit:288,
});

const DAY=86400,B=TREND_BOOK,finite=Number.isFinite;
const round=n=>Math.round((n+Number.EPSILON)*1e6)/1e6;
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<.0001;
const sum=(xs,k)=>xs.reduce((n,x)=>n+(x?.[k]||0),0);
const floorQuantity=q=>Math.floor(q/B.quantityIncrement+1e-9)*B.quantityIncrement;
const fixQuantity=q=>Number(q.toFixed(8));

function feeProfile(){
  return {id:FEE_PROFILE.id,makerRate:B.makerRate,takerRate:B.takerRate,slippageRate:B.slippageRate,accountVerified:false,
    entry:'Maker limit at the observed best bid, assumed filled',exit:'Taker: observed bids walked, plus 0.10% slippage reserve'};
}

export function initialTrendBook(now){
  if(!finite(now)||now<=0)throw Error('Invalid evaluation time');
  return {schemaVersion:1,kind:B.kind,version:B.version,policyId:TREND_POLICY.id,mode:'paper',realEnabled:false,
    startedAt:now,updatedAt:0,initialCapital:B.initialCapital,feeProfile:feeProfile(),
    account:{cash:B.initialCapital,equity:B.initialCapital,peak:B.initialCapital,maxDrawdown:0,realizedPnl:0,fees:0,markComplete:true,positions:[],trades:[]},
    benchmark:null,signals:[],decisions:[],sources:{},errors:[],curve:[],daily:[],cycles:[]};
}

function marketFor(product,input,now){
  const m={product,status:'online',tradingDisabled:false,book:input?.book||null};
  return m.book&&usableBook(m,now)?m:null;
}
const bestBid=m=>Math.max(...m.book.bids.map(r=>Number(r[0])).filter(p=>p>0));
const bestAsk=m=>Math.min(...m.book.asks.map(r=>Number(r[0])).filter(p=>p>0));

function makerBuy(m,budget){
  const bid=bestBid(m);if(!(bid>0)||!(budget>0))return null;
  let quantity=fixQuantity(floorQuantity(budget/(bid*(1+B.makerRate))));
  const fill=q=>{const principal=round(q*bid),fees=round(principal*B.makerRate);return {quantity:q,price:bid,principal,fees,slippage:0,feeRate:B.makerRate,liquidity:'maker',value:round(principal+fees)};};
  let f=fill(quantity);
  while(quantity>0&&f.value>budget){quantity=fixQuantity(quantity-B.quantityIncrement);f=fill(quantity);}
  return quantity>0&&f.principal>=B.minNotional?f:null;
}
function takerSell(m,quantity){
  const f=m?walkBook(m,'sell',quantity):null;
  return f?{...f,liquidity:'taker'}:null;
}
function modeledSell(quantity,price){
  const principal=round(quantity*price),fees=round(principal*B.takerRate),slippage=round(principal*B.slippageRate);
  return {quantity,principal,fees,slippage,feeRate:B.takerRate,slippageRate:B.slippageRate,value:round(principal-fees-slippage),price,liquidity:'taker'};
}

// Native bracket evidence, conservatively asymmetric. Adverse lows count from
// the UTC day of entry; favourable highs only from bars that began after the
// entry. A stop always wins when both appear. Evidence comes only from data
// fetched in this cycle, never from a retained failed read.
function bracketEvidence(p,bars,bid){
  const entryDay=Math.floor(p.openedAt/DAY)*DAY;
  const stopBar=bars.find(b=>b.time>=entryDay&&b.low<=p.stop),bookStop=finite(bid)&&bid<=p.stop;
  if(bookStop||stopBar)return {kind:'stop',source:bookStop?'order book':'daily low',barTime:bookStop?null:stopBar.time,observed:bookStop?bid:stopBar.low};
  const targetBar=bars.find(b=>b.time>=p.openedAt&&b.high>=p.target),bookTarget=finite(bid)&&bid>=p.target;
  if(bookTarget||targetBar)return {kind:'target',source:bookTarget?'order book':'daily high',barTime:bookTarget?null:targetBar.time,observed:bookTarget?bid:targetBar.high};
  return null;
}

function sourceRecord(prior,input,market,now){
  const candles=input?.candles&&!input.candlesError
    ?{status:'ok',fetchedAt:input.candlesReceivedAt??null,requestedAt:input.candlesRequestedAt??null,error:null}
    :{...(prior?.candles||{fetchedAt:null,requestedAt:null}),status:'error',error:input?.candlesError||'Daily candles not collected this cycle'};
  let book;
  if(market){
    const bid=bestBid(market),ask=bestAsk(market);
    book={status:'ok',requestAt:market.book.requestAt,receivedAt:market.book.receivedAt,bestBid:bid,bestAsk:ask,spreadBps:round((ask/bid-1)*10000),error:null};
  }else book={...(prior?.book||{requestAt:null,receivedAt:null,bestBid:null,bestAsk:null,spreadBps:null}),status:'error',
    error:input?.bookError||(input?.book?'Order book is stale, crossed or too wide to use':'Order book not collected this cycle')};
  return {candles,book,checkedAt:now};
}

// previous: the last valid book (or null to start a new one prospectively).
// inputs: {[product]:{candles,candlesRequestedAt,candlesReceivedAt,candlesError,book,bookError}}.
// now: evaluation time, captured after collection.
export function advanceTrendBook(previous,inputs={},now){
  if(!finite(now)||now<=0)throw Error('Invalid evaluation time');
  const s=previous?validateTrendBook(structuredClone(previous)):initialTrendBook(now);
  if(now<=s.updatedAt)return s;
  const a=s.account,errors=[],decisions=[],opened=[],closed=[],priorSignals=new Map((s.signals||[]).map(x=>[x.product,x]));
  const markets={},signals={},bars={};
  for(const product of TREND_POLICY.products){
    const input=inputs?.[product]||{};
    const market=marketFor(product,input,now);markets[product]=market;
    s.sources[product]=sourceRecord(s.sources[product],input,market,now);
    if(input.candlesError||!input.candles)errors.push({product,stage:'candles',message:input.candlesError||'Daily candles not collected this cycle',at:now});
    if(!market)errors.push({product,stage:'book',message:s.sources[product].book.error,at:now});
    try{bars[product]=input.candles&&!input.candlesError?normalizeDaily(input.candles):[];}catch{bars[product]=[];}
    const held=a.positions.some(p=>p.product===product);
    const signal=input.candles&&!input.candlesError?trendSignal({product,candles:input.candles,held,now,fetchedAt:input.candlesReceivedAt??null}):null;
    if(signal?.status==='ready')signals[product]={...signal,evaluatedAt:now,retained:false,error:null};
    else{
      const reason=signal?.reason||input.candlesError||'Daily candles not collected this cycle';
      if(signal)errors.push({product,stage:'signal',message:reason,at:now});
      const prior=priorSignals.get(product);
      // Keep the newer good reading with its original times; never act on it.
      signals[product]=prior?{...prior,retained:true,error:reason,checkedAt:now}:{product,policyId:TREND_POLICY.id,status:'unavailable',state:'unknown',action:'wait',held,fetchedAt:input.candlesReceivedAt??null,evaluatedAt:now,retained:false,error:reason,reason};
    }
  }
  const actionable=product=>{const x=signals[product];return x.status==='ready'&&!x.retained&&x.evaluatedAt===now;};

  // Exits and marks.
  a.markComplete=true;
  for(const p of [...a.positions]){
    const m=markets[p.product],sig=signals[p.product],bid=m?bestBid(m):null;
    const evidence=bracketEvidence(p,bars[p.product]||[],bid);
    let fill=null,reason=null;
    if(evidence?.kind==='stop'){
      // A native stop rests at the exchange even while software is down, so it
      // needs no fresh book here. A worse observed book is used when present.
      fill=modeledSell(p.quantity,p.stop*B.stopFillFraction);const walked=takerSell(m,p.quantity);
      if(walked&&walked.price<fill.price)fill=walked;
      reason='Modeled native stop: 80% of the entry signal close, filled at no better than 95% of the trigger';
    }else if(evidence?.kind==='target'){
      fill=modeledSell(p.quantity,p.target);reason='Modeled take-profit: 160% of the entry signal close, charged as taker';
    }else if(actionable(p.product)&&sig.action==='exit'){
      fill=takerSell(m,p.quantity);reason='Trend exit: completed daily close fell below the 100-day average less 2%';
      if(!fill)decisions.push({product:p.product,action:'exit',status:'blocked',reason:'Exit signal, but no usable public order book this cycle; retrying next cycle'});
    }
    if(fill){
      const trade={...p,closedAt:now,exitPrice:fill.price,exitPrincipal:fill.principal,exitFees:fill.fees,exitSlippage:fill.slippage,exitFeeRate:fill.feeRate,exitLiquidity:fill.liquidity,
        proceeds:fill.value,pnl:round(fill.value-p.cost),exitReason:reason,exitEvidence:evidence?{...evidence,detectedAt:now}:{kind:'trend',source:'completed daily close',barTime:sig.barTime,observed:sig.close,detectedAt:now},
        exitSignalId:sig?.signalId??null,exitFeeProfile:FEE_PROFILE.id};
      delete trade.markValue;delete trade.markAt;delete trade.markComplete;
      a.positions=a.positions.filter(x=>x.id!==p.id);a.trades.push(trade);a.cash=round(a.cash+trade.proceeds);closed.push(trade.id);
      decisions.push({product:p.product,action:evidence?evidence.kind:'exit',status:'exited',reason});continue;
    }
    const mark=takerSell(m,p.quantity);
    if(mark){p.markValue=mark.value;p.markAt=m.book.receivedAt;p.markComplete=true;}
    else{p.markComplete=false;a.markComplete=false;}
    if(!decisions.some(d=>d.product===p.product))decisions.push({product:p.product,action:sig.action,status:'holding',
      reason:!actionable(p.product)?`Holding; signal not refreshed: ${sig.error||'unavailable'}`:mark?'Holding while the close stays above the 100-day average less 2%':'Holding; liquidation mark unavailable this cycle'});
  }
  a.equity=round(a.cash+sum(a.positions,'markValue'));

  // Entries: one per product per completed daily bar, never on a bar that
  // closed before this product's latest exit, and never on a retained signal.
  const sizingEquity=a.equity;
  for(const product of TREND_POLICY.products){
    if(a.positions.some(p=>p.product===product)||decisions.some(d=>d.product===product&&d.status==='exited'))continue;
    const sig=signals[product],m=markets[product];
    const hold=reason=>decisions.push({product,action:sig.action,status:sig.action==='enter'?'blocked':'waiting',reason});
    if(!actionable(product)){hold(`Signal unavailable: ${sig.error||sig.reason}`);continue;}
    if(sig.action!=='enter'){hold(sig.reason);continue;}
    const lastExit=a.trades.filter(t=>t.product===product).reduce((n,t)=>Math.max(n,t.closedAt),0);
    if(a.trades.some(t=>t.signalId===sig.signalId)||sig.barClosedAt<=lastExit){hold('Entry signal already used, or no new completed daily bar since the last exit');continue;}
    if(!a.markComplete){hold('An open position lacks a fresh mark; entries wait');continue;}
    if(!m){hold('Entry signal, but no usable public order book this cycle');continue;}
    const fill=makerBuy(m,Math.min(sizingEquity*B.allocation,a.cash)),mark=fill?takerSell(m,fill.quantity):null;
    if(!fill||!mark||fill.value>a.cash+1e-9){hold('Entry size below minimum, insufficient cash or insufficient visible depth');continue;}
    const position={id:`${sig.signalId}:entry`,version:B.version,policyId:TREND_POLICY.id,product,side:'long',quantity:fill.quantity,
      principal:fill.principal,entryFees:fill.fees,entrySlippage:0,entryFeeRate:fill.feeRate,entryLiquidity:'maker',feeProfile:FEE_PROFILE.id,
      cost:fill.value,entryPrice:fill.price,openedAt:now,quoteAt:m.book.receivedAt,signalId:sig.signalId,signalBarTime:sig.barTime,signalClose:sig.close,
      signalSma:sig.sma,stop:round(sig.stop),target:round(sig.target),markValue:mark.value,markAt:m.book.receivedAt,markComplete:true,
      entryReasons:[sig.reason,'Paper assumes a resting buy at the observed best bid fills as maker; a real resting order may fill later, at another price, or not at all.']};
    a.positions.push(position);a.cash=round(a.cash-fill.value);opened.push(position.id);
    decisions.push({product,action:'enter',status:'entered',reason:sig.reason});
  }
  a.equity=round(a.cash+sum(a.positions,'markValue'));
  if(a.markComplete){a.peak=Math.max(a.peak,a.equity);a.maxDrawdown=Math.min(a.maxDrawdown,round(a.equity/a.peak-1));}
  a.realizedPnl=round(sum(a.trades,'pnl'));
  a.fees=round(sum([...a.positions,...a.trades],'entryFees')+sum(a.trades,'exitFees'));

  // Prospective BTC buy-and-hold with the same entry and liquidation costs.
  const btc=markets[B.benchmarkProduct];
  if(!s.benchmark&&btc){
    const fill=makerBuy(btc,B.initialCapital),mark=fill?takerSell(btc,fill.quantity):null;
    if(fill&&mark)s.benchmark={product:B.benchmarkProduct,startedAt:now,initialCapital:B.initialCapital,quantity:fill.quantity,entryPrice:fill.price,principal:fill.principal,
      entryFees:fill.fees,cost:fill.value,cash:round(B.initialCapital-fill.value),equity:round(B.initialCapital-fill.value+mark.value),markAt:btc.book.receivedAt,
      markComplete:true,peak:B.initialCapital,maxDrawdown:0,feeProfile:FEE_PROFILE.id,entryLiquidity:'maker',exitLiquidity:'taker'};
  }
  if(s.benchmark){
    const b=s.benchmark,mark=takerSell(btc,b.quantity);b.markComplete=!!mark;
    if(mark){b.equity=round(b.cash+mark.value);b.markAt=btc.book.receivedAt;b.peak=Math.max(b.peak,b.equity);b.maxDrawdown=Math.min(b.maxDrawdown,round(b.equity/b.peak-1));}
  }

  s.signals=TREND_POLICY.products.map(p=>signals[p]);s.decisions=decisions;s.errors=errors;s.feeProfile=feeProfile();s.updatedAt=now;
  const point={at:now,equity:a.equity,benchmark:s.benchmark?.equity??null,complete:a.markComplete};
  if(!s.curve.length||now-s.curve.at(-1).at>=B.curveSpacing)s.curve=[...s.curve,point].slice(-B.curveLimit);
  const day=new Date(now*1000).toISOString().slice(0,10);
  s.daily=[...(s.daily.at(-1)?.day===day?s.daily.slice(0,-1):s.daily),{day,...point}].slice(-B.dailyLimit);
  s.cycles=[...s.cycles,{at:now,opened,closed,errors:errors.length,equity:a.equity,benchmark:s.benchmark?.equity??null}].slice(-B.cycleLimit);
  return validateTrendBook(s);
}

export function validateTrendBook(s){
  const fail=reason=>{throw Error(`Invalid trend paper book (${reason}); refusing to reset`);};
  if(!s||s.schemaVersion!==1||s.kind!==B.kind||s.version!==B.version||s.mode!=='paper'||s.realEnabled!==false)fail('identity');
  if(s.policyId!==TREND_POLICY.id)fail('policy version changed; add an explicit migration');
  if(!finite(s.startedAt)||s.startedAt<=0||!finite(s.updatedAt)||(s.updatedAt&&s.updatedAt<s.startedAt))fail('times');
  if(s.initialCapital!==B.initialCapital)fail('capital');
  const a=s.account;
  if(!a||!Array.isArray(a.positions)||!Array.isArray(a.trades)||typeof a.markComplete!=='boolean')fail('ledger');
  for(const k of ['cash','equity','peak','fees'])if(!finite(a[k])||a[k]<0)fail(k);
  if(!finite(a.realizedPnl)||!finite(a.maxDrawdown)||a.maxDrawdown>0)fail('performance');
  const ids=new Set(),held=new Set();
  for(const p of [...a.positions,...a.trades]){
    if(typeof p.id!=='string'||ids.has(p.id)||!TREND_POLICY.products.includes(p.product)||p.side!=='long'||!finite(p.quantity)||p.quantity<=0)fail('position identity');
    ids.add(p.id);
    for(const k of ['principal','entryFees','entrySlippage','cost','entryPrice','stop','target','openedAt'])if(!finite(p[k])||p[k]<0)fail('position values');
    if(!near(p.cost,p.principal+p.entryFees+p.entrySlippage))fail('position cost');
  }
  for(const p of a.positions){if(held.has(p.product))fail('duplicate open product');held.add(p.product);if(!finite(p.markValue)||p.markValue<0||!finite(p.markAt))fail('mark');}
  for(const t of a.trades)if(!finite(t.closedAt)||t.closedAt<t.openedAt||!finite(t.exitFees)||!finite(t.exitSlippage)||!finite(t.proceeds)||t.proceeds<0||!near(t.pnl,t.proceeds-t.cost))fail('trade');
  const all=[...a.positions,...a.trades];
  if(!near(a.cash,s.initialCapital-sum(all,'cost')+sum(a.trades,'proceeds')))fail('cash');
  if(!near(a.equity,a.cash+sum(a.positions,'markValue')))fail('equity');
  if(!near(a.realizedPnl,sum(a.trades,'pnl')))fail('realized P&L');
  if(!near(a.fees,sum(all,'entryFees')+sum(a.trades,'exitFees')))fail('fees');
  const b=s.benchmark;
  if(b!==null&&(!b||b.product!==B.benchmarkProduct||!finite(b.startedAt)||b.startedAt<s.startedAt||!(b.quantity>0)||!near(b.cash,B.initialCapital-b.cost)||!near(b.cost,b.principal+b.entryFees)||!finite(b.equity)||b.equity<0))fail('benchmark');
  if(!Array.isArray(s.signals)||!Array.isArray(s.decisions)||!Array.isArray(s.errors)||!Array.isArray(s.curve)||!Array.isArray(s.daily)||!Array.isArray(s.cycles)||!s.sources||typeof s.sources!=='object')fail('records');
  if(s.curve.length>B.curveLimit||s.daily.length>B.dailyLimit||s.cycles.length>B.cycleLimit)fail('bounds');
  return s;
}

export function trendSnapshot(state,{generatedAt,requests=null}={}){
  validateTrendBook(state);
  if(!finite(generatedAt)||generatedAt<state.updatedAt)throw Error('Snapshot time must follow the evaluation');
  return {...state,generatedAt,requests,policy:TREND_POLICY,book:TREND_BOOK,
    execution:{mode:'paper',realEnabled:false,credentialsConnected:false,liveWorkerResultsPublished:false},
    venue:'Coinbase Exchange public daily candles and level-2 books',
    notes:[
      'Paper mirror of the private Coinbase worker rules. The worker\'s real-money orders, balances and results are private and not included.',
      'Separate $1,000 paper book started prospectively at its first cycle. No historical results are copied into it; it is not one of the eleven tournament accounts.',
      'Entries assume a maker fill at the observed best bid (0.50% fee). Exits walk observed bids with a 0.90% taker fee plus 0.10% slippage.',
      'Native stop (80% of the entry signal close) is modeled at no better than 95% of the trigger; take-profit (160%) is charged as taker.',
      'Scheduled five-minute cycles, best effort. Not continuous quotes or continuous protection.'
    ]};
}

export function validTrendSnapshot(s,now=Date.now()/1000){
  try{validateTrendBook(s);return finite(s.generatedAt)&&s.generatedAt>=s.updatedAt&&s.generatedAt<=now+60&&s.execution?.realEnabled===false;}catch{return false;}
}
