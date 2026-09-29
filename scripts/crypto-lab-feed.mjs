// Public, unauthenticated inputs for the paper Strategy Lab. GET requests only.
// About 420 daily bars per coin are fetched in windows of at most 300 candles;
// failures are returned explicitly per product and stage, and nothing is
// substituted or fabricated here. A product whose history is only partly
// retrieved is treated as failed rather than traded on a truncated series.
import {LAB_PRODUCTS,LAB_BOOK} from '../dashboard/crypto-lab-core.mjs';
import {normalizeLevels} from './crypto-trend-feed.mjs';

const BASE='https://api.exchange.coinbase.com/products';
const DAY=86400;
const MAX_WINDOW_DAYS=280; // The API returns at most 300 candles per request.
const iso=t=>new Date(t*1000).toISOString().replace(/\.\d{3}Z$/,'Z');

// Day-aligned, non-overlapping [start,end] windows, newest first.
export function candleWindows(end,days=LAB_BOOK.historyDays,windowDays=MAX_WINDOW_DAYS){
  const first=Math.floor((end-days*DAY)/DAY)*DAY,out=[];
  for(let start=first;start<=end;start+=windowDays*DAY)out.push([start,Math.min(end,start+windowDays*DAY-1)]);
  return out.reverse();
}

export async function collectLabInputs({products=LAB_PRODUCTS,fetcher=fetch,clock=()=>Date.now()/1000,days=LAB_BOOK.historyDays,pace=250}={}){
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
      const end=clock(),rows=[];row.candlesRequestedAt=end;
      const windows=candleWindows(end,days);
      for(const [i,[start,stop]] of windows.entries()){
        const part=await get(`${BASE}/${encodeURIComponent(product)}/candles?granularity=86400&start=${iso(start)}&end=${iso(stop)}`);
        if(!Array.isArray(part))throw Error('Daily candle response was not a list');
        // The newest window must contain data; older windows may legitimately
        // be empty for a young product, which the signals report as too short.
        if(i===0&&!part.length)throw Error('Daily candle response was empty');
        for(const r of part)rows.push(Array.isArray(r)?r.slice(0,6).map(Number):r);
      }
      row.candles=rows;row.candlesReceivedAt=clock();
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
