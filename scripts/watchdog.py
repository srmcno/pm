"""Bounded GitHub recovery. Never executes trades or modifies account ledgers."""
import datetime as dt
import json
import os
import subprocess
import urllib.request

WORKFLOWS = {"opportunities.yml": 1200, "predictions.yml": 2700,
             "jekyll-gh-pages.yml": 7200, "archive-settlement.yml": 43200}

def recovery_needed(run, now, max_age):
    if run.get("status") in {"in_progress", "queued", "pending", "waiting", "requested"}:
        return False
    created = dt.datetime.fromisoformat(run.get("created_at", "1970-01-01T00:00:00Z").replace("Z", "+00:00"))
    age = (now-created).total_seconds()
    return age > max_age or (run.get("conclusion") not in {None, "success", "skipped"} and age > 900)

def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=30)

def main():
    repo=os.environ["GITHUB_REPOSITORY"]
    branch=os.environ["DEFAULT_BRANCH"]
    now=dt.datetime.now(dt.timezone.utc)
    repairs=[]
    for workflow, max_age in WORKFLOWS.items():
        result=json.loads(gh("api", f"repos/{repo}/actions/workflows/{workflow}/runs?per_page=1"))
        run=(result.get("workflow_runs") or [{}])[0]
        if recovery_needed(run, now, max_age):
            gh("workflow", "run", workflow, "--repo", repo, "--ref", branch)
            repairs.append(workflow)
    # Public availability is independent from whether a paper trade qualifies.
    request=urllib.request.Request("https://srmcno.github.io/pm/build-info.json",headers={"Cache-Control":"no-cache","User-Agent":"MoffittMoney availability check"})
    try:
        with urllib.request.urlopen(request,timeout=15) as r: publication=json.loads(r.read(8192))
        if not publication.get("commit") or not publication.get("version"): raise ValueError("Invalid release identity")
        print(json.dumps({"checkedAt":now.isoformat(),"pages":"available","version":publication["version"],"recoveryDispatched":repairs}))
    except Exception as e:
        if "jekyll-gh-pages.yml" not in repairs: gh("workflow","run","jekyll-gh-pages.yml","--repo",repo,"--ref",branch)
        raise RuntimeError("Pages unavailable or invalid; recovery requested") from e

if __name__=="__main__": main()
