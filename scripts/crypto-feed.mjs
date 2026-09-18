import {PRODUCTS,POLICY} from '../dashboard/crypto-strategies-core.mjs';
const finite=Number.isFinite;
const STABLE_BASES=new Set(['USDC','USDT','DAI','PYUSD','GUSD','PAX','TUSD','FDUSD','EURC','USDS','USD1','USDP']);
function number(v){return v!==null&&v!==undefined&&v!==''&&finite(Number(v))?Number(v):null;}
function normalizeLevels(rows){if(!Array.isArray(rows)||!rows.length)throw Error('Empty order book');return rows.map(r=>{const p=number(r?.[0]),q=number(r?.[1]);if(!(p>0&&q>0))throw Error('Malformed order-book level');return [p,q];});}
function productEligible(p){
  const base=String(p?.base_currency||'').toUpperCase(),id=String(p?.id||'');
  if(p?.quote_currency!=='USD'||`${base}-USD`!==id||p?.status!=='online'||p?.trading_disabled)return false;
  if(STABLE_BASES.has(base))return false;
  if(/(?:BULL|BEAR|[23][LS])$/.test(base))return false;
  return /^[A-Z0-9][A-Z0-9.-]{0,20}-USD$/.test(id);
}
function cacheByProduct(cached){return new Map((cached||[]).filter(m=>m?.product).map(m=>[m.product,m]));}
export async function collectCoinbaseMarkets({cached=[],fetcher=fetch,clock=()=>Date.now()/1000,pace=210,products=null,requiredProducts=[],maxMarkets=40,preselect=52}={}){
  let nextRequest=0;const errors=[],cache=cacheByProduct(cached),methodCalls=[];
  async function get(url){
    const at=Math.max(Date.now(),nextRequest);nextRequest=at+pace;if(at>Date.now())await new Promise(resolve=>setTimeout(resolve,at-Date.now()));
    const options={method:'GET',headers:{'User-Agent':'MoffittMoney/6.0 public paper research'},signal:AbortSignal.timeout(10000)};methodCalls.push({url,method:'GET'});
    const response=await fetcher(url,options);if(!response.ok)throw Error(`Public market data HTTP ${response.status}`);return response.json();
  }
  const baseUrl='https://api.exchange.coinbase.com/products';
  let discovered=[],explicit=Array.isArray(products)&&products.length>0;
  if(explicit){
    for(const product of [...new Set(products)]){
      try{const p=await get(`${baseUrl}/${encodeURIComponent(product)}`);if(p.id!==product||p.quote_currency!=='USD'||`${p.base_currency}-USD`!==product)throw Error('Returned product identity does not match the requested USD market');discovered.push(p);}
      catch(error){errors.push({product,message:error.message,stage:'product'});const prior=cache.get(product);if(prior)discovered.push({id:product,base_currency:product.slice(0,-4),quote_currency:'USD',status:'online',trading_disabled:false,base_increment:String(prior.increment||.000001),base_min_size:String(prior.minSize||prior.increment||.000001),min_market_funds:String(prior.minNotional||10),_metadataError:error.message});}
    }
  }else{
    const rows=await get(baseUrl);if(!Array.isArray(rows))throw Error('Coinbase product discovery returned no list');discovered=rows.filter(productEligible);
  }
  const required=new Set(['BTC-USD',...requiredProducts].filter(x=>typeof x==='string'));
  const stats=[];
  for(let i=0;i<discovered.length;i+=4){
    const part=await Promise.all(discovered.slice(i,i+4).map(async p=>{
      const prior=cache.get(p.id);try{
        const s=await get(`${baseUrl}/${encodeURIComponent(p.id)}/stats`),volume=number(s.volume),last=number(s.last),quoteVolume=volume&&last?volume*last:(prior?.quoteVolume24h||0);
        return {product:p.id,meta:p,quoteVolume24h:quoteVolume||0,statsAt:clock()};
      }catch(error){errors.push({product:p.id,message:error.message,stage:'stats'});return {product:p.id,meta:p,quoteVolume24h:prior?.quoteVolume24h||0,statsAt:prior?.statsAt||null};}
    }));stats.push(...part);
  }
  stats.sort((a,b)=>b.quoteVolume24h-a.quoteVolume24h||a.product.localeCompare(b.product));
  let selectedStats=explicit?stats:stats.slice(0,Math.max(preselect,maxMarkets));
  for(const product of required){const row=stats.find(s=>s.product===product);if(row&&!selectedStats.some(s=>s.product===product))selectedStats.push(row);}
  const collected=[];
  for(let i=0;i<selectedStats.length;i+=3){
    const batch=await Promise.all(selectedStats.slice(i,i+3).map(async row=>{
      const product=row.product,prior=cache.get(product),p=row.meta;
      try{
        if(!explicit&&!productEligible(p))throw Error('Product is not eligible for USD spot research');
        if(p.status!=='online'||p.trading_disabled)throw Error('Product currently unavailable for trading');
        const increment=number(p.base_increment)??prior?.increment;if(!(increment>0))throw Error('Missing public quantity increment');
        const last=prior?.candles?.filter(b=>Array.isArray(b)&&finite(b[0])&&b[0]+3600<=clock()).sort((a,b)=>b[0]-a[0])[0];
        const canReuse=prior&&!prior.sourceError&&last&&clock()-(last[0]+3600)<3600&&prior.candles.length>=60;
        const candles=canReuse?prior.candles:await get(`${baseUrl}/${encodeURIComponent(product)}/candles?granularity=3600`);
        if(!Array.isArray(candles)||candles.length<60)throw Error('Insufficient public hourly history');
        const requestAt=clock(),book=await get(`${baseUrl}/${encodeURIComponent(product)}/book?level=2`),receivedAt=clock();
        const bids=normalizeLevels(book.bids).sort((a,b)=>b[0]-a[0]).slice(0,50),asks=normalizeLevels(book.asks).sort((a,b)=>a[0]-b[0]).slice(0,50);
        const spreadBps=(asks[0][0]/bids[0][0]-1)*10000,depthUsd=bids.slice(0,10).reduce((n,[px,q])=>n+px*q,0)+asks.slice(0,10).reduce((n,[px,q])=>n+px*q,0);
        if(spreadBps>POLICY.maxSpread*10000&&!required.has(product))throw Error('Spread exceeds tournament limit');
        if(depthUsd<100&&!required.has(product))throw Error('Visible near-book depth is too small');
        return {product,status:p.status,tradingDisabled:false,candles,increment,minSize:number(p.base_min_size)??prior?.minSize??increment,
          minNotional:Math.max(10,number(p.min_market_funds)??prior?.minNotional??10),fetchedAt:canReuse?prior.fetchedAt:receivedAt,metadataAt:receivedAt,
          quoteVolume24h:row.quoteVolume24h,statsAt:row.statsAt,spreadBps,depthUsd,
          book:{bids,asks,requestAt,receivedAt,sequence:book.sequence??null,timeKind:'Public REST book retrieval time; not a guaranteed executable quote'},source:'Coinbase Exchange public API'};
      }catch(error){errors.push({product,message:error.message,stage:'market'});return prior?{...prior,sourceError:error.message}:null;}
    }));collected.push(...batch.filter(Boolean));
  }
  const usable=collected.filter(m=>!m.sourceError).sort((a,b)=>{
    const sa=Math.log1p(a.quoteVolume24h||0)+.15*Math.log1p(a.depthUsd||0)-(a.spreadBps||999)/100;
    const sb=Math.log1p(b.quoteVolume24h||0)+.15*Math.log1p(b.depthUsd||0)-(b.spreadBps||999)/100;return sb-sa||a.product.localeCompare(b.product);
  });
  let markets=[];
  if(explicit){markets=collected;}
  else{
    for(const product of required){const m=collected.find(x=>x.product===product);if(m&&!markets.some(x=>x.product===product))markets.push(m);}
    for(const m of usable){if(markets.length>=maxMarkets)break;if(!markets.some(x=>x.product===m.product))markets.push(m);}
    markets=markets.slice(0,maxMarkets);
  }
  const universe={discovered:discovered.length,statsChecked:stats.length,preselected:selectedStats.length,selected:markets.length,maxMarkets,required:[...required],
    excludedStableOrNonUsd:explicit?0:null,generatedAt:clock(),ranking:'24h USD notional, current spread and visible depth; open-position products retained'};
  return {markets,errors,universe,requests:methodCalls.length};
}
