import {createPrivateKey,randomBytes,sign} from 'node:crypto';
const HOST='api.coinbase.com';
const BASE='/api/v3/brokerage';
const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
export function jwt(method,path,{keyName,privateKey},now=Math.floor(Date.now()/1000)){
 if(!keyName||!privateKey)throw Error('Private Coinbase ECDSA credentials are not configured.');
 const key=createPrivateKey(privateKey.replaceAll('\\n','\n'));
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('Coinbase requires an ECDSA P-256 key.');
 const head=encode({alg:'ES256',typ:'JWT',kid:keyName,nonce:randomBytes(16).toString('hex')}),body=encode({iss:'cdp',sub:keyName,nbf:now,exp:now+120,uri:`${method} ${HOST}${path}`});
 const input=`${head}.${body}`,signature=sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');return `${input}.${signature}`;
}
export class CoinbasePreview {
 constructor(credentials,{fetcher=fetch}={}){this.credentials=credentials;this.fetcher=fetcher;}
 async request(method,path,body){
  // This adapter deliberately has no order-submission, transfer or cancel path.
  if(!((method==='GET'&&path===`${BASE}/transaction_summary`)||(method==='POST'&&path===`${BASE}/orders/preview`)))throw Error('Endpoint is not permitted by the preview adapter.');
  const r=await this.fetcher(`https://${HOST}${path}`,{method,redirect:'error',headers:{Authorization:`Bearer ${jwt(method,path,this.credentials)}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`Coinbase ${method==='GET'?'fee lookup':'preview'} returned HTTP ${r.status}. No order was sent.`);
  const text=await r.text();if(text.length>2e6)throw Error('Coinbase response exceeded size limit.');return JSON.parse(text);
 }
 async fees(){const r=await this.request('GET',`${BASE}/transaction_summary`),tier=r.fee_tier;
  const parse=v=>typeof v==='string'&&v.trim()!==''?Number(v):NaN;
  const maker=parse(tier?.maker_fee_rate),taker=parse(tier?.taker_fee_rate);
  if(![maker,taker].every(n=>Number.isFinite(n)&&n>=0&&n<.1))throw Error('Account fee tier unavailable or outside the supported range.');
  return {makerRate:maker,takerRate:taker,checkedAt:Date.now()/1000,source:'Coinbase authenticated transaction summary'};
 }
 async preview(product,quoteBudget,fee){
  if(!/^[A-Z0-9][A-Z0-9.-]{0,20}-USD$/.test(product)||!Number.isFinite(quoteBudget)||quoteBudget<=0||quoteBudget>1000||!Number.isFinite(fee)||fee<0||fee>=.1)throw Error('Invalid bounded spot preview.');
  const quote=(Math.floor(quoteBudget/(1+fee)*100)/100).toFixed(2);
  const r=await this.request('POST',`${BASE}/orders/preview`,{product_id:product,side:'BUY',order_configuration:{market_market_ioc:{quote_size:quote}}});
  const amount=v=>v!==null&&v!==undefined&&String(v).trim()!==''?Number(v):NaN;
  const commission=amount(r.commission_total),total=amount(r.order_total);
  if(!Array.isArray(r.errs)||r.errs.length||!Number.isFinite(commission)||commission<0||!Number.isFinite(total)||total<=0)throw Error('Order preview failed or returned incomplete costs. No order was sent.');
  // Conservatively reserve commission separately even if a venue total includes it.
  if(Math.max(total,Number(quote))+commission>quoteBudget+.000001)throw Error('Preview exceeds the fee-inclusive allocation cap.');
  return {product,side:'BUY',quoteSize:Number(quote),commission,total,budget:quoteBudget,warnings:Array.isArray(r.warning)?r.warning:[],at:Date.now()/1000,orderSubmitted:false};
 }
}
