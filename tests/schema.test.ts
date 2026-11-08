import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSchemaManager, migrations, readDatabaseConfig, schemaLockKey,
  SchemaMismatchError, SCHEMA_VERSION, SCHEMA_LOCK_TIMEOUT_MS,
} from '../lib/schema';
import type { SchemaConnection, SchemaMode, SchemaPool } from '../lib/schema';

/** Deliberately implements only the SQL contract; never instantiates pg or connects. */
class FakeDatabase implements SchemaPool {
  version: number | null;
  connections = 0;
  releases = 0;
  destroys = 0;
  calls: { sql: string; values?: unknown[] }[] = [];
  lockError: unknown;
  ddlError: unknown;
  readError: unknown;
  connectError: unknown;
  rollbackError: unknown;
  beforeLock?: () => Promise<void>;

  constructor(version: number | null = SCHEMA_VERSION) { this.version = version; }

  async connect(): Promise<SchemaConnection> {
    this.connections++;
    if (this.connectError) throw this.connectError;
    let snapshot = this.version;
    return {
      query: async (sql, values) => {
        this.calls.push({ sql, values });
        if (sql === 'BEGIN') snapshot = this.version;
        if (sql === 'ROLLBACK') {
          if (this.rollbackError) throw this.rollbackError;
          this.version = snapshot;
        }
        if (sql.includes('pg_advisory_xact_lock')) {
          await this.beforeLock?.();
          if (this.lockError) throw this.lockError;
        }
        if (sql.includes('to_regclass')) {
          if (this.readError) throw this.readError;
          return { rows: [{ relation: this.version === null ? null : 'bpe_bot.bot_schema_meta' }] };
        }
        if (sql.startsWith('SELECT version')) return { rows: [{ version: this.version, applied_at: new Date('2026-11-08T00:00:00Z'), applied_by: 'auto' }] };
        if (sql.includes('CREATE SCHEMA')) {
          if (this.ddlError) throw this.ddlError;
        }
        if (sql.includes('INSERT INTO bpe_bot.bot_schema_meta')) this.version = values![0] as number;
        return { rows: [] };
      },
      release: (destroy) => { this.releases++; if (destroy) this.destroys++; },
    };
  }

  manager(mode: SchemaMode = 'auto') {
    return createSchemaManager(this, { mode, schemaToken: 'fake-schema-token-for-unit-tests' });
  }
}

function mismatch(reason?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SchemaMismatchError);
    assert.equal(error.status, 503);
    assert.equal(error.statusCode, 503);
    if (reason) assert.equal(error.reason, reason);
    return true;
  };
}

test('configuration requires all explicit values and never echoes invalid input', () => {
  const valid = {
    NODE_ENV: 'test' as const,
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/unit_only',
    DB_SCHEMA_TOKEN: 'unit-only-token', DB_SCHEMA_MODE: 'verify',
  };
  assert.equal(readDatabaseConfig(valid).mode, 'verify');
  for (const key of ['DATABASE_URL', 'DB_SCHEMA_TOKEN', 'DB_SCHEMA_MODE'] as const) {
    assert.throws(() => readDatabaseConfig({ ...valid, [key]: undefined }), mismatch('configuration'));
    assert.throws(() => readDatabaseConfig({ ...valid, [key]: ' ' }), mismatch('configuration'));
  }
  for (const mode of ['AUTO', 'true', '', 'verify ', 'malicious-secret-mode']) {
    assert.throws(() => readDatabaseConfig({ ...valid, DB_SCHEMA_MODE: mode }), mismatch('configuration'));
  }
  for (const url of ['not-a-url-with-secret', 'https://secret@example.com', 'postgresql:missing-host']) {
    assert.throws(() => readDatabaseConfig({ ...valid, DATABASE_URL: url }), mismatch('configuration'));
  }
});

test('advisory key is stable, token-derived, namespaced, lossless signed int64', () => {
  const key = schemaLockKey('token-one');
  assert.equal(key, schemaLockKey('token-one'));
  assert.notEqual(key, schemaLockKey('token-two'));
  assert.ok(BigInt(key) >= -(2n ** 63n) && BigInt(key) < 2n ** 63n);
  assert.equal(SCHEMA_LOCK_TIMEOUT_MS, 10_000);
});

test('skip is lazy and performs no schema queries or connections', async () => {
  const db = new FakeDatabase(null);
  const manager = db.manager('skip');
  assert.equal(db.connections, 0);
  await Promise.all(Array.from({ length: 12 }, () => manager.ensureReady()));
  assert.equal(db.connections, 0);
  assert.deepEqual(db.calls, []);
});

test('concurrent first requests share one flight and cache successful readiness', async () => {
  const db = new FakeDatabase(null);
  const manager = db.manager();
  let unlock!: () => void;
  db.beforeLock = () => new Promise<void>((resolve) => { unlock = resolve; });
  const calls = Array.from({ length: 20 }, () => manager.ensureReady());
  assert.ok(calls.every((call) => call === calls[0]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  unlock();
  await Promise.all(calls);
  await manager.ensureReady();
  assert.equal(db.connections, 1);
  assert.equal(db.releases, 1);
  assert.equal(db.calls.filter(({ sql }) => sql.includes('CREATE SCHEMA')).length, 1);
  assert.equal(db.version, SCHEMA_VERSION);
  assert.ok(db.calls.some(({ values }) => values?.[1] === 'auto'));
  assert.equal(db.calls.at(-1)?.sql, 'COMMIT');
});

test('verify uses transaction-scoped lock and never executes DDL or metadata writes', async () => {
  const db = new FakeDatabase();
  await db.manager('verify').ensureReady();
  assert.ok(db.calls.some(({ sql }) => sql === "SET LOCAL lock_timeout = '10s'"));
  assert.ok(db.calls.some(({ sql }) => sql === "SET LOCAL statement_timeout = '10s'"));
  assert.ok(db.calls.some(({ sql, values }) => sql.includes('pg_advisory_xact_lock') && values?.length === 1));
  assert.ok(db.calls.every(({ sql }) => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)));
});

for (const mode of ['verify', 'auto'] as const) {
  test(`${mode} rejects future versions without migrating`, async () => {
    const db = new FakeDatabase(SCHEMA_VERSION + 1);
    await assert.rejects(db.manager(mode).ensureReady(), mismatch('ahead'));
    assert.ok(db.calls.every(({ sql }) => !sql.includes('CREATE SCHEMA')));
    assert.equal(db.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(db.releases, 1);
  });
}

for (const [version, reason] of [[null, 'missing'], [0, 'behind'], [-1, 'invalid']] as const) {
  test(`verify rejects ${reason} metadata and rolls back without DDL`, async () => {
    const db = new FakeDatabase(version);
    await assert.rejects(db.manager('verify').ensureReady(), mismatch(reason));
    assert.equal(db.calls.at(-1)?.sql, 'ROLLBACK');
    assert.ok(db.calls.every(({ sql }) => !sql.includes('CREATE SCHEMA')));
  });
}

test('auto skips already-applied versions', async () => {
  const db = new FakeDatabase();
  const result = await db.manager().migrate();
  assert.deepEqual(result, { ok: true, applied: [], currentVersion: SCHEMA_VERSION });
  assert.ok(db.calls.every(({ sql }) => !sql.includes('CREATE SCHEMA')));
});

for (const mode of ['skip', 'verify', 'auto'] as const) {
  test(`manual migration ignores ${mode} mode and labels metadata manual`, async () => {
    const db = new FakeDatabase(null);
    const manager = db.manager(mode);
    const [result, concurrent] = await Promise.all([manager.migrate(), manager.migrate()]);
    assert.deepEqual(result, { ok: true, applied: [1], currentVersion: SCHEMA_VERSION });
    assert.equal(result, concurrent);
    assert.equal(db.connections, 1);
    assert.ok(db.calls.some(({ values }) => values?.[1] === 'manual'));
    await manager.ensureReady();
    assert.equal(db.connections, 1);
  });
}

for (const code of ['55P03', '57014']) {
  for (const version of [null, 0, SCHEMA_VERSION, SCHEMA_VERSION + 1]) {
    test(`lock timeout ${code}, version ${version}: rolls back then verifies without DDL`, async () => {
      const db = new FakeDatabase(version);
      db.lockError = { code, message: 'SECRET connection string and SQL' };
      const call = db.manager().ensureReady();
      if (version === SCHEMA_VERSION) await call;
      else await assert.rejects(call, mismatch());
      const rollback = db.calls.findIndex(({ sql }) => sql === 'ROLLBACK');
      const inspection = db.calls.findIndex(({ sql }) => sql.includes('to_regclass'));
      assert.ok(rollback >= 0 && inspection > rollback);
      assert.ok(db.calls.every(({ sql }) => !sql.includes('CREATE SCHEMA')));
      assert.equal(db.releases, 1);
    });
  }
}

test('manual migration uses the same verification fallback on lock timeout', async () => {
  const db = new FakeDatabase();
  db.lockError = { code: '55P03' };
  assert.deepEqual(await db.manager('skip').migrate(), {
    ok: true, applied: [], currentVersion: SCHEMA_VERSION,
  });
});

test('failed migration sanitizes errors, rolls back, and retries the next request', async () => {
  const db = new FakeDatabase(null);
  const manager = db.manager();
  db.ddlError = new Error('postgresql://SECRET-password SQL access_token');
  await assert.rejects(manager.ensureReady(), (error) => {
    mismatch('unavailable')(error);
    assert.doesNotMatch(JSON.stringify(error) + String(error) + (error as Error).stack, /SECRET|access_token|postgresql:\/\//);
    assert.equal((error as Error).cause, undefined);
    return true;
  });
  assert.equal(db.version, null);
  assert.equal(db.calls.at(-1)?.sql, 'ROLLBACK');
  db.ddlError = undefined;
  await manager.ensureReady();
  assert.equal(db.connections, 2);
  assert.equal(db.releases, 2);
  assert.equal(db.version, SCHEMA_VERSION);
});

test('failed rollback destroys the connection instead of returning an aborted client', async () => {
  const db = new FakeDatabase(null);
  db.ddlError = new Error('private SQL');
  db.rollbackError = new Error('private rollback');
  await assert.rejects(db.manager().ensureReady(), mismatch('unavailable'));
  assert.equal(db.destroys, 1);
});

test('connection and inspection failures become safe 503 errors', async () => {
  const db = new FakeDatabase();
  db.connectError = new Error('private connection');
  await assert.rejects(db.manager().ensureReady(), mismatch('unavailable'));
  assert.equal(db.releases, 0);
  db.connectError = undefined;
  db.readError = new Error('private query');
  await assert.rejects(db.manager().schemaStatus(), mismatch('unavailable'));
  assert.equal(db.releases, 1);
});

test('schemaStatus is fresh and read-only even in auto and skip modes', async () => {
  for (const mode of ['skip', 'verify', 'auto'] as const) {
    const db = new FakeDatabase(null);
    const manager = db.manager(mode);
    assert.deepEqual(await manager.schemaStatus(), { mode, expectedVersion: SCHEMA_VERSION, currentVersion: null, ready: false, appliedAt: null, appliedBy: null });
    db.version = SCHEMA_VERSION;
    assert.deepEqual(await manager.schemaStatus(), { mode, expectedVersion: SCHEMA_VERSION, currentVersion: SCHEMA_VERSION, ready: true, appliedAt: '2026-11-08T00:00:00.000Z', appliedBy: 'auto' });
    db.version++;
    assert.equal((await manager.schemaStatus()).ready, false);
    assert.ok(db.calls.every(({ sql }) => sql.startsWith('SELECT ')));
    assert.equal(db.connections, db.releases);
  }
});

test('migration registry is ordered and all tables are isolated and idempotent', () => {
  assert.equal(migrations.at(-1)?.version, SCHEMA_VERSION);
  assert.deepEqual(migrations.map(({ version }) => version), [...new Set(migrations.map(({ version }) => version))].sort((a, b) => a - b));
  const sql = migrations.map(({ sql }) => sql).join('\n');
  for (const table of ['commands', 'bot_logs', 'user_bindings', 'join_policies', 'token_cache', 'bot_schema_meta', 'webhook_requests', 'event_claims']) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS bpe_bot.${table}`));
  }
  assert.doesNotMatch(sql, /\bpublic\.|\bCREATE EXTENSION\b/);
  assert.equal([...sql.matchAll(/CREATE TABLE /g)].length, [...sql.matchAll(/CREATE TABLE IF NOT EXISTS bpe_bot\./g)].length);
  assert.equal([...sql.matchAll(/CREATE INDEX /g)].length, [...sql.matchAll(/CREATE INDEX IF NOT EXISTS /g)].length);
  assert.match(sql, /UNIQUE \(qq_app_id, qq_member_openid\)/);
  assert.match(sql, /event_id text UNIQUE/);
  assert.match(sql, /CREATE OR REPLACE TRIGGER commands_builtin_guard/);
});
