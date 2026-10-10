import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PredictionArbEngine,holdings} from '../scripts/predlive/engine.mjs';
import {complementOpportunity,multiOutcomeOpportunity,normalizeAsks,feeBound} from '../scripts/predlive/arb.mjs';
import {Journal} from '../scripts/live/journal.mjs';
import {D,S} from '../scripts/live/risk.mjs';

const T0=1_800_000_000,TICKER='KXTEST-26-A';
const clone=x=>structuredClone(x);
function memoryJournal(initial=null){let value=clone(initial);return {events:[],load:()=>clone(value),save(state,event){value=clone(state);this.events.push(clone(event));}};}
function kbook({ticker=TICKER,yes=[['0.40','10']],no=[['0.50','10']],at,eventTicker='KXTEST-26'}){
  return {venue:'kalshi',ticker,eventTicker,seriesTicker:'KXTEST',category:'Economics',status:'open',rules:'r',ruleHash:'h',closeAt:T0+86400,feeRate:'0.07',
    requestAt:at,receivedAt:at+0.1,asks:{yes:normalizeAsks(yes),no:normalizeAsks(no)}};
}
function fixture({mode='live',journal=memoryJournal(),balance='100',scopes=['read','write::trade'],plan=()=>({}),config={},settlement=async()=>null}={}){
  let now=T0,n=0;const orders=new Map(),fills=new Map(),calls=[],lagged=new Set();
  const kalshi={allowSubmit:mode==='live',canSubmit:mode==='live',authenticated:true,balanceValue:balance,
    async keyScopes(){calls.push('scopes');return {scopes,subaccount:null};},
    async balance(){calls.push('balance');return {balance:kalshi.balanceValue,checkedAt:now};},
    async create(body){
      const persisted=f.journal.load().packages.flatMap(p=>p.orders).find(o=>o.clientOrderId===body.client_order_id);
      assert.ok(persisted,'order must be persisted before POST');assert.equal(persisted.orderId,null);assert.deepEqual(persisted.body,body);
      const index=calls.filter(c=>c.create).length+1;calls.push({create:clone(body)});
      const b=plan(body,index)??{};
      if(b.throwBefore)throw Error('connection reset');
      const count=Number(body.count),fill=b.fill===undefined?count:b.fill,outcome=body.side==='bid'?'yes':'no';
      const own=b.price??(outcome==='yes'?body.price:S(D('1')-D(body.price)));
      const order_id=`order-${++n}`;
      orders.set(order_id,{order_id,client_order_id:body.client_order_id,ticker:body.ticker,book_side:body.side,outcome_side:outcome,status:fill>0?'executed':'canceled',fill_count_fp:fill.toFixed(2)});
      fills.set(order_id,fill>0?[{fill_id:`fill-${n}`,order_id,outcome_side:outcome,count_fp:fill.toFixed(2),yes_price_dollars:outcome==='yes'?own:S(D('1')-D(own)),
        no_price_dollars:outcome==='no'?own:S(D('1')-D(own)),fee_cost:S(feeBound(fill,own,'0.07'))}]:[]);
      if(b.lagFills)lagged.add(order_id);
      if(b.throwAfter)throw Error('lost response');
      return {order_id,client_order_id:body.client_order_id,fill_count:fill.toFixed(2),remaining_count:(count-fill).toFixed(2),ts_ms:1};
    },
    async order(id){calls.push(`order:${id}`);return clone(orders.get(id));},
    async ordersFor(ticker){calls.push('list');return [...orders.values()].filter(o=>o.ticker===ticker).map(clone);},
    async fills(id){calls.push('fills');if(lagged.has(id)){lagged.delete(id);return [];}return clone(fills.get(id)??[]);},
  };
  const engineConfig={mode,allocation:{kalshi:'100',polymarket:'0'},maxTrade:'25',lossLimit:'5',...config};
  const make=()=>new PredictionArbEngine({venues:{kalshi,polymarket:{canSubmit:false,allowSubmit:false}},journal:f.journal,config:engineConfig,clock:()=>now,settlement});
  const f={journal,kalshi,calls,orders,get now(){return now;},advance(s){now+=s;},
    creates:()=>calls.filter(c=>c.create).map(c=>c.create),
    opp:(o={})=>complementOpportunity(kbook({at:now-1,...o}),{now,maxTradeUsd:'25'}),
    refresh:(o={})=>async(opportunity,limits)=>complementOpportunity(kbook({at:now-(o.age??0.5),...o}),{...limits,now}),
    restart(patch={}){Object.assign(engineConfig,patch);f.engine=make();return f.engine;}};
  f.engine=make();
  f.tick=(opportunities=[],refresh=f.refresh())=>f.engine.tick({opportunities,refresh});
  return f;
}

test('preview mode records the opportunity and never submits, funds or cancels',async()=>{
  for(const allowSubmit of [false,true]){
    const f=fixture({mode:'preview'});f.kalshi.allowSubmit=allowSubmit;f.kalshi.canSubmit=allowSubmit;
    const o=f.opp();assert.equal(o.executable,true);
    f.engine.recordScan([o]);const state=await f.tick([o]);
    assert.match(state.hold,/Preview/);assert.equal(f.creates().length,0);assert.equal(state.packages.length,0);
    assert.equal(state.funding.kalshi.funded,false,'preview never freezes an allocation');
    assert.ok(state.log.some(l=>l.kind==='would_trade'));assert.ok(state.log.some(l=>l.kind==='opportunity'&&l.netEdgePerContract));
    assert.equal(f.engine.status().opportunitiesExecutable,1);assert.equal(f.engine.status().realOrdersEnabled,false);
  }
});

test('live complement: scarce leg first, both legs fill-or-kill, persisted before POST, pairs net to realized profit',async()=>{
  const f=fixture(),o=f.opp({no:[['0.50','6']]});
  let s=await f.tick([o],f.refresh({no:[['0.50','6']]}));
  assert.equal(s.funding.kalshi.initialCapital,'100');assert.match(s.hold,/submitted/);
  const [first,second]=f.creates();
  assert.equal(first.side,'ask','scarcer NO leg first');assert.equal(first.price,'0.5');assert.equal(second.side,'bid');assert.equal(second.price,'0.4');
  for(const b of [first,second]){assert.equal(b.time_in_force,'fill_or_kill');assert.equal(b.count,'6');assert.equal(b.reduce_only,false);}
  s=await f.tick([]);
  const p=s.packages[0];assert.equal(p.stage,'closed');assert.equal(holdings(p).pairs,D('6'));
  // 6 - 6*0.50 - 6*0.40 - fees(0.11 + 0.11)
  assert.equal(f.engine.status().realizedPnlUsd,'0.38');assert.equal(f.engine.status().filled,1);assert.equal(f.engine.status().attempted,1);
  assert.equal(f.creates().length,2);
});

test('FOK first leg not filled: nothing else is placed and the package closes flat',async()=>{
  const f=fixture({plan:(_,i)=>i===1?{fill:0}:{}});
  await f.tick([f.opp()]);assert.equal(f.creates().length,1);
  const s=await f.tick([]);assert.equal(s.packages[0].stage,'closed');assert.equal(f.creates().length,1);
  assert.equal(f.engine.status().realizedPnlUsd,'0');assert.equal(s.manualRecovery,false);assert.equal(f.engine.status().filled,0);
});

test('second leg fails: bounded hedge, then reduce-only unwind with partial fill, then manual latch with exact exposure',async()=>{
  const f=fixture({plan:(_,i)=>i===2||i===3?{fill:0}:i===4?{fill:6}:{}});
  await f.tick([f.opp()]);assert.equal(f.creates().length,2);
  await f.tick([]);const hedge=f.creates()[2];
  assert.deepEqual([hedge.side,hedge.price,hedge.count,hedge.time_in_force,hedge.reduce_only],['ask','0.48','10','immediate_or_cancel',false],'buy NO up to 0.52');
  await f.tick([]);const unwind=f.creates()[3];
  assert.deepEqual([unwind.side,unwind.price,unwind.count,unwind.time_in_force,unwind.reduce_only],['ask','0.35','10','immediate_or_cancel',true],'sell YES no lower than 0.35');
  const s=await f.tick([f.opp()]);
  assert.equal(s.manualRecovery,true);assert.match(s.hold,/1 position\(s\), 4 contracts/);
  const p=s.packages[0];assert.equal(p.stage,'manual');assert.deepEqual(p.exposure,[{ticker:TICKER,outcome:'yes',contracts:'4'}]);
  const u=p.orders[3];assert.equal(u.filled,'6');assert.equal(u.cost,'3.9');assert.equal(u.fees,S(feeBound(6,'0.65','0.07')));
  await f.tick([f.opp()]);assert.equal(f.creates().length,4,'manual review blocks every new order');
  f.restart();await f.tick([f.opp()]);assert.equal(f.engine.state.manualRecovery,true);assert.equal(f.creates().length,4);
});

test('a successful hedge completes the package without an unwind',async()=>{
  const f=fixture({plan:(_,i)=>i===2?{fill:0}:{}});
  await f.tick([f.opp()]);await f.tick([]);await f.tick([]);
  const s=f.engine.state;assert.equal(s.packages[0].stage,'closed');assert.equal(f.creates().length,3);assert.equal(s.manualRecovery,false);
  assert.ok(!f.creates().some(b=>b.reduce_only));
});

test('unknown POST outcome is never resent; restart reconciles it by client ID from the durable journal',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'predarb-'));
  try{
    const journal=new Journal(dir);
    const f=fixture({journal,plan:(_,i)=>i===1?{throwAfter:true}:{}});
    let s=await f.tick([f.opp()]);
    assert.match(s.hold,/unknown/);assert.equal(f.creates().length,1);
    const pending=s.packages[0].orders[0];assert.equal(pending.orderId,null);assert.equal(pending.status,'UNKNOWN');
    journal.close();f.journal=new Journal(dir);f.restart();
    f.advance(30);s=await f.tick([f.opp()]);
    const found=s.packages[0].orders[0];assert.equal(found.clientOrderId,pending.clientOrderId);assert.equal(found.orderId,'order-1');assert.equal(found.accounted,true);
    assert.equal(f.creates().filter(b=>b.client_order_id===pending.clientOrderId).length,1,'never resent');
    assert.equal(f.creates().filter(b=>b.side==='bid'&&!b.reduce_only).length,1,'no new leg after an interruption; bounded repair only');
    f.journal.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an outcome still unknown after ten minutes latches manual review instead of retrying',async()=>{
  const f=fixture({plan:()=>({throwBefore:true})});
  await f.tick([f.opp()]);assert.equal(f.creates().length,1);
  f.advance(120);let s=await f.tick([f.opp()]);assert.equal(s.manualRecovery,false);assert.match(s.hold,/unknown/);
  f.advance(600);s=await f.tick([f.opp()]);assert.equal(s.manualRecovery,true);assert.match(s.hold,/10 minutes/);assert.equal(f.creates().length,1);
});

test('fills that lag the order are awaited; cumulative accounting uses venue fills only',async()=>{
  const f=fixture({plan:(_,i)=>i===1?{lagFills:true}:{}});
  await f.tick([f.opp()]);let s=await f.tick([]);
  assert.match(s.hold,/not yet visible/);assert.equal(s.packages[0].stage,'review');
  s=await f.tick([]);assert.equal(s.packages[0].stage,'closed');assert.equal(s.packages[0].orders[0].filled,'10');
});

test('loss latch is permanent across restarts and blocks new packages',async()=>{
  const f=fixture({config:{lossLimit:'1',unwindTolerance:'0.10'},plan:(_,i)=>i===2||i===3?{fill:0}:{}});
  await f.tick([f.opp()]);await f.tick([]);await f.tick([]);let s=await f.tick([]);
  assert.equal(s.packages[0].stage,'closed');assert.equal(s.lossLatched,true);assert.equal(f.engine.status().realizedPnlUsd,'-1.32');
  const before=f.creates().length;f.restart();s=await f.tick([f.opp()]);
  assert.equal(s.lossLatched,true);assert.match(s.hold,/Loss limit latched/);assert.equal(f.creates().length,before);
  f.restart({lossLimit:'5'});s=await f.tick([f.opp()]);assert.equal(s.lossLatched,true,'raising the limit never unlatches');assert.equal(f.creates().length,before);
});

test('allocation freezes at first live funding and never tops up or changes',async()=>{
  const f=fixture({balance:'40'});f.kalshi.create=async()=>{throw Error('unused');};
  await f.tick([]);assert.equal(f.engine.state.funding.kalshi.initialCapital,'40');
  f.kalshi.balanceValue='500';f.restart();await f.tick([]);assert.equal(f.engine.state.funding.kalshi.initialCapital,'40');
  assert.throws(()=>f.restart({allocation:{kalshi:'50',polymarket:'0'}}),/frozen/);
  const small=fixture({balance:'3'});let s=await small.tick([]);assert.equal(s.funding.kalshi.funded,false);assert.match(s.hold,/\$5/);
  small.restart({allocation:{kalshi:'60',polymarket:'0'}});small.kalshi.balanceValue='70';s=await small.tick([]);assert.equal(s.funding.kalshi.initialCapital,'60');
});

test('stale refreshed books, Polymarket legs and broad key scopes are refused without any order',async()=>{
  const f=fixture();let s=await f.tick([f.opp()],f.refresh({age:11}));
  assert.match(s.hold,/fresh book check/);assert.equal(f.creates().length,0);
  const poly={...f.opp(),venues:['polymarket','kalshi']};s=await f.tick([poly]);
  assert.match(s.hold,/Polymarket US/);assert.equal(f.creates().length,0);
  for(const scopes of [['read','write'],['read','write::trade','write::transfer'],['read']]){
    const g=fixture({scopes});s=await g.tick([g.opp()]);assert.match(s.hold,/scope/);assert.equal(g.creates().length,0);
  }
});

test('multi-outcome package holds until official settlement, then realizes the $1 payout',async()=>{
  let settled=false;
  const f=fixture({settlement:async ticker=>settled?{value:ticker.endsWith('-B')?'1':'0'}:null});
  const event={event_ticker:'KXWHO-26',series_ticker:'KXWHO',mutually_exclusive:true,collateral_return_type:'MECNET',markets:['A','B','C'].map(x=>({ticker:`KXWHO-26-${x}`}))};
  const books=at=>['A','B','C'].map((x,i)=>kbook({ticker:`KXWHO-26-${x}`,eventTicker:'KXWHO-26',yes:[[['0.30','0.28','0.32'][i],'5']],at}));
  const make=(limits={})=>multiOutcomeOpportunity(event,books(f.now-0.5),{exhaustiveSeries:['KXWHO'],maxTradeUsd:'25',...limits,now:f.now});
  await f.tick([make()],async(_,limits)=>make(limits));
  assert.equal(f.creates().length,3);assert.ok(f.creates().every(b=>b.side==='bid'&&b.time_in_force==='fill_or_kill'&&b.count==='5'));
  let s=await f.tick([]);assert.equal(s.packages[0].stage,'complete');
  const st=f.engine.status();assert.equal(st.realizedPnlUsd,'0');assert.ok(D(st.lockedPnlUsd)>0n);
  settled=true;f.advance(901);s=await f.tick([]);
  assert.equal(s.packages[0].stage,'closed');assert.equal(s.packages[0].settlement.payout,'5');
  assert.equal(f.engine.status().realizedPnlUsd,st.lockedPnlUsd);
});

test('status is aggregate only: no tickers, order identifiers or balances',async()=>{
  const f=fixture({plan:(_,i)=>i===2||i===3?{fill:0}:i===4?{fill:6}:{}});
  await f.tick([f.opp()]);for(let i=0;i<3;i++)await f.tick([]);
  const text=JSON.stringify(f.engine.status());
  for(const secret of [TICKER,'order-1',f.engine.state.packages[0].orders[0].clientOrderId,'"100"'])assert.ok(!text.includes(secret),secret);
});
