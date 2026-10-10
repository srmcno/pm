// Private Kalshi Trade API v2 adapter. Least privilege: a fixed route allowlist,
// immediate-only buy orders (fill-or-kill / immediate-or-cancel), no resting
// orders, no cancel, amend, transfer, withdrawal or key-management mutation.
// Request signing: KALSHI-ACCESS-SIGNATURE = base64(sign(timestamp_ms + METHOD +
// /trade-api/v2/path-without-query)); RSA keys use RSA-PSS/SHA-256 with a
// digest-length salt, Ed25519 keys sign the same text directly.
// https://docs.kalshi.com/getting_started/api_keys
import {createPrivateKey,sign as cryptoSign,constants} from 'node:crypto';

export const KALSHI_HOSTS=Object.freeze({
  production:'https://external-api.kalshi.com',
  demo:'https://external-api.demo.kalshi.co',
});
export const API_ROOT='/trade-api/v2';
const TICKER=/^[A-Z0-9][A-Z0-9._-]{0,99}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PRICE=/^0\.\d{1,4}$/;
const COUNT=/^[1-9]\d{0,4}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const ticker=v=>{if(typeof v!=='string'||!TICKER.test(v))throw Error('Invalid Kalshi ticker.');return v;};
const identifier=v=>{if(typeof v!=='string'||!ID.test(v))throw Error('Invalid Kalshi identifier.');return v;};
function keys(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unsupported Kalshi request field.');}

/** Parse a PEM private key from an environment variable. Escaped newlines from
 * hosting dashboards are accepted. The key type comes from the parsed key, not
 * the PEM header (PKCS#8 RSA and Ed25519 share a header). */
export function parseKalshiKey(pem){
  if(typeof pem!=='string'||pem.length<64||pem.length>16384)throw Error('Kalshi private key is not configured.');
  let key;
  try{key=createPrivateKey(pem.includes('\\n')?pem.replace(/\\n/g,'\n'):pem);}catch{throw Error('Kalshi private key could not be parsed.');}
  if(key.asymmetricKeyType==='rsa'){if((key.asymmetricKeyDetails?.modulusLength??0)<2048)throw Error('Kalshi RSA key must be at least 2048 bits.');}
  else if(key.asymmetricKeyType!=='ed25519')throw Error('Kalshi key must be RSA or Ed25519.');
  return key;
}
export function signKalshi(key,timestampMs,method,path){
  if(!Number.isSafeInteger(timestampMs)||!['GET','POST'].includes(method)||typeof path!=='string'||!path.startsWith(API_ROOT+'/')||path.includes('?'))throw Error('Invalid signing input.');
  const message=Buffer.from(`${timestampMs}${method}${path}`,'utf8');
  const signature=key.asymmetricKeyType==='ed25519'?cryptoSign(null,message,key)
    :cryptoSign('sha256',message,{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST});
  return signature.toString('base64');
}

/** The only order body this adapter can send: a buy of one outcome, priced in
 * Kalshi's V2 YES-leg vocabulary, that cannot rest on the book. */
export function validateOrderBody(body){
  keys(body,['ticker','client_order_id','side','count','price','time_in_force','self_trade_prevention_type','post_only','reduce_only','cancel_order_on_pause']);
  ticker(body.ticker);identifier(body.client_order_id);
  if(!['bid','ask'].includes(body.side))throw Error('Order side must be bid (buy YES) or ask (buy NO).');
  if(typeof body.count!=='string'||!COUNT.test(body.count))throw Error('Order count must be a whole number of contracts.');
  if(typeof body.price!=='string'||!PRICE.test(body.price)||Number(body.price)<=0||Number(body.price)>=1)throw Error('Order price must be a decimal strictly between 0 and 1.');
  if(!['fill_or_kill','immediate_or_cancel'].includes(body.time_in_force))throw Error('Only fill-or-kill or immediate-or-cancel orders are permitted.');
  if(body.self_trade_prevention_type!=='taker_at_cross')throw Error('Self-trade prevention must cancel the taker.');
  if(body.post_only!==false||typeof body.reduce_only!=='boolean'||body.cancel_order_on_pause!==true)throw Error('Order flags are not the permitted values.');
  if(body.reduce_only&&body.time_in_force!=='immediate_or_cancel')throw Error('Reduce-only orders must be immediate-or-cancel.');
  return body;
}

// Route allowlist. signed:false routes are public market data and never carry
// credentials. Query keys are explicitly listed per route.
function route(method,path){
  if(method==='POST'){if(path==='/portfolio/events/orders')return {signed:true,query:[]};throw Error('Kalshi endpoint is not permitted.');}
  if(method!=='GET')throw Error('Kalshi method is not permitted.');
  const fixed={
    '/api_keys':{signed:true,query:[]},
    '/portfolio/balance':{signed:true,query:[]},
    '/portfolio/orders':{signed:true,query:['ticker','min_ts','limit','cursor']},
    '/portfolio/fills':{signed:true,query:['order_id','limit','cursor']},
    '/events':{signed:false,query:['status','with_nested_markets','limit','cursor']},
    '/markets/orderbooks':{signed:false,query:['tickers']},
    '/events/fee_changes':{signed:false,query:['event_ticker','limit']},
  };
  if(Object.hasOwn(fixed,path))return fixed[path];
  let m;
  if((m=path.match(/^\/portfolio\/orders\/([^/]+)$/))){identifier(m[1]);return {signed:true,query:[]};}
  if((m=path.match(/^\/markets\/([^/]+)$/))){ticker(m[1]);return {signed:false,query:[]};}
  if((m=path.match(/^\/events\/([^/]+)$/))){ticker(m[1]);return {signed:false,query:['with_nested_markets']};}
  if((m=path.match(/^\/series\/([^/]+)$/))){ticker(m[1]);return {signed:false,query:[]};}
  throw Error('Kalshi endpoint is not permitted.');
}

async function boundedJson(response,maxBytes){
  const length=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(length)&&length>maxBytes){try{await response.body?.cancel?.();}catch{}throw Error('Kalshi response exceeded the size limit.');}
  let text;
  if(response.body?.getReader){
    const reader=response.body.getReader(),parts=[];let bytes=0;
    try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw Error('Kalshi response exceeded the size limit.');}parts.push(Buffer.from(part.value));}}
    finally{reader.releaseLock();}
    text=Buffer.concat(parts).toString('utf8');
  }else{text=await response.text();if(Buffer.byteLength(text)>maxBytes)throw Error('Kalshi response exceeded the size limit.');}
  let parsed;try{parsed=JSON.parse(text);}catch{throw Error('Kalshi returned invalid JSON.');}
  if(!object(parsed))throw Error('Kalshi returned an invalid response envelope.');
  return parsed;
}

export class KalshiLive {
  #key=null;#keyId=null;#allowSubmit;#fetcher;#maxBytes;#timeoutMs;#clock;#origin;
  get allowSubmit(){return this.#allowSubmit;}
  get canSubmit(){return this.#allowSubmit&&this.#key!==null;}
  get authenticated(){return this.#key!==null;}
  get keyId(){return this.#keyId;}
  constructor({keyId,privateKey,allowSubmit=false,environment='production'}={},{fetcher=fetch,maxBytes=8_000_000,timeoutMs=15_000,clock=()=>Date.now()/1000}={}){
    if(!Object.hasOwn(KALSHI_HOSTS,environment))throw Error('Unknown Kalshi environment.');
    if((keyId===undefined)!==(privateKey===undefined))throw Error('Kalshi key ID and private key must be supplied together.');
    if(keyId!==undefined){
      if(typeof keyId!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(keyId))throw Error('Invalid Kalshi key ID.');
      this.#key=parseKalshiKey(privateKey);this.#keyId=keyId;
    }
    if(typeof allowSubmit!=='boolean'||(allowSubmit&&!this.#key))throw Error('Live submission requires Kalshi credentials.');
    if(typeof fetcher!=='function'||!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>10_000_000||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60_000)throw Error('Invalid Kalshi adapter configuration.');
    this.#allowSubmit=allowSubmit;this.#fetcher=fetcher;this.#maxBytes=maxBytes;this.#timeoutMs=timeoutMs;this.#clock=clock;this.#origin=KALSHI_HOSTS[environment];
  }
  async #send(method,path,{query={},body}={}){
    const allowed=route(method,path);
    if(!object(query))throw Error('Invalid Kalshi query.');
    for(const key of Object.keys(query))if(!allowed.query.includes(key))throw Error('Unsupported Kalshi query field.');
    if(allowed.signed&&!this.#key)throw Error('Kalshi credentials are not configured.');
    const url=new URL(API_ROOT+path,this.#origin);
    for(const [key,value] of Object.entries(query)){
      const values=Array.isArray(value)?value:[value];
      if(!values.length||values.length>100)throw Error('Invalid Kalshi query.');
      for(const v of values){
        if(!['string','number','boolean'].includes(typeof v)||String(v).length>512)throw Error('Invalid Kalshi query.');
        if(key==='tickers'||key==='ticker'||key==='event_ticker')ticker(String(v));
        if(key==='order_id')identifier(String(v));
        if(key==='limit'&&(!Number.isInteger(v)||v<1||v>1000))throw Error('Invalid Kalshi page size.');
        if(key==='min_ts'&&(!Number.isInteger(v)||v<0))throw Error('Invalid Kalshi timestamp.');
        url.searchParams.append(key,String(v));
      }
    }
    const payload=body===undefined?undefined:JSON.stringify(body);
    if(payload&&Buffer.byteLength(payload)>4096)throw Error('Kalshi request exceeded the size limit.');
    const headers={Accept:'application/json'};
    if(payload)headers['Content-Type']='application/json';
    if(allowed.signed){
      const timestamp=Math.floor(this.#clock()*1000);
      let signature;try{signature=signKalshi(this.#key,timestamp,method,API_ROOT+path);}catch{throw Error('Kalshi request signing failed.');}
      headers['KALSHI-ACCESS-KEY']=this.#keyId;headers['KALSHI-ACCESS-TIMESTAMP']=String(timestamp);headers['KALSHI-ACCESS-SIGNATURE']=signature;
    }
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.#timeoutMs);timer.unref?.();
    try{
      let response;
      try{response=await this.#fetcher(url.href,{method,redirect:'error',cache:'no-store',headers,body:payload,signal:controller.signal});}
      catch{throw Error(method==='POST'?'Kalshi order response unavailable; outcome unknown. Reconcile the persisted intent.':'Kalshi request failed or timed out.');}
      if(!response.ok){
        try{await response.body?.cancel?.();}catch{}
        const status=Number.isInteger(response.status)?response.status:'error';
        const error=Error(`Kalshi returned HTTP ${status}${method==='POST'?'; reconcile the persisted intent before any further action':''}.`);error.status=status;throw error;
      }
      try{return await boundedJson(response,this.#maxBytes);}
      catch(error){
        if(controller.signal.aborted)throw Error('Kalshi response timed out; reconcile any pending order.');
        if(/^Kalshi (?:response exceeded|returned invalid)/.test(error.message))throw error;
        throw Error('Kalshi response could not be read; reconcile any pending order.');
      }
    }finally{clearTimeout(timer);}
  }
  // ---- Public market data (unsigned) ----
  async events({cursor,limit=100}={}){return this.#send('GET','/events',{query:{status:'open',with_nested_markets:true,limit,...(cursor?{cursor}:{})}});}
  async event(eventTicker){return this.#send('GET',`/events/${ticker(eventTicker)}`,{query:{with_nested_markets:true}});}
  async market(marketTicker){return this.#send('GET',`/markets/${ticker(marketTicker)}`);}
  async series(seriesTicker){return this.#send('GET',`/series/${ticker(seriesTicker)}`);}
  async feeChanges(eventTicker){
    const raw=await this.#send('GET','/events/fee_changes',{query:{event_ticker:ticker(eventTicker),limit:1000}});
    if(!Array.isArray(raw.event_fee_changes)||raw.cursor)throw Error('Incomplete Kalshi fee override response.');
    return raw.event_fee_changes;
  }
  /** Books for up to 100 markets in one request, with request/receipt times. */
  async orderbooks(tickers){
    if(!Array.isArray(tickers)||!tickers.length||tickers.length>100||new Set(tickers).size!==tickers.length)throw Error('Invalid Kalshi orderbook request.');
    tickers.forEach(ticker);
    const requestAt=this.#clock(),raw=await this.#send('GET','/markets/orderbooks',{query:{tickers}}),receivedAt=this.#clock();
    if(!Array.isArray(raw.orderbooks))throw Error('Invalid Kalshi orderbook response.');
    const books=new Map();
    for(const row of raw.orderbooks){if(!object(row)||!tickers.includes(row.ticker)||books.has(row.ticker)||!object(row.orderbook_fp))throw Error('Kalshi orderbook identity mismatch.');books.set(row.ticker,row.orderbook_fp);}
    return {books,requestAt,receivedAt};
  }
  // ---- Authenticated reads ----
  async keyScopes(){
    const raw=await this.#send('GET','/api_keys');
    if(!Array.isArray(raw.api_keys))throw Error('Kalshi key listing is incomplete.');
    const own=raw.api_keys.filter(k=>k?.api_key_id===this.#keyId);
    if(own.length!==1||!Array.isArray(own[0].scopes)||own[0].scopes.some(s=>typeof s!=='string'))throw Error('Kalshi key scopes could not be verified.');
    return {scopes:[...own[0].scopes],subaccount:Number.isInteger(own[0].subaccount)?own[0].subaccount:null};
  }
  async balance(){
    const raw=await this.#send('GET','/portfolio/balance');
    if(typeof raw.balance_dollars!=='string'||!/^\d+(?:\.\d{1,6})?$/.test(raw.balance_dollars))throw Error('Kalshi balance is unavailable or invalid.');
    return {balance:raw.balance_dollars,checkedAt:this.#clock()};
  }
  async order(orderId){
    const raw=await this.#send('GET',`/portfolio/orders/${identifier(orderId)}`);
    if(!object(raw.order)||raw.order.order_id!==orderId)throw Error('Kalshi order identity mismatch.');
    return raw.order;
  }
  /** Orders for one market created at or after minTs, all pages (bounded). */
  async ordersFor(marketTicker,minTs,{maxPages=10}={}){
    ticker(marketTicker);const rows=new Map(),seen=new Set();let cursor='';
    for(let page=0;page<maxPages;page++){
      const raw=await this.#send('GET','/portfolio/orders',{query:{ticker:marketTicker,min_ts:Math.max(0,Math.floor(minTs)),limit:200,...(cursor?{cursor}:{})}});
      if(!Array.isArray(raw.orders))throw Error('Kalshi order listing is incomplete.');
      for(const row of raw.orders){if(!object(row)||typeof row.order_id!=='string')throw Error('Kalshi order row has no identity.');rows.set(row.order_id,row);}
      if(typeof raw.cursor!=='string'||!raw.cursor)return [...rows.values()];
      if(seen.has(raw.cursor))throw Error('Kalshi pagination did not advance.');
      seen.add(raw.cursor);cursor=raw.cursor;
    }
    throw Error('Kalshi order pagination limit reached; reconciliation is incomplete.');
  }
  async fills(orderId,{maxPages=10}={}){
    identifier(orderId);const rows=new Map(),seen=new Set();let cursor='';
    for(let page=0;page<maxPages;page++){
      const raw=await this.#send('GET','/portfolio/fills',{query:{order_id:orderId,limit:200,...(cursor?{cursor}:{})}});
      if(!Array.isArray(raw.fills))throw Error('Kalshi fill listing is incomplete.');
      for(const row of raw.fills){
        const id=row?.fill_id??row?.trade_id;
        if(!object(row)||typeof id!=='string'||row.order_id!==orderId)throw Error('Kalshi fill identity mismatch.');
        const prior=rows.get(id);if(prior&&JSON.stringify(prior)!==JSON.stringify(row))throw Error('Kalshi fill changed during pagination.');
        rows.set(id,row);
      }
      if(typeof raw.cursor!=='string'||!raw.cursor)return [...rows.values()];
      if(seen.has(raw.cursor))throw Error('Kalshi pagination did not advance.');
      seen.add(raw.cursor);cursor=raw.cursor;
    }
    throw Error('Kalshi fill pagination limit reached; reconciliation is incomplete.');
  }
  // ---- The single mutation ----
  async create(body){
    if(!this.#allowSubmit||!this.#key)throw Error('Live Kalshi submission is disabled.');
    const request=structuredClone(validateOrderBody(body));
    return this.#send('POST','/portfolio/events/orders',{body:request});
  }
}
export default KalshiLive;
