"""Offline contract fixtures. These do not establish actual broker execution."""
import copy
import datetime as dt
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import etf_broker as broker
import etf_lab as lab


def stamp(date, hour=14, minute=0):
    return dt.datetime.fromisoformat(f'{date}T{hour:02}:{minute:02}:00+00:00').timestamp()


def source(end='2026-09-11'):
    sessions = [s for s in lab.calendar() if '2025-01-01' <= s['date'] <= end]
    return {symbol: [dict(date=s['date'], t=s['open'], open=100., close=100.,
                         dividend=0., split=1., totalReturnIndex=100 + i / 10)
                     for i, s in enumerate(sessions)] for symbol in lab.SYMBOLS}


def report():
    return dict(modelVersion=lab.VERSION, sources={'fixture': True},
                runs=[dict(name='Fixed', returnPct=1, maxDrawdownPct=-10, rebalances=80),
                      dict(name='25 bps per side', returnPct=1)],
                blocks=[dict(mode='trend', start='2016', returnPct=1), dict(mode='trend', start='2021', returnPct=1)])


class FixtureClient:
    """Mutable broker boundary, using incremental activity quantities."""
    def __init__(self):
        self.cash = broker.Decimal('1000')
        self.account_id = 'fixture-paper-account'
        self.shares = {}
        self.rows = []
        self.orders = {}
        self.posts = []
        self.now = stamp('2026-09-14', 13, 36)
        self.timeout_after_accept = False
        self.missing_lookup = False
        self.bid, self.ask = '99.99', '100.01'

    def activities(self, since):
        return copy.deepcopy(self.rows)

    def request(self, method, path, params=None, body=None, data=False):
        if method == 'POST':
            self.posts.append(copy.deepcopy(body))
            row = dict(body, id='order-' + str(len(self.orders)), status='new', filled_qty='0', notional=None)
            self.orders[body['client_order_id']] = row
            if self.timeout_after_accept:
                raise broker.Hold('Fixture accepted but response was lost')
            return copy.deepcopy(row)
        if path == '/v2/account':
            return dict(id=self.account_id, status='ACTIVE', currency='USD', trading_blocked=False,
                        account_blocked=False, trade_suspended_by_user=False, cash=str(self.cash),
                        equity=str(self.cash + sum(self.shares.values()) * 100))
        if path == '/v2/positions':
            return [dict(symbol=s, side='long', qty=str(q)) for s, q in self.shares.items() if q]
        if path == '/v2/orders':
            return [copy.deepcopy(o) for o in self.orders.values() if o['status'] not in broker.FAILED | {'filled'}]
        if path == '/v2/orders:by_client_order_id':
            return None if self.missing_lookup else copy.deepcopy(self.orders.get(params['client_order_id']))
        if path == '/v2/clock':
            return dict(is_open=True, timestamp=dt.datetime.fromtimestamp(self.now, dt.timezone.utc).isoformat())
        if path == '/v2/calendar':
            return [dict(date=params['start'], open='09:30', close='16:00')]
        if path.startswith('/v2/assets/'):
            return dict(tradable=True, fractionable=True, status='active')
        if path.endswith('/quotes/latest'):
            return {'quote': dict(bp=self.bid, ap=self.ask,
                                  t=dt.datetime.fromtimestamp(self.now, dt.timezone.utc).isoformat())}
        raise AssertionError((method, path))

    def fill(self, client_id, qty=None, price='100'):
        row = self.orders[client_id]
        qty = broker.number(qty if qty is not None else broker.number(row['qty']) - broker.number(row['filled_qty']))
        total = broker.number(row['filled_qty']) + qty
        row.update(filled_qty=str(total), status='filled' if total == broker.number(row['qty']) else 'partially_filled')
        self.rows.append(dict(id=str(len(self.rows)) + '::fill', activity_type='FILL', order_id=row['id'],
                              symbol=row['symbol'], side=row['side'], qty=str(qty), price=price,
                              cum_qty=str(total), transaction_time=dt.datetime.fromtimestamp(self.now + 1, dt.timezone.utc).isoformat()))
        direction = 1 if row['side'] == 'buy' else -1
        self.shares[row['symbol']] = self.shares.get(row['symbol'], broker.ZERO) + direction * qty
        self.cash -= direction * qty * broker.number(price)


class BrokerController(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lock = broker.Journal(self.temp.name).locked()
        self.journal = self.lock.__enter__()
        self.addCleanup(self.lock.__exit__, None, None, None)
        self.client = FixtureClient()
        self.state = broker.initialize(self.client, self.journal, stamp('2026-09-13'))
        broker.prepare_plan(source(), self.state, stamp('2026-09-13'))
        self.journal.save(self.state)

    def run_cycle(self, armed=True, now=None):
        now = self.client.now if now is None else now
        return broker.execute_one(self.client, self.journal, self.state, source(), report(), now,
                                  armed=armed, wall_clock=lambda: self.client.now)

    def test_default_disarmed_and_stop_prevent_post(self):
        with self.assertRaisesRegex(broker.Hold, 'disarmed'):
            self.run_cycle(armed=False)
        Path(self.temp.name, 'STOP').touch()
        with self.assertRaisesRegex(broker.Hold, 'STOP'):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])

    def test_cannot_reset_or_switch_account(self):
        with self.assertRaisesRegex(broker.Hold, 'reset'):
            broker.initialize(self.client, self.journal, self.client.now)
        self.client.account_id = 'different'
        with self.assertRaisesRegex(broker.Hold, 'different account'):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])

    def test_first_decision_cannot_fill_same_session(self):
        self.state['plans'] = []
        self.assertEqual(self.run_cycle(), 'awaiting-eligible-session')
        self.assertEqual(self.state['plans'][0]['session'], '2026-09-15')
        self.assertEqual(self.client.posts, [])

    def test_slow_reconciliation_cannot_backdate_a_decision(self):
        self.state['plans'] = []
        self.assertEqual(self.run_cycle(now=stamp('2026-09-14', 13, 28)), 'awaiting-eligible-session')
        self.assertEqual(self.state['plans'][0]['session'], '2026-09-15')
        self.assertEqual(self.state['plans'][0]['createdAt'], self.client.now)
        self.assertEqual(self.client.posts, [])

    def test_full_monthly_workflow_and_repeated_runs(self):
        for _ in lab.SYMBOLS:
            self.assertEqual(self.run_cycle(), 'paper-order-submitted')
            self.client.fill(self.client.posts[-1]['client_order_id'])
        self.assertEqual(self.run_cycle(), 'monthly-plan-complete')
        self.assertEqual(self.run_cycle(), 'monthly-plan-complete')
        self.assertEqual(len(self.client.posts), 5)
        # Last buy reserves its full $100.07 limit, then fills at $100.00.
        self.assertEqual(broker.number(self.state['cash']), broker.Decimal('1.139762200'))
        self.assertEqual(broker.number(self.state['modeledFeesUsd']), broker.Decimal('.01'))
        self.assertEqual(set(self.state['shares']), set(lab.SYMBOLS))
        self.assertEqual(self.journal.read()['plans'][0]['status'], 'complete')

    def test_partial_fill_uses_incremental_qty_and_holds_next_order(self):
        self.run_cycle()
        key = self.client.posts[-1]['client_order_id']
        self.client.fill(key, '.5')
        self.assertEqual(self.run_cycle(), 'waiting-for-fill')
        self.assertEqual(broker.number(self.state['shares']['SPY']), broker.Decimal('.5'))
        self.client.fill(key)
        self.assertEqual(self.run_cycle(), 'paper-order-submitted')
        self.assertEqual(broker.number(self.state['shares']['SPY']), broker.Decimal('1.998'))
        self.assertEqual(len(self.client.posts), 2)

    def test_timeout_after_accept_recovers_without_duplicate(self):
        self.client.timeout_after_accept = True
        with self.assertRaises(broker.Hold):
            self.run_cycle()
        persisted = self.journal.read()
        self.assertEqual(persisted['orders'][0]['status'], 'unknown')
        self.state = persisted  # restart with only what reached durable storage
        self.client.timeout_after_accept = False
        self.assertEqual(self.run_cycle(), 'waiting-for-fill')
        self.assertEqual(len(self.client.posts), 1)

    def test_unknown_404_never_retries_post(self):
        self.client.timeout_after_accept = True
        with self.assertRaises(broker.Hold):
            self.run_cycle()
        self.client.missing_lookup = True
        with self.assertRaisesRegex(broker.Hold, 'unknown outcome'):
            self.run_cycle()
        self.assertEqual(len(self.client.posts), 1)

    def test_persistence_failure_before_post_cannot_trade(self):
        real_save = self.journal.save
        def fail_intent(state):
            if state['orders']:
                raise OSError('disk full')
            return real_save(state)
        with patch.object(self.journal, 'save', fail_intent), self.assertRaises(OSError):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])

    def test_cancelled_partial_is_not_replaced(self):
        self.run_cycle()
        key = self.client.posts[-1]['client_order_id']
        self.client.fill(key, '.5')
        self.client.orders[key]['status'] = 'canceled'
        with self.assertRaisesRegex(broker.Hold, 'partly filled'):
            self.run_cycle()
        self.assertEqual(len(self.client.posts), 1)

    def test_dividend_and_late_fee_reconcile_separately(self):
        self.client.rows = [dict(id='div::1', activity_type='DIV', symbol='SPY', net_amount='2.50'),
                            dict(id='fee::1', activity_type='FEE', net_amount='-.02')]
        self.client.cash += broker.Decimal('2.48')
        broker.reconcile(self.client, self.journal, self.state, self.client.now)
        self.assertEqual(broker.number(self.state['cash']), broker.Decimal('1002.48'))
        self.client.rows.append(dict(id='fee::2', activity_type='FEE', net_amount='-.01'))
        self.client.cash -= broker.Decimal('.01')
        broker.reconcile(self.client, self.journal, self.state, self.client.now + 86400)
        self.assertEqual(broker.number(self.state['cash']), broker.Decimal('1002.47'))

    def test_unknown_corporate_action_and_cash_drift_hold(self):
        self.client.rows = [dict(id='split::1', activity_type='SSP', symbol='SPY')]
        with self.assertRaisesRegex(broker.Hold, 'corporate action'):
            self.run_cycle()
        self.client.rows = []
        self.client.cash -= 1
        with self.assertRaisesRegex(broker.Hold, 'cash does not reconcile'):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])

    def test_lost_activity_history_holds(self):
        self.run_cycle()
        self.client.fill(self.client.posts[-1]['client_order_id'])
        broker.reconcile(self.client, self.journal, self.state, self.client.now + 2)
        self.client.rows = []
        with self.assertRaisesRegex(broker.Hold, 'disappeared'):
            self.run_cycle()

    def test_stale_quote_missed_window_and_nan_cannot_trade(self):
        self.client.now = stamp('2026-09-14', 14, 1)
        with self.assertRaisesRegex(broker.Hold, 'window missed'):
            self.run_cycle()
        self.client.now = stamp('2026-09-14', 13, 36)
        self.client.bid = 'NaN'
        with self.assertRaisesRegex(broker.Hold, 'Non-finite'):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])

    def test_intent_order_mismatch_holds(self):
        self.run_cycle()
        self.client.orders[self.client.posts[-1]['client_order_id']]['side'] = 'sell'
        with self.assertRaisesRegex(broker.Hold, 'differs'):
            self.run_cycle()
        self.assertEqual(len(self.client.posts), 1)

    def test_large_broker_balance_cannot_expand_allocation(self):
        self.client.cash = broker.Decimal('100000')
        self.state.update(initialCash='100000', cash='100000')
        self.journal.save(self.state)
        self.client.bid, self.client.ask = '99.76', '100.24'
        for _ in lab.SYMBOLS:
            self.assertEqual(self.run_cycle(), 'paper-order-submitted')
            order = self.client.posts[-1]
            self.client.fill(order['client_order_id'], price=order['limit_price'])
        self.assertEqual(self.run_cycle(), 'monthly-plan-complete')
        self.assertGreaterEqual(self.client.cash, broker.Decimal('99001'))
        spent = sum(broker.number(o['qty']) * broker.number(o['limit_price']) for o in self.client.posts)
        self.assertLessEqual(spent, broker.Decimal('999'))

    def test_slow_preparation_crossing_deadline_cannot_submit(self):
        original = self.client.request
        clock_reads = 0
        def request(method, path, **kwargs):
            nonlocal clock_reads
            if path == '/v2/clock':
                clock_reads += 1
                if clock_reads == 2:
                    self.client.now = stamp('2026-09-14', 14, 1)
            return original(method, path, **kwargs)
        with patch.object(self.client, 'request', request), self.assertRaisesRegex(broker.Hold, 'expired'):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])

    def test_journal_commit_crossing_deadline_cannot_submit(self):
        self.client.now = stamp('2026-09-14', 14) - 1
        real_save = self.journal.save
        def slow_save(state):
            real_save(state)
            if state['orders']:
                self.client.now += 1.5
        with patch.object(self.journal, 'save', slow_save), self.assertRaisesRegex(broker.Hold, 'timing limit'):
            self.run_cycle()
        self.assertEqual(self.client.posts, [])
        self.assertEqual(self.journal.read()['orders'][0]['status'], 'unknown')

    def test_source_revision_prevents_new_order(self):
        data = source()
        data['SPY'][10]['close'] += 1
        with self.assertRaisesRegex(broker.Hold, 'history changed'):
            broker.execute_one(self.client, self.journal, self.state, data, report(), self.client.now,
                               armed=True, wall_clock=lambda: self.client.now)
        self.assertEqual(self.client.posts, [])

    def test_rebalance_sells_before_buying_and_no_intramonth_trade(self):
        for _ in lab.SYMBOLS:
            self.run_cycle()
            self.client.fill(self.client.posts[-1]['client_order_id'])
        self.run_cycle()
        data = source('2026-09-30')
        data['SPY'][-1]['totalReturnIndex'] = 1
        self.client.now = stamp('2026-09-30', 22)
        run = lambda: broker.execute_one(self.client, self.journal, self.state, data, report(), self.client.now,
                                         armed=True, wall_clock=lambda: self.client.now)
        self.assertEqual(run(), 'awaiting-eligible-session')
        self.client.now = stamp('2026-10-01', 13, 36)
        self.assertEqual(run(), 'paper-order-submitted')
        self.assertEqual(self.client.posts[-1]['side'], 'sell')
        self.assertEqual(self.client.posts[-1]['symbol'], 'SPY')
        self.client.fill(self.client.posts[-1]['client_order_id'], '.5')
        self.assertEqual(run(), 'waiting-for-fill')
        self.assertEqual(len(self.client.posts), 6)


class TransportAndJournal(unittest.TestCase):
    def test_no_generic_key_or_live_fallback(self):
        with patch.dict('os.environ', {'APCA_API_KEY_ID': 'unused', 'APCA_API_SECRET_KEY': 'unused'}, clear=True):
            with self.assertRaisesRegex(broker.Hold, 'Dedicated'):
                broker.PaperClient()

    def test_redirect_never_forwards_credentials(self):
        with self.assertRaisesRegex(broker.Hold, 'redirect'):
            broker.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://untrusted.invalid')

    def test_activity_pagination_and_repeated_page_rejected(self):
        with patch.dict('os.environ', {'ETF_ALPACA_PAPER_KEY': 'fixture', 'ETF_ALPACA_PAPER_SECRET': 'fixture'}):
            client = broker.PaperClient()
        page = [dict(id=str(i)) for i in range(100)]
        with patch.object(client, 'request', side_effect=[page, [dict(id='last')]]) as request:
            self.assertEqual(len(client.activities('2026-09-13')), 101)
            self.assertEqual(request.call_args.kwargs['params']['page_token'], '99')
        with patch.object(client, 'request', side_effect=[page, page]):
            with self.assertRaisesRegex(broker.Hold, 'Duplicate'):
                client.activities('2026-09-13')

    def test_journal_lock_and_integrity(self):
        with tempfile.TemporaryDirectory() as home, broker.Journal(home).locked() as first:
            with self.assertRaisesRegex(broker.Hold, 'Another'):
                with broker.Journal(home).locked():
                    pass
            first.db.execute("INSERT INTO state VALUES (1, '{}')")
            first.db.commit()
            with self.assertRaisesRegex(broker.Hold, 'Invalid broker journal'):
                first.read()


if __name__ == '__main__':
    unittest.main()
