#!/usr/bin/env python3
"""Fixed monthly ETF trend research and an independent forward simulation.

The historical input is immutable. Forward collection has its own directory.
No function in this module can submit a broker order.
"""
from __future__ import annotations
import argparse
import copy
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import time
import urllib.request
from functools import lru_cache
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
VERSION = '2026-09-13-etf-monthly-v1'
SYMBOLS = ('SPY', 'EFA', 'IEF', 'GLD', 'VNQ')
ET = ZoneInfo('America/New_York')
BASE_COSTS = dict(halfSpreadBps=2., slippageBps=5., commission=0., monthlyOverhead=0.)

@lru_cache(maxsize=1)
def calendar():
    return json.loads((ROOT / 'data/etf/calendar.json').read_text())['sessions']

def is_month_end(date):
    sessions = calendar()
    for i, session in enumerate(sessions[:-1]):
        if session['date'] == date:
            return sessions[i + 1]['date'][:7] != date[:7]
    raise ValueError('Date outside verified exchange calendar')

def source_fingerprint(data, start, end):
    rows = [[symbol, row['date'], *[round(row[k], 6) for k in ('open', 'close', 'dividend', 'split')]]
            for symbol in SYMBOLS for row in data[symbol] if start <= row['date'] <= end]
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()

def stamp():
    return int(time.time())

def finite(value, minimum=0):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= minimum

def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n')
    tmp.replace(path)

def collect(directory):
    """All-or-nothing manifest; a failing request never replaces the paper book."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    fetched = stamp()
    responses, manifest = {}, {}
    for symbol in SYMBOLS:
        url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
               f'?period1=1104537600&period2={fetched}&interval=1d&events=div%2Csplits&includeAdjustedClose=true')
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        last = None
        for attempt in range(3):
            try:
                raw = urllib.request.urlopen(request, timeout=30).read()
                result = json.loads(raw)['chart']['result'][0]
                if len(result['timestamp']) < 300:
                    raise ValueError('Insufficient historical observations')
                break
            except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
                last = error
                if attempt == 2:
                    raise RuntimeError(f'{symbol} collection failed: {type(last).__name__}') from last
                time.sleep(attempt + 1)
        responses[symbol] = raw
        manifest[symbol] = dict(url=url, sha256=hashlib.sha256(raw).hexdigest(), fetchedAt=fetched,
                                bars=len(result['timestamp']), splits=result.get('events', {}).get('splits', {}))
    for symbol, raw in responses.items():
        directory.joinpath(symbol + '.json.gz').write_bytes(gzip.compress(raw, mtime=0))
    atomic(directory / 'manifest.json', manifest)

def load_data(directory, now=None):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    now = stamp() if now is None else now
    result = {}
    schedule = {s['date']: s for s in calendar()}
    for symbol in SYMBOLS:
        raw = gzip.decompress((directory / (symbol + '.json.gz')).read_bytes())
        if hashlib.sha256(raw).hexdigest() != manifest[symbol]['sha256']:
            raise ValueError(f'{symbol}: raw input hash mismatch')
        item = json.loads(raw)['chart']['result'][0]
        quotes = item['indicators']['quote'][0]
        events = item.get('events', {})
        splits = {}
        for event in events.get('splits', {}).values():
            if not finite(event['numerator'], .000001) or not finite(event['denominator'], .000001):
                raise ValueError(f'{symbol}: invalid split')
            splits[dt.datetime.fromtimestamp(int(event['date']), ET).date().isoformat()] = event['numerator'] / event['denominator']
        dividends = {dt.datetime.fromtimestamp(int(e['date']), ET).date().isoformat(): float(e['amount'])
                     for e in events.get('dividends', {}).values()}
        if any(not finite(d) for d in dividends.values()):
            raise ValueError(f'{symbol}: invalid distribution')
        rows, last_ts, tri, prev_close = [], 0, 100., None
        for i, timestamp in enumerate(item['timestamp']):
            if timestamp <= last_ts:
                raise ValueError(f'{symbol}: unordered or duplicate bars')
            last_ts = timestamp
            date = dt.datetime.fromtimestamp(timestamp, ET).date()
            if date.isoformat() not in schedule:
                raise ValueError(f'{symbol}: observation outside exchange calendar')
            closed_at = schedule[date.isoformat()]['close'] + 45 * 60
            if closed_at > now:
                continue
            values = [quotes[name][i] for name in ('open', 'high', 'low', 'close')]
            if not all(finite(v, 0.0000001) for v in values):
                raise ValueError(f'{symbol}: invalid or missing OHLC on {date}')
            o, h, l, c = values
            if l > min(o, c) + 1e-5 or h < max(o, c) - 1e-5:
                raise ValueError(f'{symbol}: inconsistent OHLC on {date}')
            # Yahoo OHLC and historical dividend amounts are split-adjusted.
            # Recreate shares/prices as traded, then apply actual split events to held lots.
            factor = math.prod(ratio for day, ratio in splits.items() if day > date.isoformat())
            split = splits.get(date.isoformat(), 1.)
            dividend = dividends.get(date.isoformat(), 0.) * factor
            o, c = o * factor, c * factor
            if prev_close is not None:
                tri *= (c + dividend) * split / prev_close
            rows.append(dict(date=date.isoformat(), t=timestamp, open=o, close=c,
                             dividend=dividend, split=split, totalReturnIndex=tri))
            prev_close = c
        if len(rows) < 300:
            raise ValueError(f'{symbol}: insufficient completed history')
        result[symbol] = rows
    dates = [r['date'] for r in result[SYMBOLS[0]]]
    expected = [s['date'] for s in calendar() if dates[0] <= s['date'] <= dates[-1]]
    if expected != dates:
        raise ValueError('Market sessions missing or unexpected against XNYS calendar')
    for symbol in SYMBOLS:
        if [r['date'] for r in result[symbol]] != dates:
            raise ValueError(f'{symbol}: session coverage differs; missing bars are not filled')
    return result, manifest

def month_ends(rows, through):
    ends = []
    for i in range(through):
        if rows[i]['date'][:7] != rows[i + 1]['date'][:7]:
            ends.append(i)
    return ends

def target_weights(data, signal_index, months=10, completed_month=False):
    rows = data[SYMBOLS[0]]
    ends = month_ends(rows, signal_index)
    if completed_month and (not ends or ends[-1] != signal_index):
        ends.append(signal_index)
    if len(ends) < months:
        raise ValueError('Ten completed months of warmup required')
    window = ends[-months:]
    weights, signals = {}, []
    for symbol in SYMBOLS:
        values = [data[symbol][j]['totalReturnIndex'] for j in window]
        current, average = values[-1], statistics.mean(values)
        held = current > average
        weights[symbol] = .2 if held else 0.
        signals.append(dict(symbol=symbol, weight=weights[symbol], aboveTrend=held,
                            index=current, average=average, signalDate=rows[window[-1]]['date']))
    return weights, signals

def ceil_cent(value):
    return math.ceil(round(value, 12) * 100 - 1e-10) / 100

def fees_raw(side, qty, notional):
    return dict(SEC=notional * .0000206 if side == 'sell' else 0.,
                TAF=min(9.79, qty * .000195) if side == 'sell' else 0., CAT=qty * .000003)

def new_book(capital=1000.):
    if not finite(capital, 1):
        raise ValueError('Capital must be finite and at least $1')
    return dict(initial=capital, cash=capital, shares={s: 0. for s in SYMBOLS}, receivables=[],
                fees={}, ledger=[], distributions=[], splitEvents=[], feesUsd=0., spreadUsd=0., slippageUsd=0.,
                commissionsUsd=0., overheadUsd=0., dividendUsd=0., taxHaircutUsd=0.)

def equity(book, prices):
    return book['cash'] + sum(book['shares'][s] * prices[s] for s in SYMBOLS) + sum(r['amount'] for r in book['receivables'])

def trade(book, symbol, side, qty, price, date, costs, reason):
    if not finite(qty) or not finite(price, .0000001) or side not in ('buy', 'sell'):
        raise ValueError('Invalid order')
    if qty <= 1e-10:
        return
    if side == 'sell' and qty > book['shares'][symbol] + 1e-8:
        raise ValueError('Cannot sell unowned shares')
    direction = 1 if side == 'buy' else -1
    fill = price * (1 + direction * (costs['halfSpreadBps'] + costs['slippageBps']) / 10000)
    notional = qty * fill
    previous = book['fees'].setdefault(date, {k: 0. for k in ('SEC', 'TAF', 'CAT')})
    raw = fees_raw(side, qty, notional)
    charged = {k: ceil_cent(previous[k] + raw[k]) - ceil_cent(previous[k]) for k in raw}
    fee = sum(charged.values()) + costs['commission']
    next_cash = book['cash'] - direction * notional - fee
    if side == 'buy' and next_cash < -1e-7:
        raise ValueError('Order exceeds cash including fees')
    for k in raw:
        previous[k] += raw[k]
    book['cash'] = next_cash
    book['shares'][symbol] += direction * qty
    if abs(book['shares'][symbol]) < 1e-9:
        book['shares'][symbol] = 0.
    book['feesUsd'] += sum(charged.values())
    book['commissionsUsd'] += costs['commission']
    book['spreadUsd'] += qty * price * costs['halfSpreadBps'] / 10000
    book['slippageUsd'] += qty * price * costs['slippageBps'] / 10000
    book['ledger'].append(dict(date=date, symbol=symbol, side=side, qty=qty, reference=price, fill=fill,
                               notional=notional, fees=fee, regulatory=charged, reason=reason))

def apply_actions(book, data, index, pay_delay=30):
    day = data[SYMBOLS[0]][index]['date']
    # Entitlement belongs to previous-session holders, including sellers at today's open.
    for symbol in SYMBOLS:
        row = data[symbol][index]
        book['shares'][symbol] *= row['split']
        if row['split'] != 1:
            book['splitEvents'].append(dict(date=day, symbol=symbol, ratio=row['split']))
        amount = book['shares'][symbol] * row['dividend']
        if amount > 0:
            due = (dt.date.fromisoformat(day) + dt.timedelta(days=pay_delay)).isoformat()
            record = dict(symbol=symbol, exDate=day, assumedPayDate=due, amount=amount)
            book['receivables'].append(record)
            book['distributions'].append(record.copy())
            book['dividendUsd'] += amount
    pending = []
    for receivable in book['receivables']:
        if receivable['assumedPayDate'] <= day:
            book['cash'] += receivable['amount']
        else:
            pending.append(receivable)
    book['receivables'] = pending

def rebalance(book, weights, prices, date, costs, reason='Monthly rebalance'):
    if set(weights) - set(SYMBOLS) or any(not finite(w) for w in weights.values()) or sum(weights.values()) > 1.000001:
        raise ValueError('Invalid long-only target weights')
    value = equity(book, prices)
    # Receivables contribute to NAV but are not spendable; available cash caps buys.
    targets = {s: max(0., value - .05) * weights.get(s, 0.) / prices[s] for s in SYMBOLS}
    for symbol in SYMBOLS:
        qty = book['shares'][symbol] - targets[symbol]
        if qty * prices[symbol] >= 1. or (weights.get(symbol, 0.) == 0 and qty > 1e-9):
            trade(book, symbol, 'sell', qty, prices[symbol], date, costs, reason)
    buys = {s: max(0., targets[s] - book['shares'][s]) for s in SYMBOLS}
    buys = {s: q for s, q in buys.items() if q * prices[s] >= 1.}
    needed = sum(q * prices[s] * (1 + (costs['halfSpreadBps'] + costs['slippageBps']) / 10000) for s, q in buys.items())
    available = max(0., book['cash'] - .02 - costs['commission'] * len(buys))
    scale = min(1., available / needed) if needed else 0.
    for symbol, qty in buys.items():
        qty = math.floor(qty * scale * 1e8) / 1e8
        if qty * prices[symbol] >= 1.:
            trade(book, symbol, 'buy', qty, prices[symbol], date, costs, reason)

def withdraw(book, amount, prices, date, costs, kind):
    if amount <= 0:
        return
    # Pay overhead/tax sensitivity from real cash; sell holdings if needed.
    shortage = amount + .1 - book['cash']
    for symbol in SYMBOLS:
        if shortage <= 0:
            break
        qty = min(book['shares'][symbol], shortage / prices[symbol] / (1 - (costs['halfSpreadBps'] + costs['slippageBps']) / 10000))
        if qty > 0:
            trade(book, symbol, 'sell', qty, prices[symbol], date, costs, kind)
            shortage = amount + .1 - book['cash']
    if book['cash'] + 1e-7 < amount:
        raise ValueError('Account exhausted by operating costs')
    book['cash'] -= amount
    book[kind] += amount

def metrics(curve, initial):
    values = [initial] + [p['equity'] for p in curve]
    returns = [b / a - 1 for a, b in zip(values, values[1:]) if a > 0]
    peak, dd = initial, 0.
    for value in values:
        peak = max(peak, value)
        dd = min(dd, value / peak - 1)
    years = max(1 / 252, (dt.date.fromisoformat(curve[-1]['date']) - dt.date.fromisoformat(curve[0]['date'])).days / 365.25)
    sd = statistics.stdev(returns) if len(returns) > 1 else 0.
    annual = {}
    prev = initial
    for i, point in enumerate(curve):
        if i == len(curve) - 1 or curve[i + 1]['date'][:4] != point['date'][:4]:
            annual[point['date'][:4]] = (point['equity'] / prev - 1) * 100
            prev = point['equity']
    return dict(finalEquity=values[-1], returnPct=(values[-1] / initial - 1) * 100,
                cagrPct=((values[-1] / initial) ** (1 / years) - 1) * 100,
                maxDrawdownPct=dd * 100, volatilityPct=sd * math.sqrt(252) * 100,
                sharpeZero=statistics.mean(returns) / sd * math.sqrt(252) if sd else None,
                years=years, annual=annual)

def replay(data, name='Monthly trend', mode='trend', capital=1000., months=10,
           start='2006-01-01', end='9999-12-31', costs=None, delay=0, tax_rate=0., pay_delay=30):
    costs = dict(BASE_COSTS, **(costs or {}))
    if any(not finite(v) for v in costs.values()) or costs['halfSpreadBps'] + costs['slippageBps'] >= 10000:
        raise ValueError('Invalid cost assumptions')
    book = new_book(capital)
    rows = data[SYMBOLS[0]]
    selected = [i for i, row in enumerate(rows) if start <= row['date'] <= end]
    if not selected:
        raise ValueError('No observations in requested period')
    first, last = selected[0], selected[-1]
    curve, pending, rebalances = [], None, []
    year_start = capital
    for i in range(first, last + 1):
        date = rows[i]['date']
        prices = {s: data[s][i]['open'] for s in SYMBOLS}
        settled = {s: sum(r['amount'] for r in book['receivables'] if r['symbol'] == s and r['assumedPayDate'] <= date) for s in SYMBOLS}
        apply_actions(book, data, i, pay_delay)
        month_changed = i > 0 and rows[i - 1]['date'][:7] != date[:7]
        year_changed = i > first and rows[i - 1]['date'][:4] != date[:4]
        if year_changed:
            withdraw(book, max(0., curve[-1]['equity'] - year_start) * tax_rate, prices, date, costs, 'taxHaircutUsd')
            year_start = equity(book, prices)
        if i == first or month_changed:
            if costs['monthlyOverhead']:
                withdraw(book, costs['monthlyOverhead'], prices, date, costs, 'overheadUsd')
            if mode == 'trend':
                weights, _ = target_weights(data, i - 1, months, completed_month=month_changed)
                pending = (i + delay, weights, rows[i - 1]['date'])
            elif i == first:
                pending = (i + delay, {s: 1. if s == 'SPY' else 0. for s in SYMBOLS} if mode in ('spy', 'spy-reinvest') else {s: .2 for s in SYMBOLS}, rows[i - 1]['date'])
        if pending and pending[0] == i:
            rebalance(book, pending[1], prices, date, costs)
            rebalances.append(dict(date=date, signalDate=pending[2], weights=pending[1]))
            pending = None
        if mode in ('hold-reinvest', 'spy-reinvest'):
            for symbol, amount in settled.items():
                budget = min(amount, max(0., book['cash'] - .02))
                qty = max(0., budget - costs['commission']) / (prices[symbol] * (1 + (costs['halfSpreadBps'] + costs['slippageBps']) / 10000))
                if qty * prices[symbol] >= 1.:
                    trade(book, symbol, 'buy', qty, prices[symbol], date, costs, 'Reinvest paid distribution')
        closes = {s: data[s][i]['close'] for s in SYMBOLS}
        if i == last:
            for symbol in SYMBOLS:
                trade(book, symbol, 'sell', book['shares'][symbol], closes[symbol], date, costs, 'Terminal liquidation')
            if tax_rate:
                withdraw(book, max(0., equity(book, closes) - year_start) * tax_rate, closes, date, costs, 'taxHaircutUsd')
        curve.append(dict(date=date, equity=equity(book, closes)))
    return dict(name=name, mode=mode, start=curve[0]['date'], end=curve[-1]['date'], capital=capital,
                months=months, costs=costs, delaySessions=delay, dividendDelayDays=pay_delay, **metrics(curve, capital),
                trades=len(book['ledger']), rebalances=len(rebalances), feesUsd=book['feesUsd'],
                spreadUsd=book['spreadUsd'], slippageUsd=book['slippageUsd'], commissionsUsd=book['commissionsUsd'],
                overheadUsd=book['overheadUsd'], taxHaircutUsd=book['taxHaircutUsd'], dividendUsd=book['dividendUsd'],
                receivablesUsd=sum(r['amount'] for r in book['receivables']), terminalCash=book['cash'], curve=curve, ledger=book['ledger'],
                decisions=rebalances, distributions=book['distributions'])

def monthly_returns(run):
    points = run['curve']
    previous, out = run['capital'], []
    for i, point in enumerate(points):
        if i == len(points) - 1 or points[i + 1]['date'][:7] != point['date'][:7]:
            if i == len(points) - 1 and not is_month_end(point['date']):
                break
            out.append(point['equity'] / previous - 1)
            previous = point['equity']
    return out

def bootstrap(candidate, benchmark, samples=2000, block=12, seed=20260913):
    a, b = monthly_returns(candidate), monthly_returns(benchmark)
    rng, differences = random.Random(seed), []
    for _ in range(samples):
        indices = []
        while len(indices) < len(a):
            start = rng.randrange(len(a))
            indices.extend((start + j) % len(a) for j in range(block))
        ia = indices[:len(a)]
        difference = 12 * statistics.mean(math.log1p(a[i]) - math.log1p(b[i]) for i in ia) * 100
        differences.append(difference)
    differences.sort()
    return dict(method='Paired circular block bootstrap of monthly log returns, 12-month blocks',
                seed=seed, samples=samples, months=len(a), lowerPct=differences[int(samples * .025)],
                upperPct=differences[int(samples * .975)], positiveFraction=sum(x > 0 for x in differences) / samples,
                label='Annualized log-return difference versus five-ETF buy-and-hold; not probability of future profit')

def research():
    data, manifest = load_data(ROOT / 'data/etf/raw')
    runs = [replay(data), replay(data, 'Five-ETF buy & hold', mode='hold'), replay(data, 'SPY buy & hold', mode='spy')]
    for name, options in [
        ('25 bps per side', {'costs': dict(halfSpreadBps=5., slippageBps=20.)}),
        ('50 bps per side', {'costs': dict(halfSpreadBps=10., slippageBps=40.)}),
        ('One extra session delay', {'delay': 1}),
        ('$100 account', {'capital': 100.}), ('$10,000 account', {'capital': 10000.}),
        ('$5 monthly overhead', {'costs': dict(monthlyOverhead=5.)}),
        ('Illustrative 25% positive-year haircut', {'tax_rate': .25}),
        ('8-month sensitivity (not selected)', {'months': 8}),
        ('12-month sensitivity (not selected)', {'months': 12}),
        ('60-day distribution payment lag', {'pay_delay': 60}),
        ('Five-ETF hold with distributions reinvested', {'mode': 'hold-reinvest'}),
        ('SPY hold with distributions reinvested', {'mode': 'spy-reinvest'}),
    ]:
        runs.append(replay(data, name, **options))
    blocks = []
    for start, end in [('2006-01-01', '2015-12-31'), ('2016-01-01', '2020-12-31'), ('2021-01-01', '9999-12-31')]:
        for mode in ('trend', 'hold', 'spy'):
            run = replay(data, f'{start[:4]}–{min(end, data[SYMBOLS[0]][-1]["date"])[:4]} {mode}', mode=mode, start=start, end=end)
            blocks.append({k: v for k, v in run.items() if k not in ('curve', 'ledger', 'decisions', 'distributions')})
    candidate = runs[0]
    checks = [dict(label='Full sample profitable after modeled costs', pass_=candidate['returnPct'] > 0),
              dict(label='2016–2020 and 2021+ blocks profitable', pass_=all(r['returnPct'] > 0 for r in blocks if r['mode'] == 'trend' and r['start'] >= '2016')),
              dict(label='25 bps per side stress profitable', pass_=runs[3]['returnPct'] > 0),
              dict(label='Drawdown less than 35%', pass_=candidate['maxDrawdownPct'] > -35),
              dict(label='At least 60 monthly decisions', pass_=candidate['rebalances'] >= 60)]
    checks = [{'label': c['label'], 'pass': c['pass_']} for c in checks]
    report = dict(modelVersion=VERSION, generatedAt=stamp(), sourceAsOf=data[SYMBOLS[0]][-1]['date'],
                  sources=manifest, universe=list(SYMBOLS), runs=runs, blocks=blocks, uncertainty=bootstrap(runs[0], runs[1]),
                  checks=checks, paperEligible=all(c['pass'] for c in checks), realEligible=False,
                  limitations=['Retrospective study; no untouched holdout or demonstrated future profit.',
                               'Daily Yahoo prices are not broker opening fills; cost/delay stresses model execution uncertainty.',
                               'Dividends use an assumed 30-day cash-payment delay; official payment dates are absent.',
                               'Current selected ETFs survived; fees are a September 2026 counterfactual across all dates.',
                               'Returns are before personal income taxes; the positive-year haircut is only an illustration.',
                               'No leverage, borrow, FX, transfer or paid-data costs in base setup; ETF expenses are embedded in prices.',
                               'Sharpe uses a zero cash reference. Idle cash earns zero. Comparators hold actual shares without daily rebalancing.'])
    atomic(ROOT / 'data/etf/research.json', report)
    public = {k: v for k, v in report.items() if k != 'runs'}
    public['runs'] = []
    for run in runs:
        compact = {k: v for k, v in run.items() if k not in ('curve', 'ledger', 'decisions', 'distributions')}
        compact['curve'] = [p for i, p in enumerate(run['curve']) if i == len(run['curve']) - 1 or run['curve'][i + 1]['date'][:7] != p['date'][:7]]
        public['runs'].append(compact)
    atomic(ROOT / 'dashboard/data/etf-research.json', public)
    import csv
    with (ROOT / 'dashboard/etf-transactions.csv').open('w', newline='') as output:
        fields = ['date', 'symbol', 'side', 'qty', 'reference', 'fill', 'notional', 'fees', 'reason']
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(candidate['ledger'])
    lines = ['# Monthly ETF trend: recorded research', '', f'Model `{VERSION}`. Data through {report["sourceAsOf"]}.', '',
             'Fixed rules were declared in docs/ETF-RESEARCH-PLAN.md before this run. All figures are historical simulation, not promised returns.', '',
             '| Scenario | CAGR | Net return | Max drawdown | Trades | Regulatory fees |', '|---|---:|---:|---:|---:|---:|']
    for r in runs:
        lines.append(f'| {r["name"]} | {r["cagrPct"]:.2f}% | {r["returnPct"]:.2f}% | {r["maxDrawdownPct"]:.2f}% | {r["trades"]} | ${r["feesUsd"]:.2f} |')
    lines += ['', '## Chronological checks (retrospective, not untouched holdouts)', '', '| Period / strategy | CAGR | Drawdown |', '|---|---:|---:|']
    lines += [f'| {r["name"]} | {r["cagrPct"]:.2f}% | {r["maxDrawdownPct"]:.2f}% |' for r in blocks]
    u = report['uncertainty']
    lines += ['', f'Paired monthly block bootstrap: 95% interval for annualized log-return difference versus five-ETF hold: {u["lowerPct"]:.2f}% to {u["upperPct"]:.2f}%. This is sample uncertainty, not a forecast.', '',
              'Paper research gate: ' + ('passed' if report['paperEligible'] else 'held') + '. Real-money activation: not authorized or validated.', '', '## Limits', '']
    lines += ['- ' + x for x in report['limitations']]
    lines += ['', '## Reproduce', '', 'Run `python3 scripts/etf_lab.py research`. Frozen compressed source responses and hashes are in `data/etf/raw/`; full daily curves, transactions, decisions and distributions are in `data/etf/research.json`.', '',
              'Current fees: [Alpaca September 2026 schedule](https://files.alpaca.markets/disclosures/BrokFeeSched.pdf). Research context: [AQR trend evidence](https://www.aqr.com/insights/research/journal-article/a-century-of-evidence-on-trend-following-investing). These papers do not validate this implementation.']
    (ROOT / 'reports/etf-research.md').write_text('\n'.join(lines) + '\n')
    print(json.dumps({k: report[k] for k in ('sourceAsOf', 'paperEligible', 'checks', 'uncertainty')}, indent=2))
    for r in runs:
        print(r['name'], round(r['cagrPct'], 3), round(r['maxDrawdownPct'], 3), r['trades'])

def state_digest(state):
    payload = {k: v for k, v in state.items() if k != 'integrity'}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

def validate_state(state):
    if state.get('schemaVersion') != 1 or state.get('modelVersion') != VERSION or state.get('mode') != 'simulation':
        raise ValueError('Incompatible ETF account; migration review required')
    if state.get('integrity') != state_digest(state):
        raise ValueError('ETF account integrity mismatch; preserve the file and recover from history')
    book = state['book']
    for key in ('initial', 'cash', 'feesUsd', 'spreadUsd', 'slippageUsd', 'commissionsUsd', 'overheadUsd', 'dividendUsd', 'taxHaircutUsd'):
        if not finite(book[key]):
            raise ValueError('Invalid ETF balance')
    if set(book['shares']) != set(SYMBOLS) or any(not finite(q) for q in book['shares'].values()):
        raise ValueError('Invalid ETF holdings')
    if set(state['marks']) != set(SYMBOLS) or any(not finite(p, .000001) for p in state['marks'].values()):
        raise ValueError('Invalid ETF marks')
    if not all(finite(r['amount']) and r['exDate'] <= r['assumedPayDate'] for r in book['receivables']):
        raise ValueError('Invalid distribution receivable')
    expected = book['initial'] + book['dividendUsd'] - sum(r['amount'] for r in book['receivables'])
    expected -= book['overheadUsd'] + book['taxHaircutUsd']
    holdings = {s: 0. for s in SYMBOLS}
    events = [(t['date'], 1, t) for t in book['ledger']] + [(s['date'], 0, s) for s in book['splitEvents']]
    for _, kind, item in sorted(events, key=lambda e: (e[0], e[1])):
        if kind == 0:
            holdings[item['symbol']] *= item['ratio']
        else:
            sign = 1 if item['side'] == 'buy' else -1
            if item['symbol'] not in SYMBOLS or item['side'] not in ('buy', 'sell') or not all(finite(item[k]) for k in ('qty', 'fill', 'notional', 'fees')):
                raise ValueError('Invalid ETF transaction')
            if abs(item['qty'] * item['fill'] - item['notional']) > 1e-6:
                raise ValueError('Invalid ETF transaction notional')
            holdings[item['symbol']] += sign * item['qty']
            expected -= sign * item['notional'] + item['fees']
    if abs(expected - book['cash']) > 1e-5 or any(abs(holdings[s] - book['shares'][s]) > 1e-6 for s in SYMBOLS):
        raise ValueError('ETF account does not reconcile to its ledger')
    regulatory = sum(sum(t['regulatory'].values()) for t in book['ledger'])
    commission = sum(t['fees'] for t in book['ledger']) - regulatory
    if abs(regulatory - book['feesUsd']) > 1e-6 or abs(commission - book['commissionsUsd']) > 1e-6:
        raise ValueError('Fees do not reconcile to transactions')
    if abs(sum(r['amount'] for r in book['distributions']) - book['dividendUsd']) > 1e-6:
        raise ValueError('Dividends do not reconcile to distribution records')
    pending_receipts = [r for r in book['distributions'] if r['assumedPayDate'] > state['lastSession']]
    if pending_receipts != book['receivables']:
        raise ValueError('Unpaid dividends do not reconcile')
    for order in book['ledger']:
        if not state['createdAt'] <= order['decisionAt'] < order['fillAt'] <= order['observedAt']:
            raise ValueError('Order fill chronology invalid')
        decisions = [d for d in state['decisions'] if d['decisionAt'] == order['decisionAt'] and d.get('filledSession') == order['date']]
        if len(decisions) != 1 or order['signalDate'] != decisions[0]['signalDate']:
            raise ValueError('Order is not linked to a recorded decision')
    if state['pending']:
        p = state['pending']
        if p['decisionAt'] >= p['eligibleOpen'] or p['signalDate'] > state['lastSession']:
            raise ValueError('Invalid decision/fill chronology')
        if set(p['weights']) != set(SYMBOLS) or any(w not in (0., .2) for w in p['weights'].values()):
            raise ValueError('Invalid strategy target')

def evidence_allows_paper(report):
    if report.get('modelVersion') != VERSION or not report.get('sources'):
        return False
    try:
        candidate = report['runs'][0]
        stress = next(r for r in report['runs'] if r['name'] == '25 bps per side')
        blocks = [r for r in report['blocks'] if r['mode'] == 'trend' and r['start'] >= '2016']
        return (candidate['returnPct'] > 0 and candidate['maxDrawdownPct'] > -35 and candidate['rebalances'] >= 60
                and stress['returnPct'] > 0 and len(blocks) == 2 and all(r['returnPct'] > 0 for r in blocks))
    except (KeyError, TypeError, StopIteration):
        return False

def simulate_cycle(data, state, now, paper_allowed=True):
    """One deterministic forward cycle. No retrospective creation of decisions."""
    rows = data[SYMBOLS[0]]
    completed = [s for s in calendar() if s['close'] + 45 * 60 <= now]
    if not completed or rows[-1]['date'] != completed[-1]['date']:
        raise ValueError('Latest completed market session missing; holding original account')
    if state is None:
        state = dict(schemaVersion=1, modelVersion=VERSION, mode='simulation', createdAt=now,
                     lastSession=rows[-1]['date'], lastSignalMonth=None, pending=None, decisions=[],
                     book=new_book(), history=[dict(date=dt.datetime.fromtimestamp(now, ET).date().isoformat(), equity=1000.)],
                     sourceStartSession=rows[-1]['date'],
                     anchor={s: data[s][-1] for s in SYMBOLS}, marks={s: data[s][-1]['close'] for s in SYMBOLS})
    else:
        validate_state(state)
        state = copy.deepcopy(state)
        lookup = {r['date']: i for i, r in enumerate(rows)}
        if state['lastSession'] not in lookup:
            raise ValueError('Prior mark missing from source; reconciliation required')
        last_index = lookup[state['lastSession']]
        if state['sourceFingerprint'] != source_fingerprint(data, state['sourceStartSession'], state['lastSession']):
            raise ValueError('Source revised an accounted session; reconciliation required')
        for symbol in SYMBOLS:
            # Earlier corrections must not quietly change existing cash/share accounting.
            for field in ('open', 'close', 'dividend', 'split'):
                if abs(data[symbol][last_index][field] - state['anchor'][symbol][field]) > 1e-5:
                    raise ValueError(f'{symbol}: source revised the last accounted session')
        for i in range(last_index + 1, len(rows)):
            day = rows[i]['date']
            apply_actions(state['book'], data, i)
            pending = state['pending']
            if pending and rows[i]['t'] >= pending['eligibleOpen']:
                if rows[i]['t'] <= pending['decisionAt']:
                    raise ValueError('Attempt to fill before recorded decision')
                if paper_allowed:
                    start_orders = len(state['book']['ledger'])
                    rebalance(state['book'], pending['weights'], {s: data[s][i]['open'] for s in SYMBOLS}, day, BASE_COSTS, 'Recorded forward monthly decision')
                    for order in state['book']['ledger'][start_orders:]:
                        order.update(decisionAt=pending['decisionAt'], signalDate=pending['signalDate'], observedAt=now, fillAt=rows[i]['t'])
                    state['decisions'].append(dict(**pending, filledSession=day, observedAt=now, orders=len(state['book']['ledger']) - start_orders))
                else:
                    state['decisions'].append(dict(**pending, canceledAt=now, reason='Current research evidence held'))
                state['pending'] = None
            marks = {s: data[s][i]['close'] for s in SYMBOLS}
            state['history'].append(dict(date=day, equity=equity(state['book'], marks)))
            state['lastSession'] = day
            state['marks'] = marks
            state['anchor'] = {s: data[s][i] for s in SYMBOLS}
    end_is_month_end = is_month_end(rows[-1]['date'])
    weights, signals = target_weights(data, len(rows) - 1, completed_month=end_is_month_end)
    signal_month = signals[0]['signalDate'][:7]
    if paper_allowed and state['pending'] is None and signal_month != state['lastSignalMonth']:
        future = next((s for s in calendar() if s['open'] > now + 60), None)
        if future is None:
            raise ValueError('Future exchange calendar unavailable')
        state['pending'] = dict(decisionAt=now, signalDate=signals[0]['signalDate'], weights=weights,
                                eligibleSession=future['date'], eligibleOpen=future['open'])
        state['lastSignalMonth'] = signal_month
    state['signals'] = signals
    state['paperEligible'] = paper_allowed
    state['sourceFingerprint'] = source_fingerprint(data, state['sourceStartSession'], state['lastSession'])
    state['integrity'] = state_digest(state)
    validate_state(state)
    return state

def paper_payload(state, now, error=None):
    if state is None:
        return dict(modelVersion=VERSION, generatedAt=now, mode='simulation', status='source-error', error=error,
                    realEnabled=False, account=None)
    book = state['book']
    return dict(modelVersion=VERSION, generatedAt=now, mode='simulation',
                status='source-error' if error else 'awaiting-fill' if state['pending'] else 'monitoring',
                error=error, createdAt=state['createdAt'], sourceAsOf=state['lastSession'], realEnabled=False,
                account=dict(initial=book['initial'], cash=book['cash'], equity=equity(book, state['marks']),
                             receivablesUsd=sum(r['amount'] for r in book['receivables']), feesUsd=book['feesUsd'],
                             spreadUsd=book['spreadUsd'], slippageUsd=book['slippageUsd'], dividendUsd=book['dividendUsd'],
                             positions=[dict(symbol=s, qty=q, mark=state['marks'][s], value=q * state['marks'][s]) for s, q in book['shares'].items() if q > 1e-9]),
                pending=state['pending'], signals=state.get('signals', []), ledger=book['ledger'],
                history=state['history'], decisions=state['decisions'],
                readiness=[{'label': 'Historical accounting and stress checks', 'pass': state.get('paperEligible', False)},
                           {'label': 'Forward simulation has begun', 'pass': len(book['ledger']) > 0},
                           {'label': 'Broker paper fills and cash reconciled', 'pass': False},
                           {'label': 'Explicit real-money activation', 'pass': False}])

def forward_cycle(refresh=True):
    path = ROOT / 'data/etf/paper.json'
    lock = ROOT / 'data/etf/.cycle.lock'
    lock.mkdir()  # No stale-lock guessing; CI concurrency and finally handle normal exits.
    state, now = None, stamp()
    try:
        if path.exists():
            state = json.loads(path.read_text())
            validate_state(state)
        if refresh:
            collect(ROOT / 'data/etf/forward-inputs')
        now = stamp()  # A decision cannot be backdated to before a slow network request.
        data, sources = load_data(ROOT / 'data/etf/forward-inputs', now=now)
        report = json.loads((ROOT / 'data/etf/research.json').read_text())
        allowed = evidence_allows_paper(report)
        updated = simulate_cycle(data, state, now, allowed)
        payload = paper_payload(updated, now)
        payload.update(sources=sources, paperEligible=allowed)
        atomic(path, updated)
        state = updated  # Any later publication failure must show the committed account.
        atomic(ROOT / 'dashboard/data/etf-paper.json', payload)
        print(json.dumps({k: payload[k] for k in ('status', 'sourceAsOf', 'account', 'pending')}))
    except Exception as error:
        # Before commit the book is untouched; after commit the receipt uses that new book.
        safe_state = state
        try:
            if safe_state:
                validate_state(safe_state)
        except Exception:
            safe_state = None
        atomic(ROOT / 'dashboard/data/etf-paper.json', paper_payload(safe_state, now, str(error)))
        raise
    finally:
        lock.rmdir()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['research', 'collect-forward', 'paper'])
    args = parser.parse_args()
    if args.command == 'research':
        research()
    elif args.command == 'collect-forward':
        collect(ROOT / 'data/etf/forward-inputs')
    else:
        forward_cycle()
