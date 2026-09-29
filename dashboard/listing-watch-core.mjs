// Listing Watch: pure, browser-safe accounting for public Coinbase listing and
// delisting observations. Nothing here performs I/O, reads credentials, places
// an order or opens a paper position. The collector supplies public responses
// and a clock; every function returns a new state and never mutates its input.
//
// Time semantics: every timestamp is epoch seconds. `at` is when this collector
// READ a source, never when Coinbase changed it. A change is reported together
// with `since`, the previous successful read of the same source, so the true
// change time lies in (since, at]. Source-published times (incident updates,
// Advanced Trade new_at) keep their own values.

export const POLICY_ID='2026-09-29-listing-watch-v1';
export const AVOID_DAYS=90;
export const LIMITS=Object.freeze({
  transitions:250,          // global recent transition log
  transitionsPerProduct:12, // per-product history (first-seen entry is always kept)
  events:{listing:120,suspension:60,other:20},
  textChars:280,
  effectiveKeepDays:30,     // an executed suspension stays on the watchlist this long
  launches:200,             // launch summaries kept; older ones are dropped
  candleLaunches:12,        // newest launches that keep their 1-minute rows in state
  candleWindow:86400,       // 24 hours after the first observed non-auction trading state
  candleChunk:300,          // candles per public request (API maximum)
  candleRequestsPerRun:4,
  candleSafety:120,         // only minutes that ended at least this long ago are read
  statusListings:7,
  minProducts:50,           // a feed smaller than this is a parse failure, not a market
  maxNewPerRead:40,
});
export const SOURCES=Object.freeze({
  exchange:{label:'Exchange product list',url:'https://api.exchange.coinbase.com/products'},
  brokerage:{label:'Advanced Trade listing feed',url:'https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT'},
  status:{label:'Exchange status incidents',url:'https://status.exchange.coinbase.com/api/v2/incidents.json'},
  candles:{label:'1-minute launch candles',url:'https://api.exchange.coinbase.com/products/{id}/candles?granularity=60'},
});
export const SOURCE_KEYS=Object.freeze(Object.keys(SOURCES));

// Static, labeled result of an earlier offline study. It is never a live value.
export const HISTORICAL_STUDY=Object.freeze({
  label:'Historical study, not live results',
  sample:'216 Coinbase listings, June 2023 to August 2026, from public Coinbase daily candles. Survivors only.',
  feesRoundTrip:.018,
  rows:Object.freeze([
    {hold:'Buy at the first daily open, sell at day 1 close',mean:.026,median:-.016,win:.41},
    {hold:'Hold to day 8',mean:-.069,median:-.136,win:.27},
    {hold:'Hold to day 31',mean:-.144,median:-.261,win:.25},
  ]),
  peak:{median:.15,withinDays:3},
  fromDay1Close:{day8:-.13,day91:-.40},
  phases:'Coinbase opens a listing in phases, hours apart: an auction of at least 10 minutes with a single opening price for everyone, then limit-only trading, then full trading.',
  notes:Object.freeze([
    'Results are after a 1.8% round-trip taker fee (0.9% each way). Mean and median differ because a few large winners lift the mean.',
    'Coins touched a median +15% above the open within three days, but that intraday peak cannot be captured, so it is not a tradable result.',
    'Survivorship makes real results worse: coins that were delisted or lost their data are missing from the sample.',
    'From the day 1 close, median returns were −13% at day 8 and −40% at day 91. That is why products first seen within 90 days are flagged to avoid.',
  ]),
});

const DAY=86400,MIN=60;
const floorMinute=t=>Math.floor(t/MIN)*MIN;
const isNum=v=>typeof v==='number'&&Number.isFinite(v);
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const ID=/^[A-Za-z0-9]{1,20}-[A-Za-z0-9]{1,10}$/;
const clone=v=>structuredClone(v);
const short=(s,n=200)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,n);
const baseOf=id=>String(id).split('-')[0].toUpperCase();
const quoteOf=id=>String(id).split('-')[1]?.toUpperCase()||'';

// ---------------------------------------------------------------- state
export function initialListingWatch(now){
  if(!isNum(now))throw Error('A start time is required');
  const source=()=>({lastAttemptAt:null,lastOkAt:null,lastError:null,lastErrorAt:null,failures:0,count:null,skipped:0});
  return {version:1,policyId:POLICY_ID,mode:'observation',realEnabled:false,startedAt:now,updatedAt:now,
    sources:{exchange:source(),brokerage:source(),status:source(),candles:{...source(),idle:false}},
    exchange:{baselineAt:null,products:{}},brokerage:{baselineAt:null,products:{}},
    transitions:[],events:[],watchlist:[],launches:{},
    counters:{launches:0,transitions:0,events:0}};
}

export function validateListingWatch(s){
  const bad=why=>{throw Error(`Listing Watch state is invalid (${why}); refusing to reset`);};
  if(!s||typeof s!=='object'||Array.isArray(s))bad('not an object');
  if(s.policyId!==POLICY_ID)throw Error('Listing Watch policy changed; an explicit migration is required, refusing to reset');
  if(s.mode!=='observation'||s.realEnabled!==false)bad('execution lock');
  if(!isNum(s.startedAt)||!isNum(s.updatedAt))bad('times');
  for(const k of SOURCE_KEYS)if(!s.sources?.[k]||typeof s.sources[k]!=='object')bad(`source ${k}`);
  for(const k of ['exchange','brokerage'])if(!s[k]||typeof s[k].products!=='object'||Array.isArray(s[k].products))bad(`${k} registry`);
  for(const k of ['transitions','events','watchlist'])if(!Array.isArray(s[k]))bad(k);
  if(!s.launches||typeof s.launches!=='object'||Array.isArray(s.launches))bad('launches');
  if(!s.counters||![s.counters.launches,s.counters.transitions,s.counters.events].every(isNum))bad('counters');
  return true;
}

export function recordSourceFailure(state,key,message,at){
  if(!SOURCE_KEYS.includes(key))throw Error(`Unknown source ${key}`);
  const s=clone(state),src=s.sources[key];
  src.lastAttemptAt=at;src.lastError=short(message,240)||'Source unavailable';src.lastErrorAt=at;src.failures=(src.failures||0)+1;
  return s;
}
function recordSourceSuccess(s,key,at,extra={}){
  const src=s.sources[key];
  Object.assign(src,{lastAttemptAt:at,lastOkAt:at,lastError:null,failures:0},extra);
}
export function sourceStatus(src){
  if(!src)return 'pending';
  if(src.lastError)return 'error';
  if(src.idle)return 'idle';
  return isNum(src.lastOkAt)?'ok':'pending';
}

// ---------------------------------------------------- product state tracking
const EXCHANGE_DEFAULTS=Object.freeze({status:'online',trading_disabled:false,cancel_only:false,post_only:false,limit_only:false,auction_mode:false,status_message:''});
const BROKERAGE_DEFAULTS=Object.freeze({new:false,is_disabled:false,view_only:false});
const FLAGS=['trading_disabled','cancel_only','post_only','limit_only','auction_mode'];
const NEW_AT_PLACEHOLDER=Date.parse('2023-01-01T00:00:00Z')/1000;

export function phaseOfExchange(a){
  const status=a.status||'online';
  if(status==='delisted')return 'delisted';
  if(status!=='online')return status==='offline'?'offline':String(status);
  if(a.trading_disabled)return 'disabled';
  if(a.cancel_only)return 'cancel-only';
  if(a.auction_mode)return 'auction';
  if(a.limit_only)return 'limit-only';
  if(a.post_only)return 'post-only';
  return 'full';
}
// Phases in which matches can occur. Auction and post-only books do not trade, so they never open the candle window.
export const TRADING_PHASES=Object.freeze(['limit-only','full']);

function readExchange(rec){
  if(!rec||typeof rec!=='object'||typeof rec.id!=='string'||!ID.test(rec.id))return null;
  const attrs={};
  if(typeof rec.status==='string')attrs.status=short(rec.status,24);
  for(const k of FLAGS)if(typeof rec[k]==='boolean')attrs[k]=rec[k];
  if(typeof rec.status_message==='string')attrs.status_message=short(rec.status_message,120);
  return {id:rec.id.toUpperCase(),attrs};
}
function readBrokerage(rec){
  const id=rec?.product_id;
  if(!rec||typeof rec!=='object'||typeof id!=='string'||!ID.test(id))return undefined;
  if(!(rec.quote_currency_id==='USD'||/-USD$/i.test(id)))return undefined; // only USD products are tracked; not a parse failure
  const attrs={};
  for(const [from,to] of [['new','new'],['is_disabled','is_disabled'],['view_only','view_only']])if(typeof rec[from]==='boolean')attrs[to]=rec[from];
  const newAt=typeof rec.new_at==='string'?Date.parse(rec.new_at)/1000:NaN;
  // Coinbase stamps older products with a 2023-01-01 placeholder; that is not a listing time.
  const extra=isNum(newAt)&&newAt!==NEW_AT_PLACEHOLDER?{newAt:Math.floor(newAt)}:{};
  return {id:id.toUpperCase(),attrs,extra};
}
const SOURCE_CFG={
  exchange:{defaults:EXCHANGE_DEFAULTS,read:readExchange,label:a=>phaseOfExchange(a)},
  brokerage:{defaults:BROKERAGE_DEFAULTS,read:readBrokerage,label:a=>a.is_disabled?'disabled':a.view_only?'view-only':'listed'},
};
const fullAttrs=(cfg,entry)=>({...cfg.defaults,...(entry?.a||{})});
const compactAttrs=(cfg,full)=>Object.fromEntries(Object.entries(full).filter(([k,v])=>v!==cfg.defaults[k]));

function capHistory(list,n){
  if(list.length<=n)return list;
  return list[0]?.field==='first-seen'?[list[0],...list.slice(-(n-1))]:list.slice(-n);
}
function logTransition(s,srcKey,entry,id,t){
  entry.tr=capHistory([...(entry.tr||[]),t],LIMITS.transitionsPerProduct);
  s.transitions.unshift({id,src:srcKey,...t});
  s.transitions.length=Math.min(s.transitions.length,LIMITS.transitions);
  s.counters.transitions+=1;
}
// Bases that currently have a live product. A delisted asset that returns is a new launch.
export function liveBases(state){
  const out=new Set();
  for(const [id,e] of Object.entries(state.exchange.products)){
    if(e.absent)continue;
    if(!['delisted','offline','disabled'].includes(phaseOfExchange(fullAttrs(SOURCE_CFG.exchange,e))))out.add(baseOf(id));
  }
  for(const [id,e] of Object.entries(state.brokerage.products))if(!e.absent&&!e.a?.is_disabled)out.add(baseOf(id));
  return out;
}

function trackSource(s,key,records,at,{knownBases}={}){
  if(!Array.isArray(records))throw Error(`${SOURCES[key].label} was not a list`);
  const cfg=SOURCE_CFG[key],reg=s[key],since=s.sources[key].lastOkAt,baseline=reg.baselineAt==null;
  const rows=new Map();let skipped=0;
  for(const rec of records){const r=cfg.read(rec);if(r===undefined)continue;if(!r){skipped+=1;continue;}rows.set(r.id,r);}
  const present=Object.values(reg.products).filter(e=>!e.absent).length;
  if(rows.size<LIMITS.minProducts)throw Error(`${SOURCES[key].label} returned only ${rows.size} usable products (${skipped} unreadable); refusing to apply it`);
  if(!baseline&&rows.size<present*.5)throw Error(`${SOURCES[key].label} shrank from ${present} to ${rows.size} products; refusing to apply it`);
  const ids=[...rows.keys()].sort(),fresh=ids.filter(id=>!has(reg.products,id));
  if(!baseline&&fresh.length>LIMITS.maxNewPerRead)throw Error(`${SOURCES[key].label} added ${fresh.length} products at once; refusing to apply it`);
  const missing=Object.keys(reg.products).filter(id=>!rows.has(id)&&!reg.products[id].absent).sort();
  if(!baseline&&missing.length>Math.max(25,present*.1))throw Error(`${SOURCES[key].label} dropped ${missing.length} products at once; refusing to apply it`);
  const newIds=[],changed=[];
  for(const id of ids){
    const r=rows.get(id);
    if(!has(reg.products,id)){
      const entry={firstSeenAt:at,a:compactAttrs(cfg,{...cfg.defaults,...r.attrs}),changedAt:at};
      if(r.extra?.newAt)entry.newAt=r.extra.newAt;
      if(baseline)entry.baseline=true;
      reg.products[id]=entry;
      if(!baseline){
        newIds.push(id);
        logTransition(s,key,entry,id,{at,since,field:'first-seen',from:null,to:cfg.label({...cfg.defaults,...r.attrs})});
      }
      continue;
    }
    const entry=reg.products[id],before=fullAttrs(cfg,entry),after={...before,...r.attrs};
    if(r.extra?.newAt&&!entry.newAt)entry.newAt=r.extra.newAt;
    if(entry.absent){
      delete entry.absent;
      logTransition(s,key,entry,id,{at,since,field:'presence',from:'absent',to:'present'});
      changed.push(id);
    }
    let any=false;
    for(const field of Object.keys(cfg.defaults))if(before[field]!==after[field]){
      any=true;logTransition(s,key,entry,id,{at,since,field,from:before[field],to:after[field]});
    }
    if(any){entry.a=compactAttrs(cfg,after);entry.changedAt=at;changed.push(id);}
  }
  if(!baseline)for(const id of missing){
    const entry=reg.products[id];entry.absent=true;entry.changedAt=at;changed.push(id);
    logTransition(s,key,entry,id,{at,since,field:'presence',from:'present',to:'absent'});
  }
  if(baseline)reg.baselineAt=at;
  return {newIds,changed,skipped,count:rows.size,baseline,since,knownBases};
}

function makeLaunch(s,id,kind,init){
  const base=baseOf(id),quote=quoteOf(id),eligible=kind==='asset-launch'&&quote==='USD';
  const l={id,base,quote,kind,...init,brokerageNewAt:null,lateSeconds:null,phases:init.phases||[],tradingObservedAt:null,tradingSince:null,
    candles:eligible?{status:'pending',windowStart:null,windowEnd:null,covered:[],count:0,first:null,rows:[],conflicts:0,lastError:null}
      :{status:'skipped',reason:kind==='new-pair'?'new pair of an asset that already trades; not a listing launch':'non-USD quote; 1-minute capture is USD launches only'}};
  s.launches[id]=l;s.counters.launches+=1;
  return l;
}
function ensureLaunch(s,id,srcKey,at,since,knownBases){
  if(has(s.launches,id)){
    const l=s.launches[id];
    l.seenAt[srcKey]??=at;
    return l;
  }
  return makeLaunch(s,id,knownBases.has(baseOf(id))?'new-pair':'asset-launch',{firstSeenAt:at,firstSeenSince:since??null,firstSeenSource:srcKey,seenAt:{[srcKey]:at}});
}
// Real launches appear in the Exchange list before their auction, cancel-only, while Advanced Trade already
// flags them new. A launch in that state when collection starts is adopted so its auction, limit-only phase and
// candles are still observed. Its first appearance and earlier phases were not, and it is marked startedInProgress.
// Only baseline reads adopt; nothing before the read is backfilled.
const PRETRADING=Object.freeze(['cancel-only','auction','post-only','disabled']);
const ADOPT_NEW_DAYS=30;
function otherPairTrading(s,id){
  const base=baseOf(id);
  return Object.entries(s.exchange.products).some(([k,e])=>k!==id&&!e.absent&&baseOf(k)===base&&TRADING_PHASES.includes(phaseOfExchange(fullAttrs(SOURCE_CFG.exchange,e))));
}
function adoptInProgress(s,at,exchangeReadAt){
  for(const id of Object.keys(s.exchange.products).sort()){
    const e=s.exchange.products[id];
    if(!e.baseline||e.absent||has(s.launches,id)||!has(s.brokerage.products,id))continue;
    const phase=phaseOfExchange(fullAttrs(SOURCE_CFG.exchange,e)),b=s.brokerage.products[id];
    if(!PRETRADING.includes(phase)||b.absent||b.a?.new!==true||(b.newAt&&at-b.newAt>=ADOPT_NEW_DAYS*DAY))continue;
    makeLaunch(s,id,otherPairTrading(s,id)?'new-pair':'asset-launch',{firstSeenAt:e.firstSeenAt,firstSeenSince:null,firstSeenSource:'exchange',
      seenAt:{exchange:e.firstSeenAt,brokerage:b.firstSeenAt},startedInProgress:true,phases:[{phase,at:exchangeReadAt??e.firstSeenAt,since:null}]});
  }
}
function syncLaunches(s,at,since){
  for(const [id,l] of Object.entries(s.launches)){
    const e=s.exchange.products[id];
    if(e&&!e.absent){
      const phase=phaseOfExchange(fullAttrs(SOURCE_CFG.exchange,e));
      if(l.seenAt.exchange!==undefined&&l.phases.at(-1)?.phase!==phase){
        l.phases.push({phase,at,since});
        if(l.tradingObservedAt==null&&TRADING_PHASES.includes(phase)){l.tradingObservedAt=at;l.tradingSince=since;}
      }
    }
    const b=s.brokerage.products[id];
    if(b?.newAt&&l.brokerageNewAt==null){
      l.brokerageNewAt=b.newAt;
      // A launch we saw much later than Advanced Trade dated it was detected late; say so.
      if(l.firstSeenAt-b.newAt>900)l.lateSeconds=l.firstSeenAt-b.newAt;
    }
    const c=l.candles;
    if(c?.status==='pending'&&l.tradingObservedAt!=null){
      c.windowStart=floorMinute(l.tradingSince??l.tradingObservedAt);
      c.windowEnd=floorMinute(l.tradingObservedAt+LIMITS.candleWindow);
      c.status='collecting';
    }
  }
}
function pruneLaunches(s){
  const all=Object.values(s.launches).sort((a,b)=>b.firstSeenAt-a.firstSeenAt||a.id.localeCompare(b.id));
  all.slice(LIMITS.launches).forEach(l=>{delete s.launches[l.id];});
  let kept=0;
  for(const l of all.slice(0,LIMITS.launches)){
    if(!l.candles?.rows)continue;
    kept+=1;
    if(kept>LIMITS.candleLaunches&&l.candles.rows.length){l.candles.rows=[];l.candles.trimmed=true;} // summary stays; older rows live in git history
  }
}

export function applyExchange(state,records,at,{knownBases}={}){
  const s=clone(state),known=knownBases||liveBases(state);
  const r=trackSource(s,'exchange',records,at,{knownBases:known});
  for(const id of r.newIds)ensureLaunch(s,id,'exchange',at,r.since,known);
  if(r.baseline)adoptInProgress(s,at,at);
  syncLaunches(s,at,r.since);pruneLaunches(s);
  recordSourceSuccess(s,'exchange',at,{count:r.count,skipped:r.skipped});
  s.updatedAt=Math.max(s.updatedAt,at);
  return {state:s,stats:{count:r.count,skipped:r.skipped,baseline:r.baseline,newProducts:r.newIds,changed:r.changed}};
}
export function applyBrokerage(state,records,at,{knownBases}={}){
  const s=clone(state),known=knownBases||liveBases(state);
  const r=trackSource(s,'brokerage',records,at,{knownBases:known});
  for(const id of r.newIds)ensureLaunch(s,id,'brokerage',at,r.since,known);
  if(r.baseline)adoptInProgress(s,at,s.sources.exchange.lastOkAt);
  syncLaunches(s,at,s.sources.exchange.lastOkAt);pruneLaunches(s);
  recordSourceSuccess(s,'brokerage',at,{count:r.count,skipped:r.skipped});
  s.updatedAt=Math.max(s.updatedAt,at);
  return {state:s,stats:{count:r.count,skipped:r.skipped,baseline:r.baseline,newProducts:r.newIds,changed:r.changed}};
}

// --------------------------------------------------------- status incidents
const MONTHS={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const MONTH_RX='(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const DMY=new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RX}\\.?,?\\s+(\\d{4})\\b`,'i');
const MDY=new RegExp(`\\b${MONTH_RX}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,'i');
const CLOCK=/(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?\s*(ET|EDT|EST|PT|PDT|PST|UTC)\b/i;
const ZONES={ET:'America/New_York',EDT:'America/New_York',EST:'America/New_York',PT:'America/Los_Angeles',PDT:'America/Los_Angeles',PST:'America/Los_Angeles',UTC:'UTC'};

function zonedEpoch(zone,y,m,d,h,mi){
  if(zone==='UTC')return Date.UTC(y,m-1,d,h,mi)/1000;
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'});
  const offset=t=>{const p=Object.fromEntries(fmt.formatToParts(new Date(t)).map(x=>[x.type,x.value]));return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-Math.floor(t/60000)*60000;};
  const guess=Date.UTC(y,m-1,d,h,mi);let t=guess-offset(guess);t=guess-offset(t);
  return t/1000;
}
// First stated date (and clock time when given) in a suspension notice. Unknown stays null.
export function parseEffective(text){
  const s=String(text??''),a=DMY.exec(s),b=MDY.exec(s);
  let m,y,d,idx;
  if(a&&(!b||a.index<=b.index)){d=+a[1];m=MONTHS[a[2].toLowerCase()];y=+a[3];idx=a.index+a[0].length;}
  else if(b){m=MONTHS[b[1].toLowerCase()];d=+b[2];y=+b[3];idx=b.index+b[0].length;}
  else return {effectiveDate:null,effectiveAt:null};
  if(!(m>=1&&m<=12&&d>=1&&d<=31))return {effectiveDate:null,effectiveAt:null};
  const effectiveDate=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const c=CLOCK.exec(s.slice(idx,idx+30)); // "on or around 2 PM ET" follows the date directly; a clock further away is not its time
  if(!c)return {effectiveDate,effectiveAt:null};
  const h=+c[1]%12+(c[3].toUpperCase()==='P'?12:0),mi=+(c[2]||0);
  if(+c[1]>12||mi>59)return {effectiveDate,effectiveAt:null};
  return {effectiveDate,effectiveAt:zonedEpoch(ZONES[c[4].toUpperCase()],y,m,d,h,mi)};
}

const PAIR=/\b([A-Z0-9]{1,15})-(USDT|USDC|USD|EUR|GBP|BTC|ETH|DAI|SGD|AUD|CAD|BRL|INR)\b/g;
const STOP=new Set(['USD','ET','UTC','PT','FAQ','API','ETA','US']);
// Best effort. Unknown stays null; nothing is guessed from prose.
export function extractSymbols(text,{name=false}={}){
  const s=String(text??'');
  const products=[...new Set([...s.matchAll(PAIR)].map(m=>m[0]))];
  const assets=new Set(products.map(baseOf));
  for(const m of s.matchAll(/\(([A-Z0-9]{2,12})\)/g))if(!STOP.has(m[1]))assets.add(m[1]);
  if(name&&!assets.size){
    const t=/(?:^|[-–]\s*)([A-Z][A-Z0-9]{1,9})\s*$/.exec(s)||/^([A-Z][A-Z0-9]{1,9})\s+[-–]/.exec(s);
    if(t&&!STOP.has(t[1]))assets.add(t[1]);
  }
  return {products:products.length?products:null,assets:assets.size?[...assets].sort():null};
}

const SUSPENSION_NAME=/trading suspension|suspen\w* (?:of )?trading|trading (?:will be )?suspen|delist|asset removal/i;
const LISTING_NAME=/markets?\s+open|moved to (?:full trading|limit[- ]only)|\bto limit[- ]only\b|full[- ]trading|new listing|now live/i;
const PHASE_RX=[['auction',/(?:re-?)?enter auction mode|auction mode/i],['limit-only',/limit[- ]only/i],['full-trading',/full[- ]trading/i]];
// The earliest phase named in the text wins: an announcement that later mentions limit-only orders stays an auction notice.
function marketPhase(text){
  let best=null;
  for(const [phase,rx] of PHASE_RX){const m=rx.exec(text);if(m&&(!best||m.index<best.index))best={phase,index:m.index};}
  return best?.phase||null;
}
export function classifyIncident(inc){
  const name=String(inc?.name??''),bodies=(inc?.incident_updates||[]).map(u=>String(u?.body??''));
  if(SUSPENSION_NAME.test(name))return 'suspension';
  if(LISTING_NAME.test(name))return 'listing';
  if(bodies.some(b=>/trading pair/i.test(b)&&marketPhase(b)&&new RegExp(PAIR.source).test(b)))return 'listing';
  if(bodies.some(b=>/\bwill suspend trading\b|\b(?:have|has) (?:suspended|disabled) trading\b|\bdelist/i.test(b)))return 'suspension';
  return 'other';
}
function updatePhase(cls,body){
  const t=String(body||'');
  if(/incident has been resolved/i.test(t))return 'resolved';
  if(cls==='listing'){
    const p=marketPhase(t);if(p)return p;
    if(/will go live on/i.test(t))return 'go-live-notice';
    if(/will add support for/i.test(t))return 'support-added';
    if(/is now live on/i.test(t))return 'live-retail';
    return 'update';
  }
  if(cls==='suspension'){
    if(/\b(?:have|has) (?:suspended|disabled|removed) trading\b|\btrading (?:has been|was|is now|is) (?:suspended|disabled)\b/i.test(t))return 'executed';
    if(/\bwill (?:be )?(?:suspend|remov|delist)|\bin an effort to .*remov|\bwill be (?:suspended|delisted|removed)\b/i.test(t))return 'notice';
    return 'update';
  }
  return null;
}
const epoch=v=>{const t=typeof v==='string'?Date.parse(v)/1000:NaN;return isNum(t)?Math.floor(t):null;};

export function parseIncident(inc){
  if(!inc||typeof inc!=='object'||typeof inc.id!=='string'||!/^[A-Za-z0-9]{4,40}$/.test(inc.id))return null;
  const cls=classifyIncident(inc),name=short(inc.name,140),events=[];let skipped=0;
  const nameSym=extractSymbols(name,{name:cls==='other'});
  for(const u of Array.isArray(inc.incident_updates)?inc.incident_updates:[]){
    const at=epoch(u?.created_at)??epoch(u?.display_at);
    if(!u||typeof u.id!=='string'||at===null){skipped+=1;continue;}
    const body=String(u.body??''),sym=extractSymbols(body),phase=updatePhase(cls,body);
    const products=[...new Set([...(nameSym.products||[]),...(sym.products||[])])],assets=[...new Set([...(nameSym.assets||[]),...(sym.assets||[])])].sort();
    const ev={key:`${inc.id}:${u.id}`,incidentId:inc.id,updateId:u.id,at,incident:name,cls,phase,incidentStatus:short(inc.status,24)||null,
      updateStatus:short(u.status,24)||null,products:products.length?products:null,assets:assets.length?assets:null};
    if(cls!=='other'){
      ev.text=short(body,LIMITS.textChars);
      if(/re-?enter/i.test(body))ev.reentry=true;
      if(cls==='suspension'&&phase==='notice')Object.assign(ev,parseEffective(body));
    }
    events.push(ev);
  }
  return {id:inc.id,name,cls,events,skipped};
}

function capEvents(events){
  const out=[],count={listing:0,suspension:0,other:0};
  for(const e of [...events].sort((a,b)=>b.at-a.at||a.key.localeCompare(b.key))){
    if(count[e.cls]>=LIMITS.events[e.cls])continue;
    count[e.cls]+=1;out.push(e);
  }
  return out;
}

// Notices that are upcoming, or effective within the last 30 days.
export function deriveWatchlist(events,now){
  const groups=new Map();
  for(const e of events)if(e.cls==='suspension'){if(!groups.has(e.incidentId))groups.set(e.incidentId,[]);groups.get(e.incidentId).push(e);}
  const out=[];
  for(const [incidentId,list] of groups){
    list.sort((a,b)=>a.at-b.at);
    const notice=list.find(e=>e.phase==='notice'),executed=list.find(e=>e.phase==='executed');
    const resolved=list.some(e=>e.incidentStatus==='resolved'||e.phase==='resolved');
    const products=[...new Set(list.flatMap(e=>e.products||[]))].sort(),assets=[...new Set(list.flatMap(e=>e.assets||[]))].sort();
    if(!products.length&&!assets.length)continue;
    const status=executed?'effective':resolved?'closed':'upcoming';
    if(status==='closed')continue;
    if(status==='effective'&&now-executed.at>LIMITS.effectiveKeepDays*DAY)continue;
    // Named non-USD pairs are removed alone; a USD pair or an asset-wide notice covers the asset everywhere.
    const scope=products.length&&products.every(p=>quoteOf(p)!=='USD')?'pairs':'asset';
    out.push({incidentId,incident:list[0].incident,noticeAt:(notice||list[0]).at,effectiveDate:notice?.effectiveDate??null,effectiveAt:notice?.effectiveAt??null,
      executedAt:executed?.at??null,status,scope,products:products.length?products:null,assets:assets.length?assets:null});
  }
  return out.sort((a,b)=>(a.status===b.status?0:a.status==='upcoming'?-1:1)||(a.status==='upcoming'?((a.effectiveAt??Infinity)-(b.effectiveAt??Infinity)):(b.executedAt-a.executedAt))||a.incidentId.localeCompare(b.incidentId));
}

// Re-derives the watchlist from stored events, so effective notices still expire while the status feed is failing.
export function refreshWatchlist(state,now){
  const s=clone(state);s.watchlist=deriveWatchlist(s.events,now);
  return s;
}

// Listing events found in the status feed. Times only; no prices are attached.
export function deriveStatusListings(events,n=LIMITS.statusListings){
  const groups=new Map();
  for(const e of events)if(e.cls==='listing'){if(!groups.has(e.incidentId))groups.set(e.incidentId,[]);groups.get(e.incidentId).push(e);}
  const out=[];
  for(const [incidentId,list] of groups){
    list.sort((a,b)=>a.at-b.at);
    const isLaunch=list.some(e=>['auction','go-live-notice','support-added','live-retail'].includes(e.phase))||/markets?\s+open/i.test(list[0].incident);
    if(!isLaunch)continue;
    const first=phase=>list.find(e=>e.phase===phase)?.at??null;
    out.push({incidentId,incident:list[0].incident,announcedAt:list[0].at,supportAddedAt:first('support-added'),goLiveNoticeAt:first('go-live-notice'),auctionAt:first('auction'),
      limitOnlyAt:first('limit-only'),fullTradingAt:first('full-trading'),reentry:list.some(e=>e.reentry)||undefined,
      products:[...new Set(list.flatMap(e=>e.products||[]))].sort(),assets:[...new Set(list.flatMap(e=>e.assets||[]))].sort(),
      source:'status-feed',prices:null});
  }
  return out.sort((a,b)=>b.announcedAt-a.announcedAt||a.incidentId.localeCompare(b.incidentId)).slice(0,n).map(x=>({...x,products:x.products.length?x.products:null,assets:x.assets.length?x.assets:null}));
}

export function applyIncidents(state,incidents,at){
  if(!Array.isArray(incidents))throw Error('Status incident list was not a list');
  const s=clone(state),byKey=new Map(s.events.map(e=>[e.key,e]));
  const before=new Set(byKey.keys());let skipped=0,parsed=0;
  for(const inc of incidents){
    const p=parseIncident(inc);
    if(!p){skipped+=1;continue;}
    parsed+=1;skipped+=p.skipped;
    for(const ev of p.events){
      const old=byKey.get(ev.key);
      if(old){old.incidentStatus=ev.incidentStatus;old.updateStatus=ev.updateStatus;continue;} // seenAt and first parse are kept
      byKey.set(ev.key,{...ev,seenAt:at});
    }
  }
  if(!parsed&&incidents.length)throw Error(`Status feed had ${incidents.length} incidents but none were readable`);
  s.events=capEvents([...byKey.values()]);
  // Count only events that survive the per-class cap, so an evicted old event still in the feed is not re-counted every run.
  const fresh=s.events.filter(e=>!before.has(e.key)),added=fresh.length,counts={listing:0,suspension:0,other:0};
  for(const e of fresh)counts[e.cls]+=1;
  s.counters.events+=added;
  s.watchlist=deriveWatchlist(s.events,at);
  recordSourceSuccess(s,'status',at,{count:parsed,skipped});
  s.updatedAt=Math.max(s.updatedAt,at);
  return {state:s,stats:{incidents:parsed,skipped,newEvents:added,byClass:counts}};
}

// ------------------------------------------------- 1-minute launch candles
function mergeRanges(ranges){
  const sorted=ranges.map(r=>[...r]).sort((a,b)=>a[0]-b[0]),out=[];
  for(const r of sorted){
    const last=out.at(-1);
    if(last&&r[0]<=last[1]+MIN)last[1]=Math.max(last[1],r[1]);else out.push(r);
  }
  return out;
}
function firstUncovered(ranges,from,to){
  let t=from;
  for(const [a,b] of ranges){if(b<t)continue;if(a>t)break;t=b+MIN;}
  return t<=to?t:null;
}
export function planCandleRequests(state,now,max=LIMITS.candleRequestsPerRun){
  const frontier=floorMinute(now)-LIMITS.candleSafety,out=[];
  const open=Object.values(state.launches).filter(l=>l.candles?.status==='collecting').sort((a,b)=>a.candles.windowStart-b.candles.windowStart||a.id.localeCompare(b.id));
  for(const l of open){
    const c=l.candles,end=Math.min(c.windowEnd,frontier);let planned=[...c.covered];
    for(let start=firstUncovered(planned,c.windowStart,end);start!==null&&out.length<max;start=firstUncovered(planned,c.windowStart,end)){
      const chunkEnd=Math.min(end,start+(LIMITS.candleChunk-1)*MIN);
      out.push({id:l.id,start,end:chunkEnd});planned=mergeRanges([...planned,[start,chunkEnd]]);
    }
    if(out.length>=max)break;
  }
  return out;
}
export const candleUrl=({id,start,end})=>{
  const iso=t=>new Date(t*1000).toISOString().replace(/\.\d{3}Z$/,'Z');
  return `https://api.exchange.coinbase.com/products/${encodeURIComponent(id)}/candles?granularity=60&start=${iso(start)}&end=${iso(end)}`;
};

// results: [{id,start,end,rows|null,error|null,receivedAt}]. rows are Coinbase [time,low,high,open,close,volume].
export function applyCandleResults(state,results,at){
  const s=clone(state);let ok=0,failed=0,added=0,rejected=0,lastError=null;
  for(const r of results){
    const l=s.launches[r.id],c=l?.candles;
    if(!c||c.status!=='collecting'){failed+=1;continue;}
    if(r.error||!Array.isArray(r.rows)){failed+=1;lastError=short(r.error||'Candle response was not a list',200);c.lastError=lastError;continue;}
    const have=new Map(c.rows.map(x=>[x[0],x]));
    let firstRow=null;
    for(const row of r.rows){
      const [t,low,high,open,close,volume]=Array.isArray(row)?row.map(Number):[];
      const m=(t-c.windowStart)/MIN;
      if(!(isNum(t)&&t%MIN===0&&t>=r.start&&t<=r.end&&t+MIN<=at&&t>=c.windowStart&&t<=c.windowEnd&&Number.isInteger(m)&&isNum(close)&&close>0&&isNum(open)&&isNum(low)&&isNum(high)&&low<=high&&isNum(volume)&&volume>=0)){rejected+=1;continue;}
      if(have.has(m)){if(have.get(m)[1]!==close)c.conflicts+=1;continue;} // completed candles are immutable evidence
      have.set(m,[m,close,volume]);added+=1;
      if(!firstRow||t<firstRow.t)firstRow={t,open};
    }
    c.rows=[...have.values()].sort((a,b)=>a[0]-b[0]);c.count=c.rows.length;
    if(firstRow&&(!c.first||firstRow.t<c.first.at))c.first={at:firstRow.t,open:firstRow.open};
    c.covered=mergeRanges([...c.covered,[r.start,r.end]]);c.lastError=null;ok+=1;
  }
  for(const l of Object.values(s.launches)){
    const c=l.candles;
    if(c?.status!=='collecting')continue;
    if(firstUncovered(c.covered,c.windowStart,c.windowEnd)===null)c.status='complete';
    else if(at>c.windowEnd+2*DAY)c.status='incomplete'; // the window closed with gaps; the covered ranges say exactly which
  }
  const src=s.sources.candles;
  src.lastAttemptAt=at;src.skipped=rejected;
  if(!results.length){src.idle=true;src.lastError=null;}
  else{
    src.idle=false;
    if(ok){src.lastOkAt=at;}
    if(failed&&!ok){src.lastError=lastError||'Every candle request failed';src.lastErrorAt=at;src.failures=(src.failures||0)+1;}
    else if(failed){src.lastError=`${failed} of ${results.length} candle requests failed${lastError?`: ${lastError}`:''}`;src.lastErrorAt=at;src.failures=(src.failures||0)+1;}
    else{src.lastError=null;src.failures=0;}
  }
  src.count=results.length;
  pruneLaunches(s);
  s.updatedAt=Math.max(s.updatedAt,at);
  return {state:s,stats:{requests:results.length,succeeded:ok,failed,rows:added,rejected}};
}

// ------------------------------------------------------------------ avoid
export function listedAtOf(id,state){
  const key=String(id||'').toUpperCase(),times=[];
  const ex=has(state.exchange?.products||{},key)?state.exchange.products[key]:null;
  const bk=has(state.brokerage?.products||{},key)?state.brokerage.products[key]:null;
  if(ex&&!ex.baseline)times.push(ex.firstSeenAt);
  if(bk&&!bk.baseline)times.push(bk.firstSeenAt);
  if(bk?.newAt)times.push(bk.newAt);
  return times.length?Math.min(...times):null;
}
// Reasons to stay out. Unknown age is never flagged: a product that predates the
// collector without a dated Advanced Trade listing has no known first-seen time.
export function avoidReasons(product,state,now){
  const rec=typeof product==='string'?{id:product}:(product&&typeof product==='object'?product:{});
  const id=String(rec.id??rec.product_id??'').toUpperCase(),reasons=[];
  if(!id)return reasons;
  const reg=has(state.exchange?.products||{},id)?state.exchange.products[id]:null,known=reg?fullAttrs(SOURCE_CFG.exchange,reg):{};
  const pick=k=>rec[k]===undefined?known[k]:rec[k];
  const status=pick('status');
  if(status==='delisted')reasons.push('delisted');
  else if(status==='offline')reasons.push('offline');
  if(pick('trading_disabled')===true)reasons.push('trading-disabled');
  if(pick('cancel_only')===true)reasons.push('cancel-only');
  const base=baseOf(id);
  for(const w of state.watchlist||[]){
    const named=w.products?.includes(id),wide=w.scope==='asset'&&(w.assets?.includes(base)||w.products?.some(p=>baseOf(p)===base));
    if(named||wide){reasons.push('suspension-notice');break;}
  }
  const listedAt=listedAtOf(id,state);
  if(listedAt!==null&&isNum(now)&&now-listedAt<AVOID_DAYS*DAY)reasons.push('new-listing');
  return reasons;
}
export const isAvoid=(product,state,now)=>avoidReasons(product,state,now).length>0;

// ------------------------------------------------------------------ snapshot
export function listingWatchSnapshot(state,{generatedAt,requests=0}={}){
  if(!isNum(generatedAt)||generatedAt<state.updatedAt)throw Error('A snapshot cannot predate the observation it describes');
  const launches=Object.values(state.launches).sort((a,b)=>b.firstSeenAt-a.firstSeenAt||a.id.localeCompare(b.id));
  const summary=l=>({id:l.id,base:l.base,quote:l.quote,kind:l.kind,startedInProgress:l.startedInProgress||undefined,firstSeenAt:l.firstSeenAt,firstSeenSince:l.firstSeenSince,firstSeenSource:l.firstSeenSource,seenAt:l.seenAt,
    brokerageNewAt:l.brokerageNewAt,lateSeconds:l.lateSeconds,phases:l.phases,tradingObservedAt:l.tradingObservedAt,tradingSince:l.tradingSince,
    candles:l.candles.rows?{status:l.candles.status,windowStart:l.candles.windowStart,windowEnd:l.candles.windowEnd,covered:l.candles.covered,count:l.candles.count,first:l.candles.first,
      lastError:l.candles.lastError,trimmed:l.candles.trimmed||undefined}:{status:l.candles.status,reason:l.candles.reason}});
  const sources=Object.fromEntries(SOURCE_KEYS.map(k=>{
    const x=state.sources[k];
    return [k,{label:SOURCES[k].label,url:SOURCES[k].url,status:sourceStatus(x),lastOkAt:x.lastOkAt,lastAttemptAt:x.lastAttemptAt,lastError:x.lastError,lastErrorAt:x.lastErrorAt,failures:x.failures,count:x.count,skipped:x.skipped||0}];
  }));
  const upcoming=state.watchlist.filter(w=>w.status==='upcoming').length;
  return {version:1,policyId:POLICY_ID,generatedAt,startedAt:state.startedAt,stateUpdatedAt:state.updatedAt,requests,
    execution:{mode:'observation',realEnabled:false,ordersPlaced:false,paperPositions:false,authenticated:false},
    cadence:'Scheduled about every five minutes, best effort. Reads are not continuous quotes; changes between reads are timestamped with the read interval.',
    sources,
    counts:{exchangeProducts:Object.keys(state.exchange.products).length,brokerageUsdProducts:Object.keys(state.brokerage.products).length,
      launches:state.counters.launches,assetLaunches:launches.filter(l=>l.kind==='asset-launch').length,
      candleLaunches:launches.filter(l=>l.candles?.status&&!['skipped'].includes(l.candles.status)).length,
      transitions:state.counters.transitions,watchlistUpcoming:upcoming,watchlistEffective:state.watchlist.length-upcoming,
      exchangeBaselineAt:state.exchange.baselineAt,brokerageBaselineAt:state.brokerage.baselineAt},
    launches:launches.slice(0,20).map(summary),
    transitions:state.transitions.slice(0,40),
    watchlist:state.watchlist,
    statusListings:deriveStatusListings(state.events),
    events:state.events.filter(e=>e.cls!=='other').slice(0,20).map(({key,incidentId,updateId,at,incident,cls,phase,incidentStatus,products,assets,reentry,seenAt})=>({key,incidentId,updateId,at,incident,cls,phase,incidentStatus,products,assets,reentry,seenAt})),
    study:HISTORICAL_STUDY};
}
export function validListingWatchSnapshot(x,now=Date.now()/1000){
  return !!x&&typeof x==='object'&&x.version===1&&x.policyId===POLICY_ID&&isNum(x.generatedAt)&&x.generatedAt<=now+300
    &&x.execution?.realEnabled===false&&x.execution?.ordersPlaced===false&&x.execution?.authenticated===false
    &&SOURCE_KEYS.every(k=>x.sources?.[k]&&typeof x.sources[k].status==='string')
    &&['launches','transitions','watchlist','statusListings','events'].every(k=>Array.isArray(x[k]))&&!!x.counts&&typeof x.counts==='object';
}
