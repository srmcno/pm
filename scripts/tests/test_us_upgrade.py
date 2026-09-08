import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from desk.core import config, evidence, money, state
from desk.backtest.metrics import max_drawdown, compute
from desk.desks.base import View, CLOSE, OPEN
from desk.data.bars import Bar

class USUpgrade(unittest.TestCase):
    def test_bankruptcy_remains_in_drawdown(self):
        self.assertEqual(max_drawdown([100, 120, 0, 90]), -1)
        self.assertLess(max_drawdown([100, -20]), -1)
        self.assertEqual(compute([.1, -.2, -1]).cagr_pct, -100)

    def test_auction_information_excludes_future_print(self):
        series={'X':[Bar(1, 10, 11, 9, 10),Bar(2,100,1000,1,999)]}
        for event in (OPEN, CLOSE):
            view=View(series,1,event,2,auction_cutoff=True)
            self.assertEqual(view.last_close('X'),10)
            self.assertEqual(view.open_price('X'),10)
        self.assertEqual(View(series,1,CLOSE,2).last_close('X'),999)

    def test_config_rejects_nonfinite_risk_and_respects_empty_desks(self):
        with tempfile.TemporaryDirectory() as d:
            path=os.path.join(d,'config.json')
            for blob in [{'equity':float('nan')},{'limits':{'daily_loss_halt':float('inf')}}, {'limits':{'max_gross_exposure':2}}]:
                with open(path,'w') as f:json.dump(blob,f)
                with self.assertRaises(ValueError):config.load(path)
            with open(path,'w') as f:json.dump({'desks':[]},f)
            self.assertEqual(config.load(path).desks,())
            cfg=config.load(path)
            config.save(cfg,path)
            self.assertEqual(config.load(path).desks,())

    def test_daily_rounding_uses_each_actual_fee_type(self):
        components=money.equity_fee_components(1,100,'buy')
        raw=sum(components.values())
        self.assertAlmostEqual(raw+money.daily_fee_floor(raw,True,components),.01)
        components={'sec':.011,'taf':.011,'cat':.001}
        raw=sum(components.values())
        self.assertAlmostEqual(raw+money.daily_fee_floor(raw,True,components),.05)

    def test_corrupt_state_never_silently_resets_the_bankroll(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d,'state.json'),'w') as f:f.write('{invalid')
            with patch.object(state,'STATE_DIR',d):
                with self.assertRaises(json.JSONDecodeError):state.load()

    def test_old_validation_and_future_dated_evidence_are_inactive(self):
        for blob in [{'generatedAt':100,'desks':{'x':{'verdict':'validated'}}},
                     {'generatedAt':10000,'modelVersion':evidence.MODEL_VERSION,'desks':{'x':{'verdict':'validated'}}}]:
            with patch.object(evidence,'load',return_value=blob):
                self.assertTrue(evidence.verdicts(now=200)['x']['stale'])

    def test_offshore_execution_refused_before_credentials_or_network(self):
        import arblive, livetrade
        with self.assertRaisesRegex(RuntimeError,'U.S.'):
            arblive.execute_opps([], {})
        with self.assertRaisesRegex(SystemExit,'Offshore'):
            livetrade.cmd_execute(None,{})

if __name__ == '__main__':
    unittest.main()
