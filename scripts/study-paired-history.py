import json,pathlib,math,bisect,datetime,hashlib,gzip,argparse
parser=argparse.ArgumentParser(description="Reproduce the frozen paired-market price screen without network requests.")
parser.add_argument("--output",type=pathlib.Path,required=True,help="Output directory for reproduced analysis and observations")
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
P=pathlib.Path(__file__).resolve().parents[1]/'data/research/paired-2026-09-13'; prov=json.loads((P/'provenance.json').read_text()); start,end=prov['start'],prov['end']
def read(n):
 raw=gzip.decompress((P/(n+'.json.gz')).read_bytes())
 assert hashlib.sha256(raw).hexdigest()==prov['requests'][n]['sha256'],n
 return json.loads(raw)
def fee(rate,price):return max(0,math.ceil((rate*price*(1-price)-1e-10)*100)/100)
def iso(t):return datetime.datetime.fromtimestamp(t,datetime.timezone.utc).isoformat()
report={'window':{'start':start,'end':end,'startISO':iso(start),'endISO':iso(end)},'method':'At each Kalshi minute end use its bid/ask closes and latest Polymarket stored observation no later than that end, aged at most 60 seconds. One contract on each leg, current fee counterfactual, round each fee up to cents, add 1 cent per leg slippage. No future match, forward-fill beyond 60s, depth, fills, or realized profit.','groups':[]}
matched=[]
for league,side_list in [('nfl',['DEN','KC']),('mlb',['NYY','MIN'])]:
 pm=[r for r in read(league+'-pm-history')['history'] if start<=r['timestamp']<=end];pm.sort(key=lambda r:r['timestamp']);ts=[r['timestamp'] for r in pm]
 market=read(league+'-pm-market')['market']; pr=float(market['feeCoefficient']);series=read(league+'-kalshi-series')['series'];kr=.07*float(series['fee_multiplier']);changes=read(league+'-kalshi-fees')['event_fee_changes'];effective=[c for c in changes if datetime.datetime.fromisoformat(c['scheduled_ts'].replace('Z','+00:00')).timestamp()<=end]
 if effective:
  effective.sort(key=lambda c:c['scheduled_ts']);kr=.07*float(effective[-1].get('fee_multiplier_override',series['fee_multiplier']))
 for kside in side_list:
  bars=read(league+'-kalshi-'+kside+'-history')['candlesticks'];samples=[];excluded={'outOfWindow':0,'invalidQuote':0,'noPriorPMWithin60s':0}
  for r in bars:
   t=r['end_period_ts']
   if not start<=t<=end:excluded['outOfWindow']+=1;continue
   try:bid=float(r['yes_bid']['close_dollars']);ask=float(r['yes_ask']['close_dollars'])
   except (KeyError,TypeError,ValueError):excluded['invalidQuote']+=1;continue
   if not 0<bid<=ask<1:excluded['invalidQuote']+=1;continue
   j=bisect.bisect_right(ts,t)-1
   if j<0 or t-ts[j]>60:excluded['noPriorPMWithin60s']+=1;continue
   point=pm[j]
   for yes in [True,False]:
    # PM LONG represents first/away team. K YES is selected kside.
    pm_long = (kside!=side_list[0]) if yes else (kside==side_list[0])
    price=float(point['longPrice' if pm_long else 'shortPrice']); kp=ask if yes else 1-bid
    if not 0<price<1:continue
    gross=1-price-kp;costfees=fee(pr,price)+fee(kr,kp);net=gross-costfees-.02
    samples.append({'time':t,'kalshiSide':'yes' if yes else 'no','pmSide':'yes' if pm_long else 'no','pmTimestamp':point['timestamp'],'pmAgeSeconds':t-point['timestamp'],'pmAsk':price,'kalshiAskProxy':kp,'grossGap':round(gross,9),'fees':round(costfees,9),'slippage':.02,'netGap':round(net,9)})
  best=max(samples,key=lambda r:r['netGap']) if samples else None
  group={'league':league,'kalshiContract':kside,'pmPoints':len(pm),'pmCoverage':[iso(ts[0]),iso(ts[-1])],'kalshiBars':len(bars),'validAlignedMinuteEnds':len(samples)//2,'directionalSamples':len(samples),'positiveGross':sum(r['grossGap']>1e-8 for r in samples),'positiveNet':sum(r['netGap']>1e-8 for r in samples),'pmFeeCoefficient':pr,'kalshiCurrentCoefficient':kr,'excluded':excluded,'strongestNet':best}
  report['groups'].append(group);matched += [dict(league=league,contract=kside,**r) for r in samples]
report['totals']={'directionalSamples':len(matched),'positiveGross':sum(r['grossGap']>1e-8 for r in matched),'positiveNet':sum(r['netGap']>1e-8 for r in matched),'strongestNet':max(matched,key=lambda r:r['netGap']) if matched else None}
report['ruleMismatch']={'nfl':'Same scheduled game and team orientations verified. Both state tie payout 0.50. Polymarket: delayed/postponed/suspended game rescheduled within two calendar days; Kalshi: game must BEGIN within 48 hours. Fair-market settlement determined independently. Full pathwise equivalence is not established.','mlb':'Same Sep14 19:40 ET game verified. Material mismatch: Polymarket permits rescheduling within TWO WEEKS, Kalshi within TWO DAYS; fair-value fallback can differ. Not a guaranteed complementary payout package.'}
report['limitations']=['Screening only: PM display prices are normally best-ask-derived, but there is no historical depth or executable order confirmation.','Kalshi minute close quote can have stale underlying updates; minute end is an availability boundary, not an authenticated quote timestamp.','Repeated observations and complementary directions are correlated, not independent trades. Missing bars are excluded and no coverage beyond the observed sample is asserted.','Current fee coefficients are a counterfactual across this one-day window, not proof every historical fill had that fee. Future overrides not applied early.','Both games remain unresolved at study time; no realized profit or outcomes follow. Rule mismatch independently blocks arbitrage eligibility.']
(args.output/'analysis.json').write_text(json.dumps(report,indent=2));(args.output/'matched-screen.json').write_text(json.dumps(matched,separators=(',',':')))
lines=['# One-day cross-venue moneyline screen','',f"Window: {iso(start)} through {iso(end)}.",'',report['method'],'','| Game / Kalshi team contract | PM points | Kalshi bars | Aligned minute ends | Directional samples | Gross below $1 | Net below $1 | Strongest net gap |','|---|---:|---:|---:|---:|---:|---:|---:|']
for g in report['groups']:lines.append(f"| {g['league']} / {g['kalshiContract']} | {g['pmPoints']} | {g['kalshiBars']} | {g['validAlignedMinuteEnds']} | {g['directionalSamples']} | {g['positiveGross']} | {g['positiveNet']} | ${g['strongestNet']['netGap']:.4f} |")
lines+=['','The two game histories are reused across team contracts; do not add PM point counts across these rows.','',*report['ruleMismatch'].values(),'']+['- '+r for r in report['limitations']]+['','Primary documentation: https://docs.polymarket.us/api-reference/price-history/get-price-history and https://docs.kalshi.com/api-reference/market/get-market-candlesticks . Raw responses, URLs, retrieval timestamps and SHA-256 are in provenance.json and discovery-provenance.json. Full directional observations are in matched-screen.json.']
(args.output/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps(report["totals"],indent=2))
