import {jwt} from '../execution/coinbase.mjs';

const BASE='/api/v3/brokerage', ORIGIN='https://api.coinbase.com';
const PRODUCT=/^[A-Z0-9][A-Z0-9.]{0,20}-USD$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DECIMAL=/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=v=>typeof v==='string'&&v.length<=48&&DECIMAL.test(v)&&Number.isFinite(Number(v))&&Number(v)>0;
const productId=id=>{if(typeof id!=='string'||!PRODUCT.test(id))throw Error('Only canonical USD spot product IDs are supported.');return id;};
const identifier=id=>{if(typeof id!=='string'||!ID.test(id))throw Error('Invalid broker identifier.');return id;};
function keys(value,allowed){
 if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unsupported request field.');
}

// Money limits and inventory ownership belong to the durable runner. This
// boundary independently prohibits leverage, transfers and other order types.
export function validateOrderBody(body,{create=false,portfolioId}={}){
 keys(body,['product_id','side','client_order_id','order_configuration','attached_order_configuration','preview_id','retail_portfolio_id']);
 productId(body.product_id);
 if(!['BUY','SELL'].includes(body.side))throw Error('Order side must be BUY or SELL.');
 if(create||body.client_order_id!==undefined)identifier(body.client_order_id);
 if(body.preview_id!==undefined)identifier(body.preview_id);
 if(body.retail_portfolio_id!==undefined&&(!portfolioId||body.retail_portfolio_id!==portfolioId))throw Error('Order portfolio does not match the configured portfolio.');
 const config=body.order_configuration;
 if(!object(config)||Object.keys(config).length!==1)throw Error('Exactly one supported order configuration is required.');
 const type=Object.keys(config)[0],order=config[type];
 if(type==='market_market_ioc')keys(order,['quote_size','base_size']);
 else if(type==='sor_limit_ioc')keys(order,['quote_size','base_size','limit_price']);
 else if(type==='limit_limit_gtc')keys(order,['quote_size','base_size','limit_price','post_only']);
 else if(type==='trigger_bracket_gtc'&&body.side==='SELL')keys(order,['base_size','limit_price','stop_trigger_price']);
 else throw Error('Unsupported spot order configuration.');
 if(Number(order.base_size!==undefined)+Number(order.quote_size!==undefined)!==1)throw Error('Specify exactly one positive order size.');
 if(!positive(order.base_size??order.quote_size))throw Error('Order size must be a positive decimal string.');
 if(body.side==='SELL'&&order.base_size===undefined)throw Error('Spot sells require a base quantity.');
 if(type!=='market_market_ioc'&&!positive(order.limit_price))throw Error('A positive decimal limit price is required.');
 if(order.post_only!==undefined&&typeof order.post_only!=='boolean')throw Error('Invalid post-only setting.');
 if(type==='trigger_bracket_gtc'&&(!positive(order.stop_trigger_price)||Number(order.stop_trigger_price)>=Number(order.limit_price)))throw Error('Bracket stop must be positive and below the take-profit price.');
 if(body.attached_order_configuration!==undefined){
  if(body.side!=='BUY'||type==='trigger_bracket_gtc')throw Error('Attached protective brackets require a buy order.');
  keys(body.attached_order_configuration,['trigger_bracket_gtc']);
  const bracket=body.attached_order_configuration.trigger_bracket_gtc;
  // Coinbase inherits the filled originating size; an attached size is invalid.
  keys(bracket,['limit_price','stop_trigger_price']);
  if(!positive(bracket.limit_price)||!positive(bracket.stop_trigger_price)||Number(bracket.stop_trigger_price)>=Number(bracket.limit_price))throw Error('Invalid attached protective bracket.');
 }
 return body;
}

export function normalizeFees(raw,now=Date.now()/1000){
 const parse=v=>typeof v==='string'&&v.trim()!==''?Number(v):NaN;
 const makerRate=parse(raw?.fee_tier?.maker_fee_rate),takerRate=parse(raw?.fee_tier?.taker_fee_rate);
 if(![makerRate,takerRate].every(n=>Number.isFinite(n)&&n>=0&&n<.1))throw Error('Coinbase account fee rates are unavailable or invalid.');
 return {makerRate,takerRate,checkedAt:now,source:'Coinbase authenticated transaction summary',raw};
}

function route(method,path){
 if(method==='GET'){
  const fixed={
   [`${BASE}/key_permissions`]:[],
   [`${BASE}/accounts`]:['limit','cursor'],
   [`${BASE}/transaction_summary`]:['product_type'],
   [`${BASE}/product_book`]:['product_id','limit'],
   [`${BASE}/orders/historical/batch`]:['product_type','product_ids','limit','cursor'],
   [`${BASE}/orders/historical/fills`]:['order_ids','limit','cursor'],
  };
  if(Object.hasOwn(fixed,path))return fixed[path];
  if(path.startsWith(`${BASE}/products/`)){productId(path.slice(`${BASE}/products/`.length));return ['get_tradability_status'];}
  if(path.startsWith(`${BASE}/orders/historical/`)){identifier(path.slice(`${BASE}/orders/historical/`.length));return [];}
 }
 if(method==='POST'&&[`${BASE}/orders/preview`,`${BASE}/orders`,`${BASE}/orders/batch_cancel`].includes(path))return [];
 throw Error('Endpoint is not permitted by the private spot adapter.');
}

async function boundedJson(response,maxBytes){
 const length=Number(response.headers?.get?.('content-length'));
 if(Number.isFinite(length)&&length>maxBytes){await response.body?.cancel?.().catch(()=>{});throw Error('Coinbase response exceeded the size limit.');}
 let text;
 if(response.body?.getReader){
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw Error('Coinbase response exceeded the size limit.');}parts.push(Buffer.from(part.value));}}
  finally{reader.releaseLock();}
  text=Buffer.concat(parts).toString('utf8');
 }else{
  text=await response.text();if(Buffer.byteLength(text)>maxBytes)throw Error('Coinbase response exceeded the size limit.');
 }
 let parsed;try{parsed=JSON.parse(text);}catch{throw Error('Coinbase returned invalid JSON.');}
 if(!object(parsed))throw Error('Coinbase returned an invalid response envelope.');
 return parsed;
}

export class CoinbaseLive {
 #credentials; #portfolioId; #allowSubmit; #fetcher; #maxPages; #maxBytes; #timeoutMs; #clock;
 get allowSubmit(){return this.#allowSubmit;}
 get portfolioId(){return this.#portfolioId;}
 constructor({keyName,privateKey,portfolioId,allowSubmit=false},{fetcher=fetch,maxPages=20,maxBytes=2_000_000,timeoutMs=15_000,clock=()=>Date.now()/1000}={}){
  if(typeof keyName!=='string'||typeof privateKey!=='string'||!keyName||!privateKey)throw Error('Private Coinbase credentials are not configured.');
  if(portfolioId!==undefined)identifier(portfolioId);
  if(typeof allowSubmit!=='boolean'||typeof fetcher!=='function'||!Number.isInteger(maxPages)||maxPages<1||maxPages>100||!Number.isInteger(maxBytes)||maxBytes<128||maxBytes>10_000_000||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw Error('Invalid private broker configuration.');
  this.#credentials={keyName,privateKey};this.#portfolioId=portfolioId;this.#allowSubmit=allowSubmit;this.#fetcher=fetcher;this.#maxPages=maxPages;this.#maxBytes=maxBytes;this.#timeoutMs=timeoutMs;this.#clock=clock;
 }
 async #send(method,path,body,query={}){
  const allowed=route(method,path);keys(query,allowed);
  const url=new URL(path,ORIGIN);
  for(const [key,value] of Object.entries(query)){
   if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')throw Error('Invalid broker query.');
   if(String(value).length>2048)throw Error('Broker query exceeded the size limit.');
   if(key==='product_type'&&value!=='SPOT')throw Error('Only spot history and fees are permitted.');
   if(key==='product_id'||key==='product_ids')productId(value);
   if(key==='order_ids')identifier(value);
   if(key==='get_tradability_status'&&value!==true)throw Error('Account tradability must be requested.');
   if(key==='limit'&&(!Number.isInteger(value)||value<1||value>250))throw Error('Invalid pagination limit.');
   url.searchParams.set(key,String(value));
  }
  const payload=body===undefined?undefined:JSON.stringify(body);
  if(payload&&Buffer.byteLength(payload)>16_384)throw Error('Broker request exceeded the size limit.');
  let authorization;try{authorization=`Bearer ${jwt(method,path,this.#credentials,Math.floor(this.#clock()))}`;}catch{throw Error('Coinbase signing configuration is invalid.');}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.#timeoutMs);timer.unref?.();
  let response;
  try{
   try{response=await this.#fetcher(url.href,{method,redirect:'error',cache:'no-store',headers:{Authorization:authorization,'Content-Type':'application/json'},body:payload,signal:controller.signal});}
   catch{throw Error(method==='POST'?'Coinbase mutation response unavailable; outcome unknown. Reconcile the persisted intent.':'Coinbase request failed or timed out.');}
   if(!response.ok){try{await response.body?.cancel?.();}catch{}throw Error(`Coinbase returned HTTP ${Number.isInteger(response.status)?response.status:'error'}${method==='POST'?'; reconcile the persisted intent before retrying':''}.`);}
   let data;try{data=await boundedJson(response,this.#maxBytes);}catch(error){
    // Do not expose response text or nested fetch/crypto errors to logs.
    if(controller.signal.aborted)throw Error('Coinbase response timed out; reconcile any pending mutation.');
    if(/^Coinbase (?:response exceeded|returned invalid JSON|returned an invalid response)/.test(error.message))throw error;
    throw Error('Coinbase response could not be read; reconcile any pending mutation.');
   }
   if(data.proof_token_required===true)throw Error('Coinbase requires additional authentication; history is incomplete.');
   return data;
  }finally{clearTimeout(timer);}
 }
 async request(method,path,body,query={}){
  route(method,path);
  if(method==='POST'){
   if(Object.keys(query).length)throw Error('Mutation queries are not permitted.');
   if(path===`${BASE}/orders`)return this.create(body);
   if(path===`${BASE}/orders/preview`)return this.preview(body);
   keys(body,['order_ids']);return this.cancel(body.order_ids);
  }
  if(body!==undefined)throw Error('GET request bodies are not permitted.');
  return this.#send(method,path,undefined,query);
 }
 async permissions(){
  const raw=await this.#send('GET',`${BASE}/key_permissions`);
  if(!['can_view','can_trade','can_transfer'].every(k=>typeof raw[k]==='boolean')||typeof raw.portfolio_uuid!=='string')throw Error('Coinbase key permissions are incomplete.');
  if(this.#portfolioId&&raw.portfolio_uuid!==this.#portfolioId)throw Error('Coinbase key belongs to a different portfolio.');
  return raw;
 }
 async #pages(path,field,idField,query,hasNext){
  const rows=new Map(),seenCursors=new Set();let cursor='',last;
  for(let i=0;i<this.#maxPages;i++){
   last=await this.#send('GET',path,undefined,{...query,limit:100,...(cursor?{cursor}:{})});
   if(!Array.isArray(last[field])||(hasNext&&typeof last.has_next!=='boolean'))throw Error('Coinbase pagination envelope is incomplete.');
   for(const row of last[field]){
    if(!object(row)||typeof row[idField]!=='string'||!row[idField])throw Error('Coinbase history row has no stable identity.');
    if(this.#portfolioId&&row.retail_portfolio_id!==this.#portfolioId)throw Error('Coinbase history row belongs to an unexpected portfolio.');
    const previous=rows.get(row[idField]);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(row))throw Error('Coinbase history changed during pagination; reconciliation is incomplete.');
    rows.set(row[idField],row);
   }
   const more=hasNext?last.has_next:(typeof last.cursor==='string'&&last.cursor.length>0);
   if(!hasNext&&last.cursor!==undefined&&typeof last.cursor!=='string')throw Error('Coinbase returned an invalid fill cursor.');
   if(!more)return {...last,[field]:[...rows.values()],...(hasNext?{has_next:false}:{}),cursor:''};
   if(typeof last.cursor!=='string'||!last.cursor||seenCursors.has(last.cursor))throw Error('Coinbase pagination did not advance; reconciliation is incomplete.');
   seenCursors.add(last.cursor);cursor=last.cursor;
  }
  throw Error('Coinbase pagination limit reached; reconciliation is incomplete.');
 }
 accounts(){return this.#pages(`${BASE}/accounts`,'accounts','uuid',{},true);}
 async fees(){return normalizeFees(await this.#send('GET',`${BASE}/transaction_summary`,undefined,{product_type:'SPOT'}),this.#clock());}
 async product(id){
  productId(id);const raw=await this.#send('GET',`${BASE}/products/${id}`,undefined,{get_tradability_status:true});
  if(raw.product_id!==id||raw.product_type!=='SPOT'||raw.quote_currency_id!=='USD'||raw.base_currency_id!==id.slice(0,-4))throw Error('Coinbase product is not the requested USD spot instrument.');
  return raw;
 }
 async book(id){
  productId(id);const requestAt=this.#clock(),raw=await this.#send('GET',`${BASE}/product_book`,undefined,{product_id:id,limit:50}),receivedAt=this.#clock(),p=raw.pricebook;
  if(!object(p)||p.product_id!==id)throw Error('Coinbase book identity mismatch.');
  const normalize=(levels,direction)=>{
   if(!Array.isArray(levels)||!levels.length||levels.length>250)throw Error('Coinbase order book is empty or invalid.');
   return levels.map(level=>{if(!positive(level?.price)||!positive(level?.size))throw Error('Coinbase order book level is invalid.');return [Number(level.price),Number(level.size)];}).sort((a,b)=>direction*(a[0]-b[0]));
  };
  const bids=normalize(p.bids,-1),asks=normalize(p.asks,1),bookAt=typeof p.time==='string'?Date.parse(p.time)/1000:NaN;
  if(bids[0][0]>asks[0][0]||!Number.isFinite(bookAt)||bookAt>receivedAt+5||receivedAt-bookAt>30||receivedAt-requestAt>30)throw Error('Coinbase order book is crossed or stale.');
  return {...raw,product:id,bids,asks,bid:bids[0][0],ask:asks[0][0],requestAt,receivedAt,bookAt};
 }
 async #checkProductForOrder(body){
  const p=await this.product(body.product_id),type=Object.keys(body.order_configuration)[0];
  if(p.status!=='online'||['is_disabled','trading_disabled','cancel_only','view_only','auction_mode'].some(k=>p[k]!==false))throw Error('Coinbase product is not currently tradable.');
  if(type==='market_market_ioc'&&(p.limit_only!==false||p.post_only!==false))throw Error('Coinbase product does not permit market orders.');
  if(type!=='market_market_ioc'&&p.post_only!==false&&body.order_configuration[type].post_only!==true)throw Error('Coinbase product requires post-only orders.');
 }
 async preview(body){
  const request=structuredClone(validateOrderBody(body,{portfolioId:this.#portfolioId}));
  await this.#checkProductForOrder(request);
  return this.#send('POST',`${BASE}/orders/preview`,request);
 }
 async create(body){
  if(!this.#allowSubmit)throw Error('Live order submission is disabled.');
  const request=structuredClone(validateOrderBody(body,{create:true,portfolioId:this.#portfolioId}));
  if(!this.#portfolioId)throw Error('Live submission requires a configured portfolio.');
  const permissions=await this.permissions();
  if(!permissions.can_view||!permissions.can_trade)throw Error('Coinbase key lacks view or trade permission.');
  await this.#checkProductForOrder(request);
  return this.#send('POST',`${BASE}/orders`,request);
 }
 async order(id){
  identifier(id);const raw=await this.#send('GET',`${BASE}/orders/historical/${id}`);
  if(!object(raw.order)||raw.order.order_id!==id||(this.#portfolioId&&raw.order.retail_portfolio_id!==this.#portfolioId))throw Error('Coinbase order identity or portfolio mismatch.');
  return raw;
 }
 orders({product}={}){
  if(product!==undefined)productId(product);
  return this.#pages(`${BASE}/orders/historical/batch`,'orders','order_id',{product_type:'SPOT',...(product?{product_ids:product}:{})},true);
 }
 async fills(orderId){
  identifier(orderId);const raw=await this.#pages(`${BASE}/orders/historical/fills`,'fills','entry_id',{order_ids:orderId},false);
  if(raw.fills.some(fill=>fill.order_id!==orderId))throw Error('Coinbase fill belongs to a different order.');
  return raw;
 }
 async cancel(orderIds){
  if(!this.#allowSubmit)throw Error('Live order cancellation is disabled.');
  if(!Array.isArray(orderIds)||!orderIds.length||orderIds.length>100||new Set(orderIds).size!==orderIds.length)throw Error('Invalid cancellation batch.');
  const ids=[...orderIds];ids.forEach(identifier);
  if(!this.#portfolioId)throw Error('Cancellation requires a configured portfolio.');
  // Query each ID before mutation so another portfolio or non-spot instrument
  // cannot be cancelled through this restricted adapter.
  for(const id of ids){const {order}=await this.order(id);productId(order.product_id);if(order.product_type!=='SPOT')throw Error('Only spot orders can be cancelled.');}
  return this.#send('POST',`${BASE}/orders/batch_cancel`,{order_ids:ids});
 }
}

export {CoinbaseLive as CoinbaseBroker};
export default CoinbaseLive;
