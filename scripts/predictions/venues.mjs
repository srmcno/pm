import {levels,numeric,timestamp,round} from '../../dashboard/prediction-core.mjs';
export const BASE={polymarket:'https://gateway.polymarket.us/v1',kalshi:'https://api.elections.kalshi.com/trade-api/v2'};
export async function get(url) {
  const r=await fetch(url,{headers:{'User-Agent':'MoffittMoney/4.2 public paper research'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error(`HTTP ${r.status} at ${new URL(url).pathname}`);
  return r.json();
}
const e=encodeURIComponent;
export {normalizePolymarket,normalizeKalshi,effectiveKalshiFee} from '../../dashboard/prediction-venues.mjs';
export async function discoverPolymarket() {
  const result=[],seen=new Set();let pages=0;
  const min=new Date().toISOString(),max=new Date(Date.now()+7*86400000).toISOString();
  const upcoming=await Promise.allSettled(['nfl','mlb','cfb'].map(league=>get(`${BASE.polymarket}/events?active=true&closed=false&limit=12&tagSlug=${league}&startTimeMin=${e(min)}&startTimeMax=${e(max)}`)));
  for(const r of upcoming)if(r.status==='fulfilled'&&Array.isArray(r.value.events)){pages++;
    for(const event of r.value.events)for(const raw of event.markets||[])if(!seen.has(raw.slug)&&raw.closed===false){seen.add(raw.slug);result.push({raw,event});}
  }
  for(let offset=0;offset<300;offset+=100){
    const d=await get(`${BASE.polymarket}/events?active=true&closed=false&limit=100&offset=${offset}`);pages++;
    if(!Array.isArray(d.events))throw new Error('Invalid Polymarket event response');
    let added=0;
    for(const event of d.events)for(const raw of event.markets||[])if(!seen.has(raw.slug)&&raw.closed===false){seen.add(raw.slug);result.push({raw,event});added++;}
    if(d.events.length<100||!added)break;
  }
  return {rows:result,pages,limit:336};
}
export async function discoverKalshi() {
  const result=[];let cursor='',pages=0;
  for(let i=0;i<3;i++){
    const d=await get(`${BASE.kalshi}/markets?status=open&mve_filter=exclude&limit=1000${cursor?'&cursor='+e(cursor):''}`);pages++;
    if(!Array.isArray(d.markets))throw new Error('Invalid Kalshi market response');
    for(const raw of d.markets)if(!raw.mve_collection_ticker&&raw.market_type==='binary'&&numeric(raw.notional_value_dollars)===1)result.push({raw});
    if(!d.cursor||d.cursor===cursor)break;cursor=d.cursor;
  }
  return {rows:result,pages,limit:3000};
}
export async function resolvedPolymarket(slug) {
  const {market:m}=await get(`${BASE.polymarket}/market/slug/${e(slug)}`);
  if(!m?.closed||m.status!=='MARKET_STATUS_RESOLVED')return null;
  const d=await get(`${BASE.polymarket}/markets/${e(slug)}/settlement`),p=numeric(d.settlement);
  return d.slug===slug&&p!==null&&p>=0&&p<=1?{yesPayout:p,observedAt:Date.now()/1000,source:`${BASE.polymarket}/markets/${e(slug)}/settlement`}:null;
}
export async function resolvedKalshi(ticker) {
  let d;try{d=await get(`${BASE.kalshi}/markets/${e(ticker)}`);}catch(error){if(!error.message.includes('HTTP 404'))throw error;d=await get(`${BASE.kalshi}/historical/markets/${e(ticker)}`);}
  const m=d.market;if(m?.ticker!==ticker||m.status!=='finalized')return null;
  const p=numeric(m.settlement_value_dollars)??(m.result==='yes'?1:m.result==='no'?0:null);
  return p!==null&&p>=0&&p<=1?{yesPayout:p,observedAt:Date.now()/1000,source:`${BASE.kalshi}/markets/${e(ticker)}`}:null;
}
