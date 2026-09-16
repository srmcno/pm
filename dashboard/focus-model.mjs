export function venueSummary(snapshot,venue,now=Date.now()/1000) {
  const account=snapshot.accounts[venue],source=snapshot.sources?.find(s=>s.venue===venue);
  const rows=(snapshot.decisions||[]).filter(d=>d.venue===venue);
  const checked=new Set(rows.map(d=>d.marketId)).size;
  const pending=Object.keys(account.pending||{}).length;
  const candidates=rows.filter(d=>d.plan?.status==='candidate').length;
  let status,detail;
  if(source?.status==='error') {status='Source unavailable';detail='The collector could not refresh this venue. No source times have been changed.';}
  else if(!Number.isFinite(source?.observedAt)||!Number.isFinite(snapshot.generatedAt)||now-source.observedAt>2700||now-snapshot.generatedAt>2700||source.observedAt>now+5||snapshot.generatedAt>now+5) {
    status='Collection delayed';detail='The latest completed scan is outside the expected collection window.';
  } else if(account.halted) {status='Risk stop';detail='New entries are paused by the account drawdown limit.';}
  else if(account.markComplete===false) {status='Position price unavailable';detail='New entries wait for a fresh value on an existing position.';}
  else if(pending) {status='Confirming a paper entry';detail=`${pending} outcome${pending===1?' has':'s have'} passed one scan. Another qualifying scan is required.`;}
  else if(account.positions.length) {status='Managing paper positions';detail=`${account.positions.length} open position${account.positions.length===1?'':'s'} awaiting official settlement; new markets are still evaluated.`;}
  else if(!rows.length) {status='No markets evaluated';detail='The latest snapshot contains no decisions for this venue.';}
  else if(rows.every(d=>!d.forecast?.eligible)) {
    const best=[...rows].sort((a,b)=>{
      const score=d=>Math.min(1,(d.forecast?.samples||0)/(d.forecast?.requirements?.cohort||100))+Math.min(1,(d.forecast?.binSamples||0)/(d.forecast?.requirements?.bin||50));
      return score(b)-score(a);
    })[0].forecast||{};
    status=best.entryStage?'Paper warmup':'Previous entry policy';
    detail=best.entryStage?`Closest match: ${best.samples||0}/${best.requirements?.cohort||100} related outcomes and ${best.binSamples||0}/${best.requirements?.bin||50} similar-price outcomes.`:
      'This snapshot still uses the previous validation-only entry policy. The updated collector has not published its first result yet.';
  } else {status=candidates?'Checking entry conditions':'Scanning for a price advantage';detail=candidates?`${candidates} outcome${candidates===1?' qualified':'s qualified'} in the last scan. Confirmation, funding and duplicate checks determine actual entries.`:
      'Paper estimates are available, but no entry passed every price, cost, depth and risk check.';}
  return {account,source,checked,pending,candidates,status,detail,partial:source?.status==='partial'};
}
export function ledgerRows(snapshot) {
  return Object.entries(snapshot.accounts||{}).flatMap(([venue,a])=>[
    ...(a.positions||[]).map(p=>({...p,venue,status:'open'})),
    ...(a.trades||[]).map(p=>({...p,venue,status:'settled'})),
  ]).sort((a,b)=>(b.closedAt||b.openedAt||0)-(a.closedAt||a.openedAt||0));
}
export function toCsv(rows) {
  const keys=['venue','status','question','side','quantity','cost','payout','pnl','openedAt','closedAt','entryPolicy'];
  const cell=v=>{
    let text=String(v??'');
    if(typeof v==='string' && /^[\s]*[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return [keys.join(','),...rows.map(r=>keys.map(k=>cell(k==='entryPolicy'?(r.forecast?.entryPolicy||r.version):r[k])).join(','))].join('\r\n');
}
