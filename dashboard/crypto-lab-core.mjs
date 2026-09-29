// Strategy Lab: paper-only alternative daily strategies that run prospectively
// beside the live bot. Deterministic and unauthenticated: it never submits an
// order, never reads credentials, balances or fills, and never shares a ledger
// or state file with the eleven-account tournament or with the BTC/ETH trend
// mirror. Every book is its own $1,000 paper account that starts at the lab's
// first scheduled cycle. Nothing is backfilled and nothing here is evidence of
// an edge: the windows are short and the rules are experiments.
import {TREND_POLICY,completedDaily} from './trend-core.mjs';
import {FEE_PROFILE,POLICY,usableBook,walkBook} from './crypto-strategies-core.mjs';

export const LAB_POLICY_ID='2026-09-29-lab-v1';
export const LAB_VERSION='2026-09-29-strategy-lab-paper-v1';
export const LAB_PRODUCTS=Object.freeze(['BTC-USD','ETH-USD','SOL-USD']);
export const LAB_BOOK=Object.freeze({
  version:LAB_VERSION,kind:'crypto-lab-paper',policyId:LAB_POLICY_ID,initialCapital:1000,
  // Equal split of each book's equity across the three products while long.
  allocation:1/3,
  // Entry: resting limit at the observed best bid, assumed to fill as maker
  // (the same assumption as the trend mirror). Exit: taker, walking the
  // observed bids plus the tournament slippage reserve.
  makerRate:FEE_PROFILE.makerRate,takerRate:FEE_PROFILE.takerRate,slippageRate:POLICY.slippageRate,
  quantityIncrement:1e-8,minNotional:10,maxQuoteAge:POLICY.maxQuoteAge,
  // About 420 daily bars are fetched so the slowest indicator has history.
  historyDays:420,
  curveSpacing:3600,curveLimit:720,dailyLimit:1100,cycleLimit:288,
});

// Book definitions. Numeric parameters are part of the recorded history: a
// change is refused by validateLab until an explicit migration is written.
export const LAB_DEFS=Object.freeze([
  Object.freeze({id:'sma200-5',kind:'sma',name:'SMA200 ±5%',
    rule:'Enter when the completed daily close is above the 200-day average + 5%; exit when it is below the average − 5%.',
    params:Object.freeze({days:200,band:.05,exitAtBoundary:false}),minBars:201}),
  Object.freeze({id:'donchian-100-50',kind:'donchian',name:'Donchian 100/50',
    rule:'Enter when the close is above the highest high of the previous 100 daily bars; exit when it is below the lowest low of the previous 50.',
    params:Object.freeze({entryDays:100,exitDays:50}),minBars:101}),
  Object.freeze({id:'supertrend-10-3',kind:'supertrend',name:'Supertrend 10×3',
    rule:'Long while the Supertrend (10-day mean true range, multiplier 3, on the high-low midpoint) is up; flat when it flips down.',
    params:Object.freeze({atrDays:10,multiplier:3}),minBars:250}),
  Object.freeze({id:'sma100-2',kind:'sma',name:'SMA100 ±2% (live rule, control)',
    rule:'The live bot\'s rule applied to all three coins: enter above the 100-day average + 2%; exit below the average − 2%.',
    params:Object.freeze({days:100,band:.02,exitAtBoundary:true}),minBars:101}),
  Object.freeze({id:'hold-3',kind:'hold',name:'Hold BTC/ETH/SOL (benchmark)',
    rule:'Equal-weight buy-and-hold entered once at the first usable book. Never sells. The reference every other book is compared with.',
    params:Object.freeze({}),minBars:0}),
]);

const DAY=86400,B=LAB_BOOK,finite=Number.isFinite;
const round=n=>Math.round((n+Number.EPSILON)*1e6)/1e6;
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<.0001;
const sum=(xs,k)=>xs.reduce((n,x)=>n+(x?.[k]||0),0);
const floorQuantity=q=>Math.floor(q/B.quantityIncrement+1e-9)*B.quantityIncrement;
const fixQuantity=q=>Number(q.toFixed(8));
const defOf=id=>LAB_DEFS.find(d=>d.id===id);

function feeProfile(){
  return {id:FEE_PROFILE.id,makerRate:B.makerRate,takerRate:B.takerRate,slippageRate:B.slippageRate,accountVerified:false,
    entry:'Maker limit at the observed best bid, assumed filled',exit:'Taker: observed bids walked, plus 0.10% slippage reserve'};
}

// ---------------------------------------------------------------------------
// Pure indicators. Bars are {time,low,high,open,close} in ascending order.
// ---------------------------------------------------------------------------

// Standard Supertrend. True range is defined from the second bar; ATR is the
// simple mean of the last `atrDays` true ranges, so the first reading is at
// index atrDays. Bands use the usual final-band ratchet. The trend starts
// down (flat) at the first reading, as in common charting packages, and the
// warm-up is the whole history passed in, so the latest state is a pure
// function of the bars.
export function supertrendSeries(bars,{atrDays=10,multiplier=3}={}){
  const n=bars.length,tr=new Array(n).fill(null),rows=[];
  for(let i=1;i<n;i++){const b=bars[i],pc=bars[i-1].close;tr[i]=Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc));}
  let upper=null,lower=null,trend='down';
  for(let i=atrDays;i<n;i++){
    let atr=0;for(let j=i-atrDays+1;j<=i;j++)atr+=tr[j];atr/=atrDays;
    const b=bars[i],mid=(b.high+b.low)/2,basicUpper=mid+multiplier*atr,basicLower=mid-multiplier*atr,priorClose=bars[i-1].close;
    if(!rows.length){upper=basicUpper;lower=basicLower;}
    else{
      upper=basicUpper<upper||priorClose>upper?basicUpper:upper;
      lower=basicLower>lower||priorClose<lower?basicLower:lower;
      if(trend==='up'&&b.close<lower)trend='down';
      else if(trend==='down'&&b.close>upper)trend='up';
    }
    rows.push({index:i,time:b.time,atr,upper,lower,trend,line:trend==='up'?lower:upper});
  }
  return rows;
}
export const supertrend=(bars,params)=>supertrendSeries(bars,params).at(-1)||null;

export const smaLevels=(bars,{days,band})=>{
  const window=bars.slice(-days);
  if(window.length<days)return null;
  const sma=window.reduce((n,b)=>n+b.close,0)/days;
  return {sma,upper:sma*(1+band),lower:sma*(1-band)};
};
export const donchianLevels=(bars,{entryDays,exitDays})=>{
  const highs=bars.slice(-(entryDays+1),-1),lows=bars.slice(-(exitDays+1),-1);
  if(highs.length<entryDays||lows.length<exitDays)return null;
  return {high:Math.max(...highs.map(b=>b.high)),low:Math.min(...lows.map(b=>b.low))};
};

// Completed UTC daily bars only, from the last contiguous run. completedDaily
// (shared with the live worker's signal) rejects a stale latest bar and gaps
// in the last `minBars` bars; only that contiguous run is used here.
export function labBars(candles,now,minBars){
  const bars=completedDaily(candles,now,{smaDays:Math.max(0,minBars-1),maxBarAgeSeconds:TREND_POLICY.maxBarAgeSeconds});
  let i=bars.length-1;
  while(i>0&&bars[i].time-bars[i-1].time===DAY)i--;
  return bars.slice(i);
}

const REASONS={
  enter:{sma:'Close is above the average plus the entry band',donchian:'Close is above the highest high of the previous 100 daily bars',supertrend:'Supertrend is up',hold:'Benchmark: not yet bought; enters once at the first usable book'},
  hold:{sma:'Close remains above the average less the exit band',donchian:'Close is not below the lowest low of the previous 50 daily bars',supertrend:'Supertrend remains up',hold:'Benchmark: held, never sold'},
  exit:{sma:'Close fell below the average less the exit band',donchian:'Close fell below the lowest low of the previous 50 daily bars',supertrend:'Supertrend flipped down',hold:''},
  wait:{sma:'Close is not above the average plus the entry band',donchian:'Close is not above the highest high of the previous 100 daily bars',supertrend:'Supertrend is down',hold:''},
};

// One product's reading for one book: a pure function of completed daily bars
// and whether the book currently holds the product.
export function labSignal({bookId,product,candles,held=false,now,fetchedAt=null}){
  const def=defOf(bookId),base={bookId,product,held:!!held,fetchedAt,kind:def?.kind??null};
  try{
    if(!def)throw Error('Unknown lab book');
    if(!LAB_PRODUCTS.includes(product))throw Error('Product is outside the Strategy Lab');
    if(def.kind==='hold'){
      // The benchmark needs no candles; a completed close is context only.
      let last=null;try{last=labBars(candles,now,1).at(-1);}catch{}
      const action=held?'hold':'enter';
      return {...base,status:'ready',barTime:last?.time??null,barClosedAt:null,close:last?.close??null,indicator:null,enterLevel:null,exitLevel:null,distance:null,
        state:'long',action,signalId:`${LAB_POLICY_ID}:${bookId}:${product}:initial`,reason:REASONS[action].hold};
    }
    const bars=labBars(candles,now,def.minBars),last=bars.at(-1),close=last.close;
    let indicator=null,enterLevel,exitLevel,state,extra={};
    if(def.kind==='sma'){
      const lv=smaLevels(bars,def.params);if(!lv)throw Error('Insufficient completed daily history');
      indicator=lv.sma;enterLevel=lv.upper;exitLevel=lv.lower;
      const stays=def.params.exitAtBoundary?close>lv.lower:close>=lv.lower;
      state=held?(stays?'long':'flat'):(close>lv.upper?'long':'flat');
    }else if(def.kind==='donchian'){
      const lv=donchianLevels(bars,def.params);if(!lv)throw Error('Insufficient completed daily history');
      enterLevel=lv.high;exitLevel=lv.low;
      state=held?(close<lv.low?'flat':'long'):(close>lv.high?'long':'flat');
    }else if(def.kind==='supertrend'){
      const st=supertrend(bars,def.params);if(!st||st.time!==last.time)throw Error('Insufficient completed daily history');
      indicator=st.line;enterLevel=st.upper;exitLevel=st.lower;state=st.trend==='up'?'long':'flat';
      extra={trend:st.trend,atr:st.atr};
    }else throw Error('Unknown signal kind');
    const long=state==='long',action=held?(long?'hold':'exit'):(long?'enter':'wait');
    return {...base,status:'ready',barTime:last.time,barClosedAt:last.time+DAY,close,indicator,enterLevel,exitLevel,
      distance:indicator?close/indicator-1:null,state,action,...extra,
      signalId:`${LAB_POLICY_ID}:${bookId}:${product}:${last.time}`,reason:REASONS[action][def.kind]};
  }catch(error){
    return {...base,status:'unavailable',state:'unknown',action:'wait',reason:error.message};
  }
}

// ---------------------------------------------------------------------------
// Fills. The book is walked exactly as the trend mirror does.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function newBenchmark(now){
  return {startedAt:now,initialCapital:B.initialCapital,legs:Object.fromEntries(LAB_PRODUCTS.map(p=>[p,null])),cash:B.initialCapital,equity:B.initialCapital,
    peak:B.initialCapital,maxDrawdown:0,markComplete:true,feeProfile:FEE_PROFILE.id,entryLiquidity:'maker',exitLiquidity:'taker'};
}
function newBook(def,now){
  return {id:def.id,signalId:def.id,kind:def.kind,name:def.name,rule:def.rule,params:{...def.params},startedAt:now,
    account:{cash:B.initialCapital,equity:B.initialCapital,peak:B.initialCapital,maxDrawdown:0,realizedPnl:0,fees:0,slippage:0,markComplete:true,positions:[],trades:[]},
    benchmark:newBenchmark(now),signals:[],decisions:[],curve:[],daily:[]};
}
export function initialLab(now){
  if(!finite(now)||now<=0)throw Error('Invalid evaluation time');
  return {schemaVersion:1,kind:B.kind,version:B.version,policyId:LAB_POLICY_ID,mode:'paper',realEnabled:false,
    startedAt:now,updatedAt:0,initialCapital:B.initialCapital,products:[...LAB_PRODUCTS],feeProfile:feeProfile(),
    books:LAB_DEFS.map(d=>newBook(d,now)),sources:{},errors:[],cycles:[]};
}

// Equal-weight buy-and-hold with the same entry and liquidation costs. A leg
// starts at the first usable book for its product; until then its share stays
// as cash and the leg's own start time stays empty rather than invented.
function advanceBenchmark(bench,markets){
  for(const product of LAB_PRODUCTS){
    const m=markets[product];
    if(bench.legs[product]||!m)continue;
    const fill=makerBuy(m,B.initialCapital*B.allocation),mark=fill?takerSell(m,fill.quantity):null;
    if(fill&&mark){
      bench.legs[product]={startedAt:m.book.receivedAt,quantity:fill.quantity,entryPrice:fill.price,principal:fill.principal,entryFees:fill.fees,cost:fill.value,
        markValue:mark.value,markAt:m.book.receivedAt,markComplete:true};
      bench.cash=round(bench.cash-fill.value);
    }
  }
  bench.markComplete=true;
  for(const product of LAB_PRODUCTS){
    const leg=bench.legs[product];if(!leg)continue;
    const mark=takerSell(markets[product],leg.quantity);
    if(mark){leg.markValue=mark.value;leg.markAt=markets[product].book.receivedAt;leg.markComplete=true;}
    else{leg.markComplete=false;bench.markComplete=false;}
  }
  bench.equity=round(bench.cash+LAB_PRODUCTS.reduce((n,p)=>n+(bench.legs[p]?.markValue||0),0));
  if(bench.markComplete){bench.peak=Math.max(bench.peak,bench.equity);bench.maxDrawdown=Math.min(bench.maxDrawdown,round(bench.equity/bench.peak-1));}
}

function advanceBook(book,{inputs,markets,now,errors,startedAt}){
  const def=defOf(book.id),a=book.account,decisions=[],priorSignals=new Map(book.signals.map(x=>[x.product,x]));
  let opened=0,closed=0;
  book.name=def.name;book.rule=def.rule;
  const signals={};
  for(const product of LAB_PRODUCTS){
    const input=inputs?.[product]||{},held=a.positions.some(p=>p.product===product);
    const goodCandles=input.candles&&!input.candlesError;
    const signal=def.kind==='hold'||goodCandles?labSignal({bookId:def.id,product,candles:goodCandles?input.candles:[],held,now,fetchedAt:input.candlesReceivedAt??null}):null;
    if(signal?.status==='ready')signals[product]={...signal,evaluatedAt:now,retained:false,error:null};
    else{
      const reason=signal?.reason||input.candlesError||'Daily candles not collected this cycle';
      // A failed candle read is already an error at the product level.
      if(signal)errors.push({product,bookId:def.id,stage:'signal',message:reason,at:now});
      const prior=priorSignals.get(product);
      // Keep the newer good reading with its original times; never act on it.
      signals[product]=prior&&prior.status==='ready'?{...prior,retained:true,error:reason,checkedAt:now}
        :{bookId:def.id,product,kind:def.kind,status:'unavailable',state:'unknown',action:'wait',held,fetchedAt:input.candlesReceivedAt??null,evaluatedAt:now,retained:false,error:reason,reason};
    }
  }
  const actionable=product=>{const x=signals[product];return x.status==='ready'&&!x.retained&&x.evaluatedAt===now;};

  // Exits and marks.
  a.markComplete=true;
  for(const p of [...a.positions]){
    const m=markets[p.product],sig=signals[p.product];
    let fill=null;
    if(actionable(p.product)&&sig.action==='exit'){
      fill=takerSell(m,p.quantity);
      if(!fill)decisions.push({product:p.product,action:'exit',status:'blocked',reason:'Exit signal, but no usable public order book this cycle; retrying next cycle'});
    }
    if(fill){
      const trade={...p,closedAt:now,exitPrice:fill.price,exitPrincipal:fill.principal,exitFees:fill.fees,exitSlippage:fill.slippage,exitFeeRate:fill.feeRate,exitLiquidity:fill.liquidity,
        proceeds:fill.value,pnl:round(fill.value-p.cost),exitReason:`${def.name}: ${sig.reason}`,
        exitEvidence:{kind:'signal',source:'completed daily close',barTime:sig.barTime,observed:sig.close,detectedAt:now},exitSignalId:sig.signalId,exitFeeProfile:FEE_PROFILE.id};
      delete trade.markValue;delete trade.markAt;delete trade.markComplete;
      a.positions=a.positions.filter(x=>x.id!==p.id);a.trades.push(trade);a.cash=round(a.cash+trade.proceeds);closed++;
      decisions.push({product:p.product,action:'exit',status:'exited',reason:trade.exitReason});continue;
    }
    const mark=takerSell(m,p.quantity);
    if(mark){p.markValue=mark.value;p.markAt=m.book.receivedAt;p.markComplete=true;}
    else{p.markComplete=false;a.markComplete=false;}
    if(!decisions.some(d=>d.product===p.product))decisions.push({product:p.product,action:sig.action,status:'holding',
      reason:!actionable(p.product)?`Holding; signal not refreshed: ${sig.error||'unavailable'}`:mark?'Holding while the rule stays long':'Holding; liquidation mark unavailable this cycle'});
  }
  a.equity=round(a.cash+sum(a.positions,'markValue'));

  // Entries: one per product per completed daily bar, never on a bar that
  // closed before this product's latest exit, and never on a retained signal.
  const sizingEquity=a.equity;
  for(const product of LAB_PRODUCTS){
    if(a.positions.some(p=>p.product===product)||decisions.some(d=>d.product===product&&d.status==='exited'))continue;
    const sig=signals[product],m=markets[product];
    const hold=reason=>decisions.push({product,action:sig.action,status:sig.action==='enter'?'blocked':'waiting',reason});
    if(!actionable(product)){hold(`Signal unavailable: ${sig.error||sig.reason}`);continue;}
    if(sig.action!=='enter'){hold(sig.reason);continue;}
    const lastExit=a.trades.filter(t=>t.product===product).reduce((n,t)=>Math.max(n,t.closedAt),0);
    if(a.trades.some(t=>t.signalId===sig.signalId)||(lastExit>0&&finite(sig.barClosedAt)&&sig.barClosedAt<=lastExit)){hold('Entry signal already used, or no new completed daily bar since the last exit');continue;}
    if(!a.markComplete){hold('An open position lacks a fresh mark; entries wait');continue;}
    if(!m){hold('Entry signal, but no usable public order book this cycle');continue;}
    const fill=makerBuy(m,Math.min(sizingEquity*B.allocation,a.cash)),mark=fill?takerSell(m,fill.quantity):null;
    if(!fill||!mark||fill.value>a.cash+1e-9){hold('Entry size below minimum, insufficient cash or insufficient visible depth');continue;}
    // Initial entries take a signal that was already in force when the book
    // started (or, for the benchmark, the one-time purchase). Later entries
    // are bar-close entries on a newly completed daily bar.
    const initial=def.kind==='hold'||sig.barClosedAt<=startedAt,kind=initial?'initial':'bar-close';
    const position={id:`${sig.signalId}:entry`,version:B.version,policyId:LAB_POLICY_ID,bookId:def.id,product,side:'long',quantity:fill.quantity,
      principal:fill.principal,entryFees:fill.fees,entrySlippage:0,entryFeeRate:fill.feeRate,entryLiquidity:'maker',feeProfile:FEE_PROFILE.id,
      cost:fill.value,entryPrice:fill.price,openedAt:now,quoteAt:m.book.receivedAt,signalId:sig.signalId,signalBarTime:sig.barTime,signalClose:sig.close,
      signalIndicator:sig.indicator,entryKind:kind,markValue:mark.value,markAt:m.book.receivedAt,markComplete:true,
      entryReasons:[initial?`Initial entry: ${sig.reason}; the signal was already in force when the book started.`:`Bar-close entry on a newly completed daily bar: ${sig.reason}.`,
        'Paper assumes a resting buy at the observed best bid fills as maker; a real resting order may fill later, at another price, or not at all.']};
    a.positions.push(position);a.cash=round(a.cash-fill.value);opened++;
    decisions.push({product,action:'enter',status:'entered',reason:position.entryReasons[0]});
  }
  a.equity=round(a.cash+sum(a.positions,'markValue'));
  if(a.markComplete){a.peak=Math.max(a.peak,a.equity);a.maxDrawdown=Math.min(a.maxDrawdown,round(a.equity/a.peak-1));}
  a.realizedPnl=round(sum(a.trades,'pnl'));
  const all=[...a.positions,...a.trades];
  a.fees=round(sum(all,'entryFees')+sum(a.trades,'exitFees'));
  a.slippage=round(sum(all,'entrySlippage')+sum(a.trades,'exitSlippage'));

  advanceBenchmark(book.benchmark,markets);
  book.signals=LAB_PRODUCTS.map(p=>signals[p]);book.decisions=decisions;
  const point={at:now,equity:a.equity,benchmark:book.benchmark.equity,complete:a.markComplete&&book.benchmark.markComplete};
  if(!book.curve.length||now-book.curve.at(-1).at>=B.curveSpacing)book.curve=[...book.curve,point].slice(-B.curveLimit);
  const day=new Date(now*1000).toISOString().slice(0,10);
  book.daily=[...(book.daily.at(-1)?.day===day?book.daily.slice(0,-1):book.daily),{day,...point}].slice(-B.dailyLimit);
  return {opened,closed};
}

// previous: the last valid state (or null to start prospectively).
// inputs: {[product]:{candles,candlesRequestedAt,candlesReceivedAt,candlesError,book,bookError}}.
// now: evaluation time, captured after collection.
export function advanceLab(previous,inputs={},now){
  if(!finite(now)||now<=0)throw Error('Invalid evaluation time');
  const s=previous?validateLab(structuredClone(previous)):initialLab(now);
  if(now<=s.updatedAt)return s;
  const errors=[],markets={};
  for(const product of LAB_PRODUCTS){
    const input=inputs?.[product]||{};
    const market=marketFor(product,input,now);markets[product]=market;
    s.sources[product]=sourceRecord(s.sources[product],input,market,now);
    if(input.candlesError||!input.candles)errors.push({product,stage:'candles',message:input.candlesError||'Daily candles not collected this cycle',at:now});
    if(!market)errors.push({product,stage:'book',message:s.sources[product].book.error,at:now});
  }
  let opened=0,closed=0;
  for(const book of s.books){const r=advanceBook(book,{inputs,markets,now,errors,startedAt:book.startedAt});opened+=r.opened;closed+=r.closed;}
  s.errors=errors;s.feeProfile=feeProfile();s.updatedAt=now;
  s.cycles=[...s.cycles,{at:now,opened,closed,errors:errors.length}].slice(-B.cycleLimit);
  return validateLab(s);
}

export function validateLab(s){
  const fail=reason=>{throw Error(`Invalid strategy lab (${reason}); refusing to reset`);};
  if(!s||s.schemaVersion!==1||s.kind!==B.kind||s.version!==B.version||s.mode!=='paper'||s.realEnabled!==false)fail('identity');
  if(s.policyId!==LAB_POLICY_ID)fail('policy version changed; add an explicit migration');
  if(!finite(s.startedAt)||s.startedAt<=0||!finite(s.updatedAt)||(s.updatedAt&&s.updatedAt<s.startedAt))fail('times');
  if(s.initialCapital!==B.initialCapital)fail('capital');
  if(JSON.stringify(s.products)!==JSON.stringify(LAB_PRODUCTS))fail('products');
  if(!Array.isArray(s.books)||s.books.length!==LAB_DEFS.length)fail('books');
  if(!Array.isArray(s.errors)||!Array.isArray(s.cycles)||!s.sources||typeof s.sources!=='object')fail('records');
  if(s.cycles.length>B.cycleLimit)fail('bounds');
  s.books.forEach((b,i)=>validateBook(b,s,LAB_DEFS[i],fail));
  return s;
}
function validateBook(b,s,def,fail){
  const at=reason=>fail(`${def.id}: ${reason}`);
  if(!b||b.id!==def.id||b.signalId!==def.id||b.kind!==def.kind||JSON.stringify(b.params)!==JSON.stringify(def.params))at('identity or parameters');
  if(!finite(b.startedAt)||b.startedAt<s.startedAt||(s.updatedAt&&b.startedAt>s.updatedAt))at('times');
  const a=b.account;
  if(!a||!Array.isArray(a.positions)||!Array.isArray(a.trades)||typeof a.markComplete!=='boolean')at('ledger');
  for(const k of ['cash','equity','peak','fees','slippage'])if(!finite(a[k])||a[k]<0)at(k);
  if(!finite(a.realizedPnl)||!finite(a.maxDrawdown)||a.maxDrawdown>0)at('performance');
  const ids=new Set(),held=new Set();
  for(const p of [...a.positions,...a.trades]){
    if(typeof p.id!=='string'||ids.has(p.id)||p.bookId!==def.id||!LAB_PRODUCTS.includes(p.product)||p.side!=='long'||!finite(p.quantity)||p.quantity<=0)at('position identity');
    ids.add(p.id);
    for(const k of ['principal','entryFees','entrySlippage','cost','entryPrice','openedAt'])if(!finite(p[k])||p[k]<0)at('position values');
    if(!near(p.cost,p.principal+p.entryFees+p.entrySlippage))at('position cost');
  }
  for(const p of a.positions){if(held.has(p.product))at('duplicate open product');held.add(p.product);if(!finite(p.markValue)||p.markValue<0||!finite(p.markAt))at('mark');}
  for(const t of a.trades)if(!finite(t.closedAt)||t.closedAt<t.openedAt||!finite(t.exitFees)||!finite(t.exitSlippage)||!finite(t.proceeds)||t.proceeds<0||!near(t.pnl,t.proceeds-t.cost))at('trade');
  const all=[...a.positions,...a.trades];
  if(!near(a.cash,s.initialCapital-sum(all,'cost')+sum(a.trades,'proceeds')))at('cash');
  if(!near(a.equity,a.cash+sum(a.positions,'markValue')))at('equity');
  if(!near(a.realizedPnl,sum(a.trades,'pnl')))at('realized P&L');
  if(!near(a.fees,sum(all,'entryFees')+sum(a.trades,'exitFees')))at('fees');
  if(!near(a.slippage,sum(all,'entrySlippage')+sum(a.trades,'exitSlippage')))at('slippage');
  const k=b.benchmark;
  if(!k||!finite(k.startedAt)||k.startedAt<b.startedAt||!k.legs||!finite(k.cash)||k.cash<0||!finite(k.equity)||k.equity<0||!finite(k.peak)||!finite(k.maxDrawdown)||k.maxDrawdown>0)at('benchmark');
  let legCost=0,legMarks=0;
  for(const product of LAB_PRODUCTS){
    const leg=k.legs[product];if(leg===null)continue;
    if(!leg||!(leg.quantity>0)||!finite(leg.cost)||!finite(leg.markValue)||leg.markValue<0||!near(leg.cost,leg.principal+leg.entryFees))at('benchmark leg');
    legCost+=leg.cost;legMarks+=leg.markValue;
  }
  if(!near(k.cash,s.initialCapital-legCost)||!near(k.equity,k.cash+legMarks))at('benchmark identity');
  if(!Array.isArray(b.signals)||!Array.isArray(b.decisions)||!Array.isArray(b.curve)||!Array.isArray(b.daily))at('records');
  if(b.curve.length>B.curveLimit||b.daily.length>B.dailyLimit)at('bounds');
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------
export function labSnapshot(state,{generatedAt,requests=null}={}){
  validateLab(state);
  if(!finite(generatedAt)||generatedAt<state.updatedAt)throw Error('Snapshot time must follow the evaluation');
  return {...state,generatedAt,requests,
    lab:{id:LAB_POLICY_ID,books:LAB_DEFS.map(d=>({id:d.id,kind:d.kind,name:d.name,rule:d.rule,params:d.params})),products:LAB_PRODUCTS,book:B},
    execution:{mode:'paper',realEnabled:false,credentialsConnected:false,liveWorkerResultsPublished:false},
    venue:'Coinbase Exchange public daily candles and level-2 books',
    notes:[
      'Paper experiments. Not the live bot. Each book is a separate $1,000 paper account started prospectively at the lab\'s first scheduled cycle; nothing is backfilled.',
      'Long-only spot in BTC-USD, ETH-USD and SOL-USD, one position per product, equal thirds of book equity per coin while long.',
      'Entries assume a maker fill at the observed best bid (0.50% fee). Exits walk observed bids with a 0.90% taker fee plus 0.10% slippage.',
      'Signals use completed UTC daily bars only. Failed reads keep the earlier good reading with its original time and never trigger a trade.',
      'Scheduled five-minute cycles, best effort. Not continuous quotes. Short-window results are not evidence of an edge.'
    ]};
}

export function validLabSnapshot(s,now=Date.now()/1000){
  try{validateLab(s);return finite(s.generatedAt)&&s.generatedAt>=s.updatedAt&&s.generatedAt<=now+60&&s.execution?.realEnabled===false;}catch{return false;}
}
