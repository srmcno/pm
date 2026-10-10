import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {run} from '../scripts/live/runner.mjs';
import {predictionConfiguration,PM_LIVE_ACK} from '../scripts/predlive/config.mjs';
import {startPredictionWorker} from '../scripts/predlive/worker.mjs';
import {complementOpportunity,normalizeAsks} from '../scripts/predlive/arb.mjs';

const PEM=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const KEY_ID='0f0e0d0c-1111-2222-3333-444455556666',POLY_SECRET=Buffer.alloc(64,9).toString('base64');
const BASE={MM_DATA_DIR:'/var/data/test'};

test('prediction configuration is absent by default and enforces hard ceilings and the exact acknowledgement',()=>{
  assert.equal(predictionConfiguration(BASE),null);assert.equal(predictionConfiguration({...BASE,PM_MODE:''}),null);
  const preview=predictionConfiguration({...BASE,PM_MODE:'preview'});
  assert.equal(preview.mode,'preview');assert.equal(preview.dataDir,'/var/data/test/predictions');assert.equal(preview.allowSports,false);
  assert.deepEqual({maxTrade:preview.engine.maxTrade,lossLimit:preview.engine.lossLimit,margin:preview.engine.margin},{maxTrade:'5',lossLimit:'5',margin:'0.01'});
  assert.equal(preview.credentials.kalshi,null);
  const live={...BASE,PM_MODE:'live',PM_LIVE_ACK:PM_LIVE_ACK,PM_KALSHI_ALLOCATION_USD:'100',KALSHI_KEY_ID:KEY_ID,KALSHI_PRIVATE_KEY:PEM};
  const ok=predictionConfiguration(live);assert.equal(ok.credentials.kalshi.allowSubmit,true);assert.equal(ok.engine.allocation.kalshi,'100');
  assert.equal(PM_LIVE_ACK,'I_ACCEPT_REAL_MONEY_PREDICTION_ARBITRAGE');
  const bad=[{PM_MODE:'on'},{PM_LIVE_ACK:'yes'},{PM_LIVE_ACK:undefined},{KALSHI_KEY_ID:undefined},{KALSHI_PRIVATE_KEY:undefined},{PM_KALSHI_ALLOCATION_USD:'100.01'},
    {PM_KALSHI_ALLOCATION_USD:'0'},{PM_KALSHI_ALLOCATION_USD:'4'},{PM_POLY_ALLOCATION_USD:'101'},{PM_MAX_TRADE_USD:'25.01'},{PM_LOSS_LIMIT_USD:'20.01'},{PM_MARGIN_USD:'0.005'},
    {PM_ALLOW_SPORTS:'yes'},{PM_SCAN_SECONDS:'5'},{PM_KALSHI_ENV:'staging'},{PM_EXHAUSTIVE_SERIES:'bad series!'},{POLYMARKET_US_KEY_ID:'only-one-half'},{MM_DATA_DIR:'relative'},
    {PM_KALSHI_ALLOCATION_USD:'10',PM_MAX_TRADE_USD:'11'},{PM_KALSHI_ALLOCATION_USD:'10',PM_LOSS_LIMIT_USD:'10'},{RENDER:'true',MM_DATA_DIR:'/tmp/x'}];
  for(const patch of bad){const env={...live,...patch};for(const [k,v] of Object.entries(patch))if(v===undefined)delete env[k];assert.throws(()=>predictionConfiguration(env),JSON.stringify(patch));}
  assert.equal(predictionConfiguration({...live,PM_MAX_TRADE_USD:'25',PM_LOSS_LIMIT_USD:'20'}).engine.maxTrade,'25');
  assert.equal(predictionConfiguration({...BASE,PM_MODE:'preview',PM_ALLOW_SPORTS:'true'}).engine.allowSports,true);
});

function lifecycle(env={}){
  const signals=new EventEmitter(),logs=[],statuses=[];let ticks=0;
  const journal={load:()=>null,save:()=>{},close:()=>{}};
  const options={signals,clock:()=>1000,ensureDirectory:async()=>{},executionExists:async()=>true,createJournal:()=>journal,
    createBroker:c=>({allowSubmit:c.allowSubmit}),createEngine:async()=>({state:{funded:true,intents:[]},tick:async()=>{ticks++;}}),
    collect:async()=>({markets:[{product:'BTC-USD'}]}),monitor:async()=>({mode:'preview-only'}),
    writeStatus:async(_,s)=>statuses.push(structuredClone(s)),log:v=>logs.push(structuredClone(v)),wait:async()=>{throw Error('Unexpected second iteration');}};
  return {env:{...BASE,MM_ONCE:'true',COINBASE_KEY_NAME:'cb-key',COINBASE_PRIVATE_KEY:'cb-private',COINBASE_PORTFOLIO_ID:'portfolio',...env},options,logs,statuses,ticks:()=>ticks};
}

test('Coinbase worker is unchanged when PM variables are absent',async()=>{
  const f=lifecycle();let calls=0;
  f.options.startPrediction=(env,o)=>{calls++;return startPredictionWorker(env,o);};
  await run(f.env,f.options);
  assert.equal(calls,1);assert.equal(f.ticks(),1);
  assert.equal(f.statuses.length,1);assert.equal('prediction_arbitrage' in f.statuses[0],false);
  assert.ok(!f.logs.some(l=>l.event==='prediction_arbitrage'));
});

test('prediction failures never block or crash the Coinbase engine',async()=>{
  const throwing=lifecycle({PM_MODE:'preview'});throwing.options.startPrediction=()=>{throw Error('boom');};
  await run(throwing.env,throwing.options);assert.equal(throwing.ticks(),1);assert.equal(throwing.statuses[0].prediction_arbitrage.mode,'error');
  const broken=lifecycle({PM_MODE:'preview'});
  broken.options.startPrediction=()=>({poll(){throw Error('poll');},async finish(){throw Error('finish');},async stop(){throw Error('stop');},status(){throw Error('status');}});
  await run(broken.env,broken.options);assert.equal(broken.ticks(),1);assert.equal(broken.statuses[0].prediction_arbitrage.hold,'Prediction status unavailable');
  const invalid=lifecycle({PM_MODE:'live'});
  await run(invalid.env,invalid.options);assert.equal(invalid.ticks(),1);
  assert.match(invalid.statuses[0].prediction_arbitrage.hold,/Invalid prediction configuration/);assert.equal(invalid.statuses[0].prediction_arbitrage.realOrdersEnabled,false);
  // A slow scan runs in the background: poll returns at once and never overlaps generations.
  let release,scans=0;const kalshi={authenticated:false,allowSubmit:false,canSubmit:false,async market(){return {};}};
  const worker=startPredictionWorker({...BASE,PM_MODE:'preview'},{clock:()=>5000,createJournal:()=>{let v=null;return {load:()=>v,save:x=>{v=structuredClone(x);},close(){}};},
    createKalshi:()=>kalshi,createScanner:()=>({scan:()=>{scans++;return new Promise(r=>{release=()=>r({opportunities:[],errors:[],coverage:{}});});},refresh:async()=>null}),crossVenue:async()=>({opportunities:[],errors:[]})});
  assert.equal(worker.poll(),true);assert.equal(worker.poll(),false);assert.equal(scans,1);assert.equal(worker.status().scans,0);
  release();await worker.finish();assert.equal(worker.status().scans,1);await worker.stop();
});

test('a preview prediction cycle runs in its own journal and exposes aggregate status without credentials',async()=>{
  const env={...BASE,PM_MODE:'preview',KALSHI_KEY_ID:KEY_ID,KALSHI_PRIVATE_KEY:PEM,POLYMARKET_US_KEY_ID:'pm-key-abcdef12',POLYMARKET_US_SECRET_KEY:POLY_SECRET};
  const f=lifecycle(env);let journalDir=null,now=1000;const saved=[];
  const book={venue:'kalshi',ticker:'KXSECRET-TICKER',eventTicker:'KXSECRET',status:'open',feeRate:'0.07',requestAt:999,receivedAt:999.1,closeAt:2000,
    asks:{yes:normalizeAsks([['0.40','10']]),no:normalizeAsks([['0.50','10']])}};
  const kalshi={authenticated:true,allowSubmit:false,canSubmit:false,async keyScopes(){return {scopes:['read','write::trade']};},
    async balance(){return {balance:'55.55'};},async create(){throw Error('must not submit');},async market(){return {};}};
  f.options.startPrediction=(e,o)=>startPredictionWorker(e,{...o,clock:()=>now,createJournal:dir=>{journalDir=dir;let v=null;return {load:()=>structuredClone(v),save:s=>{v=structuredClone(s);saved.push(v);},close(){}};},
    createKalshi:(credentials)=>{assert.equal(credentials.keyId,KEY_ID);assert.equal(credentials.allowSubmit,false);return kalshi;},
    createScanner:()=>({scan:async options=>({opportunities:[complementOpportunity(book,options)],errors:[],coverage:{events:1}}),refresh:async()=>null}),
    crossVenue:async()=>({opportunities:[],errors:[]})});
  await run(f.env,f.options);
  assert.equal(journalDir,'/var/data/test/predictions/execution');
  const status=f.statuses[0].prediction_arbitrage;
  assert.equal(status.mode,'preview');assert.equal(status.realOrdersEnabled,false);assert.equal(status.opportunitiesPositive,1);assert.equal(status.opportunitiesExecutable,1);
  assert.match(status.hold,/Preview/);assert.equal(status.latestNetEdgePerContractUsd,'0.05');assert.equal(status.venues.polymarket,'scan-only');
  assert.deepEqual(status.credentialsConfigured,{kalshi:true,polymarket:true});
  const text=JSON.stringify([f.statuses,f.logs]);
  for(const secret of [KEY_ID,PEM.slice(40,90),'PRIVATE KEY',POLY_SECRET,'pm-key-abcdef12','KXSECRET','55.55','cb-private'])assert.ok(!text.includes(secret),secret);
  assert.ok(saved.length>0);assert.ok(!JSON.stringify(saved).includes(KEY_ID),'the journal never stores credentials');
});
