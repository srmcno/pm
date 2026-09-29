import {TREND_POLICY} from '../../dashboard/trend-core.mjs';

// Public Coinbase Exchange daily bars for the trend policy. A product's prior
// bars are kept when a refresh fails; fetch times are never restamped.
const BASE='https://api.exchange.coinbase.com/products',DAY=86400;
export class TrendFeed {
  #fetcher;#clock;#cache=new Map();#pending=null;#lastAttempt=-Infinity;
  constructor({fetcher=fetch,clock=()=>Date.now()/1000,policy=TREND_POLICY}={}){this.#fetcher=fetcher;this.#clock=clock;this.policy=policy;}
  #due(product,now){
    const prior=this.#cache.get(product);if(!prior)return true;
    const latestClose=Math.floor(now/DAY)*DAY,newest=prior.candles.reduce((max,row)=>Math.max(max,row[0]),0);
    // Refresh hourly, and promptly once a new UTC daily bar has closed.
    return now-prior.fetchedAt>=3600||(newest+DAY<latestClose&&now-prior.fetchedAt>=300);
  }
  async #fetchProduct(product){
    const requestAt=this.#clock(),end=Math.floor(requestAt/DAY)*DAY,start=end-200*DAY;
    const url=`${BASE}/${encodeURIComponent(product)}/candles?granularity=${DAY}&start=${new Date(start*1000).toISOString()}&end=${new Date(end*1000).toISOString()}`;
    const response=await this.#fetcher(url,{method:'GET',headers:{'User-Agent':'MoffittMoney/7 private trend worker'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error(`Public daily candles HTTP ${response.status}`);
    const rows=await response.json();
    if(!Array.isArray(rows)||!rows.length||rows.length>400)throw Error('Public daily candles are empty or malformed');
    const candles=rows.filter(row=>Array.isArray(row)&&row.length>=5&&row.slice(0,5).every(Number.isFinite)&&row[0]%DAY===0&&row[0]+DAY<=requestAt);
    if(candles.length<this.policy.smaDays+1)throw Error('Public daily history is too short');
    this.#cache.set(product,{candles,fetchedAt:requestAt});
  }
  // Starts a background refresh when due; never blocks the broker loop.
  refresh(){
    const now=this.#clock();
    if(this.#pending||now-this.#lastAttempt<60)return false;
    const due=this.policy.products.filter(product=>this.#due(product,now));
    if(!due.length)return false;
    this.#lastAttempt=now;
    this.#pending=(async()=>{for(const product of due){try{await this.#fetchProduct(product);}catch{}}})().finally(()=>{this.#pending=null;});
    return true;
  }
  async finish(){await this.#pending;}
  snapshot(){
    const candles={},fetchedAt={};
    for(const [product,row] of this.#cache){candles[product]=row.candles;fetchedAt[product]=row.fetchedAt;}
    return {policyId:this.policy.id,candles,fetchedAt};
  }
}
