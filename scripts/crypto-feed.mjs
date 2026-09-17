import {PRODUCTS} from '../dashboard/crypto-strategies-core.mjs';
const finite=Number.isFinite;
function number(v){return v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;}
function normalizeLevels(rows){
  if(!Array.isArray(rows)||!rows.length)throw Error('Empty order book');
  return rows.map(r=>{const p=number(r?.[0]),q=number(r?.[1]);if(!(p>0&&q>0))throw Error('Malformed order-book level');return [p,q];});
}
// Public GET only. Fetch injection exists for deterministic offline adapter tests.
export async function collectCoinbaseMarkets({cached=[],fetcher=fetch,clock=()=>Date.now()/1000,pace=210,products=PRODUCTS}={}){
  let nextRequest=0;const errors=[],markets=[];
  async function get(url){
    const at=Math.max(Date.now(),nextRequest);nextRequest=at+pace;
    if(at>Date.now())await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    const response=await fetcher(url,{method:'GET',headers:{'User-Agent':'MoffittMoney/5.4 public paper research'},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error(`Public market data HTTP ${response.status}`);return response.json();
  }
  for(let i=0;i<products.length;i+=2){
    const batch=await Promise.all(products.slice(i,i+2).map(async product=>{
      const prior=cached.find(m=>m.product===product);
      try{
        if(!PRODUCTS.includes(product))throw Error('Product is not in the paper universe');
        const base=`https://api.exchange.coinbase.com/products/${product}`;
        const info=await get(base);
        if(info.id!==product||info.quote_currency!=='USD'||`${info.base_currency}-USD`!==product)throw Error('Returned product identity does not match the requested USD market');
        if(info.status!=='online'||info.trading_disabled)throw Error('Product currently unavailable for trading');
        const increment=number(info.base_increment);
        if(!(increment>0))throw Error('Missing public quantity increment');
        const last=prior?.candles?.filter(b=>Array.isArray(b)&&finite(b[0])&&b[0]+3600<=clock()).sort((a,b)=>b[0]-a[0])[0];
        const canReuse=prior&&!prior.sourceError&&last&&clock()-(last[0]+3600)<3600&&prior.candles.length>=60;
        const candles=canReuse?prior.candles:await get(`${base}/candles?granularity=3600`);
        if(!Array.isArray(candles)||candles.length<60)throw Error('Insufficient public hourly history');
        const requestAt=clock(),book=await get(`${base}/book?level=2`),receivedAt=clock();
        const bids=normalizeLevels(book.bids).sort((a,b)=>b[0]-a[0]).slice(0,50),asks=normalizeLevels(book.asks).sort((a,b)=>a[0]-b[0]).slice(0,50);
        return {product,status:info.status,tradingDisabled:false,candles,increment,minSize:number(info.base_min_size)??increment,
          minNotional:Math.max(10,number(info.min_market_funds)??10),fetchedAt:canReuse?prior.fetchedAt:receivedAt,
          metadataAt:receivedAt,book:{bids,asks,requestAt,receivedAt,sequence:book.sequence??null,
            timeKind:'Public REST book retrieval time; not a guaranteed executable quote'},source:'Coinbase Exchange public API'};
      }catch(error){errors.push({product,message:error.message});return {...(prior||{product,candles:[],status:'unavailable'}),sourceError:error.message};}
    }));markets.push(...batch);
  }
  return {markets,errors};
}
