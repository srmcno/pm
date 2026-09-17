import test from 'node:test';
import assert from 'node:assert/strict';
let api={};try{api=await import('../dashboard/crypto-strategies-core.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const now=1789603200;
function market(product='SOL-USD',slope=.1){
 const candles=Array.from({length:100},(_,i)=>{const c=100+i*slope;return [now-(100-i)*3600,c-.8,c+.8,c-.05,c,1000];});
 const price=candles.at(-1)[4];return {product,status:'online',tradingDisabled:false,candles,increment:.000001,minSize:.000001,minNotional:10,book:{bids:[[price-.01,100]],asks:[[price+.01,100]],receivedAt:now,requestAt:now-1}};
}
const fresh=(m,t)=>({...m,book:{...m.book,receivedAt:t,requestAt:t-1}});
function openState(){const markets=[market('BTC-USD',.01),market()];let s=api.advanceCompetition(null,markets,now);s=api.advanceCompetition(s,markets.map(m=>fresh(m,now+300)),now+300);return {s,markets};}
test('paper engine exposes its deterministic API',()=>{assert.equal(typeof api.advanceCompetition,'function');});
test('new accounts are separate paper bankrolls and real execution is locked',()=>{const s=api.initialCompetition(now);assert.equal(s.realEnabled,false);assert.equal(s.mode,'paper');assert.equal(Object.keys(s.accounts).length,2);for(const a of Object.values(s.accounts)){assert.equal(a.cash,1000);assert.equal(a.positions.length,0);}});
test('a repeated clock tick is idempotent and input state is not mutated',()=>{let s=api.advanceCompetition(null,[market('BTC-USD'),market()],now);const before=structuredClone(s);assert.deepEqual(api.advanceCompetition(s,[market()],now),s);assert.deepEqual(s,before);});
test('ranks stronger qualifying coins before weaker ones, not arrival order',()=>{const ms=[market('BTC-USD',.01),market('ETH-USD',.05),market('SOL-USD',.1)];const a=api.evaluateUniverse(ms,now);assert.equal(a.decisions.filter(d=>d.strategyId==='rotation'&&d.status==='candidate')[0].product,'SOL-USD');assert.deepEqual(api.evaluateUniverse([...ms].reverse(),now),a);});
test('forming and future candles cannot change earlier decisions',()=>{const ms=[market('BTC-USD',.01),market()];const baseline=api.evaluateUniverse(ms,now);ms[1].candles.push([now,1,9999,5,8000,900000]);assert.deepEqual(api.evaluateUniverse(ms,now),baseline);});
test('gaps and conflicting duplicate candles are explicit data failures',()=>{for(const kind of ['gap','duplicate']){const m=market();if(kind==='gap')m.candles.splice(-3,1);else m.candles.push([...m.candles.at(-1).slice(0,4),10000,1000]);const r=api.evaluateUniverse([market('BTC-USD'),m],now);assert.ok(r.decisions.filter(d=>d.product===m.product).every(d=>d.status==='unavailable'));}});
test('stale, crossed and failed books cannot produce an entry',()=>{for(const change of [m=>m.book.receivedAt=now-91,m=>m.book.bids[0][0]=10000,m=>m.sourceError='offline',m=>m.tradingDisabled=true]){const m=market();change(m);const s=api.advanceCompetition(null,[market('BTC-USD',.01),m],now);assert.equal(s.accounts.rotation.positions.length,0);assert.ok(!Object.values(s.accounts.rotation.pending).some(p=>p.product===m.product));}});
test('first scan only confirms interest; second scan opens a real paper ledger position',()=>{const ms=[market('BTC-USD',.01),market()];const first=api.advanceCompetition(null,ms,now);assert.equal(first.accounts.rotation.positions.length,0);assert.ok(Object.keys(first.accounts.rotation.pending).length>0);const next=api.advanceCompetition(first,ms.map(m=>fresh(m,now+300)),now+300);assert.ok(next.accounts.rotation.positions.length>0);assert.ok(next.accounts.rotation.cash<1000);api.validateCompetition(next);});
test('back-to-back scans do not erase the first confirmation time',()=>{const ms=[market('BTC-USD',.01),market()];let s=api.advanceCompetition(null,ms,now);s=api.advanceCompetition(s,ms.map(m=>fresh(m,now+30)),now+30);s=api.advanceCompetition(s,ms.map(m=>fresh(m,now+90)),now+90);assert.ok(s.accounts.rotation.positions.length>0);});
test('missing a candidate for a scan resets its confirmation',()=>{const ms=[market('BTC-USD',.01),market()];let s=api.advanceCompetition(null,ms,now);s=api.advanceCompetition(s,[],now+300);s=api.advanceCompetition(s,ms.map(m=>fresh(m,now+600)),now+600);assert.equal(s.accounts.rotation.positions.length,0);});
test('fees and slippage are charged on entry, mark and exit; cash reconciles',()=>{let {s,markets}=openState();const a=s.accounts.rotation,p=a.positions.find(p=>p.product==='SOL-USD');assert.ok(p);assert.ok(p.cost>p.principal);const ms=markets.map(m=>fresh(m,now+600));for(const m of ms){m.book.bids=[[80,100]];m.book.asks=[[80.01,100]];}s=api.advanceCompetition(s,ms,now+600);const t=s.accounts.rotation.trades.find(t=>t.id===p.id);assert.ok(t);assert.equal(t.exitReason,'Stop / adverse gap');assert.ok(t.exitFees>0);assert.ok(Math.abs(t.pnl-(t.proceeds-t.cost))<.00001);assert.ok(t.pnl<0);api.validateCompetition(s);});
test('no synthetic stop fill is invented inside an unobserved candle',()=>{let {s,markets}=openState();const before=s.accounts.rotation.trades.length;const ms=markets.map(m=>fresh(m,now+600));ms[1].candles.at(-1)[1]=1;s=api.advanceCompetition(s,ms,now+600);assert.equal(s.accounts.rotation.trades.length,before);});
test('stale open-position marks hold new entries without resetting balances',()=>{let {s}=openState();const before=s.accounts.rotation.cash;s=api.advanceCompetition(s,[],now+600);assert.equal(s.accounts.rotation.cash,before);assert.equal(s.accounts.rotation.markComplete,false);assert.equal(Object.keys(s.accounts.rotation.pending).length,0);});
test('same signal never reopens a completed trade or duplicates on restart',()=>{let {s,markets}=openState();const count=s.accounts.rotation.positions.length;const later=api.advanceCompetition(JSON.parse(JSON.stringify(s)),markets.map(m=>fresh(m,now+600)),now+600);assert.equal(later.accounts.rotation.positions.length,count);});
test('unknown modes, corrupted cash and invalid quantities are refused',()=>{const s=api.initialCompetition(now);for(const change of [x=>x.realEnabled=true,x=>x.mode='live',x=>x.accounts.rotation.cash=999,x=>x.accounts.rotation.cash=NaN]){const bad=structuredClone(s);change(bad);assert.throws(()=>api.validateCompetition(bad));}});
test('small losing samples are not mislabeled persistent failure',()=>{const trades=[{pnl:-10,openedAt:now-86400,closedAt:now}];assert.equal(api.retirementReason(trades),null);});
test('30 losses across at least 14 days retire a strategy; recent clustered losses do not',()=>{const trades=Array.from({length:30},(_,i)=>({pnl:-1,openedAt:now-(30-i)*86400,closedAt:now-(29-i)*86400}));assert.match(api.retirementReason(trades),/negative/i);assert.equal(api.retirementReason(trades.map(t=>({...t,closedAt:now,openedAt:now-100}))),null);});
test('mixed profitable subperiods do not satisfy persistent-loss retirement',()=>{const trades=Array.from({length:30},(_,i)=>({pnl:i<10?1:-2,openedAt:now-(30-i)*86400,closedAt:now-(29-i)*86400}));assert.equal(api.retirementReason(trades),null);});
test('retired strategies cannot restart themselves on a favorable market',()=>{const s=api.initialCompetition(now);s.accounts.rotation.status='retired';s.accounts.rotation.retirement={at:now,reason:'fixture'};let n=api.advanceCompetition(s,[market('BTC-USD',.01),market()],now+300);n=api.advanceCompetition(n,[fresh(market('BTC-USD',.01),now+600),fresh(market(),now+600)],now+600);assert.equal(n.accounts.rotation.positions.length,0);assert.equal(n.accounts.rotation.status,'retired');});
test('legacy retirement preserves original cash, trade history and exit management metadata',()=>{const a={cash:969.68,positions:[],closed:[{strategy:'Trend reclaim',pnl:-10}],entryPolicy:{allowedStrategies:['reclaim'],strategies:[]}};const before=structuredClone(a);const r=api.retireLegacy(a,now);assert.equal(r.cash,a.cash);assert.deepEqual(r.closed,a.closed);assert.deepEqual(r.entryPolicy.allowedStrategies,[]);assert.equal(r.retirement.status,'retired');assert.deepEqual(a,before);});
test('fills respect both depth and exact quantity increments',()=>{const m=market();m.book.asks=[[110,0.01]];const s=api.advanceCompetition(null,[market('BTC-USD',.01),m],now);assert.ok(s.decisions.filter(d=>d.product==='SOL-USD').every(d=>d.status!=='candidate'||d.plan===null||d.plan.cost<=1.2));});

test('public adapter rejects a wrong product identity and does not rejuvenate retained data',async()=>{
 const {collectCoinbaseMarkets}=await import('../scripts/crypto-feed.mjs');const m=market('BTC-USD');
 const r=await collectCoinbaseMarkets({cached:[m],products:['BTC-USD'],pace:0,clock:()=>now,
  fetcher:async()=>({ok:true,json:async()=>({id:'ETH-USD',base_currency:'ETH',quote_currency:'USD'})})});
 assert.ok(r.errors.length);assert.equal(r.markets[0].book.receivedAt,m.book.receivedAt);assert.ok(r.markets[0].sourceError);
});
test('public adapter uses only GET requests and keeps exact per-book receipt times',async()=>{
 const {collectCoinbaseMarkets}=await import('../scripts/crypto-feed.mjs');let time=now,calls=[];
 const r=await collectCoinbaseMarkets({cached:[market('BTC-USD')],products:['BTC-USD'],pace:0,clock:()=>time++,fetcher:async(url,options)=>{
  calls.push({url,options});return {ok:true,json:async()=>url.endsWith('?level=2')?{bids:[['109','10',1]],asks:[['110','10',1]],sequence:5}:{id:'BTC-USD',base_currency:'BTC',quote_currency:'USD',base_increment:'.000001',status:'online'}};
 }});
 assert.equal(r.errors.length,0);assert.ok(calls.every(c=>c.options.method==='GET'));assert.equal(calls.length,2);assert.ok(r.markets[0].book.receivedAt>r.markets[0].book.requestAt);
});

test('main navigation exposes crypto and routes history to Archive without loading archived screens',async()=>{
 const {readFile}=await import('node:fs/promises');const focus=await readFile(new URL('../dashboard/focus.html',import.meta.url),'utf8');
 assert.ok(focus.includes('href="crypto.html">Crypto Strategies'));
 assert.ok(focus.includes('href="crypto.html#retired"'));
 assert.ok(!focus.includes('>Spot paper account</a>'));
 const crypto=await readFile(new URL('../dashboard/crypto.html',import.meta.url),'utf8');
 assert.equal((crypto.match(/<nav[\s\S]*?<\/nav>/)||[''])[0].match(/<a /g).length,4);
 assert.ok(crypto.includes('id="activity-view"'));assert.ok(crypto.includes('id="retired-view"'));
});
