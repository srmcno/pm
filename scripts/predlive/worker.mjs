// Separate prediction-arbitrage engine hosted by the Coinbase worker process.
// It owns its own journal (MM_DATA_DIR/predictions/execution), runs in the
// background, and isolates every error so the Coinbase loop is never blocked.
import path from 'node:path';
import {Journal} from '../live/journal.mjs';
import {predictionConfiguration} from './config.mjs';
import {KalshiLive} from './kalshi.mjs';
import {PolymarketUSReadOnly,POLYMARKET_SUBMIT_REASON} from './polymarket.mjs';
import {PredictionArbEngine} from './engine.mjs';
import {KalshiScanner,scanCrossVenue,kalshiSettlement} from './scanner.mjs';

const CROSS_VENUE_SECONDS=1800,REPAIR_SECONDS=15;
const disabled=(mode,hold)=>({mode,realOrdersEnabled:false,hold});

/** Returns null when PM_MODE is absent. Never throws: a broken prediction
 * configuration produces a held status block, not a worker crash. */
export function startPredictionWorker(env,{clock=()=>Date.now()/1000,isStopping=()=>false,createJournal=dir=>new Journal(dir),
  createKalshi=(credentials,environment)=>new KalshiLive(credentials?{...credentials,environment}:{environment}),
  createPolymarket=credentials=>new PolymarketUSReadOnly(credentials??{}),createScanner=kalshi=>new KalshiScanner({kalshi,clock}),
  crossVenue=scanCrossVenue,log=()=>{}}={}){
  if(env.PM_MODE===undefined||env.PM_MODE==='')return null;
  let config;
  try{config=predictionConfiguration(env);}catch(error){
    const status=disabled(String(env.PM_MODE).slice(0,16),`Invalid prediction configuration: ${error.message}`);
    return {status:()=>status,poll(){},async finish(){},async stop(){}};
  }
  let engine=null,scanner=null,journal=null,startError=null;
  try{
    const kalshi=createKalshi(config.credentials.kalshi,config.environment);
    const polymarket=createPolymarket(config.credentials.polymarket);
    journal=createJournal(path.join(config.dataDir,'execution'));
    engine=new PredictionArbEngine({venues:{kalshi,polymarket},journal,config:config.engine,clock,isStopping,settlement:kalshiSettlement(kalshi)});
    scanner=createScanner(kalshi);
  }catch{
    try{journal?.close();}catch{}
    startError='Prediction engine could not start: check its private configuration and durable journal';
  }
  let pending=null,lastStart=-Infinity,lastRepair=-Infinity,lastCross=-Infinity,crossCache=[],lastError=null,coverage=null,sourceErrors=0;
  const options=()=>({allowSports:config.allowSports,exhaustiveSeries:[...config.exhaustiveSeries],margin:config.engine.margin,maxTradeUsd:config.engine.maxTrade});
  async function cycle(){
    // Reconcile and repair before the (slow) scan so a broken package is never
    // left waiting behind market discovery.
    if(engine.activePackages)await engine.tick({opportunities:[]});
    const now=clock();
    const result=await scanner.scan({...options(),now});
    let opportunities=result.opportunities;
    if(config.scanCrossVenue&&now-lastCross>=CROSS_VENUE_SECONDS){
      lastCross=now;
      try{const cross=await crossVenue({...options(),now:clock()});crossCache=cross.opportunities;sourceErrors+=cross.errors.length;}catch{sourceErrors++;}
      opportunities=[...opportunities,...crossCache];
    }
    coverage=result.coverage;sourceErrors+=result.errors.length;
    engine.recordScan(opportunities,clock());
    const refresh=(opportunity,limits)=>scanner.refresh(opportunity,{...options(),...limits,now:clock()});
    await engine.tick({opportunities:result.opportunities,refresh});
    lastError=null;
  }
  return {
    poll(){
      if(!engine||pending||isStopping())return false;
      let work;
      if(clock()-lastStart>=config.scanSeconds){lastStart=lastRepair=clock();work=cycle;}
      else if(engine.activePackages&&clock()-lastRepair>=REPAIR_SECONDS){lastRepair=clock();work=()=>engine.tick({opportunities:[]}).then(()=>{lastError=null;});}
      else return false;
      pending=work().catch(()=>{lastError='Prediction cycle failed; existing journal and controls remain in force';})
        .finally(()=>{pending=null;try{log({event:'prediction_arbitrage',...this.status()});}catch{}});
      return true;
    },
    async finish(){await pending;},
    async stop(){await pending;try{journal?.close();}catch{}journal=null;},
    status(){
      if(!engine)return disabled(config.mode,startError);
      const s=engine.status();
      return {...s,hold:lastError??s.hold,credentialsConfigured:{kalshi:!!config.credentials.kalshi,polymarket:!!config.credentials.polymarket},
        venues:{kalshi:config.mode==='live'?'live-capable':'preview',polymarket:'scan-only'},polymarketNote:POLYMARKET_SUBMIT_REASON,
        allowSports:config.allowSports,coverage,sourceErrors};
    },
  };
}
