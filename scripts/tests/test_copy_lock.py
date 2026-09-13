"""Exercise the actual OS lock across parent and child process termination."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

WRAPPER = Path(__file__).resolve().parents[1] / 'copy-study-lock.py'
class CopyLock(unittest.TestCase):
    def test_parent_death_keeps_child_locked_then_child_death_releases(self):
        with tempfile.TemporaryDirectory() as d:
            lock=Path(d)/'ledger.flock';ready=Path(d)/'pid'
            child_code='import os,time,pathlib;pathlib.Path('+repr(str(ready))+').write_text(str(os.getpid()));time.sleep(30)'
            parent=subprocess.Popen([sys.executable,str(WRAPPER),str(lock),sys.executable,'-c',child_code],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            child=None
            try:
                for _ in range(100):
                    if ready.exists():break
                    time.sleep(.02)
                self.assertTrue(ready.exists());child=int(ready.read_text())
                parent.kill();parent.wait(timeout=3)
                attempt=[sys.executable,str(WRAPPER),str(lock),sys.executable,'-c','pass']
                busy=subprocess.run(attempt,capture_output=True,timeout=3)
                self.assertEqual(busy.returncode,1)
                self.assertIn(b'collector is running',busy.stderr)
                os.kill(child,signal.SIGKILL);child=None
                for _ in range(100):
                    free=subprocess.run(attempt,capture_output=True,timeout=3)
                    if free.returncode==0:break
                    time.sleep(.01)
                self.assertEqual(free.returncode,0)
            finally:
                if parent.poll() is None:parent.kill();parent.wait(timeout=3)
                if child:
                    try:os.kill(child,signal.SIGKILL)
                    except ProcessLookupError:pass
