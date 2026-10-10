// Polymarket US adapter: public market data plus signed, READ-ONLY account
// checks. Order submission is deliberately not implemented.
//
// Why no submit path (verified 2026-10-10 against docs.polymarket.us):
// the retail order API (POST https://api.polymarket.us/v1/orders) accepts no
// client-supplied order identifier. After a timeout or lost response the only
// way to find a possibly-created order is to search account activity by
// market, size and time, which cannot distinguish this worker's order from any
// other order in the account. That breaks the journal's core rule (an unknown
// outcome is reconciled by its persisted client ID and never resent), so the
// engine refuses every Polymarket US leg. The institutional API has `clordId`
// but is not a retail product. Revisit if the retail API adds an idempotency key.
//
// Signing (https://docs.polymarket.us/api-reference/authentication):
// X-PM-Signature = base64(Ed25519(timestamp_ms + METHOD + path)); the secret key
// is base64 whose first 32 bytes are the Ed25519 seed.
import {createPrivateKey,sign as cryptoSign} from 'node:crypto';

export const POLYMARKET_ORIGINS=Object.freeze({private:'https://api.polymarket.us',public:'https://gateway.polymarket.us'});
export const POLYMARKET_SUBMIT_SUPPORTED=false;
export const POLYMARKET_SUBMIT_REASON='Polymarket US retail orders have no client order ID, so an unknown submission outcome cannot be reconciled safely; Polymarket US stays scan-only.';
const SLUG=/^[a-z0-9][a-z0-9-]{0,199}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const slug=v=>{if(typeof v!=='string'||!SLUG.test(v))throw Error('Invalid Polymarket US market slug.');return v;};

export function parsePolymarketSecret(secret){
  if(typeof secret!=='string'||secret.length<40||secret.length>512||!/^[A-Za-z0-9+/=_-]+$/.test(secret))throw Error('Polymarket US secret key is not configured.');
  const bytes=Buffer.from(secret.replace(/-/g,'+').replace(/_/g,'/'),'base64');
  if(bytes.length<32)throw Error('Polymarket US secret key is invalid.');
  const der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),bytes.subarray(0,32)]);
  try{return createPrivateKey({key:der,format:'der',type:'pkcs8'});}catch{throw Error('Polymarket US secret key is invalid.');}
}
export function signPolymarket(key,timestampMs,method,path){
  if(!Number.isSafeInteger(timestampMs)||method!=='GET'||typeof path!=='string'||!path.startsWith('/v1/')||path.includes('?'))throw Error('Invalid signing input.');
  return cryptoSign(null,Buffer.from(`${timestampMs}${method}${path}`,'utf8'),key).toString('base64');
}
function route(path){
  const signed=['/v1/account/balances','/v1/portfolio/positions'];
  if(signed.includes(path))return {origin:'private',signed:true};
  let m;
  if((m=path.match(/^\/v1\/market\/slug\/([^/]+)$/))){slug(m[1]);return {origin:'public',signed:false};}
  if((m=path.match(/^\/v1\/markets\/([^/]+)\/book$/))){slug(m[1]);return {origin:'public',signed:false};}
  throw Error('Polymarket US endpoint is not permitted.');
}
export class PolymarketUSReadOnly {
  #key=null;#keyId=null;#fetcher;#timeoutMs;#maxBytes;#clock;
  get allowSubmit(){return false;}
  get canSubmit(){return POLYMARKET_SUBMIT_SUPPORTED;}
  get authenticated(){return this.#key!==null;}
  constructor({keyId,secretKey}={},{fetcher=fetch,timeoutMs=12_000,maxBytes=2_000_000,clock=()=>Date.now()/1000}={}){
    if((keyId===undefined)!==(secretKey===undefined))throw Error('Polymarket US key ID and secret must be supplied together.');
    if(keyId!==undefined){if(typeof keyId!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(keyId))throw Error('Invalid Polymarket US key ID.');this.#key=parsePolymarketSecret(secretKey);this.#keyId=keyId;}
    if(typeof fetcher!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60_000)throw Error('Invalid Polymarket US adapter configuration.');
    this.#fetcher=fetcher;this.#timeoutMs=timeoutMs;this.#maxBytes=maxBytes;this.#clock=clock;
  }
  async #get(path){
    const r=route(path);
    if(r.signed&&!this.#key)throw Error('Polymarket US credentials are not configured.');
    const headers={Accept:'application/json'};
    if(r.signed){const timestamp=Math.floor(this.#clock()*1000);headers['X-PM-Access-Key']=this.#keyId;headers['X-PM-Timestamp']=String(timestamp);headers['X-PM-Signature']=signPolymarket(this.#key,timestamp,'GET',path);}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.#timeoutMs);timer.unref?.();
    try{
      let response;try{response=await this.#fetcher(new URL(path,POLYMARKET_ORIGINS[r.origin]).href,{method:'GET',redirect:'error',cache:'no-store',headers,signal:controller.signal});}
      catch{throw Error('Polymarket US request failed or timed out.');}
      if(!response.ok){try{await response.body?.cancel?.();}catch{}throw Error(`Polymarket US returned HTTP ${Number.isInteger(response.status)?response.status:'error'}.`);}
      const text=await response.text();
      if(Buffer.byteLength(text)>this.#maxBytes)throw Error('Polymarket US response exceeded the size limit.');
      let parsed;try{parsed=JSON.parse(text);}catch{throw Error('Polymarket US returned invalid JSON.');}
      if(!object(parsed))throw Error('Polymarket US returned an invalid response envelope.');
      return parsed;
    }finally{clearTimeout(timer);}
  }
  async market(marketSlug){const raw=await this.#get(`/v1/market/slug/${slug(marketSlug)}`);if(!object(raw.market)||raw.market.slug!==marketSlug)throw Error('Polymarket US market identity mismatch.');return raw.market;}
  async book(marketSlug){const requestAt=this.#clock(),raw=await this.#get(`/v1/markets/${slug(marketSlug)}/book`),receivedAt=this.#clock();return {book:raw,requestAt,receivedAt};}
  async balances(){return this.#get('/v1/account/balances');}
  async positions(){return this.#get('/v1/portfolio/positions');}
  async create(){throw Error(POLYMARKET_SUBMIT_REASON);}
}
export default PolymarketUSReadOnly;
