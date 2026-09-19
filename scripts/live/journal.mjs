import { DatabaseSync } from 'node:sqlite';
import { constants, mkdirSync, lstatSync, chmodSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// A separate database keeps the lifetime lock independent of state commits.
// Do not unlink either database: an existing inode may still be locked.
function privateFile(path) {
  const existed = existsSync(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!lstatSync(path).isFile()) throw new Error('Invalid journal file');
    chmodSync(path, 0o600);
  } finally { closeSync(fd); }
  return existed;
}

function jsonState(state) {
  const ancestors = new Set();
  function check(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid state');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Invalid state');
    ancestors.add(value);
    if (Reflect.ownKeys(value).some(key => typeof key === 'symbol' || (key !== 'length' && !Object.getOwnPropertyDescriptor(value, key)?.enumerable))) throw new Error('Invalid state');
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property)) throw new Error('Invalid state');
      check(property.value);
    }
    if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) throw new Error('Invalid state');
    ancestors.delete(value);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid state');
  check(state);
  return JSON.stringify(state);
}

function auditEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event');
  const result = { type: event.type ?? 'tick' };
  for (const key of ['type', 'status']) {
    const value = key === 'type' ? result.type : event.status;
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(value)) throw new Error('Invalid event');
    result[key] = value;
  }
  if (event.time !== undefined) {
    if (typeof event.time === 'number' && Number.isFinite(event.time) && event.time >= 0) result.time = event.time;
    else if (typeof event.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(event.time) && Number.isFinite(Date.parse(event.time))) result.time = event.time;
    else throw new Error('Invalid event');
  }
  return JSON.stringify(result);
}

export class Journal {
  #lock;
  #db;
  #closed = false;
  #failed = false;
  #directory;

  constructor(directory) {
    try {
      this.#directory = resolve(directory);
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.#directory).isDirectory()) throw new Error('Invalid directory');
      chmodSync(this.#directory, 0o700);
      const lockPath = join(this.#directory, 'lock.sqlite');
      const lockExisted = privateFile(lockPath);
      this.#lock = new DatabaseSync(lockPath, { timeout: 0 });
      this.#lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      const statePath = join(this.#directory, 'state.sqlite');
      // A prior lock file marks a previously attempted initialization. Missing
      // state may mean lost durable storage while broker orders still exist.
      // Even an interrupted first initialization requires manual reconciliation.
      if (lockExisted && !existsSync(statePath)) throw new Error('Missing existing journal state');
      const existed = privateFile(statePath);
      this.#db = new DatabaseSync(statePath, { timeout: 0 });
      if (!existed) {
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE events (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL UNIQUE CHECK(revision>0), data TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Append-only audit'); END;
          CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Append-only audit'); END;
          PRAGMA user_version=1;
          COMMIT;`);
      }
      if (this.#db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Invalid schema');
      if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Corrupt journal');
      const triggers = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('events_no_update','events_no_delete')").all();
      if (triggers.length !== 2) throw new Error('Invalid schema');
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
      if (this.#db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' || this.#db.prepare('PRAGMA synchronous').get().synchronous !== 2) throw new Error('Durability unavailable');
      this.#secureSidecars();
      this.load();
    } catch {
      this.close();
      throw new Error('Journal unavailable: locked, invalid, or inaccessible; existing state preserved');
    }
  }

  #ready() {
    if (this.#closed || this.#failed) throw new Error('Journal is closed or failed');
  }

  #secureSidecars() {
    for (const name of ['lock.sqlite', 'lock.sqlite-journal', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      const path = join(this.#directory, name);
      if (existsSync(path)) {
        if (!lstatSync(path).isFile()) throw new Error('Invalid journal sidecar');
        chmodSync(path, 0o600);
      }
    }
  }

  load() {
    this.#ready();
    try {
      const rows = this.#db.prepare('SELECT id, revision, data FROM state').all();
      const audit = this.#db.prepare('SELECT COUNT(*) AS count, MAX(revision) AS revision FROM events').get();
      if (rows.length === 0) {
        if (audit.count !== 0) throw new Error('Missing state');
        return null;
      }
      if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 1 || rows[0].revision !== audit.revision || rows[0].revision !== audit.count) throw new Error('Invalid state history');
      const state = JSON.parse(rows[0].data);
      jsonState(state);
      return state;
    } catch {
      this.#failed = true;
      throw new Error('Journal state invalid or unreadable; execution must stop');
    }
  }

  save(state, event = { type: 'tick' }) {
    this.#ready();
    let transaction = false;
    try {
      const data = jsonState(state);
      const audit = auditEvent(event);
      const time = new Date().toISOString();
      this.#db.exec('BEGIN IMMEDIATE');
      transaction = true;
      // Validate persisted state before overwriting it, including external corruption.
      this.load();
      const previous = this.#db.prepare('SELECT revision FROM state WHERE id=1').get();
      const revision = (previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Revision overflow');
      this.#db.prepare('INSERT INTO state(id,revision,data,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').run(revision, data, time);
      this.#db.prepare('INSERT INTO events(revision,data,created_at) VALUES(?,?,?)').run(revision, audit, time);
      this.#secureSidecars();
      this.#db.exec('COMMIT');
      transaction = false;
    } catch {
      this.#failed = true;
      if (transaction) { try { this.#db.exec('ROLLBACK'); } catch { /* Fail closed even if rollback fails. */ } }
      throw new Error('Journal save failed; execution must stop and reconcile before retrying');
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    // Closing releases SQLite locks even when initialization/transactions failed.
    try { this.#db?.close(); } finally { this.#lock?.close(); }
  }
}

export default Journal;
