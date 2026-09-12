# Publication and maintenance

Canonical source: `srmcno/pm`, using the repository default branch. Do not create a new project or publish to another Site. `.openai/hosting.json` holds the persistent Sites identity. The Sites Git remote is a publishing mirror of this source, not a competing development branch.

## Data updates

`dashboard/data-client.mjs` requests current public JSON from the default branch through GitHub raw `HEAD`. The main interface checks snapshots once per minute, histories when a completed hour is missing, and replay results every five minutes. Quotes stream directly from Coinbase with REST fallback. These continue without a new interface deployment while the page is open. GitHub collection schedules remain best effort. On failure, retain newer loaded data or use the bundled data, never relabel source timestamps. Original source dates and errors are visible in Data Health.

No market orders, brokerage activation or wallet connections are introduced by this site. Existing independent execution controls are retained. Do not restart retired workflows merely to remove an archive label.

## Interface updates

For a Sites update, read the Sites building and hosting skills, reuse the manifest project ID, and obtain its existing source credential. Fetch the default branch and preserve concurrent work. Run `npm test` and `python3 scripts/check_site.py`, commit the exact source, and publish that same source to Sites. `npm run build` produces `dist/` from the checked-in dashboard. Publish using the Sites helper and verify terminal success. Push code changes to GitHub as well, without creating stray branches. Never store a credential in source, config or a workflow.

A requested hourly ChatGPT maintenance task checks this source for interface changes and republishes the existing Site when required. It must compare content in `dashboard/` excluding `dashboard/data/` and generated `build-info.json`, plus the build script and manifest. Data-only commits need no Sites rebuild. Notify the owner on an unresolved source or publishing failure. The task is scheduled maintenance, not a promise of instantaneous deployment or uninterrupted external APIs.

The source check may run with fresh credentials when its retained token expires. Do not put a temporary Sites token in a GitHub secret to simulate permanent push deployment.

## Verification

The September 12 rebuild passes offline calculation, fallback/rollback regression checks and local resource/embedded JavaScript checks. Optional WebMCP is feature-detected; no supported browser WebMCP context was available for end-to-end validation. No browser-based visual QA was requested or run.
