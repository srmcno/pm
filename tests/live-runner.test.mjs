import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {configuration,newState,validateState,scan,receipt,FeedRefresh,run} from '../scripts/live/runner.mjs';
import {LIVE_ACK} from '../scripts/live/config.mjs';
import {monitorCycle} from '../scripts/live/monitor.mjs';

test('cloud entry point refuses real execution and incomplete credentials',()=>{
  const env={MM_DATA_DIR:'/var/data/test'};
  assert.equal(configuration(env).credentials,null);
  assert.throws(()=>configuration({...env,MM_MODE:'live'}));
  assert.throws(()=>configuration({...env,MM_LIVE_ENABLED:'true'}));
  assert.throws(()=>configuration({...env,COINBASE_KEY_NAME:'partial'}));
  assert.throws(()=>configuration({...env,MM_SCAN_SECONDS:'NaN'}));
  assert.throws(()=>configuration({MM_DATA_DIR:'relative'}));
  const cfg=configuration({...env,COINBASE_KEY_NAME:'name',COINBASE_PRIVATE_KEY:'test',COINBASE_PORTFOLIO_ID:'scope'});
  assert.equal(cfg.credentials.allowSubmit,false);
  const live=configuration({...env,MM_MODE:'live',MM_LIVE_ACK:LIVE_ACK,COINBASE_KEY_NAME:'name',COINBASE_PRIVATE_KEY:'test',COINBASE_PORTFOLIO_ID:'scope'});
  assert.equal(live.credentials.allowSubmit,true);assert.equal(live.engine.allocation,'20');assert.equal(live.engine.maxOrder,'5');assert.equal(live.engine.lossLimit,'2');
  assert.equal(configuration({...env,MM_ALLOCATION_USD:'18.85'}).engine.allocation,'18.85');
  assert.throws(()=>configuration({...env,MM_ALLOCATION_USD:'20.01'}));
  assert.throws(()=>configuration({...env,MM_ALLOCATION_USD:'4.99'}));
  assert.throws(()=>configuration({...env,RENDER:'true',MM_DATA_DIR:'/tmp/ephemeral'}));
});

test('failed scan preserves evidence, cache and source time without leaking provider error',async()=>{
  const prior={...newState(1000),cycles:1,lastSuccessAt:1100,feedCache:[{product:'BTC-USD'}],report:{generatedAt:1100}};
  const next=await scan(prior,{clock:()=>2000,collect:async()=>{throw Error('secret response');}});
  assert.equal(next.lastSuccessAt,1100);assert.equal(next.cycles,2);assert.equal(next.consecutiveFailures,1);
  assert.deepEqual(next.report,prior.report);assert.deepEqual(next.feedCache,prior.feedCache);
  const status=receipt(next,{monthlyHosting:7.25},2100);
  assert.equal(status.sourceAgeSeconds,1000);assert.equal(status.actualTradingProfitUsd,null);
  assert.equal(status.status,'source_error');assert(!JSON.stringify(status).includes('secret response'));
});

test('successful scan uses post-collection clock and persists recovery',async()=>{
  const prior={...newState(1000),consecutiveFailures:2};let tick=1100;
  const next=await scan(prior,{clock:()=>tick,collect:async options=>{
    assert.equal(options.maxMarkets,100);assert.equal(options.preselect,130);tick=1200;
    return {markets:[{product:'BTC-USD'}],cache:[{product:'BTC-USD',candles:[]}]};
  },monitor:async({now,broker})=>{assert.equal(now,1200);assert.equal(broker,null);return {generatedAt:now};}});
  assert.equal(next.lastSuccessAt,1200);assert.equal(next.lastAttemptAt,1100);assert.equal(next.consecutiveFailures,0);
  assert.equal(next.feedCache.length,1);assert.equal(next.report.generatedAt,1200);
});

test('empty feed is failed, corrupt state is never reset and costs are separately labelled',async()=>{
  const next=await scan(newState(1000),{collect:async()=>({markets:[]}),clock:()=>1001});
  assert.equal(next.lastSuccessAt,null);assert.equal(next.consecutiveFailures,1);
  assert.throws(()=>validateState({...next,version:2}));
  const status=receipt(newState(1000),{monthlyHosting:7.25},1000+30.4375*86400);
  assert.equal(status.hostingAccruedEstimateUsd,7.25);assert.equal(status.actualTradingProfitUsd,null);
});
test('private marked PnL is unavailable for stale or incomplete portfolio marks',()=>{
  const state=newState(1000),config={monthlyHosting:7.25},engine={funded:true,marksComplete:true,lastMarkedAt:1050,equity:'19.05',initialCapital:'18.85'};
  assert.equal(receipt(state,config,1051,engine).markedTradingPnlUsd,'0.2');
  assert.equal(receipt(state,config,1111,engine).markedTradingPnlUsd,null);
  assert.equal(receipt(state,config,1051,{...engine,marksComplete:false}).markedTradingPnlUsd,null);
  assert.equal(receipt(state,config,1051,engine).actualTradingProfitUsd,null);
});

test('slow feed refresh does not block broker loop or overlap generations',async()=>{
  let finish,ticks=0,now=1000,calls=0;
  const worker=new FeedRefresh({clock:()=>now,collect:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  assert.equal(worker.start([],300),true);await Promise.resolve();
  for(let i=0;i<30;i++){ticks++;now+=15;assert.equal(worker.start([],300),false);}
  assert.equal(ticks,30);assert.equal(calls,1);assert.equal(worker.take(),null);
  finish({markets:[{product:'BTC-USD'}]});await worker.finish();
  assert.equal(worker.start([],300),false,'completed generation must be consumed first');
  const result=worker.take();assert.equal(result.at,1450);assert.equal(result.attemptAt,1000);
  assert.equal(worker.start([],300),true);await Promise.resolve();finish({markets:[]});await worker.finish();
});

function lifecycle({existing=false,credentials=false,live=false,once=true}={}){
  const signals=new EventEmitter(),closed=[],logs=[],saved=[],engineOptions=[],brokerOptions=[];let time=1000;
  const priorExecution={funded:true,lossLatched:false,manualRecovery:false,lastTickAt:900,lastSuccessAt:901,portfolioId:'DO_NOT_PUBLISH',cash:'123456',intents:[]};
  const journals={monitor:{load:()=>null,save:s=>saved.push(structuredClone(s)),close:()=>closed.push('monitor')},
    execution:{load:()=>structuredClone(priorExecution),save:()=>{},close:()=>closed.push('execution')}};
  const env={MM_DATA_DIR:'/var/data/test',...(once?{MM_ONCE:'true'}:{}),...(credentials||live?{COINBASE_KEY_NAME:'private-key-name',COINBASE_PRIVATE_KEY:'private-key-value',COINBASE_PORTFOLIO_ID:'portfolio'}:{}),...(live?{MM_MODE:'live',MM_LIVE_ACK:LIVE_ACK}:{})};
  const options={signals,clock:()=>time,ensureDirectory:async()=>{},executionExists:async()=>existing,
    createJournal:directory=>journals[directory.endsWith('/execution')?'execution':'monitor'],
    createBroker:config=>{brokerOptions.push(config);return {allowSubmit:config.allowSubmit};},
    createEngine:async config=>{engineOptions.push(config);return {state:priorExecution,tick:async()=>{}};},
    collect:async()=>({markets:[{product:'BTC-USD'}],universe:{generatedAt:time}}),
    monitor:async({now})=>({mode:'preview-only',generatedAt:now,coverage:{ready:1,selected:1}}),
    writeStatus:async()=>{},log:value=>logs.push(structuredClone(value)),wait:async()=>{throw Error('Unexpected second iteration');}};
  return {env,options,signals,closed,logs,saved,journals,engineOptions,brokerOptions,setTime:value=>{time=value;}};
}

test('queued collector completion is evaluated at consumption time while its original source receipt is retained',async()=>{
  const f=lifecycle({once:false});let evaluatedAt;
  f.options.collect=async()=>{f.setTime(1020);return {markets:[{product:'BTC-USD'}]};};
  f.options.wait=async()=>{await new Promise(resolve=>setImmediate(resolve));f.setTime(1040);};
  f.options.monitor=async({now})=>{evaluatedAt=now;f.signals.emit('SIGTERM');return {mode:'preview-only',generatedAt:now};};
  await run(f.env,f.options);
  assert.equal(evaluatedAt,1040);assert.equal(f.saved.at(-1).lastSuccessAt,1020);assert.equal(f.saved.at(-1).report.generatedAt,1040);
  assert.deepEqual(f.closed,['monitor']);assert.equal(f.signals.listenerCount('SIGTERM'),0);
});

test('preview restart reconciles existing execution journal with both mutation guards disarmed',async()=>{
  const f=lifecycle({existing:true,credentials:true});let ticks=0;
  f.options.createEngine=async options=>{f.engineOptions.push(options);return {state:{funded:true,intents:[]},tick:async()=>{ticks++;}};};
  f.options.monitor=async({broker})=>{assert.equal(broker,null,'only one owner may perform broker work');return {mode:'preview-only'};};
  await run(f.env,f.options);
  assert.equal(ticks,1);assert.equal(f.engineOptions[0].config.mode,'preview');assert.equal(f.brokerOptions[0].allowSubmit,false);
  assert.deepEqual(f.closed,['execution','monitor']);
});

test('live and disarmed existing engines give the companion report market-only scope',async()=>{
 for(const live of [false,true]){
  const f=lifecycle({existing:true,credentials:true,live});
  f.options.monitor=async args=>{
   assert.equal(args.broker,null);assert.equal(args.executionManaged,true);
   return monitorCycle({...args,clock:()=>args.now});
  };
  await run(f.env,f.options);
  const status=f.logs.find(x=>x.event==='worker_status');
  assert.equal(status.mode,live?'live':'preview');assert.equal(status.realOrdersEnabled,live);
  assert.equal(status.report.mode,'market-only');assert.equal(status.report.realEnabled,null);
  assert.equal(status.report.credentialStatus,'handled_by_execution_engine');assert.equal(status.report.feeStatus,'handled_by_execution_engine');
  assert.ok(status.execution);assert.equal(status.report.coverage.previewed,0);
 }
});

test('fresh preview workers retain their own authenticated preflight or missing-credentials context',async()=>{
 for(const credentials of [false,true]){
  const f=lifecycle({credentials});
  f.options.monitor=async args=>{
   assert.equal(args.executionManaged,false);assert.equal(args.broker!==null,credentials);
   return {mode:'preview-only',credentialStatus:credentials?'view_verified':'needs_credentials'};
  };
  await run(f.env,f.options);
  const status=f.logs.find(x=>x.event==='worker_status');
  assert.equal(status.mode,'preview');assert.equal(status.report.mode,'preview-only');assert.equal(status.execution,null);
 }
});

test('preview restart without credentials explicitly retains unresolved execution status without private fields',async()=>{
  const f=lifecycle({existing:true});await run(f.env,f.options);
  assert.equal(f.engineOptions.length,0);const status=f.logs.find(x=>x.event==='worker_status');
  assert.equal(status.execution.manualRecovery,true);assert.match(status.execution.hold,/without credentials/);assert.equal(status.execution.lastSuccessAt,901);
  assert.equal(status.realOrdersEnabled,false);for(const secret of ['DO_NOT_PUBLISH','123456','private-key-value'])assert.ok(!JSON.stringify(f.logs).includes(secret));
  assert.deepEqual(f.closed,['execution','monitor']);
});

test('initialization failures close every acquired journal and remove handlers',async()=>{
  for(const failure of ['load','broker','engine']){
    const f=lifecycle({existing:true,credentials:true});
    if(failure==='load')f.journals.monitor.load=()=>{throw Error('Unreadable state');};
    if(failure==='broker')f.options.createBroker=()=>{throw Error('Invalid config');};
    if(failure==='engine')f.options.createEngine=async()=>{throw Error('Invalid execution state');};
    await assert.rejects(run(f.env,f.options));assert.deepEqual(f.closed,failure==='engine'?['execution','monitor']:['monitor']);
    assert.equal(f.signals.listenerCount('SIGTERM'),0);assert.equal(f.signals.listenerCount('SIGINT'),0);
  }
});

test('shutdown during awaited monitor prevents starting an execution tick',async()=>{
  const f=lifecycle({live:true});let ticks=0;
  f.options.createEngine=async()=>({state:{intents:[]},tick:async()=>{ticks++;}});
  f.options.monitor=async()=>{await Promise.resolve();f.signals.emit('SIGTERM');return {mode:'preview-only'};};
  await run(f.env,f.options);assert.equal(ticks,0);assert.deepEqual(f.closed,['execution','monitor']);
});

test('shutdown during a running tick reaches the engine mutation predicate',async()=>{
  const f=lifecycle({live:true});let mutations=0,observedStopping=false;
  f.options.createEngine=async({isStopping})=>({state:{intents:[]},tick:async()=>{
    assert.equal(isStopping(),false);await Promise.resolve();f.signals.emit('SIGINT');observedStopping=isStopping();if(!isStopping())mutations++;
  }});
  await run(f.env,f.options);assert.equal(observedStopping,true);assert.equal(mutations,0);assert.deepEqual(f.closed,['execution','monitor']);
});

test('shutdown during single-run collection starts no tick or monitor after the await',async()=>{
  const f=lifecycle({live:true});let ticks=0,monitors=0;
  f.options.createEngine=async()=>({state:{intents:[]},tick:async()=>{ticks++;}});
  f.options.collect=async()=>{f.signals.emit('SIGTERM');return {markets:[{product:'BTC-USD'}]};};
  f.options.monitor=async()=>{monitors++;return {};};
  await run(f.env,f.options);assert.equal(ticks,0);assert.equal(monitors,0);assert.deepEqual(f.closed,['execution','monitor']);
});

test('startup recovery requires an explicit acknowledgement and happens before ordinary ticks',async()=>{
 for(const outcome of ['absent','recovered','already_applied','held']){
  const f=lifecycle({live:true}),calls=[],token='projection-v1-'+'a'.repeat(64);
  if(outcome!=='absent')f.env.MM_RECOVER_PROJECTION_ACK=token;
  f.options.createEngine=async()=>({state:{manualRecovery:true,intents:[]},
   recoverProjectionHold:async received=>{calls.push('recover');assert.equal(received,token);if(outcome==='held')throw Error('PRIVATE BROKER RESPONSE');return {recovered:outcome==='recovered'};},
   tick:async()=>calls.push('tick')});
  await run(f.env,f.options);
  assert.deepEqual(calls,outcome==='absent'?['tick']:['recover','tick']);
  const recovery=f.logs.filter(item=>item.event==='projection_recovery');assert.equal(recovery.length,outcome==='absent'?0:1);
  if(outcome!=='absent')assert.equal(recovery[0].status,outcome);
  assert.ok(!JSON.stringify(f.logs).includes(token));assert.ok(!JSON.stringify(f.logs).includes('PRIVATE BROKER RESPONSE'));
 }
});
