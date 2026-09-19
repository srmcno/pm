import {initialCompetition,advanceCompetition,validateCompetition,validRotationStudy} from '../dashboard/crypto-strategies-core.mjs';

export const STUDY_VERSION='2026-09-19-rotation-40-vs-100-v1';
const limits={control:40,expanded:100};
function carrier(account,startedAt,updatedAt){
 const s=initialCompetition(startedAt);s.updatedAt=updatedAt;
 for(const a of Object.values(s.accounts))if(a.id!=='rotation')a.status='risk-paused';
 if(account)s.accounts.rotation=structuredClone(account);
 return validateCompetition(s);
}
export function validateStudy(s){
 if(!validRotationStudy(s))throw Error('Invalid rotation comparison; refusing to reset evidence');
 for(const key of Object.keys(limits)){if(!s.accounts?.[key])throw Error('Missing comparison account');carrier(s.accounts[key],s.startedAt,s.updatedAt);}
 return s;
}
export function studyRequiredProducts(s){return s?Object.values(validateStudy(s).accounts).flatMap(a=>a.positions.map(p=>p.product)):[];}
function select(markets,account,limit){
 const required=new Set(['BTC-USD',...(account?.positions||[]).map(p=>p.product)]);
 const score=m=>Math.log1p(m.quoteVolume24h||0)+.15*Math.log1p(m.depthUsd||0)-(m.spreadBps??999)/100;
 const ranked=[...markets].sort((a,b)=>score(b)-score(a)||a.product.localeCompare(b.product));
 const chosen=ranked.filter(m=>required.has(m.product));
 for(const m of ranked)if(chosen.length<limit&&!chosen.some(x=>x.product===m.product))chosen.push(m);
 return chosen;
}
export function advanceStudy(previous,markets,now){
 if(previous)validateStudy(previous);
 if(previous&&now<=previous.updatedAt)return structuredClone(previous);
 const s=previous?structuredClone(previous):{version:STUDY_VERSION,realEnabled:false,startedAt:now,updatedAt:0,accounts:{},coverage:{}};
 for(const [key,limit] of Object.entries(limits)){
  const subset=select(markets,s.accounts[key],limit),next=advanceCompetition(carrier(s.accounts[key],s.startedAt,s.updatedAt),subset,now);
  s.accounts[key]=next.accounts.rotation;s.coverage[key]={limit,selected:subset.length,ready:next.markets.filter(m=>m.status==='ready').length,products:subset.map(m=>m.product)};
 }
 s.updatedAt=now;return validateStudy(s);
}
