import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../scripts/live/journal.mjs';

const moduleUrl = new URL('../scripts/live/journal.mjs', import.meta.url).href;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function inspect(directory, operation) {
  const db = new DatabaseSync(join(directory, 'state.sqlite'));
  try { return operation(db); } finally { db.close(); }
}

test('state and append-only audit survive close/reopen with private files', t => {
  const directory = fixture(t);
  let journal = new Journal(directory);
  assert.equal(journal.load(), null);
  const state = { version: 1, cash: '19.00000001', orders: [{ id: 'local-1', filled: false }], empty: null };
  journal.save(state, { type: 'intent_saved', status: 'pending', time: '2026-09-19T12:00:00Z', apiKey: 'NEVER_AUDIT_THIS_SECRET', body: { private: true } });
  state.cash = 'wrong';
  assert.equal(journal.load().cash, '19.00000001');
  journal.save({ cash: '18.50', orders: [] });
  for (const file of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'lock.sqlite']) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  journal.close();
  journal = new Journal(directory);
  t.after(() => journal.close());
  assert.deepEqual(journal.load(), { cash: '18.50', orders: [] });
  inspect(directory, db => {
    const events = db.prepare('SELECT revision, data FROM events ORDER BY id').all();
    assert.deepEqual(events.map(e => e.revision), [1, 2]);
    assert.deepEqual(JSON.parse(events[0].data), { type: 'intent_saved', status: 'pending', time: '2026-09-19T12:00:00Z' });
    assert.equal(events.some(e => e.data.includes('NEVER_AUDIT_THIS_SECRET')), false);
    assert.deepEqual(JSON.parse(events[1].data), { type: 'tick' });
    assert.throws(() => db.exec("UPDATE events SET data='{}'"), /Append-only audit/);
    assert.throws(() => db.exec('DELETE FROM events'), /Append-only audit/);
  });
});

test('audit failure rolls back the entire state transaction and poisons the handle', t => {
  const directory = fixture(t);
  let journal = new Journal(directory);
  journal.save({ cash: '20' });
  inspect(directory, db => db.exec("CREATE TRIGGER simulate_disk_failure BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'simulated'); END"));
  assert.throws(() => journal.save({ cash: '10' }), /Journal save failed/);
  assert.throws(() => journal.load(), /closed or failed/);
  journal.close();
  inspect(directory, db => {
    assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM state').get().data), { cash: '20' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
    db.exec('DROP TRIGGER simulate_disk_failure');
  });
  journal = new Journal(directory);
  t.after(() => journal.close());
  assert.deepEqual(journal.load(), { cash: '20' });
});

test('corrupt persisted JSON fails closed without reset or secret disclosure', t => {
  const directory = fixture(t);
  const journal = new Journal(directory);
  journal.save({ cash: '20' });
  journal.close();
  inspect(directory, db => db.prepare('UPDATE state SET data=?').run('CORRUPT_SECRET_VALUE'));
  assert.throws(() => new Journal(directory), error => !error.message.includes('CORRUPT_SECRET_VALUE') && /unavailable/.test(error.message));
  inspect(directory, db => assert.equal(db.prepare('SELECT data FROM state').get().data, 'CORRUPT_SECRET_VALUE'));
});

test('incomplete or non-SQLite existing files are never reinitialized', t => {
  for (const contents of ['', 'not a SQLite database']) {
    const directory = fixture(t);
    writeFileSync(join(directory, 'state.sqlite'), contents);
    assert.throws(() => new Journal(directory), /unavailable/);
  }
});

test('missing state after prior initialization is never silently recreated', t => {
  const directory = fixture(t);
  const journal = new Journal(directory);
  journal.save({ cash: '17', pendingClientId: 'persisted-order' });
  journal.close();
  const statePath = join(directory, 'state.sqlite');
  rmSync(statePath);
  assert.throws(() => new Journal(directory), /unavailable/);
  assert.equal(existsSync(statePath), false, 'lost ledger must not be replaced');
});

test('interrupted initial setup with only a lock file requires recovery', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'lock.sqlite'), '');
  assert.throws(() => new Journal(directory), /unavailable/);
  assert.equal(existsSync(join(directory, 'state.sqlite')), false);
});

test('invalid JSON values never overwrite durable state', t => {
  const circular = {}; circular.self = circular;
  const hiddenTransform = Object.defineProperty({}, 'toJSON', { value: () => ({ cash: 'wrong' }) });
  const sparse = new Array(1); sparse.extra = true;
  for (const state of [{ cash: NaN }, { x: Infinity }, { missing: undefined }, { x: 1n }, circular, { date: new Date() }, { list: sparse }, hiddenTransform, null]) {
    const directory = fixture(t);
    let journal = new Journal(directory);
    journal.save({ cash: '20' });
    assert.throws(() => journal.save(state), /Journal save failed/);
    journal.close();
    journal = new Journal(directory);
    assert.deepEqual(journal.load(), { cash: '20' });
    journal.close();
  }
});

test('separate process cannot open journal while owner commits repeatedly', t => {
  const directory = fixture(t);
  const journal = new Journal(directory);
  t.after(() => journal.close());
  const code = `import { Journal } from ${JSON.stringify(moduleUrl)};
    try { const j = new Journal(process.argv[1]); j.close(); process.exit(0); }
    catch { process.exit(23); }`;
  for (let n = 0; n < 3; n++) {
    journal.save({ revision: n });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, directory], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 23, 'competing process must be rejected');
  }
  journal.close();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, directory], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, 'owner close releases lock');
  assert.throws(() => journal.save({}), /closed or failed/);
});

test('killed process releases lock and committed WAL state survives', async t => {
  const directory = fixture(t);
  const code = `import { Journal } from ${JSON.stringify(moduleUrl)};
    const journal = new Journal(process.argv[1]);
    journal.save({ cash: '17.25', pendingClientId: 'persist-before-send' });
    process.send('committed'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const message = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error('Journal child exited before commit'); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Journal child timed out')), 5000); timer.unref(); child.once('message', () => clearTimeout(timer)); }),
  ]);
  assert.equal(message[0], 'committed');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const journal = new Journal(directory);
  t.after(() => journal.close());
  assert.deepEqual(journal.load(), { cash: '17.25', pendingClientId: 'persist-before-send' });
});
