// Server-only Node.js module. Route handlers using this module must export runtime = 'nodejs'.
import { Pool } from 'pg';
import { createSchemaManager, readDatabaseConfig, SchemaMismatchError } from './schema';
import type { MigrationResult, SchemaStatus } from './schema';

export { SCHEMA_VERSION, SchemaMismatchError } from './schema';
export type { MigrationResult, SchemaMode, SchemaStatus } from './schema';

let state: { pool: Pool; schema: ReturnType<typeof createSchemaManager> } | undefined;

function database() {
  if (state) return state;
  const config = readDatabaseConfig();
  try {
    const pool = new Pool({
      connectionString: config.connectionString,
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    // pg emits idle-client errors outside query promises. Handle them without
    // printing an error object that could contain credentials or SQL.
    pool.on('error', () => {});
    state = { pool, schema: createSchemaManager(pool, config) };
    return state;
  } catch {
    throw new SchemaMismatchError('configuration');
  }
}

/** Lazy pool creation; concurrent first callers share exactly one initialization. */
export async function getDb(): Promise<Pool> {
  const { pool, schema } = database();
  await schema.ensureReady();
  return pool;
}

/** Caller must authenticate x-schema-token BEFORE invoking this method. */
export function migrate(): Promise<MigrationResult> {
  return database().schema.migrate();
}

/** Read-only inspection; unlike getDb(), never initializes or migrates the schema. */
export function schemaStatus(): Promise<SchemaStatus> {
  return database().schema.schemaStatus();
}
