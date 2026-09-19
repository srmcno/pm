import {writeFile,rename,mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectCoinbaseMarkets} from '../crypto-feed.mjs';
import {CoinbaseLive} from './coinbase.mjs';
import {Journal} from './journal.mjs';
import {monitorCycle} from './monitor.mjs';
import {configuration} from './config.mjs';
import {D,S} from './risk.mjs';
export {configuration} from './config.mjs';

export function validateState(state){
  if(!state||state.version!==1||!Number.isFinite(state.startedAt)||state.startedAt<=0||!Number.isInteger(state.cycles)||state.cycles<0||!Number.isInteger(state.consecutiveFailures)||state.consecutiveFailures<0||!Array.isArray(state.feedCache)||state.feedCache.length>1000)throw Error('Invalid monitor journal; refusing to reset its history.');
  if(state.lastSuccessAt!==null&&(!Number.isFinite(state.lastSuccessAt)||state.lastSuccessAt<state.startedAt))throw Error('Invalid source receipt in monitor journal.');
  return state;
}
export function newState(now){return {version:1,startedAt:now,cycles:0,consecutiveFailures:0,lastSuccessAt:null,lastAttemptAt:null,feedCache:[],report:null};}
export async function scan(state,{broker=null,collect=collectCoinbaseMarkets,monitor=monitorCycle,clock=()=>Date.now()/1000}={}){
  validateState(state);const attemptAt=clock();
  try{
    const feed=await collect({cached:state.feedCache,maxMarkets:100,preselect:130});
    if(!Array.isArray(feed.markets)||!feed.markets.some(m=>!m.sourceError))throw Error('No usable markets');
    const now=clock(),report=await monitor({feed,broker,now});
    return {...state,cycles:state.cycles+1,consecutiveFailures:0,lastAttemptAt:attemptAt,lastSuccessAt:now,feedCache:feed.cache||feed.markets,report};
  }catch{
    // Preserve original source times; never stamp old evidence as freshly read.
    return {...state,cycles:state.cycles+1,consecutiveFailures:state.consecutiveFailures+1,lastAttemptAt:attemptAt};
  }
}
export function receipt(state,config,now=Date.now()/1000,engineState=null){
  let markedTradingPnlUsd=null;
  if(engineState?.funded&&engineState.marksComplete===true&&Number.isFinite(engineState.lastMarkedAt)&&engineState.lastMarkedAt<=now&&now-engineState.lastMarkedAt<=60){
    try{markedTradingPnlUsd=S(D(engineState.equity)-D(engineState.initialCapital));}catch{}
  }
  return {event:'worker_status',mode:config.mode||'preview',realOrdersEnabled:config.mode==='live',at:now,
    startedAt:state.startedAt,cycles:state.cycles,lastAttemptAt:state.lastAttemptAt,lastSuccessAt:state.lastSuccessAt,
    sourceAgeSeconds:state.lastSuccessAt===null?null:Math.max(0,Math.round(now-state.lastSuccessAt)),
    status:state.consecutiveFailures?'source_error':state.lastSuccessAt===null?'starting':'monitoring',consecutiveFailures:state.consecutiveFailures,
    monthlyHostingEstimateUsd:config.monthlyHosting,hostingAccruedEstimateUsd:Number((Math.max(0,now-state.startedAt)*config.monthlyHosting/(30.4375*86400)).toFixed(6)),
    hostingEstimateBasis:'Elapsed wall time at configured monthly rate; not a Render invoice',
    // Identifiers, balances, order IDs and responses stay in the private journal.
    execution:engineState?{funded:engineState.funded,lossLatched:engineState.lossLatched,manualRecovery:engineState.manualRecovery,hold:engineState.hold,lastTickAt:engineState.lastTickAt,lastSuccessAt:engineState.lastSuccessAt}:null,
    actualTradingProfitUsd:null,markedTradingPnlUsd,markedTradingPnlBasis:'Own bot holdings valued at current net liquidation estimates; not realized profit. External setup costs and hosting excluded.',
    lastMarkedAt:engineState?.lastMarkedAt??null,marksComplete:engineState?.marksComplete===true,report:state.report};
}
async function exportStatus(dir,status){
  const temporary=path.join(dir,`status.${process.pid}.tmp`);
  await writeFile(temporary,JSON.stringify(status)+'\n',{mode:0o600});await rename(temporary,path.join(dir,'status.json'));
}

// Collection can take minutes. It must never block the broker reconciliation
// loop, and overlapping collector generations must never overwrite each other.
export class FeedRefresh {
  #pending=null; #finished=null; #clock; #collect; #lastAttempt=-Infinity;
  constructor({collect=collectCoinbaseMarkets,clock=()=>Date.now()/1000}={}){this.#collect=collect;this.#clock=clock;}
  start(cached,interval,requiredProducts=[]){
    if(this.#pending||this.#finished||this.#clock()-this.#lastAttempt<interval)return false;
    this.#lastAttempt=this.#clock();
    this.#pending=Promise.resolve().then(()=>this.#collect({cached,requiredProducts,maxMarkets:100,preselect:130}))
      .then(feed=>{this.#finished={feed,at:this.#clock(),attemptAt:this.#lastAttempt};},()=>{this.#finished={failed:true,at:this.#clock(),attemptAt:this.#lastAttempt};})
      .finally(()=>{this.#pending=null;});
    return true;
  }
  take(){const result=this.#finished;this.#finished=null;return result;}
  async finish(){await this.#pending;}
}
async function executionExists(directory){
  // Either file indicates a previous execution lifecycle. A missing/corrupt
  // partner must reach Journal's recovery checks, never become a fresh account.
  for(const name of ['lock.sqlite','state.sqlite']){
    try{await lstat(path.join(directory,name));return true;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return false;
}
function waitForTick(ms,signal){
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
  });
}
export async function run(env=process.env,dependencies={}){
  const config=configuration(env),clock=dependencies.clock||(()=>Date.now()/1000),signals=dependencies.signals||process;
  const createJournal=dependencies.createJournal||(directory=>new Journal(directory));
  const createBroker=dependencies.createBroker||(credentials=>new CoinbaseLive(credentials));
  const createEngine=dependencies.createEngine||(async options=>{const {Engine}=await import('./engine.mjs');return new Engine(options);});
  const monitor=dependencies.monitor||monitorCycle,writeStatus=dependencies.writeStatus||exportStatus,log=dependencies.log||(value=>console.log(JSON.stringify(value)));
  const controller=new AbortController();let stopping=false,journal,executionJournal,state,engine=null,unresolvedExecution=null;
  const stop=()=>{stopping=true;controller.abort();};signals.once('SIGTERM',stop);signals.once('SIGINT',stop);
  try{
    await (dependencies.ensureDirectory||mkdir)(config.dataDir,{recursive:true,mode:0o700});
    journal=createJournal(path.join(config.dataDir,'monitor'));
    state=journal.load();if(state)validateState(state);else{state=newState(clock());journal.save(state,{type:'initialize'});}
    const broker=config.credentials?createBroker(config.credentials):null;
    const executionDir=path.join(config.dataDir,'execution'),existing=await (dependencies.executionExists||executionExists)(executionDir);
    if(config.mode==='live'||existing){
      executionJournal=createJournal(executionDir);
      if(broker){
        // Existing positions continue read-only reconciliation after disarming.
        // Both the engine mode and broker mutation guard remain preview-only.
        engine=await createEngine({broker,journal:executionJournal,config:config.engine,clock,isStopping:()=>stopping});
      }else{
        const prior=executionJournal.load();
        if(!prior)throw Error('Existing execution journal needs recovery; refusing to hide missing state.');
        unresolvedExecution={funded:prior.funded===true,lossLatched:prior.lossLatched===true,manualRecovery:true,
          hold:'Existing execution state cannot be reconciled without credentials. Outstanding orders and positions may remain at the broker.',
          lastTickAt:Number.isFinite(prior.lastTickAt)?prior.lastTickAt:null,lastSuccessAt:Number.isFinite(prior.lastSuccessAt)?prior.lastSuccessAt:null};
      }
    }
    if(engine&&env.MM_RECOVER_PROJECTION_ACK){
      try{
        const result=await engine.recoverProjectionHold(env.MM_RECOVER_PROJECTION_ACK);
        log({event:'projection_recovery',status:result.recovered?'recovered':'already_applied'});
      }catch{
        // A refused or stale acknowledgement must never unlock the ledger.
        log({event:'projection_recovery',status:'held',message:'Recovery conditions changed or the acknowledgement did not match; existing controls remain in force.'});
      }
    }
    const refresher=new FeedRefresh({clock,collect:dependencies.collect||collectCoinbaseMarkets});let feed=null,lastOutput=0;
    log({event:'worker_started',mode:config.mode,realOrdersEnabled:config.mode==='live',credentialsConfigured:!!broker,revision:env.RENDER_GIT_COMMIT||null});
    while(!stopping){
      const requiredProducts=engine?[...new Set((engine.state.intents||[]).map(i=>i.productId??i.product).filter(Boolean))]:[];
      refresher.start(state.feedCache,config.scanSeconds,requiredProducts);
      if(env.MM_ONCE==='true')await refresher.finish();
      if(stopping)break;
      const completed=refresher.take();
      if(completed){
        const good=completed.feed?.markets?.some(m=>!m.sourceError);
        if(good){
          feed=completed.feed;
          // Engine owns authenticated work, including read-only reconciliation
          // after disarming. Its companion scan reports only market signals.
          const report=await monitor({feed,broker:engine?null:broker,now:clock(),allocation:config.engine.allocation,executionManaged:!!engine});
          state={...state,cycles:state.cycles+1,consecutiveFailures:0,lastAttemptAt:completed.attemptAt,lastSuccessAt:completed.at,feedCache:feed.cache||feed.markets,report};
        }else state={...state,cycles:state.cycles+1,consecutiveFailures:state.consecutiveFailures+1,lastAttemptAt:completed.attemptAt};
        journal.save(state,{type:good?'scan':'source_error'});
      }
      if(engine&&!stopping)await engine.tick(feed&&clock()-state.lastSuccessAt<=900?feed:{markets:[]});
      if(completed||stopping||clock()-lastOutput>=30){
        const status=receipt(state,config,clock(),engine?.state||unresolvedExecution);await writeStatus(config.dataDir,status);log(status);lastOutput=clock();
      }
      if(env.MM_ONCE==='true')break;
      if(!stopping)await (dependencies.wait||waitForTick)(15000,controller.signal);
    }
  }finally{
    signals.removeListener('SIGTERM',stop);signals.removeListener('SIGINT',stop);
    try{executionJournal?.close();}finally{journal?.close();}
  }
  if(state?.consecutiveFailures&&env.MM_ONCE==='true')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  run().then(()=>process.exit(process.exitCode||0)).catch(()=>{console.error(JSON.stringify({event:'worker_fatal',message:'Worker stopped. Check private configuration and durable state; reconcile any outstanding broker orders before recovery.'}));process.exit(1);});
}
