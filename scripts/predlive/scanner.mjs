// Public-data scanner: finds candidate packages and re-reads books on demand.
// It never uses credentials and never mutates anything.
import {D} from '../live/risk.mjs';
import {kalshiBook,fromPaperMarket,complementOpportunity,crossVenueOpportunities,multiOutcomeOpportunity} from './arb.mjs';

const META_TTL=3600;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const activeBinary=m=>m?.status==='active'&&m.market_type==='binary'&&num(m.notional_value_dollars)===1;

export class KalshiScanner {
  #kalshi;#clock;#pause;#meta=new Map();#series=new Map();#fees=new Map();
  // A short pause between public pages stays well inside the Basic read budget.
  constructor({kalshi,clock=()=>Date.now()/1000,pause=ms=>new Promise(r=>setTimeout(r,ms))}){this.#kalshi=kalshi;this.#clock=clock;this.#pause=pause;}
  async #seriesFor(ticker){
    const now=this.#clock(),c=this.#series.get(ticker);
    if(c&&now-c.at<META_TTL)return c.value;
    const raw=await this.#kalshi.series(ticker);if(!raw?.series||raw.series.ticker!==ticker)throw Error('Kalshi series identity mismatch');
    this.#series.set(ticker,{at:now,value:raw.series});return raw.series;
  }
  async #feesFor(eventTicker){
    const now=this.#clock(),c=this.#fees.get(eventTicker);
    if(c&&now-c.at<META_TTL)return c.value;
    const value=await this.#kalshi.feeChanges(eventTicker);this.#fees.set(eventTicker,{at:now,value});
    if(this.#fees.size>2000)for(const [k,v] of this.#fees)if(now-v.at>=META_TTL)this.#fees.delete(k);
    return value;
  }
  /** Evaluate one event from fresh books. */
  async evaluateEvent(event,options){
    const markets=(event.markets||[]).filter(activeBinary);
    if(!markets.length)return [];
    const tickers=markets.map(m=>m.ticker).slice(0,100);
    const [series,feeChanges]=await Promise.all([this.#seriesFor(event.series_ticker),this.#feesFor(event.event_ticker)]);
    const {books,requestAt,receivedAt}=await this.#kalshi.orderbooks(tickers);
    this.#meta.set(event.event_ticker,{at:this.#clock(),event});
    if(this.#meta.size>2000)for(const [k,v] of this.#meta)if(this.#clock()-v.at>=META_TTL)this.#meta.delete(k);
    const normalized=markets.filter(m=>books.has(m.ticker)).map(market=>kalshiBook({market,event,series,feeChanges,orderbook:books.get(market.ticker),requestAt,receivedAt}));
    const evaluated={...options,now:this.#clock()};
    const out=normalized.map(book=>complementOpportunity(book,evaluated));
    if(event.mutually_exclusive===true&&(event.markets||[]).length===markets.length){
      const multi=multiOutcomeOpportunity({...event,markets},normalized,evaluated);if(multi)out.push(multi);
    }
    return out;
  }
  /** Bounded scan of open events. Listing quotes only choose which events get
   * fresh books; every evaluated opportunity uses books read just now. */
  async scan(options,{maxPages=100,maxEvents=25,deadline=this.#clock()+240}={}){
    // Pages are screened as they arrive and then discarded, so memory stays
    // bounded by one page plus the shortlisted candidate events.
    const errors=[],ranked=[];let cursor='',pages=0,events=0,meEvents=0;
    // Reviewed exhaustive series first: those are the only multi-outcome packages that can trade.
    const reviewed=new Set(options?.exhaustiveSeries??[]);
    const order=(a,b)=>(reviewed.has(b.event.series_ticker)-reviewed.has(a.event.series_ticker))||a.score-b.score;
    for(;pages<maxPages&&this.#clock()<deadline;pages++){
      if(pages)await this.#pause(250);
      let raw;try{raw=await this.#kalshi.events({cursor});}catch(error){errors.push(error.message);break;}
      if(!Array.isArray(raw.events)){errors.push('Invalid Kalshi event page');break;}
      events+=raw.events.length;
      for(const event of raw.events){
        if(event?.mutually_exclusive===true)meEvents++;
        const markets=(event?.markets||[]).filter(activeBinary);if(!markets.length||!event.event_ticker||!event.series_ticker)continue;
        const yes=markets.map(m=>num(m.yes_ask_dollars)),no=markets.map(m=>num(m.no_ask_dollars));
        // Complement gap: a crossed listing on any market.
        const crossed=markets.some((m,i)=>yes[i]>0&&no[i]>0&&yes[i]+no[i]<1);
        let multi=Infinity;
        if(event.mutually_exclusive===true&&markets.length===(event.markets||[]).length&&markets.length>=2&&yes.every(v=>v>0&&v<1))multi=yes.reduce((a,b)=>a+b,0);
        if(crossed||multi<1)ranked.push({event,score:crossed?-1:multi});
      }
      ranked.sort(order);ranked.splice(maxEvents*4);
      if(typeof raw.cursor!=='string'||!raw.cursor||raw.cursor===cursor)break;cursor=raw.cursor;
    }
    const candidates=ranked.length;
    const opportunities=[];let evaluated=0;
    for(const {event} of ranked.slice(0,maxEvents)){
      if(this.#clock()>=deadline){errors.push('Scan time budget exhausted');break;}
      await this.#pause(100);
      try{opportunities.push(...await this.evaluateEvent(event,options));evaluated++;}catch(error){errors.push(`${event.event_ticker}: ${error.message}`);}
    }
    return {opportunities,errors,coverage:{pages,events,mutuallyExclusiveEvents:meEvents,candidates,evaluatedEvents:evaluated}};
  }
  /** Re-read books for one Kalshi opportunity and re-evaluate the same package. */
  async refresh(opportunity,options){
    const eventTickers=[...new Set(opportunity.legs.map(l=>l.eventTicker))];
    if(eventTickers.length!==1||!eventTickers[0])return null;
    const cached=this.#meta.get(eventTickers[0]);
    if(!cached||this.#clock()-cached.at>=META_TTL)return null;
    const result=(await this.evaluateEvent(cached.event,options)).find(o=>o.key===opportunity.key);
    return result??null;
  }
}

/** Cross-venue candidates from the existing paper matcher (public data only). */
export async function scanCrossVenue(options,{collect}={}){
  const collectPairs=collect??(await import('../predictions/arbitrage.mjs')).collectPairs;
  const accounts={polymarket:{cash:100,equity:100,positions:[]},kalshi:{cash:100,equity:100,positions:[]}};
  const result=await collectPairs(accounts,Date.now()/1000+180,{});
  const opportunities=[];
  for(const pair of result.pairs||[]){
    const [a,b]=(pair.markets||[]).map(fromPaperMarket);
    if(!a||!b)continue;
    opportunities.push(...crossVenueOpportunities(a,b,options));
  }
  return {opportunities,errors:(result.errors||[]).map(e=>e.message??String(e)),coverage:{pairs:(result.pairs||[]).length}};
}

/** Public settlement value for a Kalshi market, or null while unresolved. */
export function kalshiSettlement(kalshi){
  return async ticker=>{
    const raw=await kalshi.market(ticker),m=raw?.market;
    if(m?.ticker!==ticker||!['finalized','settled'].includes(m.status))return null;
    let value=null;
    try{if(typeof m.settlement_value_dollars==='string')value=D(m.settlement_value_dollars);}catch{}
    if(value===null)value=m.result==='yes'?D('1'):m.result==='no'?D('0'):null;
    return value===null?null:{value:String(m.settlement_value_dollars??(m.result==='yes'?'1':'0')),at:Date.parse(m.settlement_ts??m.close_time)/1000||null};
  };
}
