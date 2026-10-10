import path from 'node:path';
import {D,S} from '../live/risk.mjs';

export const PM_LIVE_ACK='I_ACCEPT_REAL_MONEY_PREDICTION_ARBITRAGE';
// Absolute ceilings fixed in code. Configuration can only lower them.
export const HARD_LIMITS=Object.freeze({allocation:'100',maxTrade:'25',lossLimit:'20',minFunding:'5'});
const SERIES=/^[A-Z0-9][A-Z0-9._-]{0,63}$/;

function money(env,key,fallback,{min,max,allowZero=false}){
  const raw=env[key]===undefined||env[key]===''?fallback:env[key];
  let value;try{value=D(raw);}catch{throw Error(`${key} must be a decimal dollar amount.`);}
  if(allowZero&&value===0n)return value;
  if(value<D(min)||value>D(max))throw Error(`${key} must be between $${min} and $${max}${allowZero?' (or 0 to disable the venue)':''}.`);
  return value;
}
function flag(env,key){
  const raw=env[key]??'false';
  if(raw!=='true'&&raw!=='false')throw Error(`${key} must be true or false.`);
  return raw==='true';
}

/** Returns null when PM_MODE is absent: the prediction engine does not exist
 * and the Coinbase worker behaves exactly as before. Credentials stay in the
 * returned object only; never log it. */
export function predictionConfiguration(env=process.env){
  if(env.PM_MODE===undefined||env.PM_MODE==='')return null;
  const mode=env.PM_MODE;
  if(!['preview','live'].includes(mode))throw Error('PM_MODE must be preview or live.');
  if(mode==='live'&&env.PM_LIVE_ACK!==PM_LIVE_ACK)throw Error('Live prediction arbitrage requires the exact operator acknowledgement in PM_LIVE_ACK.');
  const kalshiAllocation=money(env,'PM_KALSHI_ALLOCATION_USD','0',{min:HARD_LIMITS.minFunding,max:HARD_LIMITS.allocation,allowZero:true});
  const polyAllocation=money(env,'PM_POLY_ALLOCATION_USD','0',{min:HARD_LIMITS.minFunding,max:HARD_LIMITS.allocation,allowZero:true});
  const maxTrade=money(env,'PM_MAX_TRADE_USD','5',{min:'1',max:HARD_LIMITS.maxTrade});
  const lossLimit=money(env,'PM_LOSS_LIMIT_USD','5',{min:'1',max:HARD_LIMITS.lossLimit});
  const margin=money(env,'PM_MARGIN_USD','0.01',{min:'0.01',max:'0.25'});
  const hedgeTolerance=money(env,'PM_HEDGE_TOLERANCE_USD','0.02',{min:'0',max:'0.05',allowZero:true});
  const unwindTolerance=money(env,'PM_UNWIND_TOLERANCE_USD','0.05',{min:'0.01',max:'0.10'});
  if(mode==='live'&&kalshiAllocation===0n)throw Error('Live mode needs PM_KALSHI_ALLOCATION_USD; Kalshi is the only venue that can execute.');
  if(kalshiAllocation>0n&&(maxTrade>kalshiAllocation||lossLimit>=kalshiAllocation))throw Error('PM_MAX_TRADE_USD must fit within, and PM_LOSS_LIMIT_USD must be below, the Kalshi allocation.');
  const scanSeconds=Number(env.PM_SCAN_SECONDS||300);
  if(!Number.isInteger(scanSeconds)||scanSeconds<30||scanSeconds>3600)throw Error('PM_SCAN_SECONDS must be 30-3600.');
  const environment=env.PM_KALSHI_ENV||'production';
  if(!['production','demo'].includes(environment))throw Error('PM_KALSHI_ENV must be production or demo.');
  const exhaustiveSeries=(env.PM_EXHAUSTIVE_SERIES||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(exhaustiveSeries.some(s=>!SERIES.test(s))||exhaustiveSeries.length>50)throw Error('PM_EXHAUSTIVE_SERIES must be a comma-separated list of Kalshi series tickers.');
  const dataRoot=env.MM_DATA_DIR;
  if(!dataRoot||!path.isAbsolute(dataRoot))throw Error('An absolute persistent MM_DATA_DIR is required.');
  if(env.RENDER==='true'&&!path.resolve(dataRoot).startsWith('/var/data/'))throw Error('Render state must reside on the configured /var/data disk.');
  const pair=(a,b,label)=>{const has=[env[a],env[b]].filter(Boolean).length;if(has===1)throw Error(`${label} requires both ${a} and ${b}.`);return has===2;};
  const hasKalshi=pair('KALSHI_KEY_ID','KALSHI_PRIVATE_KEY','Kalshi connection');
  const hasPoly=pair('POLYMARKET_US_KEY_ID','POLYMARKET_US_SECRET_KEY','Polymarket US connection');
  if(mode==='live'&&!hasKalshi)throw Error('Live mode requires KALSHI_KEY_ID and KALSHI_PRIVATE_KEY.');
  return Object.freeze({
    mode,dataDir:path.join(dataRoot,'predictions'),scanSeconds,environment,
    allowSports:flag(env,'PM_ALLOW_SPORTS'),scanCrossVenue:env.PM_SCAN_CROSS_VENUE===undefined?true:flag(env,'PM_SCAN_CROSS_VENUE'),
    exhaustiveSeries:Object.freeze(exhaustiveSeries),
    engine:Object.freeze({mode,allocation:Object.freeze({kalshi:S(kalshiAllocation),polymarket:S(polyAllocation)}),maxTrade:S(maxTrade),lossLimit:S(lossLimit),
      margin:S(margin),hedgeTolerance:S(hedgeTolerance),unwindTolerance:S(unwindTolerance),allowSports:flag(env,'PM_ALLOW_SPORTS'),exhaustiveSeries:Object.freeze(exhaustiveSeries)}),
    credentials:Object.freeze({
      kalshi:hasKalshi?Object.freeze({keyId:env.KALSHI_KEY_ID,privateKey:env.KALSHI_PRIVATE_KEY,allowSubmit:mode==='live',environment}):null,
      polymarket:hasPoly?Object.freeze({keyId:env.POLYMARKET_US_KEY_ID,secretKey:env.POLYMARKET_US_SECRET_KEY}):null,
    }),
  });
}
