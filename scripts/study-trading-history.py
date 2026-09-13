"""Reproduce archive concentration and depth loss without inventing fills."""
import json, statistics, hashlib
from collections import Counter
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def study(name):
    paths=sorted((ROOT/'data'/name/'history').glob('*.jsonl'))
    count=0; receipts=0; route_counts=Counter(); losses=[]; stamps=[]; digest=hashlib.sha256()
    for p in paths:
        for line in p.open('rb'):
            digest.update(line)
            d=json.loads(line);count+=1;stamps.append(d['t'])
            for r in d.get('verified',[]):
                receipts+=1;route_counts[r['path']]+=1
                if isinstance(r.get('screenBps'),(int,float)) and isinstance(r.get('verifiedBps'),(int,float)):
                    losses.append(r['screenBps']-r['verifiedBps'])
    stamps=sorted(set(stamps));intervals=[b-a for a,b in zip(stamps,stamps[1:])]
    return {'name':'Kraken' if name=='krakenarb' else 'MEXC (retired)', 'scans':count,'positiveDepthReceipts':receipts,
      'distinctRoutes':len(route_counts),'topRoutes':[{'path':p,'receipts':n} for p,n in route_counts.most_common(5)],
      'topTwoShare':sum(n for _,n in route_counts.most_common(2))/receipts if receipts else None,
      'medianDepthDeteriorationBps':statistics.median(losses) if losses else None,
      'medianScanIntervalSeconds':statistics.median(intervals) if intervals else None,
      'firstAt':stamps[0] if stamps else None,'lastAt':stamps[-1] if stamps else None,'sourceSha256':digest.hexdigest(),
      'limits':'Selected positive depth receipts, not fills. No full historical depth or synchronized venue timestamps; adjacent observations overlap.'}
if __name__=='__main__':
    result=[study('krakenarb'),study('arb')]
    p=ROOT/'dashboard/data/crypto-history.json';d=json.loads(p.read_text());d['depthStudy']=result
    p.write_text(json.dumps(d,separators=(',',':'))+'\n')
    print(json.dumps(result,indent=2))
