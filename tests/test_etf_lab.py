"""Independent cash examples and adversarial timing/persistence regressions."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('etf_lab', ROOT / 'scripts/etf_lab.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def fixture(end='2006-03-31'):
    sessions = [s for s in lab.calendar() if '2005-01-01' <= s['date'] <= end]
    return {symbol: [dict(date=s['date'], t=s['open'], open=100 + i / 10, close=100 + i / 10,
                         dividend=0., split=1., totalReturnIndex=100 + i / 10)
                     for i, s in enumerate(sessions)] for symbol in lab.SYMBOLS}


def at_close(date):
    return next(s['close'] + 3600 for s in lab.calendar() if s['date'] == date)


class ETFAccounting(unittest.TestCase):
    def test_current_fees_manual_example_and_daily_aggregation(self):
        b = lab.new_book(10000)
        c = dict(lab.BASE_COSTS, halfSpreadBps=0, slippageBps=0)
        lab.trade(b, 'SPY', 'buy', 10, 100, '2026-09-11', c, 'test')
        lab.trade(b, 'EFA', 'buy', 10, 100, '2026-09-11', c, 'test')
        self.assertAlmostEqual(b['cash'], 7999.99)  # buy-only: CAT one cent total
        lab.trade(b, 'SPY', 'sell', 10, 100, '2026-09-11', c, 'test')
        self.assertAlmostEqual(b['feesUsd'], .05)  # CAT .01, SEC .03, TAF .01
        self.assertAlmostEqual(b['cash'], 8999.95)

    def test_fee_cap_applies_per_order(self):
        self.assertEqual(lab.fees_raw('sell', 100000, 1e6)['TAF'], 9.79)
        self.assertEqual(lab.fees_raw('buy', 100000, 1e6)['SEC'], 0)

    def test_cost_direction_and_cash_sizing(self):
        b = lab.new_book()
        lab.rebalance(b, {s: .2 for s in lab.SYMBOLS}, {s: 100 for s in lab.SYMBOLS}, '2026-09-11', lab.BASE_COSTS)
        self.assertGreaterEqual(b['cash'], 0)
        self.assertTrue(all(t['fill'] > t['reference'] for t in b['ledger']))
        lab.trade(b, 'SPY', 'sell', b['shares']['SPY'], 100, '2026-09-12', lab.BASE_COSTS, 'exit')
        self.assertLess(b['ledger'][-1]['fill'], 100)

    def test_dividend_entitlement_before_open_sales_and_after_split(self):
        data = fixture()
        for s in lab.SYMBOLS:
            data[s] = [dict(date='2006-01-03', t=1, open=50, close=50, dividend=1., split=2., totalReturnIndex=100)]
        b = lab.new_book()
        b['shares']['SPY'] = 3
        lab.apply_actions(b, data, 0)
        self.assertEqual(b['shares']['SPY'], 6)
        self.assertEqual(b['receivables'][0]['amount'], 6)
        cash = b['cash']
        self.assertEqual(cash, 1000)
        self.assertEqual(lab.equity(b, {s: 50 for s in lab.SYMBOLS}), 1306)
        lab.trade(b, 'SPY', 'sell', 6, 50, '2006-01-03', lab.BASE_COSTS, 'exit')
        self.assertEqual(b['receivables'][0]['amount'], 6)
        lab.trade(b, 'EFA', 'buy', 1, 50, '2006-01-03', lab.BASE_COSTS, 'entry')
        self.assertEqual(len(b['receivables']), 1)  # new EFA buyer gets no distribution
        for s in lab.SYMBOLS:
            data[s][0].update(date='2006-02-02', dividend=0., split=1.)
        before = lab.equity(b, {s: 50 for s in lab.SYMBOLS})
        lab.apply_actions(b, data, 0)
        self.assertEqual(b['receivables'], [])
        self.assertAlmostEqual(lab.equity(b, {s: 50 for s in lab.SYMBOLS}), before)

    def test_receivable_does_not_finance_a_purchase(self):
        b = lab.new_book()
        b['receivables'] = [dict(amount=100000)]
        lab.rebalance(b, {s: .2 for s in lab.SYMBOLS}, {s: 100 for s in lab.SYMBOLS}, '2026-09-11', lab.BASE_COSTS)
        self.assertGreaterEqual(b['cash'], 0)
        self.assertLess(sum(t['notional'] for t in b['ledger']), 1000)

    def test_invalid_costs_and_leverage_rejected(self):
        for value in (-1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                lab.replay(fixture(), costs={'commission': value})
        with self.assertRaises(ValueError):
            lab.rebalance(lab.new_book(), {'SPY': 1.1}, {s: 100 for s in lab.SYMBOLS}, '2006-01-03', lab.BASE_COSTS)

    def test_zero_equity_drawdown_is_not_hidden(self):
        self.assertEqual(lab.metrics([{'date': '2026-01-02', 'equity': 0}], 1000)['maxDrawdownPct'], -100)


class ETFTiming(unittest.TestCase):
    def test_future_values_cannot_change_prior_signal(self):
        data = fixture()
        j = next(i for i, r in enumerate(data['SPY']) if r['date'] == '2005-12-30')
        before = lab.target_weights(data, j, completed_month=True)
        for s in lab.SYMBOLS:
            for row in data[s][j + 1:]:
                row['close'] *= 100
                row['totalReturnIndex'] *= 100
        self.assertEqual(lab.target_weights(data, j, completed_month=True), before)

    def test_no_same_session_signal_fill_and_no_daily_rebalance(self):
        run = lab.replay(fixture())
        self.assertEqual(run['decisions'][0]['date'], '2006-01-03')
        self.assertEqual(run['decisions'][0]['signalDate'], '2005-12-30')
        self.assertEqual(run['rebalances'], 3)
        self.assertTrue(all(d['signalDate'] < d['date'] for d in run['decisions']))
        self.assertLessEqual({t['date'] for t in run['ledger']} - {'2006-03-31'}, {'2006-01-03', '2006-02-01', '2006-03-01'})

    def test_delayed_fill_keeps_same_signal(self):
        a, b = lab.replay(fixture()), lab.replay(fixture(), delay=1)
        self.assertEqual(a['decisions'][0]['weights'], b['decisions'][0]['weights'])
        self.assertEqual(a['decisions'][0]['signalDate'], b['decisions'][0]['signalDate'])
        self.assertEqual(b['decisions'][0]['date'], '2006-01-04')

    def test_benchmark_is_real_hold_with_terminal_costs(self):
        run = lab.replay(fixture(), mode='hold')
        self.assertEqual(run['trades'], 10)
        for s in lab.SYMBOLS:
            rows = [r for r in run['ledger'] if r['symbol'] == s]
            self.assertEqual(rows[0]['qty'], rows[1]['qty'])
        self.assertGreater(run['feesUsd'], 0)
        self.assertEqual(run['terminalCash'], run['finalEquity'])

    def test_bootstrap_excludes_partial_month_and_is_reproducible(self):
        a = lab.replay(fixture('2006-03-15'))
        b = lab.replay(fixture('2006-03-15'), mode='hold')
        self.assertEqual(len(lab.monthly_returns(a)), 2)
        self.assertEqual(lab.bootstrap(a, b, samples=50), lab.bootstrap(a, b, samples=50))

    def test_calendar_contains_extraordinary_closures(self):
        days = {r['date'] for r in lab.calendar()}
        self.assertNotIn('2012-10-29', days)
        self.assertNotIn('2012-10-30', days)
        self.assertNotIn('2018-12-05', days)


class ETFPaper(unittest.TestCase):
    def test_first_observation_never_inherits_backtest_profit(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        self.assertEqual(state['book']['cash'], 1000)
        self.assertEqual(state['book']['ledger'], [])
        self.assertEqual(state['pending']['eligibleSession'], '2006-01-04')
        self.assertLess(state['pending']['decisionAt'], state['pending']['eligibleOpen'])

    def test_restart_fills_recorded_order_once_then_holds(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        filled = lab.simulate_cycle(fixture('2006-01-04'), state, at_close('2006-01-04'))
        self.assertEqual(len(filled['book']['ledger']), 5)
        for t in filled['book']['ledger']:
            self.assertLess(t['decisionAt'], t['fillAt'])
        again = lab.simulate_cycle(fixture('2006-01-04'), filled, at_close('2006-01-04') + 60)
        self.assertEqual(again, filled)
        lab.validate_state(again)

    def test_stale_source_preserves_input(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, 'Latest completed'):
            lab.simulate_cycle(fixture('2006-01-03'), state, at_close('2006-01-04'))
        self.assertEqual(state, before)

    def test_source_correction_blocks_without_overwriting(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        data = fixture('2006-01-04')
        data['SPY'][-2]['close'] += 2
        with self.assertRaisesRegex(ValueError, '[Ss]ource revised'):
            lab.simulate_cycle(data, state, at_close('2006-01-04'))

    def test_corrupt_balances_rejected_even_if_rehashed(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        for key, value in [('cash', 2000), ('cash', float('nan'))]:
            broken = copy.deepcopy(state)
            broken['book'][key] = value
            if value == value:
                broken['integrity'] = lab.state_digest(broken)
            with self.assertRaises(ValueError):
                lab.validate_state(broken)

    def test_held_evidence_never_enters_but_still_marks(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        held = lab.simulate_cycle(fixture('2006-01-04'), state, at_close('2006-01-04'), False)
        self.assertEqual(held['book']['ledger'], [])
        self.assertEqual(held['lastSession'], '2006-01-04')
        self.assertIsNone(held['pending'])

    def test_missing_cycles_do_not_invent_monthly_decisions(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        later = lab.simulate_cycle(fixture('2006-03-02'), state, at_close('2006-03-02'))
        self.assertEqual(len(later['decisions']), 1)
        self.assertEqual(later['pending']['eligibleSession'], '2006-03-03')
        self.assertEqual(len(later['book']['ledger']), 5)

    def test_older_dividend_correction_requires_reconciliation(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        state = lab.simulate_cycle(fixture('2006-01-04'), state, at_close('2006-01-04'))
        data = fixture('2006-01-05')
        data['SPY'][-1]['dividend'] = 1.
        state = lab.simulate_cycle(data, state, at_close('2006-01-05'))
        later = fixture('2006-01-06')
        later['SPY'][-2]['dividend'] = 1.
        state = lab.simulate_cycle(later, state, at_close('2006-01-06'))
        later['SPY'][-2]['dividend'] = 100.
        with self.assertRaisesRegex(ValueError, 'Source revised'):
            lab.simulate_cycle(later, state, at_close('2006-01-06'))

    def test_fee_mark_distribution_and_chronology_corruption_rejected(self):
        state = lab.simulate_cycle(fixture('2006-01-03'), None, at_close('2006-01-03'))
        state = lab.simulate_cycle(fixture('2006-01-04'), state, at_close('2006-01-04'))
        corruptions = [
            lambda s: s['book'].update(feesUsd=999),
            lambda s: s['marks'].update(SPY=-100),
            lambda s: s['book']['ledger'][0].update(decisionAt=9999999999),
            lambda s: s['book'].update(dividendUsd=100, receivables=[dict(symbol='SPY',exDate='2006-01-04',assumedPayDate='2006-02-03',amount=100)])
        ]
        for corrupt in corruptions:
            changed = copy.deepcopy(state)
            corrupt(changed)
            changed['integrity'] = lab.state_digest(changed)
            with self.assertRaises(ValueError):
                lab.validate_state(changed)

    def test_slow_refresh_does_not_backdate_a_decision(self):
        opening = next(s['open'] for s in lab.calendar() if s['date'] == '2006-01-04')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data/etf').mkdir(parents=True)
            (root / 'data/etf/research.json').write_text('{}')
            with patch.object(lab, 'ROOT', root), patch.object(lab, 'collect'), patch.object(lab, 'load_data', return_value=(fixture('2006-01-03'), {})), patch.object(lab, 'evidence_allows_paper', return_value=True), patch.object(lab, 'stamp', side_effect=[opening-120, opening+120]):
                lab.forward_cycle()
            state = json.loads((root / 'data/etf/paper.json').read_text())
            self.assertEqual(state['pending']['decisionAt'], opening + 120)
            self.assertEqual(state['pending']['eligibleSession'], '2006-01-05')

    def test_publication_failure_receipt_uses_committed_book(self):
        real_atomic = lab.atomic
        calls = []
        def write(path, value):
            calls.append(str(path))
            if len(calls) == 2:
                raise OSError('Injected dashboard write failure')
            real_atomic(path, value)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data/etf').mkdir(parents=True)
            (root / 'data/etf/research.json').write_text('{}')
            with patch.object(lab, 'ROOT', root), patch.object(lab, 'collect'), patch.object(lab, 'load_data', return_value=(fixture('2006-01-03'), {})), patch.object(lab, 'evidence_allows_paper', return_value=True), patch.object(lab, 'stamp', return_value=at_close('2006-01-03')), patch.object(lab, 'atomic', side_effect=write):
                with self.assertRaises(OSError):
                    lab.forward_cycle()
            state = json.loads((root / 'data/etf/paper.json').read_text())
            payload = json.loads((root / 'dashboard/data/etf-paper.json').read_text())
            self.assertEqual(payload['createdAt'], state['createdAt'])
            self.assertEqual(payload['account']['cash'], state['book']['cash'])
            self.assertEqual(payload['status'], 'source-error')

    def test_evidence_boolean_alone_does_not_authorize(self):
        self.assertFalse(lab.evidence_allows_paper({'modelVersion': lab.VERSION, 'paperEligible': True}))

    def test_actual_frozen_inputs_match_calendar_and_hashes(self):
        data, sources = lab.load_data(ROOT / 'data/etf/raw')
        self.assertEqual(len(data['SPY']), 5457)
        self.assertEqual(len(sources), 5)
        efa = data['EFA']
        j = next(i for i, r in enumerate(efa) if r['split'] == 3)
        self.assertGreater(efa[j - 1]['close'], 100)
        self.assertLess(efa[j]['close'], 100)
        self.assertLess(abs(efa[j]['totalReturnIndex'] / efa[j - 1]['totalReturnIndex'] - 1), .05)


if __name__ == '__main__':
    unittest.main()
