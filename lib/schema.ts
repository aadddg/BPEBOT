import { createHash } from 'node:crypto';
import { initialSchemaSql } from '../migrations/001_initial';

export const SCHEMA_VERSION = 1;
export const SCHEMA_LOCK_TIMEOUT_MS = 10_000;
export type SchemaMode = 'skip' | 'verify' | 'auto';
export type SchemaErrorReason = 'configuration' | 'missing' | 'behind' | 'ahead' | 'invalid' | 'unavailable';

/** Safe to return to an HTTP caller. Never retains the underlying driver error. */
export class SchemaMismatchError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = 'SCHEMA_MISMATCH';
  readonly expectedVersion = SCHEMA_VERSION;

  constructor(
    readonly reason: SchemaErrorReason,
    readonly currentVersion: number | null = null,
  ) {
    super(`BPEBOT database schema unavailable (${reason}); expected version ${SCHEMA_VERSION}, current ${currentVersion ?? 'unknown'}.`);
    this.name = 'SchemaMismatchError';
  }
}

export interface DatabaseConfig {
  connectionString: string;
  mode: SchemaMode;
  schemaToken: string;
}

/** All three values are explicit, including for skip and manual migrations. */
export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const connectionString = env.DATABASE_URL;
  const mode = env.DB_SCHEMA_MODE;
  const schemaToken = env.DB_SCHEMA_TOKEN;
  if (!connectionString?.trim() || !schemaToken?.trim() ||
      (mode !== 'skip' && mode !== 'verify' && mode !== 'auto')) {
    throw new SchemaMismatchError('configuration');
  }
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new SchemaMismatchError('configuration');
  }
  return { connectionString, mode, schemaToken };
}

/** Signed int64 represented as a string so JavaScript never loses precision. */
export function schemaLockKey(token: string): string {
  return createHash('sha256').update('bpe_bot:schema:').update(token).digest().readBigInt64BE(0).toString();
}

export interface SchemaConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

export interface SchemaPool {
  connect(): Promise<SchemaConnection>;
}

export interface MigrationResult {
  ok: true;
  applied: number[];
  currentVersion: number;
}

export interface SchemaStatus {
  mode: SchemaMode;
  expectedVersion: number;
  currentVersion: number | null;
  ready: boolean;
  appliedAt: string | null;
  appliedBy: 'auto' | 'manual' | 'ci' | null;
}

export const migrations: readonly { version: number; sql: string }[] = Object.freeze([
  Object.freeze({ version: 1, sql: initialSchemaSql }),
]);

async function readMetadata(client: SchemaConnection): Promise<Pick<SchemaStatus, 'currentVersion' | 'appliedAt' | 'appliedBy'>> {
  const missing = { currentVersion: null, appliedAt: null, appliedBy: null };
  const table = await client.query("SELECT to_regclass('bpe_bot.bot_schema_meta') AS relation");
  if (!table.rows[0]?.relation) return missing;
  const result = await client.query('SELECT version, applied_at, applied_by FROM bpe_bot.bot_schema_meta WHERE id = 1');
  if (!result.rows.length) return missing;
  const version = result.rows[0].version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new SchemaMismatchError('invalid');
  }
  const appliedAt = result.rows[0].applied_at;
  const appliedBy = result.rows[0].applied_by;
  if (!(appliedAt instanceof Date) || !Number.isFinite(appliedAt.getTime()) ||
      (appliedBy !== null && appliedBy !== 'auto' && appliedBy !== 'manual' && appliedBy !== 'ci')) {
    throw new SchemaMismatchError('invalid', version);
  }
  return { currentVersion: version, appliedAt: appliedAt.toISOString(), appliedBy };
}

async function readVersion(client: SchemaConnection): Promise<number | null> {
  return (await readMetadata(client)).currentVersion;
}

function verifyVersion(version: number | null): asserts version is number {
  if (version === null) throw new SchemaMismatchError('missing');
  if (version < SCHEMA_VERSION) throw new SchemaMismatchError('behind', version);
  if (version > SCHEMA_VERSION) throw new SchemaMismatchError('ahead', version);
}

function safeError(error: unknown): SchemaMismatchError {
  return error instanceof SchemaMismatchError ? error : new SchemaMismatchError('unavailable');
}

function isLockTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === '55P03' || error.code === '57014';
}

/** The injected pool allows lifecycle tests without opening any real connection. */
export function createSchemaManager(pool: SchemaPool, config: Pick<DatabaseConfig, 'mode' | 'schemaToken'>) {
  let ready = false;
  let initialization: Promise<void> | undefined;
  let manualMigration: Promise<MigrationResult> | undefined;

  async function run(mode: 'verify' | 'auto', appliedBy: 'auto' | 'manual'): Promise<MigrationResult> {
    let client: SchemaConnection | undefined;
    let transaction = false;
    let destroy = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transaction = true;
      // Both are transaction-local, including through Neon transaction pooling.
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      try {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [schemaLockKey(config.schemaToken)]);
      } catch (error) {
        if (!isLockTimeout(error)) throw error;
        // A lock timeout aborts the transaction. Roll back before read-only fallback.
        await client.query('ROLLBACK');
        transaction = false;
        const version = await readVersion(client);
        verifyVersion(version);
        return { ok: true, applied: [], currentVersion: version };
      }

      const version = await readVersion(client);
      if (version !== null && version > SCHEMA_VERSION) throw new SchemaMismatchError('ahead', version);
      const applied: number[] = [];
      if (mode === 'verify') {
        verifyVersion(version);
      } else {
        for (const migration of migrations) {
          if (migration.version <= (version ?? 0)) continue;
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO bpe_bot.bot_schema_meta (id, version, applied_at, applied_by)
             VALUES (1, $1, now(), $2)
             ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version,
               applied_at = EXCLUDED.applied_at, applied_by = EXCLUDED.applied_by`,
            [migration.version, appliedBy],
          );
          applied.push(migration.version);
        }
        verifyVersion(await readVersion(client));
      }
      await client.query('COMMIT');
      transaction = false;
      return { ok: true, applied, currentVersion: SCHEMA_VERSION };
    } catch (error) {
      if (client && transaction) {
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
      }
      throw safeError(error);
    } finally {
      client?.release(destroy);
    }
  }

  function ensureReady(): Promise<void> {
    if (ready) return Promise.resolve();
    if (initialization) return initialization;
    initialization = (async () => {
      if (config.mode !== 'skip') await run(config.mode, 'auto');
      ready = true;
    })().finally(() => { initialization = undefined; });
    return initialization;
  }

  function migrate(): Promise<MigrationResult> {
    if (manualMigration) return manualMigration;
    manualMigration = run('auto', 'manual').then((result) => {
      ready = true;
      return result;
    }).finally(() => { manualMigration = undefined; });
    return manualMigration;
  }

  /** Fresh read, even in skip mode; never calls ensureReady or performs DDL. */
  async function schemaStatus(): Promise<SchemaStatus> {
    let client: SchemaConnection | undefined;
    try {
      client = await pool.connect();
      const metadata = await readMetadata(client);
      return { mode: config.mode, expectedVersion: SCHEMA_VERSION, ...metadata, ready: metadata.currentVersion === SCHEMA_VERSION };
    } catch (error) {
      throw safeError(error);
    } finally {
      client?.release();
    }
  }

  return { ensureReady, migrate, schemaStatus };
}
