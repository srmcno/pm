import datetime as dt
import importlib.util
from pathlib import Path
import io
import json
import os
import tempfile
import unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('watchdog',Path(__file__).resolve().parents[1]/'scripts/watchdog.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class Recovery(unittest.TestCase):
    def test_recovery_does_not_duplicate_active_jobs(self):
        now=dt.datetime(2026,9,19,12,tzinfo=dt.timezone.utc)
        self.assertFalse(w.recovery_needed({'status':'queued','created_at':'2026-09-19T00:00:00Z'},now,1200))
        self.assertTrue(w.recovery_needed({'status':'completed','conclusion':'failure','created_at':'2026-09-19T11:30:00Z'},now,2700))
        self.assertFalse(w.recovery_needed({'status':'completed','conclusion':'failure','created_at':'2026-09-19T11:59:00Z'},now,2700))
        self.assertTrue(w.recovery_needed({},now,1200))
    def test_interface_lag_redeploys_only_after_the_window_without_an_active_run(self):
        now=dt.datetime(2026,9,19,12,tzinfo=dt.timezone.utc)
        head={'interfaceRevision':'b'*20}
        old={'interfaceRevision':'a'*20,'builtAt':'2026-09-19T11:20:00.000Z'}
        self.assertTrue(w.interface_stale(old,head,now,{'status':'completed','conclusion':'success'}))
        self.assertFalse(w.interface_stale({**old,'builtAt':'2026-09-19T11:45:00.000Z'},head,now))
        self.assertFalse(w.interface_stale(old,head,now,{'status':'in_progress'}))
        self.assertFalse(w.interface_stale({**old,'interfaceRevision':'b'*20},head,now))
        self.assertTrue(w.interface_stale({'commit':'c'},head,now))
        self.assertFalse(w.interface_stale(old,{},now))
    def test_missing_or_corrupt_head_build_skips_the_comparison(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'build-info.json'
            self.assertEqual(w.head_release(path),{})
            path.write_text('{"interfaceRevision":')
            self.assertEqual(w.head_release(path),{})
            path.write_text('{"interfaceRevision":"'+'b'*20+'"}')
            self.assertEqual(w.head_release(path)['interfaceRevision'],'b'*20)
    def test_paper_cycle_is_reported_after_consecutive_failures_only(self):
        fail,ok={'status':'completed','conclusion':'failure'},{'status':'completed','conclusion':'success'}
        self.assertTrue(w.repeated_failures([{'status':'in_progress'},fail,fail,ok],2))
        self.assertFalse(w.repeated_failures([fail,ok,fail],2))
        self.assertFalse(w.repeated_failures([fail],2))
        self.assertFalse(w.repeated_failures([fail,{'status':'completed','conclusion':'cancelled'}],2))
        self.assertTrue(w.repeated_failures([fail,{'status':'completed','conclusion':'timed_out'}],2))
        self.assertEqual(w.REPORT_ONLY,{'etf-paper.yml':2})
        self.assertNotIn('etf-paper.yml',w.WORKFLOWS)
    def test_stale_interface_redeploys_pages_and_failed_paper_cycle_is_only_reported(self):
        recent=dt.datetime.now(dt.timezone.utc).isoformat()
        dispatched=[]
        def gh(*args):
            if args[:2]==('workflow','run'):
                dispatched.append(args[2]);return ''
            if 'etf-paper.yml' in args[1]:
                return json.dumps({'workflow_runs':[{'status':'completed','conclusion':'failure','created_at':recent}]*2})
            return json.dumps({'workflow_runs':[{'status':'completed','conclusion':'success','created_at':recent}]})
        live=json.dumps({'version':'7.1.0','commit':'c','interfaceRevision':'a'*20,'builtAt':'2026-09-19T00:00:00Z'}).encode()
        with mock.patch.dict(os.environ,{'GITHUB_REPOSITORY':'o/r','DEFAULT_BRANCH':'main'}),mock.patch.object(w,'gh',gh),\
             mock.patch.object(w,'head_release',lambda:{'interfaceRevision':'b'*20}),\
             mock.patch.object(w.urllib.request,'urlopen',lambda *a,**k:io.BytesIO(live)),mock.patch('builtins.print'):
            with self.assertRaisesRegex(RuntimeError,'etf-paper.yml'):
                w.main()
        self.assertEqual(dispatched,['jekyll-gh-pages.yml'])
