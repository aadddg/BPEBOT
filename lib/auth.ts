import { createHash, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { createSso, SsoFailure } from './sso';

export class AuthError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'AUTH_REQUIRED') {
    super(message); this.name = 'AuthError';
  }
}

export type AdminSession = {
  user: { id: string; name: string; role: 'admin' };
  session: { id: string; expiresAt: string };
};
export type RoleDatabase = { query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
type AuthDependencies = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  database?: () => Promise<RoleDatabase>;
  now?: () => number;
};

let platformPool: Pool | undefined;
/** Deliberately separate from bot schema initialization: the platform owns this table. */
async function platformDatabase(): Promise<RoleDatabase> {
  const connectionString = process.env.PLATFORM_DATABASE_URL;
  if (!connectionString) throw new AuthError(503, 'Platform role database unavailable.', 'AUTH_UNAVAILABLE');
  if (!platformPool) {
    platformPool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
    platformPool.on('error', () => {});
  }
  return platformPool;
}

export function platformBaseUrl(env: NodeJS.ProcessEnv = process.env): URL {
  try {
    if (!env.PLATFORM_URL) throw new Error();
    const url = new URL(env.PLATFORM_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    return url;
  } catch { throw new AuthError(503, 'Platform URL is not configured correctly.', 'AUTH_UNAVAILABLE'); }
}

export function platformLoginUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLATFORM_AUTH_MODE === 'sso') return '/api/sso/start';
  return new URL('/#/account', platformBaseUrl(env)).href;
}

export function createAuth(dependencies: AuthDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const database = dependencies.database ?? platformDatabase;
  const now = dependencies.now ?? Date.now;
  const useDatabase = !!dependencies.database || !!env.PLATFORM_DATABASE_URL?.trim();
  async function isPlatformAdmin(userId: string): Promise<boolean> {
    if (!userId || userId.length > 256) return false;
    // A user-id-only QQ lookup cannot impersonate a browser session at admin-check.
    if (!useDatabase) throw new AuthError(503, 'Platform user role lookup requires a configured adapter.', 'AUTH_UNAVAILABLE');
    try {
      const result = await (await database()).query('SELECT role FROM public."user" WHERE id=$1', [userId]);
      return result.rows.length === 1 && result.rows[0].role === 'admin';
    } catch { throw new AuthError(503, 'Platform role verification unavailable.', 'AUTH_UNAVAILABLE'); }
  }
  async function requireAdmin(request: Request | Headers): Promise<AdminSession> {
    const headers = request instanceof Headers ? request : request.headers;
    if (env.PLATFORM_AUTH_MODE === 'sso') {
      try {
        const value = await createSso({ env, fetch: fetcher, now }).session(headers);
        const user = value.user as Record<string, unknown> | undefined;
        const session = value.session as Record<string, unknown> | undefined;
        if (!user || user.role !== 'admin' || typeof user.id !== 'string' || !user.id || user.id.length > 256 ||
          !session || typeof session.id !== 'string' || !session.id || session.userId !== user.id ||
          typeof session.expiresAt !== 'string' || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now()) {
          throw new AuthError(401, 'Invalid or expired platform session.');
        }
        return { user: { id: user.id, name: typeof user.name === 'string' ? user.name : '', role: 'admin' },
          session: { id: session.id, expiresAt: session.expiresAt } };
      } catch (error) {
        if (error instanceof AuthError) throw error;
        if (error instanceof SsoFailure && error.status === 401) throw new AuthError(401, 'Sign in through the platform.');
        if (error instanceof SsoFailure && error.status === 403) throw new AuthError(403, 'Platform administrator access required.', 'FORBIDDEN');
        throw new AuthError(503, 'Platform SSO unavailable.', 'AUTH_UNAVAILABLE');
      }
    }
    const cookie = headers.get('cookie');
    if (!cookie) throw new AuthError(401, 'Sign in through the platform.');
    if (Buffer.byteLength(cookie) > 16384) throw new AuthError(401, 'Invalid platform session.');
    let value: unknown;
    try {
      value = await platformJson('/api/auth/get-session', cookie);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'Platform session verification unavailable.', 'AUTH_UNAVAILABLE');
    }
    if (!value || typeof value !== 'object') throw new AuthError(401, 'Sign in through the platform.');
    const { user, session } = value as { user?: Record<string, unknown>; session?: Record<string, unknown> };
    if (!user || !session || typeof user.id !== 'string' || !user.id || user.id.length > 256 ||
        typeof session.id !== 'string' || !session.id || typeof session.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now() ||
        (session.userId !== undefined && session.userId !== user.id)) {
      throw new AuthError(401, 'Invalid or expired platform session.');
    }
    // Never trust user.role from a session, even when its cookie is valid.
    if (useDatabase) {
      if (!await isPlatformAdmin(user.id)) throw new AuthError(403, 'Platform administrator access required.', 'FORBIDDEN');
    } else {
      const check = await platformJson('/api/account/admin-check', cookie, true);
      if (!check || typeof check !== 'object' || (check as { status?: unknown }).status !== 'ok') {
        throw new AuthError(503, 'Platform role verification unavailable.', 'AUTH_UNAVAILABLE');
      }
    }
    return { user: { id: user.id, name: typeof user.name === 'string' ? user.name : '', role: 'admin' },
      session: { id: session.id, expiresAt: session.expiresAt } };
  }
  async function platformJson(path: string, cookie: string, adminCheck = false): Promise<unknown> {
    try {
      const response = await fetcher(new URL(path, platformBaseUrl(env)), {
        method: 'GET', headers: { cookie, accept: 'application/json', 'cache-control': 'no-cache' },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (response.status === 403 && adminCheck) throw new AuthError(403, 'Platform administrator access required.', 'FORBIDDEN');
      if (response.status === 401 || response.status === 403) throw new AuthError(401, 'Sign in through the platform.');
      if (!response.ok) throw new Error();
      if (!response.body) throw new Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) { await reader.cancel().catch(() => {}); throw new Error(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, 'Platform identity verification unavailable.', 'AUTH_UNAVAILABLE');
    }
  }
  return { requireAdmin, isPlatformAdmin };
}

export const { requireAdmin, isPlatformAdmin } = createAuth();

/** Hash first so timingSafeEqual always compares equal-sized buffers. Empty config fails closed. */
export function validSchemaToken(candidate: string | null, expected = process.env.DB_SCHEMA_TOKEN): boolean {
  if (!expected?.trim() || !candidate || candidate.length > 4096) return false;
  return timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(expected).digest());
}

/** Compare to configured application origin, never to attacker-controlled forwarded headers. */
export function assertSameOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!env.APP_URL) throw new Error();
    const app = new URL(env.APP_URL);
    const origin = request.headers.get('origin');
    if (!['https:', 'http:'].includes(app.protocol) || app.username || app.password || !origin || origin !== app.origin) throw new Error();
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') throw new Error();
  } catch { throw new AuthError(403, 'Same-origin request required.', 'CSRF_REJECTED'); }
}
