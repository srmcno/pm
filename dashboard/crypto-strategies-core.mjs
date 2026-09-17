// Deterministic, unauthenticated spot-paper research. Never submits an order.
export const CRYPTO_VERSION = '2026-09-16-multicoin-v1';
export const PRODUCTS = Object.freeze(['BTC-USD','ETH-USD','SOL-USD','LINK-USD','AVAX-USD','DOGE-USD','XRP-USD','ADA-USD','LTC-USD','DOT-USD']);
export const POLICY = Object.freeze({initialCapital:1000,feeRate:.006,slippageRate:.001,
  maxQuoteAge:90,maxSpread:.005,maxWeight:.20,maxExposure:.60,maxPositions:3,
  riskPct:.01,maxDrawdown:.10,dailyLoss:.03,minNotional:10,minNetR:1.1,
  confirmationMin:60,confirmationMax:1800,cooldown:21600,retireTrades:30,retireDays:14});
export const STRATEGIES = Object.freeze([
  Object.freeze({id:'rotation',name:'Relative-strength rotation',maxHold:72*3600,
    description:'Compares positive 6-hour and 24-hour momentum across coins, adjusted for volatility and relative to BTC. Buys strength, not a cross-exchange gap.'}),
  Object.freeze({id:'recovery',name:'Range recovery',maxHold:36*3600,
    description:'Looks for an observed rebound after a substantial drawdown, with room to recover toward the recent range. It does not buy a coin just because it fell.'}),
]);
const finite=Number.isFinite;
const round=n=>Math.round((n+Number.EPSILON)*1e6)/1e6;
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<.0001;
const sum=(xs,k)=>xs.reduce((n,x)=>n+(x[k]||0),0);
const age=(t,now)=>finite(t)&&t>0&&t<=now+5?now-t:Infinity;
const ema=(xs,p)=>{let value=xs.slice(0,p).reduce((a,b)=>a+b,0)/p;for(const x of xs.slice(p))value+=2/(p+1)*(x-value);return value;};
function completed(rows,now){
  const seen=new Map();
  for(const r of rows||[]){
    if(!Array.isArray(r)||r.length<6||!finite(r[0]))continue;
    const [t,l,h,o,c,v]=r;if(t+3600>now)continue;
    if(seen.has(t)&&JSON.stringify(seen.get(t))!==JSON.stringify(r))throw Error('Conflicting duplicate hourly candles');
    if(!r.every(finite)||t<=0||l<=0||o<=0||c<=0||v<0||h<Math.max(o,c)||l>Math.min(o,c))throw Error('Invalid hourly candle');
    seen.set(t,r);
  }
  const bars=[...seen.values()].sort((a,b)=>a[0]-b[0]).slice(-100);
  if(bars.length<60)throw Error('Need 60 completed hourly candles');
  if(bars.slice(-60).some((b,i,xs)=>i&&b[0]-xs[i-1][0]!==3600))throw Error('Hourly candle history has gaps');
  if(age(bars.at(-1)[0]+3600,now)>3900)throw Error('Hourly candle history is stale');
  return bars;
}
function levels(rows,side){
  if(!Array.isArray(rows))return [];
  return rows.filter(r=>Array.isArray(r)&&finite(r[0])&&finite(r[1])&&r[0]>0&&r[1]>0)
    .map(r=>[r[0],r[1]]).sort((a,b)=>side==='buy'?a[0]-b[0]:b[0]-a[0]);
}
export function usableBook(m,now){
  const b=m?.book;
  if(!m||m.sourceError||m.status!=='online'||m.tradingDisabled||!b||age(b.receivedAt,now)>POLICY.maxQuoteAge||age(b.requestAt,now)>POLICY.maxQuoteAge)return false;
  const bids=levels(b.bids,'sell'),asks=levels(b.asks,'buy');
  return !!(bids.length&&asks.length&&bids[0][0]<=asks[0][0]&&asks[0][0]/bids[0][0]-1<=POLICY.maxSpread);
}
export function walkBook(m,side,quantity){
  if(!finite(quantity)||quantity<=0||!['buy','sell'].includes(side))return null;
  let remaining=quantity,principal=0;
  for(const [p,available] of levels(m.book?.[side==='buy'?'asks':'bids'],side)){
    const q=Math.min(remaining,available);principal+=q*p;remaining-=q;if(remaining<quantity*1e-10)break;
  }
  if(remaining>quantity*1e-9)return null;
  const fees=round(principal*POLICY.feeRate),slippage=round(principal*POLICY.slippageRate);
  principal=round(principal);
  return {quantity,principal,fees,slippage,value:round(principal+(side==='buy'?1:-1)*(fees+slippage)),price:principal/quantity};
}
function features(m,now){
  const out={product:m.product,status:'unavailable',reasons:[]};
  try{
    if(!PRODUCTS.includes(m.product))throw Error('Product outside the frozen paper universe');
    const bars=completed(m.candles,now),closes=bars.map(b=>b[4]),last=bars.at(-1),prev=bars.at(-2);
    const tr=bars.slice(-15).slice(1).map((b,i)=>Math.max(b[2]-b[1],Math.abs(b[2]-bars.slice(-15)[i][4]),Math.abs(b[1]-bars.slice(-15)[i][4])));
    const atr=tr.reduce((a,b)=>a+b,0)/tr.length;
    if(!(atr>0))throw Error('Volatility estimate unavailable');
    const p=last[4],low=Math.min(...bars.slice(-24).map(b=>b[1])),high=Math.max(...bars.slice(-24).map(b=>b[2]));
    const e20=ema(closes,20),e50=ema(closes,50),change6=p/closes.at(-7)-1,change24=p/closes.at(-25)-1;
    Object.assign(out,{status:'ready',price:p,change1:p/prev[4]-1,change6,change24,atr,ema20:e20,ema50:e50,low,high,
      signalAt:last[0]+3600,regime:p>e50?'Above long trend':'Below long trend',last:closes.slice(-3)});
    if(!usableBook(m,now))throw Error(m.sourceError||'Fresh two-sided order book required');
    if(!finite(m.increment)||m.increment<=0||!finite(m.minNotional))throw Error('Product quantity increment or minimum notional unavailable');
    return out;
  }catch(e){return {...out,status:'unavailable',reasons:[e.message]};}
}
export function evaluateUniverse(markets,now){
  const unique=new Map();
  for(const m of markets||[]){if(!unique.has(m.product))unique.set(m.product,m);else unique.set(m.product,{...m,sourceError:'Duplicate product in feed'});}
  const fs=[...unique.values()].map(m=>features(m,now)).sort((a,b)=>a.product.localeCompare(b.product));
  const btc=fs.find(f=>f.product==='BTC-USD'&&f.status==='ready');
  const decisions=STRATEGIES.flatMap(strategy=>fs.map(f=>{
    const row={strategyId:strategy.id,product:f.product,signalAt:f.signalAt||null,status:'waiting',score:null,reasons:[],features:f};
    if(f.status!=='ready')return {...row,status:'unavailable',reasons:f.reasons};
    const volatility=f.atr/f.price;
    let pass,stop,target,score,reason;
    if(strategy.id==='rotation'){
      if(!btc)return {...row,status:'unavailable',reasons:['Fresh BTC comparison required']};
      pass=f.change6>0&&f.change24>0&&f.price>f.ema20&&f.price-f.ema20<=2.5*f.atr;
      score=(f.change24+f.change6+(f.change24-btc.change24)*.5)/volatility;
      stop=f.price-2*f.atr;target=f.price+5*f.atr;
      reason=pass?'Positive multi-coin momentum and relative strength; paper hypothesis only':'Waiting for positive 6h/24h momentum above the short trend without chasing';
    }else{
      const drawdown=f.high-f.low;
      pass=drawdown>=Math.max(3*f.atr,f.price*.02)&&f.last[2]>f.last[1]&&f.last[1]>f.last[0]&&f.price-f.low<=3*f.atr&&f.price<f.ema50*1.02;
      score=(drawdown/f.atr)+(f.change1/volatility);
      stop=Math.min(f.low-.25*f.atr,f.price-1.5*f.atr);target=f.high;
      reason=pass?'Two completed rising closes after a drawdown with room toward the range high':'Waiting for an observed rebound after a drawdown, not an unconfirmed falling price';
    }
    if(stop<=0||target<=f.price)pass=false;
    return {...row,status:pass?'candidate':'waiting',score:round(score),stop,target,reasons:[reason],
      id:`${CRYPTO_VERSION}:${strategy.id}:${f.product}:${f.signalAt}`};
  })).sort((a,b)=>a.strategyId.localeCompare(b.strategyId)||(b.score??-Infinity)-(a.score??-Infinity)||a.product.localeCompare(b.product));
  return {markets:fs,decisions};
}
function plan(m,d,a,now){
  if(!usableBook(m,now))return {reason:'Fresh order book unavailable'};
  const ask=levels(m.book.asks,'buy')[0][0],bid=levels(m.book.bids,'sell')[0][0];
  if(ask>d.features.price+d.features.atr||bid<d.stop)return {reason:'Price moved beyond the observed setup'};
  const unitCost=ask*(1+POLICY.feeRate+POLICY.slippageRate),loss=unitCost-d.stop*(1-POLICY.feeRate-POLICY.slippageRate),gain=d.target*(1-POLICY.feeRate-POLICY.slippageRate)-unitCost;
  if(!(loss>0)||gain/loss<POLICY.minNetR)return {reason:'Planned reward does not clear fees, slippage and risk hurdle'};
  const exposure=sum(a.positions,'cost');
  const budget=Math.min(a.cash,a.equity*POLICY.maxWeight,Math.max(0,a.equity*POLICY.maxExposure-exposure));
  const raw=Math.min(budget/unitCost,a.equity*POLICY.riskPct/loss);
  if(!(raw>0))return {reason:'Account cash or exposure limit'};
  // Round down to the public product increment. Never round up into excess risk.
  let q=Math.floor(raw/m.increment+1e-9)*m.increment;
  for(let attempt=0;attempt<20&&q>0;attempt++,q=Math.floor(q*.8/m.increment)*m.increment){
    const buy=walkBook(m,'buy',q),sell=walkBook(m,'sell',q);
    if(!buy||!sell)continue;
    const risk=buy.value-q*d.stop*(1-POLICY.feeRate-POLICY.slippageRate),reward=q*d.target*(1-POLICY.feeRate-POLICY.slippageRate)-buy.value;
    if(q<(m.minSize||m.increment)||buy.principal<Math.max(POLICY.minNotional,m.minNotional)||buy.value>budget+.000001||risk>a.equity*POLICY.riskPct+.000001||reward/risk<POLICY.minNetR)continue;
    return {fill:buy,mark:sell.value,cost:buy.value,quantity:q,risk:round(risk),reward:round(reward)};
  }
  return {reason:'No position fits minimums, depth and risk limits'};
}
export function performance(trades){
  const rows=(trades||[]).filter(t=>finite(t.pnl)),wins=rows.filter(t=>t.pnl>0),losses=rows.filter(t=>t.pnl<0);
  const gains=sum(wins,'pnl'),lost=-sum(losses,'pnl'),net=round(gains-lost);
  return {trades:rows.length,wins:wins.length,losses:losses.length,net,expectancy:rows.length?round(net/rows.length):null,
    profitFactor:lost?gains/lost:null,winRate:rows.length?wins.length/rows.length:null};
}
export function retirementReason(trades){
  const rows=(trades||[]).filter(t=>finite(t.pnl)&&finite(t.closedAt)).sort((a,b)=>a.closedAt-b.closedAt).slice(-POLICY.retireTrades);
  if(rows.length<POLICY.retireTrades||rows.at(-1).closedAt-rows[0].closedAt<POLICY.retireDays*86400)return null;
  const p=performance(rows),negativeBlocks=[0,10,20].every(i=>sum(rows.slice(i,i+10),'pnl')<0);
  return p.net<0&&p.profitFactor<1&&negativeBlocks?'Persistently negative: last 30 net trades and all three 10-trade periods lost money over at least 14 days':null;
}
export function initialCompetition(now){
  return {schemaVersion:1,version:CRYPTO_VERSION,mode:'paper',realEnabled:false,startedAt:now,updatedAt:0,
    accounts:Object.fromEntries(STRATEGIES.map(s=>[s.id,{id:s.id,name:s.name,initialCapital:1000,startedAt:now,
      cash:1000,equity:1000,peak:1000,realizedPnl:0,fees:0,status:'experimental',retirement:null,
      positions:[],trades:[],pending:{},markComplete:true,day:'',dayStart:1000,curve:[]}])),markets:[],decisions:[],cycles:[]};
}
export function validateCompetition(s){
  const fail=()=>{throw Error('Invalid crypto paper state; refusing to reset accounts');};
  if(s?.schemaVersion!==1||s.version!==CRYPTO_VERSION||s.mode!=='paper'||s.realEnabled!==false||!finite(s.updatedAt)||!finite(s.startedAt))fail();
  for(const strategy of STRATEGIES){
    const a=s.accounts?.[strategy.id];
    if(!a||a.id!==strategy.id||a.initialCapital!==1000||!['experimental','retired','risk-paused'].includes(a.status)||!Array.isArray(a.positions)||!Array.isArray(a.trades)||!a.pending||Array.isArray(a.pending)||typeof a.markComplete!=='boolean')fail();
    for(const k of ['cash','equity','peak','fees','dayStart'])if(!finite(a[k])||a[k]<0)fail();
    if(!finite(a.realizedPnl))fail();
    const ids=new Set();
    for(const p of [...a.positions,...a.trades]){
      if(!p.id||ids.has(p.id)||!PRODUCTS.includes(p.product)||p.strategyId!==a.id||p.version!==CRYPTO_VERSION||!finite(p.quantity)||p.quantity<=0)fail();ids.add(p.id);
      for(const k of ['cost','principal','entryFees','entrySlippage','openedAt','markValue','markAt','stop','target'])if(!finite(p[k])||p[k]<0)fail();
      if(!near(p.cost,p.principal+p.entryFees+p.entrySlippage))fail();
    }
    for(const t of a.trades)if(!finite(t.closedAt)||t.closedAt<t.openedAt||!finite(t.exitFees)||!finite(t.exitSlippage)||!finite(t.proceeds)||t.proceeds<0||!near(t.pnl,t.proceeds-t.cost))fail();
    const all=[...a.positions,...a.trades];
    if(!near(a.cash,1000-sum(all,'cost')+sum(a.trades,'proceeds'))||!near(a.equity,a.cash+sum(a.positions,'markValue'))||!near(a.realizedPnl,sum(a.trades,'pnl'))||!near(a.fees,sum(all,'entryFees')+sum(a.trades,'exitFees')))fail();
    for(const pending of Object.values(a.pending))if(!finite(pending.at)||!pending.product||!PRODUCTS.includes(pending.product))fail();
  }
  return s;
}
export function advanceCompetition(previous,markets,now){
  if(!finite(now)||now<=0)throw Error('Invalid evaluation time');
  const s=previous?structuredClone(validateCompetition(previous)):initialCompetition(now);
  if(now<=s.updatedAt)return s;
  const view=evaluateUniverse(markets,now),byProduct=new Map(markets.map(m=>[m.product,m]));
  const receipt={at:now,accounts:[]};
  for(const strategy of STRATEGIES){
    const a=s.accounts[strategy.id],opened=[],closed=[];a.markComplete=true;
    for(const p of [...a.positions]){
      const m=byProduct.get(p.product),fill=m&&usableBook(m,now)?walkBook(m,'sell',p.quantity):null;
      if(!fill){a.markComplete=false;continue;}
      p.markValue=fill.value;p.markAt=m.book.receivedAt;
      const f=view.markets.find(f=>f.product===p.product),bid=levels(m.book.bids,'sell')[0][0];
      const reason=bid<=p.stop?'Stop / adverse gap':bid>=p.target?'Target observed':
        f?.status==='ready'&&f.change6<0&&f.price<f.ema20?'Momentum reversal':now-p.openedAt>=strategy.maxHold?'Maximum holding window':null;
      if(reason){const trade={...p,closedAt:now,exitPrice:fill.price,exitFees:fill.fees,exitSlippage:fill.slippage,proceeds:fill.value,pnl:round(fill.value-p.cost),exitReason:reason};
        a.positions=a.positions.filter(x=>x.id!==p.id);a.trades.push(trade);a.cash=round(a.cash+trade.proceeds);closed.push(trade.id);}
    }
    a.equity=round(a.cash+sum(a.positions,'markValue'));
    if(a.markComplete)a.peak=Math.max(a.peak,a.equity);
    const day=new Date(now*1000).toISOString().slice(0,10);if(a.day!==day){a.day=day;a.dayStart=a.equity;}
    const reason=retirementReason(a.trades);
    if(reason&&a.status!=='retired'){a.status='retired';a.retirement={at:now,reason,stats:performance(a.trades.slice(-30))};}
    if(a.markComplete&&a.status==='experimental'&&a.equity<=a.peak*(1-POLICY.maxDrawdown)){a.status='risk-paused';a.retirement={at:now,reason:'10% peak drawdown; manual review required, no automatic restart'};}
    const canEnter=()=>a.status==='experimental'&&a.markComplete&&a.equity>a.dayStart*(1-POLICY.dailyLoss)&&a.equity>a.peak*(1-POLICY.maxDrawdown);
    const nextPending={};
    for(const d of view.decisions.filter(d=>d.strategyId===strategy.id)){
      if(d.status!=='candidate')continue;
      if(!canEnter()){d.status='held';d.reasons=[!a.markComplete?'Open position has a stale mark':a.status!=='experimental'?'Strategy retired or risk-paused':'Daily loss or drawdown limit'];continue;}
      if(a.positions.some(p=>p.product===d.product)||a.positions.length>=POLICY.maxPositions){d.status='held';d.reasons=['Position already open or maximum simultaneous positions reached'];continue;}
      if(a.trades.some(t=>t.id===d.id||t.product===d.product&&now-t.closedAt<POLICY.cooldown)){d.status='held';d.reasons=['Signal already traded or six-hour re-entry cooldown'];continue;}
      const m=byProduct.get(d.product),p=plan(m,d,a,now);d.plan=p.fill?{cost:p.cost,quantity:p.quantity,risk:p.risk,reward:p.reward}:null;
      if(!p.fill){d.status='held';d.reasons=[p.reason];continue;}
      const prior=a.pending[d.id],gap=prior?now-prior.at:Infinity;
      nextPending[d.id]={at:prior&&gap<=POLICY.confirmationMax?prior.at:now,product:d.product};
      if(!prior||gap<POLICY.confirmationMin||gap>POLICY.confirmationMax){d.status='confirming';d.reasons=['Waiting for a second qualifying scan, not for a fixed entry time'];continue;}
      const position={id:d.id,version:CRYPTO_VERSION,strategyId:strategy.id,product:d.product,side:'long',quantity:p.quantity,
        principal:p.fill.principal,entryFees:p.fill.fees,entrySlippage:p.fill.slippage,cost:p.cost,
        entryPrice:p.fill.price,stop:d.stop,target:d.target,openedAt:now,quoteAt:m.book.receivedAt,
        markAt:m.book.receivedAt,markValue:p.mark,signalAt:d.signalAt,regime:d.features.regime,entryReasons:d.reasons,score:d.score};
      a.positions.push(position);a.cash=round(a.cash-p.cost);a.equity=round(a.cash+sum(a.positions,'markValue'));
      delete nextPending[d.id];opened.push(position.id);d.status='entered';
    }
    a.pending=nextPending;a.realizedPnl=round(sum(a.trades,'pnl'));a.fees=round(sum([...a.positions,...a.trades],'entryFees')+sum(a.trades,'exitFees'));
    a.stats=performance(a.trades);a.curve=[...a.curve,{at:now,equity:a.equity}].slice(-2016);
    receipt.accounts.push({id:a.id,status:a.status,opened,closed,pending:Object.keys(a.pending).length,equity:a.equity});
  }
  s.updatedAt=now;s.markets=view.markets;s.decisions=view.decisions;s.cycles=[...s.cycles,receipt].slice(-288);
  return validateCompetition(s);
}
export function retireLegacy(account,now){
  const a=structuredClone(account);if(!a)return a;
  const prior=a.entryPolicy||{};
  a.entryPolicy={...prior,allowedStrategies:[],state:'retired',reason:'Legacy breakout and reclaim retired by owner request; no new entries. Existing positions retain their exit rules.',
    strategies:(prior.strategies||[]).map(s=>({...s,allowed:false,status:'retired'}))};
  a.retirement||={at:now,status:'retired',reason:'Owner requested removal of the losing legacy models',
    note:'Observed losses do not prove that every future trade would lose. Replay evidence is not a forward trading record.'};
  return a;
}
export function validCompetitionSnapshot(s,now=Date.now()/1000){try{return !!(validateCompetition(s)&&finite(s.generatedAt)&&s.generatedAt<=now+60&&Array.isArray(s.errors)&&Array.isArray(s.markets)&&Array.isArray(s.decisions));}catch{return false;}}
