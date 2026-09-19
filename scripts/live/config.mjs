import path from 'node:path';
import {D,S} from './risk.mjs';
export const LIVE_ACK='I_ACCEPT_REAL_MONEY_TRADING';
export function configuration(env=process.env){
  if(env.MM_LIVE_ENABLED!==undefined)throw Error('Use MM_MODE and the explicit operator acknowledgement; the legacy live flag is unsupported.');
  const mode=env.MM_MODE||'preview';
  const allocation=D(env.MM_ALLOCATION_USD||'20');
  if(allocation<D('5')||allocation>D('20'))throw Error('Allocation must be between $5 and the $20 hard ceiling.');
  if(!['preview','live'].includes(mode))throw Error('MM_MODE must be preview or live.');
  if(mode==='live'&&env.MM_LIVE_ACK!==LIVE_ACK)throw Error('Live activation requires the operator acknowledgement.');
  const scanSeconds=Number(env.MM_SCAN_SECONDS||300),monthlyHosting=Number(env.MM_MONTHLY_HOSTING_USD||7.25);
  if(!Number.isInteger(scanSeconds)||scanSeconds<120||scanSeconds>3600)throw Error('Scan interval must be 120–3600 seconds.');
  if(!Number.isFinite(monthlyHosting)||monthlyHosting<0||monthlyHosting>100)throw Error('Invalid hosting estimate.');
  const dataDir=env.MM_DATA_DIR;
  if(!dataDir||!path.isAbsolute(dataDir))throw Error('An absolute persistent MM_DATA_DIR is required.');
  if(env.RENDER==='true'&&!path.resolve(dataDir).startsWith('/var/data/'))throw Error('Render state must reside on the configured /var/data disk.');
  const fields=['COINBASE_KEY_NAME','COINBASE_PRIVATE_KEY','COINBASE_PORTFOLIO_ID'];
  const present=fields.filter(k=>env[k]);
  if((present.length&&present.length!==fields.length)||(mode==='live'&&present.length!==fields.length))throw Error('Coinbase connection requires all three private variables.');
  const credentials=present.length?{keyName:env.COINBASE_KEY_NAME,privateKey:env.COINBASE_PRIVATE_KEY,portfolioId:env.COINBASE_PORTFOLIO_ID,allowSubmit:mode==='live'}:null;
  return {dataDir,mode,scanSeconds,monthlyHosting,credentials,engine:{mode,allocation:S(allocation),maxOrder:'5',lossLimit:'2',expectedPortfolioId:credentials?.portfolioId}};
}
