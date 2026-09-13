"""Hold an OS advisory lock across the Node collector, including parent death."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

lock_path = Path(sys.argv[1])
lock_path.parent.mkdir(parents=True, exist_ok=True)
with lock_path.open('a+') as lock:
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Another copy-study collector is running.', file=sys.stderr)
        sys.exit(1)
    env = dict(os.environ, MOFFITT_COPY_LOCK_HELD='1')
    # The child inherits the open description: killing only this parent must
    # not release the lock while the ledger writer is still alive.
    result = subprocess.run(sys.argv[2:], env=env, pass_fds=(lock.fileno(),))
    sys.exit(result.returncode)
