import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { getDb, migrate, schemaStatus, SCHEMA_VERSION, SchemaMismatchError } from '../lib/db';

test('public db exports initialize lazily, share one Pool, and inspect without DDL', async (t) => {
  const envKeys = ['DATABASE_URL', 'DB_SCHEMA_MODE', 'DB_SCHEMA_TOKEN'] as const;
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of envKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  process.env.DATABASE_URL = 'postgresql://fake:fake@localhost:1/unit_only';
  process.env.DB_SCHEMA_MODE = 'invalid';
  process.env.DB_SCHEMA_TOKEN = 'unit-only-token';
  await assert.rejects(getDb(), (error) => error instanceof SchemaMismatchError && error.status === 503);
  process.env.DB_SCHEMA_MODE = 'verify';

  let connections = 0;
  let releases = 0;
  const queries: string[] = [];
  // Intercept before pg can establish a socket. No live application DB is touched.
  t.mock.method(Pool.prototype, 'connect', async () => {
    connections++;
    return {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) return { rows: [{ relation: 'bpe_bot.bot_schema_meta' }] };
        if (sql.startsWith('SELECT version')) return { rows: [{ version: SCHEMA_VERSION, applied_at: new Date('2026-11-08T00:00:00Z'), applied_by: 'auto' }] };
        return { rows: [] };
      },
      release: () => { releases++; },
    };
  });
  assert.equal(connections, 0);
  const pools = await Promise.all(Array.from({ length: 16 }, () => getDb()));
  assert.ok(pools.every((pool) => pool === pools[0] && pool instanceof Pool));
  assert.equal(connections, 1);
  assert.equal(releases, 1);
  assert.deepEqual(await schemaStatus(), {
    mode: 'verify', expectedVersion: SCHEMA_VERSION, currentVersion: SCHEMA_VERSION, ready: true,
    appliedAt: '2026-11-08T00:00:00.000Z', appliedBy: 'auto',
  });
  assert.deepEqual(await migrate(), { ok: true, applied: [], currentVersion: SCHEMA_VERSION });
  assert.equal(connections, 3);
  assert.equal(releases, 3);
  assert.ok(queries.every((sql) => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)));
  await pools[0].end();
});
