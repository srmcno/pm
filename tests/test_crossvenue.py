import math
import unittest
from engine.config import EngineConfig, RiskLimits
from engine.crossvenue import CrossVenueMonitor
from engine.book import walk_buy

class TestCrossVenueFunding(unittest.TestCase):
    def monitor(self, fee=0):
        self.books={'a': ([(.99,100)],[(1,100)]), 'b': ([(1.05,100)],[(1.06,100)])}
        cfg=EngineConfig(risk=RiskLimits(bankroll_usd=100,max_stake_per_cycle_usd=100))
        return CrossVenueMonitor(cfg,{v:lambda s,v=v:self.books[v] for v in self.books},{'a':fee,'b':0})

    def gap(self,m):
        return m.scan(['FOOUSD'],{'FOOUSD':'FOO'},'USD')[0]

    def test_absent_or_invalid_balances_are_never_executable(self):
        m=self.monitor()
        self.assertFalse(self.gap(m).executable)
        for invalid in [0,-1,math.nan,math.inf,None]:
            m.set_balances('a',{'USD':100});m.set_balances('b',{'FOO':invalid})
            g=self.gap(m);self.assertFalse(g.executable);self.assertEqual(g.size_usd,0)

    def test_sale_inventory_caps_tokens_not_their_more_expensive_sale_value(self):
        for fee in [0,.001]:
            m=self.monitor(fee);m.set_balances('a',{'USD':100});m.set_balances('b',{'FOO':10})
            g=self.gap(m);self.assertTrue(g.executable)
            acquired=walk_buy(self.books['a'][1],g.size_usd,fee).filled
            self.assertAlmostEqual(acquired,10);self.assertLessEqual(acquired,10+1e-10)

    def test_missing_fees_and_insufficient_sell_depth_fail_closed(self):
        m=self.monitor();m.set_balances('a',{'USD':10});m.set_balances('b',{'FOO':100})
        del m.fees['a'];self.assertEqual(m.scan(['FOOUSD'],{'FOOUSD':'FOO'},'USD'),[])
        m.fees['a']=0;self.books['b']=([(1.05,1)],[(1.06,100)])
        self.assertEqual(m.scan(['FOOUSD'],{'FOOUSD':'FOO'},'USD'),[])
