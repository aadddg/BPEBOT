import assert, { AssertionError } from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'dotenv';
import { Client, Pool, type PoolConfig } from 'pg';
import {
  createSchemaManager, migrations, schemaLockKey, SchemaMismatchError,
  SCHEMA_LOCK_TIMEOUT_MS, SCHEMA_VERSION,
} from '../lib/schema';
import { createStore, type Log } from '../lib/store';

/**
 * Opt-in from the repository root:
 *   $env:BPEBOT_SCHEMA_INTEGRATION='1'
 *   node --import tsx --test BPEBOT/tests/schema-integration.test.ts
 *
 * Reads the parent .env without changing process.env or printing credentials.
 * Connects to local postgres maintenance DB, creates a random isolated database,
 * and drops only that database in finally. Never connects to the application DB.
 */
test('live schema and store integration in a disposable local database', {
  skip: process.env.BPEBOT_SCHEMA_INTEGRATION !== '1', timeout: 120_000,
}, async (t) => {
  const parentEnv = new URL('../../.env', import.meta.url);
  const fileEnv = existsSync(parentEnv) ? parse(readFileSync(parentEnv)) : {};
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...process.env, NODE_ENV: 'test' };
  const dbName = `bpebot_schema_it_${Date.now()}_${randomBytes(6).toString('hex')}`;
  assert.match(dbName, /^bpebot_schema_it_[0-9]+_[a-f0-9]{12}$/);
  const sourceUrl = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
  const host = sourceUrl?.hostname ?? env.PGHOST ?? '127.0.0.1';
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(host), 'Integration test requires a local PostgreSQL server.');

  function config(database: string, readOnly = false): PoolConfig {
    const options = readOnly ? '-c default_transaction_read_only=on' : undefined;
    if (sourceUrl) {
      const url = new URL(sourceUrl);
      url.pathname = `/${database}`;
      // URL parameters override pg config fields; override all database selectors.
      url.searchParams.delete('database');
      url.searchParams.delete('dbname');
      url.searchParams.delete('options');
      if (options) url.searchParams.set('options', options);
      return { connectionString: url.href, max: 12, connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000 };
    }
    return {
      host, port: Number(env.PGPORT ?? 55432), user: env.PGUSER ?? 'radioweb2',
      password: env.PGPASSWORD, database, options, max: 12,
      connectionTimeoutMillis: 3000, idleTimeoutMillis: 1000,
    };
  }

  // Prevent driver errors from exposing configuration, SQL or credentials in TAP.
  function sanitized(error: unknown): Error {
    if (error instanceof AssertionError || error instanceof SchemaMismatchError) return error;
    const code = error && typeof error === 'object' && 'code' in error &&
      typeof error.code === 'string' && /^[A-Z0-9_]{1,20}$/.test(error.code) ? error.code : 'UNKNOWN';
    return new Error(`Disposable database integration failed (${code}).`);
  }
  const step = (name: string, action: () => Promise<void>) => t.test(name, async () => {
    try { await action(); } catch (error) { throw sanitized(error); }
  });
  const mismatch = (reason: string) => (error: unknown) => error instanceof SchemaMismatchError &&
    error.reason === reason && error.status === 503;

  const admin = new Client(config('postgres'));
  const pools: Pool[] = [];
  const token = randomBytes(32).toString('hex');
  let created = false;
  let createdOid: number | undefined;
  function makePool(readOnly = false) {
    const pool = new Pool(config(dbName, readOnly));
    pool.on('error', () => {});
    pools.push(pool);
    return pool;
  }
  try {
    await admin.connect();
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'postgres');
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE template0`);
    created = true;
    createdOid = (await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [dbName])).rows[0].oid;
    const pool = makePool();
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, dbName);
    t.diagnostic(`Created disposable database; PostgreSQL ${(await pool.query('SHOW server_version')).rows[0].server_version}.`);
    const manager = (mode: 'auto' | 'verify' | 'skip' = 'auto', db = pool) => createSchemaManager(db, { mode, schemaToken: token });
    const noSchema = async () => assert.equal((await pool.query("SELECT to_regnamespace('bpe_bot') AS ns")).rows[0].ns, null);
    const dropSchema = () => pool.query('DROP SCHEMA IF EXISTS bpe_bot CASCADE');

    await step('skip and status on an empty database create nothing; verify returns 503', async () => {
      await manager('skip').ensureReady();
      await noSchema();
      assert.deepEqual(await manager().schemaStatus(), {
        mode: 'auto', expectedVersion: SCHEMA_VERSION, currentVersion: null,
        ready: false, appliedAt: null, appliedBy: null,
      });
      await assert.rejects(manager('verify').ensureReady(), mismatch('missing'));
      await noSchema();
      // Model an existing parent table with the same name, inside this test DB only.
      await pool.query('CREATE TABLE public.commands (sentinel text NOT NULL)');
      await pool.query("INSERT INTO public.commands VALUES ('parent table preserved')");
    });

    await step('independent pools and concurrent first requests migrate exactly once', async () => {
      const independent = Array.from({ length: 4 }, () => manager('auto', makePool()));
      await Promise.all(independent.flatMap((schema) => Array.from({ length: 5 }, () => schema.ensureReady())));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='bpe_bot'")).rows[0].n, 8);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bpe_bot.commands')).rows[0].n, 2);
      assert.equal((await pool.query('SELECT sentinel FROM public.commands')).rows[0].sentinel, 'parent table preserved');
      const status = await manager().schemaStatus();
      assert.equal(status.currentVersion, SCHEMA_VERSION);
      assert.equal(status.appliedBy, 'auto');
      assert.ok(status.appliedAt && Number.isFinite(Date.parse(status.appliedAt)));
      assert.equal(status.ready, true);
    });

    await step('verify and status work on a server-enforced read-only connection', async () => {
      const readOnly = makePool(true);
      assert.equal((await readOnly.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
      await manager('verify', readOnly).ensureReady();
      assert.equal((await manager('auto', readOnly).schemaStatus()).ready, true);
      await assert.rejects(readOnly.query('CREATE TABLE bpe_bot.must_not_exist(id int)'), (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === '25006');
    });

    await step('manual no-op preserves metadata and bundled DDL is idempotent', async () => {
      const before = await manager().schemaStatus();
      assert.deepEqual(await manager('skip').migrate(), { ok: true, applied: [], currentVersion: SCHEMA_VERSION });
      const after = await manager().schemaStatus();
      assert.equal(after.appliedAt, before.appliedAt);
      assert.equal(after.appliedBy, before.appliedBy);
      for (const migration of migrations) await pool.query(migration.sql);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bpe_bot.commands')).rows[0].n, 2);
    });

    await step('store CRUD, webhook rows, dedup claims, filters and dashboard SQL match real columns', async () => {
      const schema = manager();
      const store = createStore(async () => pool, schema.schemaStatus, {
        NODE_ENV: 'test', APP_URL: 'http://localhost:3100', PLATFORM_URL: 'http://localhost:3000',
      });
      const builtin = (await store.getCommands()).find((command) => command.builtin_key === 'warn')!;
      const command = await store.saveCommand({ keyword: 'help', match_type: 'contains', reply_body: 'Hello from integration test' });
      const updated = await store.saveCommand({ reply_body: 'Updated reply' }, command.id);
      assert.equal(updated.reply_body, 'Updated reply');
      await store.saveCommand({ enabled: false }, builtin.id);
      await store.saveCommand({ enabled: true }, builtin.id);
      const policy = await store.savePolicy({ group_openid: 'test-group', rule_type: 'keyword', rule_value: 'join', action: 'approve' });
      await store.savePolicy({ action: 'reject', reject_reason: 'Test rejection' }, policy.id);
      const log: Omit<Log, 'id' | 'created_at'> = {
        event_id: 'test-event', event_type: 'GROUP_AT_MESSAGE_CREATE', group_openid: 'test-group',
        member_openid: 'test-member', target_openid: null, operator_openid: null, content: 'help',
        matched_command_id: command.id, action_type: 'message', action_param: {}, reply_status: 'pending',
        reply_body: null, error: null, msg_id: 'test-msg', member_role: 'member', raw_event: { unit: true },
      };
      const claims = await Promise.all(Array.from({ length: 8 }, () => store.beginEvent(log)));
      assert.equal(claims.filter(Boolean).length, 1);
      await store.finishEvent('test-event', 'replied', 'Updated reply', null);
      await store.recordWebhook({ event_id: log.event_id, event_type: log.event_type, signature_valid: true,
        processing_result: 'replied', http_status: 200, duration_ms: 1, error: null });
      const filtered = await store.listLogs({ event_id: 'test-event', action_type: 'message', matched_command_id: command.id, from: '2020-01-01', to: '2100-01-01' });
      assert.equal(filtered.total, 1);
      assert.equal(filtered.logs[0].reply_status, 'replied');
      const state = await store.getState();
      assert.equal(state.commands.find((item) => item.id === command.id)?.recent.length, 1);
      assert.equal(state.commands.find((item) => item.id === command.id)?.hits.reduce((a, b) => a + b, 0), 1);
      assert.equal(state.requests[0].signature_valid, true);
      assert.equal(state.policies.find((item) => item.id === policy.id)?.reject_reason, 'Test rejection');
      assert.equal(state.settings.schemaVersion, SCHEMA_VERSION);
      await pool.query("INSERT INTO bpe_bot.user_bindings(platform_user_id,qq_member_openid,qq_app_id) VALUES ('test-user','test-member','test-app')");
      assert.equal(await store.boundPlatformUser('test-member', 'test-app'), 'test-user');
      await store.clearLogs();
      assert.equal(await store.beginEvent(log), false);
      assert.equal((await store.listLogs()).total, 0);
      await store.deleteCommand(command.id);
      await store.deletePolicy(policy.id);
    });

    await step('database enforces singleton metadata, identity uniqueness, and builtin protection', async () => {
      const code = (expected: string) => (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;
      await assert.rejects(pool.query("DELETE FROM bpe_bot.commands WHERE builtin_key='warn'"), code('23514'));
      await assert.rejects(pool.query("UPDATE bpe_bot.commands SET builtin=false,builtin_key=NULL WHERE builtin_key='warn'"), code('23514'));
      await assert.rejects(pool.query("INSERT INTO bpe_bot.bot_schema_meta(id,version,applied_at) VALUES(2,1,now())"), code('23514'));
      await assert.rejects(pool.query("INSERT INTO bpe_bot.user_bindings(platform_user_id,qq_member_openid,qq_app_id) VALUES ('another-user','test-member','test-app')"), code('23505'));
      await pool.query("INSERT INTO bpe_bot.token_cache(access_token,expires_at) VALUES ('test-only-token',now()+interval '1 hour')");
      await assert.rejects(pool.query("INSERT INTO bpe_bot.token_cache(id,access_token,expires_at) VALUES (2,'test-only-token',now())"), code('23514'));
    });

    await step('behind versions migrate and future versions reject auto, verify, and manual', async () => {
      await pool.query('UPDATE bpe_bot.bot_schema_meta SET version=0');
      await assert.rejects(manager('verify').ensureReady(), mismatch('behind'));
      await manager().ensureReady();
      await pool.query('UPDATE bpe_bot.bot_schema_meta SET version=$1', [SCHEMA_VERSION + 1]);
      await assert.rejects(manager().ensureReady(), mismatch('ahead'));
      await assert.rejects(manager('verify').ensureReady(), mismatch('ahead'));
      await assert.rejects(manager('skip').migrate(), mismatch('ahead'));
      assert.equal((await manager().schemaStatus()).ready, false);
      assert.equal((await pool.query('SELECT version FROM bpe_bot.bot_schema_meta')).rows[0].version, SCHEMA_VERSION + 1);
      await manager('skip').ensureReady();
      await pool.query('UPDATE bpe_bot.bot_schema_meta SET version=$1', [SCHEMA_VERSION]);
    });

    for (const mode of ['skip', 'verify'] as const) {
      await step(`manual migration creates missing schema despite ${mode} mode`, async () => {
        await dropSchema();
        assert.deepEqual(await manager(mode).migrate(), { ok: true, applied: [1], currentVersion: SCHEMA_VERSION });
        assert.equal((await manager().schemaStatus()).appliedBy, 'manual');
      });
    }

    await step('DDL failure rolls back metadata and retries successfully with the same manager', async () => {
      await dropSchema();
      await pool.query('CREATE SCHEMA bpe_bot; CREATE TABLE bpe_bot.commands(incompatible boolean)');
      const schema = manager();
      await assert.rejects(schema.ensureReady(), mismatch('unavailable'));
      assert.equal((await pool.query("SELECT to_regclass('bpe_bot.bot_schema_meta') AS meta")).rows[0].meta, null);
      await dropSchema();
      await schema.ensureReady();
      assert.equal((await schema.schemaStatus()).ready, true);
    });

    for (const existingSchema of [true, false]) {
      await step(`real 10-second lock contention uses verify fallback (${existingSchema ? 'matching' : 'missing'} schema)`, async () => {
        if (!existingSchema) await dropSchema();
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [schemaLockKey(token)]);
          const started = performance.now();
          const automatic = manager();
          const attempts = [automatic.ensureReady(), manager('verify').ensureReady(), manager('skip').migrate()];
          const results = await Promise.allSettled(attempts);
          const elapsed = performance.now() - started;
          assert.ok(elapsed >= SCHEMA_LOCK_TIMEOUT_MS - 500 && elapsed < SCHEMA_LOCK_TIMEOUT_MS + 8000, `Lock wait bounded: ${Math.round(elapsed)}ms`);
          for (const result of results) {
            if (existingSchema) assert.equal(result.status, 'fulfilled');
            else {
              assert.equal(result.status, 'rejected');
              if (result.status === 'rejected') assert.ok(mismatch('missing')(result.reason));
            }
          }
          if (!existingSchema) await noSchema();
          await holder.query('ROLLBACK');
          if (!existingSchema) {
            await automatic.ensureReady();
            assert.equal((await automatic.schemaStatus()).ready, true);
          }
          t.diagnostic(`Lock fallback checked in ${Math.round(elapsed)}ms.`);
        } finally {
          await holder.query('ROLLBACK').catch(() => {});
          holder.release();
        }
      });
    }
  } catch (error) {
    throw sanitized(error);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    try {
      if (created) {
        // Both identifier and OID must match the database created by this test.
        const owned = await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [dbName]);
        assert.equal(owned.rows[0]?.oid, createdOid);
        assert.match(dbName, /^bpebot_schema_it_[0-9]+_[a-f0-9]{12}$/);
        await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rowCount, 0);
        t.diagnostic('Disposable database dropped and absence verified.');
      }
    } catch (error) {
      throw sanitized(error);
    } finally {
      await admin.end();
    }
  }
});
