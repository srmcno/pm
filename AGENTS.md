# Moffitt Money

The user wants this repository and its existing Sites publication kept together. The canonical code is the GitHub default branch. Reuse `.openai/hosting.json` for Sites identity and preserve it across updates. Read `docs/SITES.md` and apply the Sites building/hosting skills when changing the deployed site. Publish completed interface changes to the same Site, verify success, and update the GitHub default branch without adding stray branches. Keep credentials out of files and git configuration.

Preserve the validated cost/accounting model, original source times, explicit source-error states, and archival labels. Keep newer loaded snapshots on source failures; never make historical data appear live. Do not activate real orders or retired collectors as part of website maintenance.

Verification: `npm test`, `python3 scripts/check_site.py`; build: `npm run build`. Source is `dashboard/`, public output is `dist/`. Data-only snapshot commits are read directly by the browser and do not need Sites redeployment.
