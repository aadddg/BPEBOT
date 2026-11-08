import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type ClientConfig } from 'pg';
import { createSchemaManager } from '../lib/schema';
import { createSsoService, ssoSchema, SsoError } from '../platform-integration/sso-core';

export const APP_URL = 'http://127.0.0.1:3109';
export const UI_SECRET = 'ui-only-qq-secret-never-display';
export const UI_TOKEN = 'ui-only-access-token-never-display';
export const UI_APP_ID = '98765432101234567890';
export const ADMIN_NAME = 'Browser Test Administrator';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function closeServer(server: Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

async function stopNext(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit');
  } else {
    // The Next CLI forks a worker; stop the entire isolated process group.
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise<void>(done => {
    timer = setTimeout(() => {
      if (process.platform !== 'win32') { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ } }
      done();
    }, 8000);
  })]);
  clearTimeout(timer);
}

/** Playwright global setup returns teardown, so assertion failures also drop the database. */
export default async function startUiServer() {
  const uiSso = process.env.BPEBOT_UI_SSO === '1';
  const uiSsoSecret = randomBytes(48).toString('base64url');
  // Read the parent configuration without changing process.env or writing its database.
  const dotenv = require('dotenv') as { parse(text: string): Record<string, string> };
  const parentEnv = await readFile(resolve(root, '../.env'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw new Error('Cannot read local test connection settings.');
  });
  const fileEnv = dotenv.parse(parentEnv);
  const env = { ...fileEnv, ...process.env };
  const source: ClientConfig = env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : { host: env.PGHOST || '127.0.0.1', port: Number(env.PGPORT || 55432),
      user: env.PGUSER || 'radioweb2', password: env.PGPASSWORD };
  // Even the maintenance connection targets postgres, never the parent application DB.
  if (source.connectionString) {
    const url = new URL(source.connectionString);
    url.pathname = '/postgres';
    url.searchParams.delete('database');
    url.searchParams.delete('dbname');
    source.connectionString = url.href;
  }
  const targetHost = source.connectionString ? new URL(source.connectionString).hostname : source.host;
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(targetHost || '')) throw new Error('UI tests require local PostgreSQL.');
  const maintenance = new Client({ ...source, database: 'postgres', connectionTimeoutMillis: 5000 });
  const databaseName = `bpebot_ui_${process.pid}_${randomBytes(8).toString('hex')}`;
  if (!/^bpebot_ui_[0-9]+_[a-f0-9]{16}$/.test(databaseName)) throw new Error('Invalid isolated database name.');
  let created = false, connected = false;
  let database: Client | undefined, platform: Server | undefined, child: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    try { await stopNext(child); }
    finally {
      try { await closeServer(platform); }
      finally {
        try { await database?.end(); }
        finally {
          try {
            if (created) {
              await maintenance.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
              await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
              console.log('[ui harness] Isolated database removed.');
            }
          } finally { if (connected) await maintenance.end(); }
        }
      }
    }
  })();
  const interrupted = () => { void cleanup().then(() => process.exit(130), () => process.exit(1)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);

  try {
    // Refuse to reuse another server, which could point at a non-test database.
    const portCheck = createServer();
    await new Promise<void>((done, reject) => {
      portCheck.once('error', reject);
      portCheck.listen(3109, '127.0.0.1', () => { portCheck.removeListener('error', reject); done(); });
    });
    await closeServer(portCheck);
    await maintenance.connect(); connected = true;
    await maintenance.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = source.connectionString ? new URL(source.connectionString) : new URL('postgresql://127.0.0.1');
    if (!source.connectionString) {
      url.hostname = source.host!;
      url.port = String(source.port);
      url.username = source.user!;
      url.password = typeof source.password === 'string' ? source.password : '';
    }
    url.pathname = `/${databaseName}`;
    url.searchParams.delete('database');
    url.searchParams.delete('dbname');
    const databaseUrl = url.href;
    database = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await database.connect();
    await database.query("CREATE TABLE public.\"user\" (id text PRIMARY KEY, role text NOT NULL, name text NOT NULL DEFAULT 'Browser Test Administrator')");
    await database.query('INSERT INTO public."user" (id,role) VALUES ($1,$2),($3,$4)', ['ui-admin', 'admin', 'ui-member', 'user']);
    const schemaToken = `ui-schema-secret-${randomBytes(32).toString('hex')}`;
    const manager = createSchemaManager({ connect: async () => ({
      query: (sql, values) => database!.query(sql, values), release() {},
    }) }, { mode: 'auto', schemaToken });
    await manager.ensureReady();
    await database.query('INSERT INTO bpe_bot.token_cache (access_token,expires_at) VALUES ($1,now()+interval \'1 hour\')', [UI_TOKEN]);
    for (let index = 1; index <= 25; index++) {
      const special = index > 21;
      await database.query(`INSERT INTO bpe_bot.bot_logs
        (event_id,event_type,group_openid,member_openid,content,action_type,reply_status,reply_body,error,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-($10::integer * interval '1 minute'))`, [
        `ui-event-${index}`, index === 25 ? 'GROUP_ADD_REQUEST' : 'GROUP_AT_MESSAGE_CREATE',
        index === 23 ? 'group-b' : 'group-a', 'ui-member-openid',
        special ? `UI audit record ${index}` : `UI pagination record ${index}`,
        index >= 24 ? 'approval' : 'message',
        index === 23 || index === 25 ? 'failed' : index === 24 ? 'denied' : 'replied',
        index === 22 ? 'UI successful reply' : null, index === 23 || index === 25 ? 'UI upstream unavailable' : null, index,
      ]);
    }
    const ssoService = createSsoService(database, { secret: uiSsoSecret, redirectUri: APP_URL + '/api/sso/callback' });
    if (uiSso) {
      await database.query('CREATE TABLE public."session" (id text PRIMARY KEY,"userId" text REFERENCES public."user"(id),"expiresAt" timestamptz)');
      await database.query("INSERT INTO public.\"session\" VALUES ('session-ui-admin','ui-admin',now()+interval '1 hour'),('session-ui-member','ui-member',now()+interval '1 hour')");
      await database.query(ssoSchema);
    }
    platform = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json');
      if (uiSso && request.url?.startsWith('/api/bot-sso/')) {
        try {
          const url = new URL(request.url, 'http://127.0.0.1');
          if (url.pathname.endsWith('/authorize') && request.method === 'GET') {
            const cookie = request.headers.cookie || '';
            const id = cookie.split(';').map(value => value.trim()).includes('test-session=admin') ? 'ui-admin' : 'ui-member';
            const location = await ssoService.issue(Object.fromEntries(url.searchParams), { userId: id, sessionId: `session-${id}` });
            response.writeHead(303, { location }).end(); return;
          }
          if (request.method !== 'POST') { response.writeHead(405).end('{}'); return; }
          const parts: Buffer[] = []; let size = 0;
          for await (const part of request) { size += part.length; if (size > 8192) throw new Error('too large'); parts.push(part); }
          const body = JSON.parse(Buffer.concat(parts).toString()); const secret = request.headers['x-bpebot-client-secret'];
          if (url.pathname.endsWith('/token')) { response.end(JSON.stringify(await ssoService.exchange(body, secret))); return; }
          if (url.pathname.endsWith('/introspect')) { response.end(JSON.stringify(await ssoService.introspect(body.token, secret))); return; }
          if (url.pathname.endsWith('/revoke')) { await ssoService.revoke(body.token, secret); response.end('{"status":"ok"}'); return; }
          response.writeHead(404).end('{}');
        } catch (error) { response.writeHead(error instanceof SsoError ? error.status : 503).end('{}'); }
        return;
      }
      if (!['/api/auth/get-session', '/api/account/admin-check'].includes(request.url || '') || request.method !== 'GET') {
        response.writeHead(404).end('{}'); return;
      }
      const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('test-session='));
      const id = cookie === 'test-session=admin' ? 'ui-admin' : cookie === 'test-session=member' ? 'ui-member' : null;
      if (!id) { response.writeHead(401).end('null'); return; }
      if (request.url === '/api/account/admin-check') {
        try {
          const result = await database!.query('SELECT role FROM public."user" WHERE id=$1', [id]);
          if (result.rows[0]?.role !== 'admin') { response.writeHead(403).end('{}'); return; }
          response.end(JSON.stringify({ status: 'ok' }));
        } catch { response.writeHead(503).end('{}'); }
        return;
      }
      // Both claim admin upstream: only the actual public.user role may authorize access.
      response.end(JSON.stringify({ user: { id, name: ADMIN_NAME, role: 'admin' },
        session: { id: `session-${id}`, userId: id, expiresAt: new Date(Date.now() + 3600_000).toISOString() } }));
    });
    await new Promise<void>((done, reject) => {
      platform!.once('error', reject);
      platform!.listen(0, uiSso ? undefined : '127.0.0.1', () => { platform!.removeListener('error', reject); done(); });
    });
    const address = platform.address();
    if (!address || typeof address === 'string') throw new Error('Platform fixture failed to bind.');
    const secrets = [databaseUrl, source.connectionString, env.PGPASSWORD, url.password,
      UI_SECRET, UI_TOKEN, schemaToken].filter((value): value is string => !!value);
    const redact = (chunk: Buffer) => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), chunk.toString());
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '3109'], {
      cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: databaseUrl, PLATFORM_DATABASE_URL: '',
        PLATFORM_AUTH_MODE: uiSso ? 'sso' : 'api', BPEBOT_SSO_CLIENT_SECRET: uiSsoSecret,
        PLATFORM_URL: `http://${uiSso ? 'localhost' : '127.0.0.1'}:${address.port}`, APP_URL,
        DB_SCHEMA_MODE: 'auto', DB_SCHEMA_TOKEN: schemaToken, QQ_APP_ID: UI_APP_ID,
        QQ_CLIENT_SECRET: UI_SECRET, NEXT_TELEMETRY_DISABLED: '1' },
    });
    child.stdout!.on('data', chunk => process.stdout.write(redact(chunk)));
    child.stderr!.on('data', chunk => process.stderr.write(redact(chunk)));
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (spawnFailed || child.exitCode !== null) throw new Error('Isolated Next server exited before readiness.');
      try {
        const result = await fetch(`${APP_URL}/login`, { signal: AbortSignal.timeout(2000) });
        if (result.ok) {
          console.log('[ui harness] Isolated database and trusted platform fixture ready.');
          return cleanup;
        }
      } catch { /* Next may still be compiling its first route. */ }
      await new Promise(done => setTimeout(done, 300));
    }
    throw new Error('Isolated Next server did not become ready within 120 seconds.');
  } catch {
    await cleanup();
    // Do not print pg exceptions: they can contain credentials or connection URLs.
    throw new Error('UI harness setup failed. Check local PostgreSQL availability, CREATEDB permission, and port 3109.');
  }
}
