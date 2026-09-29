"""Bounded GitHub recovery. Never executes trades or modifies account ledgers."""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import urllib.request

WORKFLOWS = {"opportunities.yml": 1200, "predictions.yml": 2700,
             "jekyll-gh-pages.yml": 7200, "archive-settlement.yml": 43200}
# Reported for review after this many consecutive failed runs; never re-run here.
REPORT_ONLY = {"etf-paper.yml": 2}
ACTIVE = {"in_progress", "queued", "pending", "waiting", "requested"}
FAILED = {"failure", "timed_out", "startup_failure"}
INTERFACE_LAG = 1800
# The watchdog workflow builds default-branch HEAD first; its interface revision is the target.
HEAD_RELEASE = Path(__file__).resolve().parents[1] / "dist/build-info.json"

def when(value):
    return dt.datetime.fromisoformat((value or "1970-01-01T00:00:00Z").replace("Z", "+00:00"))

def recovery_needed(run, now, max_age):
    if run.get("status") in ACTIVE:
        return False
    age = (now-when(run.get("created_at"))).total_seconds()
    return age > max_age or (run.get("conclusion") not in {None, "success", "skipped"} and age > 900)

def repeated_failures(runs, count):
    done = [r for r in runs if r.get("status") == "completed"][:count]
    return len(done) == count and all(r.get("conclusion") in FAILED for r in done)

def interface_stale(live, head, now, pages_run=None):
    # Only a successful deployment moves builtAt, so an interface older than the lag
    # window with no newer live build means Pages missed it. An active run is left alone.
    if (pages_run or {}).get("status") in ACTIVE or not head.get("interfaceRevision"):
        return False
    return live.get("interfaceRevision") != head["interfaceRevision"] and (now-when(live.get("builtAt"))).total_seconds() > INTERFACE_LAG

def head_release(path=HEAD_RELEASE):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}

def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=30)

def main():
    repo=os.environ["GITHUB_REPOSITORY"]
    branch=os.environ["DEFAULT_BRANCH"]
    now=dt.datetime.now(dt.timezone.utc)
    repairs, latest=[], {}
    for workflow, max_age in WORKFLOWS.items():
        result=json.loads(gh("api", f"repos/{repo}/actions/workflows/{workflow}/runs?per_page=1"))
        run=latest[workflow]=(result.get("workflow_runs") or [{}])[0]
        if recovery_needed(run, now, max_age):
            gh("workflow", "run", workflow, "--repo", repo, "--ref", branch)
            repairs.append(workflow)
    reports=[workflow for workflow, count in REPORT_ONLY.items()
             if repeated_failures(json.loads(gh("api", f"repos/{repo}/actions/workflows/{workflow}/runs?per_page=10")).get("workflow_runs") or [], count)]
    # Public availability is independent from whether a paper trade qualifies.
    request=urllib.request.Request(f"https://srmcno.github.io/pm/build-info.json?t={int(now.timestamp())}",headers={"Cache-Control":"no-cache","User-Agent":"MoffittMoney availability check"})
    try:
        with urllib.request.urlopen(request,timeout=15) as r: publication=json.loads(r.read(8192))
        if not publication.get("commit") or not publication.get("version"): raise ValueError("Invalid release identity")
    except Exception as e:
        if "jekyll-gh-pages.yml" not in repairs: gh("workflow","run","jekyll-gh-pages.yml","--repo",repo,"--ref",branch)
        raise RuntimeError("Pages unavailable or invalid; recovery requested"+(f"; review repeated failures: {', '.join(reports)}" if reports else "")) from e
    head=head_release()
    stale=interface_stale(publication, head, now, latest.get("jekyll-gh-pages.yml"))
    if stale and "jekyll-gh-pages.yml" not in repairs:
        gh("workflow","run","jekyll-gh-pages.yml","--repo",repo,"--ref",branch)
        repairs.append("jekyll-gh-pages.yml")
    print(json.dumps({"checkedAt":now.isoformat(),"pages":"stale-interface" if stale else "available","version":publication["version"],
                      "interfaceRevision":publication.get("interfaceRevision"),"headInterfaceRevision":head.get("interfaceRevision"),
                      "recoveryDispatched":repairs,"repeatedFailures":reports}))
    if reports: raise RuntimeError(f"Repeated failures need review (not re-run): {', '.join(reports)}")

if __name__=="__main__": main()
