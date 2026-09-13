import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from signals import compute_signals
class CopyVwap(unittest.TestCase):
    def test_equal_dollars_buy_625_shares_at_32_cents(self):
        wallet='0x'+'1'*40
        common={'conditionId':'c','side':'BUY','timestamp':100,'outcomeIndex':0,'title':'Example'}
        trades=[{**common,'usdcSize':100,'price':.2},{**common,'usdcSize':100,'price':.8}]
        watch={wallet:{'name':'Example','quality':1,'medianTrade':100}}
        out=compute_signals({wallet:trades},watch,now=100,hours=1,min_net_usd=1,min_conviction=0,min_backers=1)
        self.assertEqual(out[0]['backers'][0]['avgPrice'],.32)

    def test_reported_cash_with_fees_does_not_change_quote_vwap(self):
        wallet='0x'+'1'*40
        trade={'conditionId':'c','side':'BUY','timestamp':100,'outcomeIndex':0,'title':'Example',
               'size':160,'price':.4,'usdcSize':65.92}
        watch={wallet:{'name':'Example','quality':1,'medianTrade':100}}
        out=compute_signals({wallet:[trade]},watch,now=100,hours=1,min_net_usd=1,min_conviction=0,min_backers=1)
        self.assertEqual(out[0]['backers'][0]['avgPrice'],.4)
