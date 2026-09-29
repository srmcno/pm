// Public, unauthenticated inputs for the BTC/ETH daily trend paper mirror.
// GET requests only. Failures are returned explicitly per product and stage;
// nothing is substituted or fabricated here.
import {TREND_POLICY} from '../dashboard/trend-core.mjs';

const BASE='https://api.exchange.coinbase.com/products';
const DAY=86400;
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const iso=t=>new Date(t*1000).toISOString().replace(/\.\d{3}Z$/,'Z');

export function normalizeLevels(rows,side){
  if(!Array.isArray(rows)||!rows.length)throw Error('Empty order book side');
  return rows.map(r=>{const p=number(r?.[0]),q=number(r?.[1]);if(!(p>0&&q>0))throw Error('Malformed order-book level');return [p,q];})
    .sort((a,b)=>side==='bids'?b[0]-a[0]:a[0]-b[0]).slice(0,50);
}

export async function collectTrendInputs({products=TREND_POLICY.products,fetcher=fetch,clock=()=>Date.now()/1000,days=200,pace=250}={}){
  const inputs={},errors=[],calls=[];let nextRequest=0;
  async function get(url){
    const at=Math.max(Date.now(),nextRequest);nextRequest=at+pace;
    if(at>Date.now())await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    const options={method:'GET',headers:{'User-Agent':'MoffittMoney/7.1 public paper research',Accept:'application/json'},signal:AbortSignal.timeout(10000)};
    calls.push({url,method:options.method});
    const response=await fetcher(url,options);
    if(!response.ok)throw Error(`Public market data HTTP ${response.status}`);
    return response.json();
  }
  // Daily history first, then books, so candle latency never ages a quote.
  for(const product of products){
    const row={product,candles:null,candlesRequestedAt:null,candlesReceivedAt:null,candlesError:null,book:null,bookError:null};inputs[product]=row;
    try{
      const end=clock(),start=Math.floor((end-days*DAY)/DAY)*DAY;row.candlesRequestedAt=end;
      const rows=await get(`${BASE}/${encodeURIComponent(product)}/candles?granularity=86400&start=${iso(start)}&end=${iso(end)}`);
      if(!Array.isArray(rows)||!rows.length)throw Error('Daily candle response was empty');
      row.candles=rows.map(r=>Array.isArray(r)?r.slice(0,6).map(Number):r);row.candlesReceivedAt=clock();
    }catch(error){row.candlesError=error.message;errors.push({product,stage:'candles',message:error.message});}
  }
  for(const product of products){
    const row=inputs[product];
    try{
      const requestAt=clock(),raw=await get(`${BASE}/${encodeURIComponent(product)}/book?level=2`),receivedAt=clock();
      const bids=normalizeLevels(raw?.bids,'bids'),asks=normalizeLevels(raw?.asks,'asks');
      if(!(bids[0][0]<asks[0][0]))throw Error('Crossed or locked public order book');
      row.book={bids,asks,requestAt,receivedAt,sequence:raw.sequence??null,timeKind:'Public REST book retrieval time; not a guaranteed executable quote'};
    }catch(error){row.bookError=error.message;errors.push({product,stage:'book',message:error.message});}
  }
  const usable=products.filter(p=>inputs[p].candles||inputs[p].book).length;
  return {inputs,errors,requests:calls.length,calls,usable};
}
