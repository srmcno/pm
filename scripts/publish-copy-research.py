"""Rebuild the public copy-trading research without fetching or placing orders."""
import json
from pathlib import Path
from pmlib import build_watchlist

ROOT = Path(__file__).resolve().parents[1]
def read(name):
    return json.loads((ROOT / name).read_text())

def build():
    analytics = read('data/analyzed.json')
    signals = read('data/signals/latest.json')
    paper = read('data/paper/state.json')
    watchlist = build_watchlist(analytics)
    fields = ['wallet','name','archetype','truncated','pnl90','maxDrawdown90','winDayRate',
              'volume90','trades90','activeDays','medianTradeUsd','bothSidesShare',
              'top5EventShare','categoryVol','topEvents','topPositions','distinctMarkets']
    wallets = []
    for original in analytics['wallets']:
        w = {k: original.get(k) for k in fields}
        w['quality'] = watchlist.get(w['wallet'], {}).get('quality')
        w['tracked'] = w['wallet'] in watchlist
        w['history'] = [[p['t'],p['p']] for p in (original.get('pnlDaily') or [])]
        wallets.append(w)
    # The file contains an inherited pre-funding point after createdAt. Anchor
    # this book at its recorded all-cash opening balance, before its first trade.
    first_trade = min(p['openedAt'] for p in paper['positions'] + paper['closed'])
    anchors = [p['t'] for p in paper['equityCurve'] if paper['createdAt'] <= p['t'] <= first_trade
               and abs(p['equity'] - paper['bankrollStart']) < .00001
               and abs(p['cash'] - paper['bankrollStart']) < .00001]
    if not anchors:
        raise ValueError('No verified opening baseline for this copy-paper book')
    curve_start = min(anchors)
    curve = [p for p in paper['equityCurve'] if p['t'] >= curve_start]
    as_of = max(p['t'] for p in paper['equityCurve'])
    account = {'updatedAt':as_of,'bankrollStart':paper['bankrollStart'],'cash':paper['cash'],
               'equity':round(paper['cash']+sum(p['valueUsd'] for p in paper['positions']),4),
               'positions':paper['positions'],'closed':paper['closed'],'closedCount':len(paper['closed']),
               'wins':sum(p['pnl']>0 for p in paper['closed']),
               'createdAt':paper['createdAt'], 'curveStartAt':curve_start,'equityCurve':curve,
               'inheritedCurvePoints':len(paper['equityCurve'])-len(curve),
               'realizedPnl':round(sum(p['pnl'] for p in paper['closed']),4),
               'status':'paused','feeComplete':False,'settlementVerified':False}
    return {'schemaVersion':1,'generatedAt':max(analytics['generatedAt'],signals['meta']['generatedAt'],as_of),
            'mode':'research-paper','realEnabled':False,
            'analytics':{'observedAt':analytics['generatedAt'],'cutoff':analytics['cutoff'],'windowDays':analytics['windowDays'],
                         'wallets':wallets,'watchlistSize':len(watchlist)},
            'consensus':{'observedAt':signals['meta']['generatedAt'],'hours':signals['meta']['hours'],
                         'watchlistSize':signals['meta']['watchlistSize'],'minBackers':signals['meta']['minBackers'],
                         'status':'paused','signals':signals['signals']},'paper':account}

if __name__ == '__main__':
    output = ROOT / 'dashboard/data/copy-trading.json'
    output.write_text(json.dumps(build(),separators=(',',':'),allow_nan=False)+'\n')
    print(f'Published dated copy-trading research: {output.stat().st_size:,} bytes')
