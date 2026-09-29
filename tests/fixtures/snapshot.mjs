// Default suites read frozen copies, so a bot data commit cannot fail a deploy.
// Collector workflows set MM_LIVE_SNAPSHOTS=1 to check the files they publish.
export const snapshotUrl=name=>new URL(process.env.MM_LIVE_SNAPSHOTS==='1'?`../../dashboard/data/${name}`:`./${name}`,import.meta.url);
