#!/usr/bin/env python3
"""Dormant Alpaca PAPER controller for the fixed ETF experiment.

Default command is offline status. No live URL, generic credential fallback,
scheduled invocation, or simulation-account import exists. A persistent local
journal is required: an ephemeral Actions checkout is not an order journal.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_UP
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

import etf_lab as lab

PAPER_URL = 'https://paper-api.alpaca.markets'
DATA_URL = 'https://data.alpaca.markets'
DEFAULT_HOME = lab.ROOT / 'data/etf/broker'
ZERO = Decimal('0')
CASH_TYPES = {'DIV', 'DIVCGL', 'DIVCGS', 'DIVFEE', 'DIVFT', 'DIVNRA', 'DIVROC',
              'DIVTW', 'DIVTXEX', 'CGD', 'FEE', 'INT', 'INTNRA', 'INTTW'}
FAILED = {'canceled', 'expired', 'rejected', 'stopped', 'suspended', 'replaced', 'done_for_day'}


class Hold(RuntimeError):
    """Recoverable hold; never resubmit an uncertain order automatically."""


def number(value, minimum=None):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise Hold('Missing or invalid numeric broker field') from None
    if not result.is_finite() or (minimum is not None and result < Decimal(str(minimum))):
        raise Hold('Non-finite or out-of-range broker field')
    return result


def iso_time(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.utcoffset() is None:
            raise ValueError
        return parsed.timestamp()
    except (ValueError, TypeError, AttributeError):
        raise Hold('Invalid broker timestamp') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Hold('Broker redirect refused')


class PaperClient:
    """Small allowlisted transport. Errors never include credentials or bodies."""
    def __init__(self):
        self.key = os.environ.get('ETF_ALPACA_PAPER_KEY')
        self.secret = os.environ.get('ETF_ALPACA_PAPER_SECRET')
        if not self.key or not self.secret:
            raise Hold('Dedicated ETF paper credentials are not configured')
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, path, params=None, body=None, data=False):
        if method not in {'GET', 'POST'} or (method == 'POST' and (data or path != '/v2/orders')):
            raise Hold('Unsupported broker operation')
        if not path.startswith('/v2/') or '?' in path or '..' in path:
            raise Hold('Unsupported broker path')
        url = (DATA_URL if data else PAPER_URL) + path
        if params:
            url += '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'APCA-API-KEY-ID': self.key,
                                              'APCA-API-SECRET-KEY': self.secret,
                                              'Content-Type': 'application/json'})
        try:
            with self.opener.open(req, timeout=15) as response:
                raw = response.read(4_000_001)
                if len(raw) > 4_000_000:
                    raise Hold('Broker response too large')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            if method == 'GET' and path == '/v2/orders:by_client_order_id' and error.code == 404:
                return None
            raise Hold(f'Broker HTTP {error.code}; reconcile before retrying') from None
        except (OSError, ValueError):
            raise Hold('Broker transport or response failure; reconcile before retrying') from None

    def activities(self, since):
        rows, seen, token = [], set(), None
        for _ in range(100):
            params = dict(after=since, direction='asc', page_size=100)
            if token:
                params['page_token'] = token
            page = self.request('GET', '/v2/account/activities', params=params)
            if not isinstance(page, list) or len(page) > 100:
                raise Hold('Invalid activity page')
            for row in page:
                key = row.get('id')
                if not isinstance(key, str) or not key or key in seen:
                    raise Hold('Duplicate or missing activity ID')
                seen.add(key)
            rows.extend(page)
            if len(page) < 100:
                return rows
            token = page[-1]['id']
        raise Hold('Activity pagination limit; archive/reconciliation review required')


class Journal:
    def __init__(self, home):
        self.home = Path(home)

    @contextlib.contextmanager
    def locked(self):
        self.home.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.home, 0o700)
        with (self.home / 'lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Hold('Another broker controller is running') from None
            self.db = sqlite3.connect(self.home / 'journal.sqlite3')
            try:
                self.db.execute('PRAGMA synchronous=FULL')
                self.db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')
                self.db.commit()
                yield self
            finally:
                self.db.close()
                fcntl.flock(lock, fcntl.LOCK_UN)

    def read(self):
        row = self.db.execute('SELECT payload FROM state WHERE id=1').fetchone()
        if row is None:
            return None
        try:
            state = json.loads(row[0])
            if (state['mode'] != 'alpaca-paper' or state['modelVersion'] != lab.VERSION
                    or state['integrity'] != lab.state_digest(state)):
                raise ValueError
            return state
        except (KeyError, TypeError, ValueError):
            raise Hold('Invalid broker journal; preserve it for recovery') from None

    def save(self, state):
        state['integrity'] = lab.state_digest(state)
        payload = json.dumps(state, allow_nan=False, sort_keys=True)
        with self.db:
            self.db.execute('INSERT INTO state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (payload,))


def account_snapshot(client):
    account = client.request('GET', '/v2/account')
    if (account.get('status') != 'ACTIVE' or account.get('currency') != 'USD'
            or any(account.get(k) is not False for k in ('trading_blocked', 'account_blocked', 'trade_suspended_by_user'))
            or not isinstance(account.get('id'), str) or not account['id']):
        raise Hold('Account is not explicitly active and permitted for USD trading')
    number(account.get('cash'), 0)
    number(account.get('equity'), 0)
    positions = client.request('GET', '/v2/positions')
    orders = client.request('GET', '/v2/orders', params={'status': 'open', 'limit': 500})
    if not isinstance(orders, list) or len(orders) >= 500 or not isinstance(positions, list):
        raise Hold('Invalid or truncated account snapshot')
    shares = {}
    for position in positions:
        symbol = position.get('symbol')
        if symbol not in lab.SYMBOLS or symbol in shares or position.get('side') != 'long':
            raise Hold('Unexpected holding; dedicated long-only ETF account required')
        shares[symbol] = number(position.get('qty'), 0)
    return account, shares, orders


def initialize(client, journal, now, cap=1000):
    if journal.read() is not None:
        raise Hold('Broker account already initialized; it will not be reset')
    cap = number(cap, 1)
    if cap > 1000:
        raise Hold('Initial broker-paper capital cap must be at most $1,000')
    # Baseline a dedicated flat account. Re-read both sides to detect a changing
    # snapshot. Late historical activities subsequently fail cash reconciliation.
    since = (dt.datetime.fromtimestamp(now, dt.timezone.utc).date() - dt.timedelta(days=2)).isoformat() + 'T00:00:00Z'
    activities = client.activities(since)
    account, shares, orders = account_snapshot(client)
    again = client.activities(since)
    second, shares2, orders2 = account_snapshot(client)
    if (shares or shares2 or orders or orders2 or activities != again
            or any(account[k] != second[k] for k in ('id', 'cash', 'equity'))
            or number(account['cash']) != number(account['equity']) or number(account['cash']) < cap):
        raise Hold('Initialization requires a stable, flat, dedicated funded paper account')
    state = dict(mode='alpaca-paper', modelVersion=lab.VERSION, createdAt=now, accountId=account['id'],
                 initialCash=account['cash'], capitalCap=str(cap), since=since,
                 baselineActivities=activities, activities=[], orders=[], plans=[],
                 cash=account['cash'], shares={s: '0' for s in lab.SYMBOLS}, modeledFeesUsd='0')
    journal.save(state)
    return state


def validate_order(row, intent):
    body = intent['body']
    if (not isinstance(row, dict) or not row.get('id')
            or any(row.get(k) != body[k] for k in ('client_order_id', 'symbol', 'side', 'type', 'time_in_force'))
            or row.get('extended_hours') is not False or row.get('notional') is not None
            or number(row.get('qty'), 0) != number(body['qty'], 0)
            or number(row.get('limit_price'), 0) != number(body['limit_price'], 0)):
        raise Hold('Broker order differs from the persisted intent')
    filled = number(row.get('filled_qty'), 0)
    if filled > number(body['qty']):
        raise Hold('Order overfilled')
    if intent.get('brokerId') and intent['brokerId'] != row['id']:
        raise Hold('Broker order ID changed')
    return filled


def reconcile(client, journal, state, now):
    # Order lookup precedes activity reads: POST may have succeeded just before
    # a crash. No second POST occurs, even if the lookup currently returns 404.
    for intent in state['orders']:
        row = client.request('GET', '/v2/orders:by_client_order_id',
                             params={'client_order_id': intent['body']['client_order_id']})
        if row is None:
            raise Hold('Persisted order has an unknown outcome; no automatic resubmission')
        filled = validate_order(row, intent)
        intent.update(brokerId=row['id'], status=row.get('status'), filledQty=str(filled))
    # Persist recovered IDs even if a later cash snapshot is temporarily racing.
    journal.save(state)
    activities = client.activities(state['since'])
    old = {a['id']: a for a in state['baselineActivities'] + state['activities']}
    received = {a['id']: a for a in activities}
    if any(received.get(key) != value for key, value in old.items()):
        raise Hold('Activity history changed or disappeared; reconciliation review required')
    baseline = {a['id'] for a in state['baselineActivities']}
    new = [a for a in activities if a['id'] not in baseline]
    cash, shares = number(state['initialCash'], 0), {s: ZERO for s in lab.SYMBOLS}
    orders = {o['brokerId']: o for o in state['orders']}
    fills = {key: ZERO for key in orders}
    grouped = {}
    for activity in new:
        kind = activity.get('activity_type')
        if kind == 'FILL':
            order = orders.get(activity.get('order_id'))
            if order is None:
                raise Hold('Untracked broker fill; manual trades cannot enter the strategy ledger')
            body = order['body']
            if any(activity.get(k) != body[k] for k in ('symbol', 'side')):
                raise Hold('Fill does not match its order')
            qty, price = number(activity.get('qty'), '0.000000001'), number(activity.get('price'), '0.000000001')
            timestamp = iso_time(activity.get('transaction_time'))
            if timestamp < order['createdAt'] - 1 or timestamp > now + 5:
                raise Hold('Fill chronology differs from recorded submission')
            if ((body['side'] == 'buy' and price > number(body['limit_price']))
                    or (body['side'] == 'sell' and price < number(body['limit_price']))):
                raise Hold('Fill violates recorded limit price')
            direction = 1 if body['side'] == 'buy' else -1
            shares[body['symbol']] += direction * qty
            cash -= direction * qty * price
            fills[order['brokerId']] += qty
            day = dt.datetime.fromtimestamp(timestamp, lab.ET).date().isoformat()
            bucket = grouped.setdefault((day, order['brokerId']), [body['side'], ZERO, ZERO])
            bucket[1] += qty
            bucket[2] += qty * price
        elif kind in CASH_TYPES:
            if activity.get('symbol') and activity['symbol'] not in lab.SYMBOLS:
                raise Hold('Unexpected cash activity symbol')
            cash += number(activity.get('net_amount'))
        else:
            raise Hold('Unsupported transfer or corporate action; reconcile before further orders')
    account, actual, open_orders = account_snapshot(client)
    if account['id'] != state['accountId']:
        raise Hold('Paper credentials point to a different account')
    if any(o.get('id') not in orders for o in open_orders):
        raise Hold('Untracked open order in dedicated account')
    if any(abs(actual.get(s, ZERO) - shares[s]) > Decimal('0.000001') or shares[s] < 0 for s in lab.SYMBOLS):
        raise Hold('Broker holdings do not reconcile to recorded fills')
    if cash < 0 or abs(number(account['cash']) - cash) > Decimal('0.02'):
        raise Hold('Broker cash does not reconcile to fills and cash activities')
    for key, order in orders.items():
        if fills[key] != number(order['filledQty']):
            raise Hold('Order and activity fills have not converged; retry reconciliation')
        if order['status'] == 'filled' and fills[key] != number(order['body']['qty']):
            raise Hold('Filled order has incomplete quantity')
    # This is an explicit modeled fee overlay, never subtracted from broker cash
    # and never called broker-reported fees. Aggregate TAF per order, fees per day.
    days = {}
    for (day, _), (side, qty, amount) in grouped.items():
        fees = days.setdefault(day, dict(SEC=0., TAF=0., CAT=0.))
        for key, amount in lab.fees_raw(side, float(qty), float(amount)).items():
            fees[key] += amount
    modeled = sum(lab.ceil_cent(v) for fees in days.values() for v in fees.values())
    state.update(activities=new, cash=str(cash), shares={s: str(q) for s, q in shares.items()},
                 modeledFeesUsd=str(modeled), reconciledAt=now)
    journal.save(state)
    return account


def quote(client, symbol, wall_clock):
    asset = client.request('GET', '/v2/assets/' + symbol)
    if any(asset.get(k) is not True for k in ('tradable', 'fractionable')) or asset.get('status') != 'active':
        raise Hold('ETF is not currently tradable and fractionable')
    q = client.request('GET', '/v2/stocks/' + symbol + '/quotes/latest', params={'feed': 'iex'}, data=True)['quote']
    bid, ask = number(q.get('bp'), '.01'), number(q.get('ap'), '.01')
    timestamp = iso_time(q.get('t'))
    if not -2 <= wall_clock() - timestamp <= 15 or ask < bid or (ask / bid - 1) > Decimal('.005'):
        raise Hold('Quote is stale, crossed or wider than 50 bps')
    return bid, ask, timestamp


def prepare_plan(data, state, now):
    rows = data[lab.SYMBOLS[0]]
    completed = [s for s in lab.calendar() if s['close'] + 2700 <= now]
    if not completed or rows[-1]['date'] != completed[-1]['date']:
        raise Hold('Fresh completed market data required for a broker decision')
    if state.get('sourceEnd'):
        if state['sourceFingerprint'] != lab.source_fingerprint(data, state['sourceStart'], state['sourceEnd']):
            raise Hold('Market history changed after a broker decision; review required')
    weights, signals = lab.target_weights(data, len(rows) - 1, completed_month=lab.is_month_end(rows[-1]['date']))
    date = signals[0]['signalDate']
    if state['plans'] and state['plans'][-1]['signalDate'] == date:
        return state['plans'][-1]
    if state['plans'] and state['plans'][-1]['status'] != 'complete':
        raise Hold('Previous monthly plan is unfinished; review before a new decision')
    next_session = next((s for s in lab.calendar() if s['open'] > now + 60), None)
    if next_session is None:
        raise Hold('Exchange calendar must be updated')
    plan = dict(signalDate=date, createdAt=now, session=next_session['date'],
                open=next_session['open'], weights=weights, status='pending', targets=None,
                completedSymbols=[], orderIds=[])
    state['plans'].append(plan)
    state.update(sourceStart=rows[0]['date'], sourceEnd=rows[-1]['date'],
                 sourceFingerprint=lab.source_fingerprint(data, rows[0]['date'], rows[-1]['date']))
    return plan


def execute_one(client, journal, state, data, report, now, armed=False, wall_clock=None):
    wall_clock = time.time if wall_clock is None else wall_clock
    if not armed or (journal.home / 'STOP').exists():
        raise Hold('Paper submission is disarmed or STOP exists')
    if not lab.evidence_allows_paper(report):
        raise Hold('Historical evidence does not allow a paper experiment')
    reconcile(client, journal, state, now)
    if any(o['status'] in FAILED for o in state['orders']):
        raise Hold('A broker order ended unfilled or partly filled; operator review required')
    if any(o['status'] != 'filled' for o in state['orders']):
        return 'waiting-for-fill'
    plan = prepare_plan(data, state, wall_clock())
    journal.save(state)
    if plan['status'] == 'complete':
        return 'monthly-plan-complete'
    clock = client.request('GET', '/v2/clock')
    broker_now = iso_time(clock.get('timestamp'))
    if abs(broker_now - wall_clock()) > 5:
        raise Hold('Local and broker clocks disagree')
    if broker_now < plan['open'] + 300:
        return 'awaiting-eligible-session'
    if broker_now >= plan['open'] + 1800:
        raise Hold('09:35–10:00 ET execution window missed; do not backdate or roll the plan')
    if clock.get('is_open') is not True:
        raise Hold('Broker market is not open')
    schedule = client.request('GET', '/v2/calendar', params={'start': plan['session'], 'end': plan['session']})
    if len(schedule) != 1 or schedule[0].get('date') != plan['session'] or schedule[0].get('open') != '09:30':
        raise Hold('Broker and pinned exchange calendar disagree')
    quotes = {s: quote(client, s, wall_clock) for s in lab.SYMBOLS}
    if any(wall_clock() - q[2] > 15 for q in quotes.values()):
        raise Hold('Sizing quotes became stale during collection')
    mids = {s: (q[0] + q[1]) / 2 for s, q in quotes.items()}
    held = {s: number(state['shares'][s], 0) for s in lab.SYMBOLS}
    # Alpaca paper accounts can start with $100k. Keep all capital outside the
    # explicit allocation unavailable to this strategy, even for spread costs.
    strategy_cash = number(state['cash']) - (number(state['initialCash']) - number(state['capitalCap']))
    if plan['targets'] is None:
        nav = strategy_cash + sum(held[s] * mids[s] for s in lab.SYMBOLS)
        budget = min(number(state['capitalCap']), nav)
        # Reserve at least $1; position sizing uses cash equity, never margin BP.
        plan['targets'] = {s: str((max(ZERO, budget - 1) * number(plan['weights'][s]) / mids[s])
                                  .quantize(Decimal('.000000001'), rounding=ROUND_DOWN)) for s in lab.SYMBOLS}
        plan['referencePrices'] = {s: str(p) for s, p in mids.items()}
        journal.save(state)
    for order in state['orders']:
        if order['body']['client_order_id'] in plan['orderIds']:
            symbol = order['body']['symbol']
            if symbol not in plan['completedSymbols']:
                plan['completedSymbols'].append(symbol)
    candidates = sorted((s for s in lab.SYMBOLS if s not in plan['completedSymbols']),
                        key=lambda s: number(plan['targets'][s]) - held[s] >= 0)
    for symbol in candidates:
        delta = number(plan['targets'][symbol]) - held[symbol]
        if abs(delta) * mids[symbol] < 1:
            plan['completedSymbols'].append(symbol)
            continue
        if abs(mids[symbol] / number(plan['referencePrices'][symbol]) - 1) > Decimal('.02'):
            raise Hold('Quote moved over 2% from the recorded sizing reference')
        side = 'buy' if delta > 0 else 'sell'
        bid, ask, quote_time = quotes[symbol]
        limit = (ask * Decimal('1.0005') if side == 'buy' else bid * Decimal('.9995')).quantize(
            Decimal('.01'), rounding=ROUND_UP if side == 'buy' else ROUND_DOWN)
        qty = abs(delta)
        if side == 'buy':
            qty = min(qty, max(ZERO, strategy_cash - 1) / limit).quantize(Decimal('.000000001'), rounding=ROUND_DOWN)
        if qty * limit < 1:
            raise Hold('Insufficient unborrowed cash for remaining target')
        identity = '|'.join((state['accountId'], lab.VERSION, plan['signalDate'], symbol, side))
        client_id = 'etf-paper-' + hashlib.sha256(identity.encode()).hexdigest()[:40]
        body = dict(symbol=symbol, side=side, qty=str(qty), type='limit', limit_price=str(limit),
                    time_in_force='day', extended_hours=False, client_order_id=client_id)
        # Network calls above can be slow. Recheck account, clock and quote age
        # immediately before the durable intent rather than reusing cycle time.
        current, current_shares, open_orders = account_snapshot(client)
        if (current['id'] != state['accountId'] or open_orders
                or abs(number(current['cash']) - number(state['cash'])) > Decimal('.02')
                or any(abs(current_shares.get(s, ZERO) - held[s]) > Decimal('.000001') for s in lab.SYMBOLS)):
            raise Hold('Account changed during order preparation')
        final_clock = client.request('GET', '/v2/clock')
        submit_now = wall_clock()
        if (final_clock.get('is_open') is not True or abs(iso_time(final_clock.get('timestamp')) - submit_now) > 5
                or not plan['open'] + 300 <= submit_now < plan['open'] + 1800
                or not -2 <= submit_now - quote_time <= 15):
            raise Hold('Execution window or quote expired during order preparation')
        intent = dict(body=body, createdAt=submit_now, status='unknown', brokerId=None, filledQty='0')
        state['orders'].append(intent)
        plan['orderIds'].append(client_id)
        journal.save(state)  # Durable write-ahead commit before any possible POST.
        after_commit = wall_clock()
        if ((journal.home / 'STOP').exists() or not 0 <= after_commit - submit_now <= 2
                or not plan['open'] + 300 <= after_commit < plan['open'] + 1800
                or not -2 <= after_commit - quote_time <= 15):
            raise Hold('STOP or timing limit after journal commit; persisted intent requires review')
        response = client.request('POST', '/v2/orders', body=body)
        validate_order(response, intent)
        intent.update(brokerId=response['id'], status=response.get('status'), filledQty=str(response['filled_qty']))
        journal.save(state)
        return 'paper-order-submitted'
    plan['status'] = 'complete'
    journal.save(state)
    return 'monthly-plan-complete'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('status', 'init', 'reconcile', 'run'), nargs='?', default='status')
    parser.add_argument('--submit-paper-orders', action='store_true')
    parser.add_argument('--home', type=Path, default=DEFAULT_HOME)
    args = parser.parse_args()
    if args.command == 'status':
        exists = (args.home / 'journal.sqlite3').exists()
        state = None
        if exists:
            with Journal(args.home).locked() as journal:
                state = journal.read()
        print(json.dumps(dict(mode='alpaca-paper' if state else 'simulation',
                              brokerController='manual-paper-only' if state else 'dormant-paper-only',
                              realEnabled=False, journalExists=exists,
                              recordedOrders=len(state['orders']) if state else 0)))
        return
    if os.environ.get('CI') or os.environ.get('GITHUB_ACTIONS'):
        raise Hold('Broker controller requires a persistent local journal, not an ephemeral CI runner')
    if args.command == 'run' and not args.submit_paper_orders:
        raise Hold('run requires --submit-paper-orders; simulation remains the default')
    with Journal(args.home).locked() as journal:
        client = PaperClient()
        state = journal.read()
        if args.command == 'init':
            initialize(client, journal, time.time())
            result = 'dedicated-paper-account-initialized'
        else:
            if state is None:
                raise Hold('Initialize a dedicated broker-paper account first')
            if args.command == 'reconcile':
                reconcile(client, journal, state, time.time())
                result = 'broker-paper-reconciled'
            else:
                lab.collect(args.home / 'inputs')
                now = time.time()
                data, _ = lab.load_data(args.home / 'inputs', now)
                report = json.loads((lab.ROOT / 'data/etf/research.json').read_text())
                result = execute_one(client, journal, state, data, report, now, armed=True)
        print(json.dumps(dict(status=result, mode='alpaca-paper', realEnabled=False)))


if __name__ == '__main__':
    try:
        main()
    except (Hold, sqlite3.Error) as error:
        print(json.dumps(dict(status='held', error=str(error) if isinstance(error, Hold) else 'Journal failure', realEnabled=False)))
        raise SystemExit(1)
