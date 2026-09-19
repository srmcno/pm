import datetime as dt
import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('watchdog',Path(__file__).resolve().parents[1]/'scripts/watchdog.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class Recovery(unittest.TestCase):
    def test_recovery_does_not_duplicate_active_jobs(self):
        now=dt.datetime(2026,9,19,12,tzinfo=dt.timezone.utc)
        self.assertFalse(w.recovery_needed({'status':'queued','created_at':'2026-09-19T00:00:00Z'},now,1200))
        self.assertTrue(w.recovery_needed({'status':'completed','conclusion':'failure','created_at':'2026-09-19T11:30:00Z'},now,2700))
        self.assertFalse(w.recovery_needed({'status':'completed','conclusion':'failure','created_at':'2026-09-19T11:59:00Z'},now,2700))
        self.assertTrue(w.recovery_needed({},now,1200))
