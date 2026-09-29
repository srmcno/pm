// Daily BTC/ETH trend following, shared by the public paper book and the
// private Coinbase worker. Pure and deterministic: signals use completed UTC
// daily bars only, and every reading keeps its original bar and fetch times.
//
// Evidence (2026-09-29, Coinbase daily bars 2024-01 to 2026-09, maker entry /
// taker exit costs): each coin held only while its close stays above the
// 100-day simple average (enter +2%, exit -2%) returned +118% with a -36%
// maximum drawdown, versus +99% / -53% for BTC buy-and-hold, and was positive
// in each third of the sample. Neighbouring settings (75-150 days, 0-4% band)
// were also positive. This is a historical study, not a promise of returns.
export const TREND_POLICY=Object.freeze({
  id:'2026-09-29-trend-v1',
  name:'BTC/ETH daily trend',
  products:Object.freeze(['BTC-USD','ETH-USD']),
  smaDays:100,
  band:0.02,
  atrDays:14,
  // Native crash protection sits well below the trend exit. The trend exit
  // is the normal way out; the bracket covers gaps while software is down.
  stopFraction:0.80,
  targetMultiple:1.6,
  // A daily bar closes at 00:00 UTC. Allow the next fetch some slack.
  maxBarAgeSeconds:26*3600,
});

const DAY=86400;
const finite=value=>typeof value==='number'&&Number.isFinite(value);

// Coinbase Exchange candle rows are [time, low, high, open, close, volume],
// where time is the bar start. Objects with the same fields are also accepted.
export function normalizeDaily(rows){
  if(!Array.isArray(rows))throw Error('Daily candles must be an array');
  const bars=new Map();
  for(const row of rows){
    const bar=Array.isArray(row)?{time:row[0],low:row[1],high:row[2],open:row[3],close:row[4],volume:row[5]}:row;
    if(!bar||![bar.time,bar.low,bar.high,bar.open,bar.close].every(finite)||bar.time%DAY!==0||bar.low<=0||bar.high<bar.low||bar.close<=0||bar.open<=0)throw Error('Invalid daily candle');
    const prior=bars.get(bar.time);
    if(prior&&(prior.close!==bar.close||prior.high!==bar.high||prior.low!==bar.low))throw Error('Conflicting daily candle');
    bars.set(bar.time,{time:bar.time,low:bar.low,high:bar.high,open:bar.open,close:bar.close,volume:finite(bar.volume)?bar.volume:0});
  }
  return [...bars.values()].sort((a,b)=>a.time-b.time);
}

export function completedDaily(rows,now,policy=TREND_POLICY){
  if(!finite(now))throw Error('Signal time required');
  const bars=normalizeDaily(rows).filter(bar=>bar.time+DAY<=now);
  const need=policy.smaDays+1;
  if(bars.length<need)throw Error('Insufficient completed daily history');
  const recent=bars.slice(-need);
  for(let i=1;i<recent.length;i++)if(recent[i].time-recent[i-1].time!==DAY)throw Error('Daily history has a gap');
  const last=recent.at(-1);
  if(now-(last.time+DAY)>policy.maxBarAgeSeconds)throw Error('Latest completed daily bar is stale');
  return bars;
}

// held: whether the book currently owns the product. The band gives the
// signal hysteresis: enter above sma*(1+band), exit below sma*(1-band).
export function trendSignal({product,candles,held=false,now,fetchedAt=null,policy=TREND_POLICY}){
  const base={product,policyId:policy.id,held:!!held,fetchedAt};
  try{
    if(!policy.products.includes(product))throw Error('Product is outside the trend policy');
    const bars=completedDaily(candles,now,policy),last=bars.at(-1),window=bars.slice(-policy.smaDays);
    const sma=window.reduce((sum,bar)=>sum+bar.close,0)/window.length;
    const ranges=bars.slice(-(policy.atrDays+1));
    let trueRange=0;
    for(let i=1;i<ranges.length;i++)trueRange+=Math.max(ranges[i].high-ranges[i].low,Math.abs(ranges[i].high-ranges[i-1].close),Math.abs(ranges[i].low-ranges[i-1].close));
    const atr=trueRange/policy.atrDays,upper=sma*(1+policy.band),lower=sma*(1-policy.band),close=last.close;
    const long=held?close>lower:close>upper;
    const action=held?(long?'hold':'exit'):(long?'enter':'wait');
    return {...base,status:'ready',barTime:last.time,barClosedAt:last.time+DAY,close,sma,upper,lower,atr,
      distance:close/sma-1,state:long?'long':'flat',action,
      signalId:`${policy.id}:${product}:${last.time}`,
      stop:close*policy.stopFraction,target:close*policy.targetMultiple,
      reason:action==='enter'?'Close is above the 100-day average plus the entry band':
        action==='hold'?'Close remains above the 100-day average less the exit band':
        action==='exit'?'Close fell below the 100-day average less the exit band':
        'Close is not above the 100-day average plus the entry band'};
  }catch(error){
    return {...base,status:'unavailable',state:'unknown',action:'wait',reason:error.message};
  }
}

export function trendView({candles={},held=[],now,fetchedAt={},policy=TREND_POLICY}){
  const owned=new Set(held);
  return policy.products.map(product=>trendSignal({product,candles:candles[product]??[],held:owned.has(product),now,fetchedAt:fetchedAt[product]??null,policy}));
}
