// Same-quantity/same-price cost sensitivity; never an assertion of real fills.
export function executionEstimate(account,{feeRate=.009,slippageRate=.001}={}){
 if(!Number.isFinite(feeRate)||!Number.isFinite(slippageRate)||feeRate<0||slippageRate<0)throw Error('Invalid cost assumptions');
 let gross=0,turnover=0,legacyFeeLegs=0;
 for(const t of account?.trades||[]){
  const exit=t.proceeds+t.exitFees+t.exitSlippage;
  if(![t.principal,exit,t.entryFees,t.exitFees].every(Number.isFinite))return null;
  gross+=exit-t.principal;turnover+=exit+t.principal;
  if(Math.abs(t.entryFees-t.principal*feeRate)>.00001)legacyFeeLegs++;
  if(Math.abs(t.exitFees-exit*feeRate)>.00001)legacyFeeLegs++;
 }
 return {closedTrades:account?.trades?.length||0,gross,turnover,fees:turnover*feeRate,slippage:turnover*slippageRate,net: gross-turnover*(feeRate+slippageRate),legacyFeeLegs,feeRate,slippageRate};
}
