import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, createAuth, assertSameOrigin, validSchemaToken, platformBaseUrl, platformLoginUrl } from '../lib/auth';

const env = { ...process.env, PLATFORM_DATABASE_URL: '', PLATFORM_URL: 'https://platform.example', APP_URL: 'https://bot.example' };
const session = { user: { id: 'u1', name: 'Admin', role: 'admin' }, session: { id: 's1', userId: 'u1', expiresAt: '2030-01-01T00:00:00Z' } };
const cookie = new Headers({ cookie: 'breezever.session_token=opaque' });
const fetchSession = (value: unknown = session) => (async () => Response.json(value)) as typeof fetch;

test('platform login uses the existing hash route instead of a nonexistent account path', () => {
  assert.equal(platformLoginUrl(env), 'https://platform.example/#/account');
});

test('without platform database, checks the live admin API using the same session cookie every time', async () => {
  let role = 'admin';
  const paths: string[] = [];
  const auth = createAuth({ env: { ...env, DATABASE_URL: 'postgresql://bot-only.invalid/bot' }, fetch: (async (url, options) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('cookie'), cookie.get('cookie'));
    assert.equal(new Headers(options?.headers).get('authorization'), null);
    if (path === '/api/auth/get-session') return Response.json(session);
    assert.equal(path, '/api/account/admin-check');
    return role === 'admin' ? Response.json({ status: 'ok' }) : Response.json({ error: 'denied' }, { status: 403 });
  }) as typeof fetch });
  assert.equal((await auth.requireAdmin(cookie)).user.id, 'u1');
  role = 'user';
  await assert.rejects(auth.requireAdmin(cookie), (e: AuthError) => e.status === 403);
  assert.deepEqual(paths, ['/api/auth/get-session', '/api/account/admin-check', '/api/auth/get-session', '/api/account/admin-check']);
  await assert.rejects(auth.isPlatformAdmin('u1'), (e: AuthError) => e.status === 503);
});

test('admin API fails closed for expired, unavailable, redirected, malformed, and oversized responses', async () => {
  const cases: [() => Response, number][] = [
    [() => Response.json({}, { status: 401 }), 401],
    [() => Response.json({}, { status: 403 }), 403],
    [() => Response.json({}, { status: 404 }), 503],
    [() => Response.json({}, { status: 503 }), 503],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), 503],
    [() => Response.json({}), 503],
    [() => Response.json(null), 503],
    [() => Response.json({ status: 'denied' }), 503],
    [() => new Response('<html>login</html>'), 503],
    [() => new Response('x'.repeat(65537)), 503],
  ];
  for (const [response, expected] of cases) {
    const auth = createAuth({ env, fetch: (async (url) => new URL(String(url)).pathname === '/api/auth/get-session' ? Response.json(session) : response()) as typeof fetch });
    await assert.rejects(auth.requireAdmin(cookie), (e: AuthError) => e.status === expected);
  }
});

test('forwards cookie only, disables session caching, and queries authoritative user role', async () => {
  let checked = false;
  const auth = createAuth({ env, fetch: (async (url, options) => {
    assert.equal(String(url), 'https://platform.example/api/auth/get-session');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('cookie'), cookie.get('cookie'));
    assert.equal(new Headers(options?.headers).get('authorization'), null);
    return Response.json(session);
  }) as typeof fetch, database: async () => ({ query: async (sql, values) => {
    assert.equal(sql, 'SELECT role FROM public."user" WHERE id=$1');
    assert.deepEqual(values, ['u1']); checked = true; return { rows: [{ role: 'admin' }] };
  } }) });
  assert.equal((await auth.requireAdmin(cookie)).user.role, 'admin');
  assert.equal(checked, true);
});

test('revoked role fails despite stale admin session; no auth memoization', async () => {
  let role = 'admin';
  const auth = createAuth({ env, fetch: fetchSession(), database: async () => ({ query: async () => ({ rows: [{ role }] }) }) });
  await auth.requireAdmin(cookie); role = 'user';
  await assert.rejects(auth.requireAdmin(cookie), (e: AuthError) => e.status === 403);
});

test('live admin role wins over stale non-admin session role', async () => {
  const auth = createAuth({ env, fetch: fetchSession({ ...session, user: { ...session.user, role: 'user' } }), database: async () => ({ query: async () => ({ rows: [{ role: 'admin' }] }) }) });
  assert.equal((await auth.requireAdmin(cookie)).user.role, 'admin');
});

test('missing, expired, malformed, and mismatched sessions fail closed', async () => {
  let calls = 0;
  const database = async () => ({ query: async () => { calls++; return { rows: [{ role: 'admin' }] }; } });
  const missing = createAuth({ env, fetch: fetchSession(), database });
  await assert.rejects(missing.requireAdmin(new Headers()), (e: AuthError) => e.status === 401);
  for (const value of [null, {}, { ...session, session: { ...session.session, expiresAt: 'invalid' } },
    { ...session, session: { ...session.session, expiresAt: '2000-01-01' } },
    { ...session, session: { ...session.session, userId: 'someone-else' } }]) {
    await assert.rejects(createAuth({ env, fetch: fetchSession(value), database }).requireAdmin(cookie), (e: AuthError) => e.status === 401);
  }
  assert.equal(calls, 0);
});

test('upstream/role database errors are unavailable without leaking secrets', async () => {
  const fetchFailure = createAuth({ env, fetch: (async () => { throw new Error('postgresql://secret'); }) as typeof fetch });
  const roleFailure = createAuth({ env, fetch: fetchSession(), database: async () => { throw new Error('password=secret'); } });
  for (const auth of [fetchFailure, roleFailure]) {
    await assert.rejects(auth.requireAdmin(cookie), (e: AuthError) => e.status === 503 && !e.message.includes('secret'));
  }
});

test('same origin required, forwarded host cannot grant access', () => {
  const request = (headers: Record<string, string>) => new Request('https://bot.example/api/admin/commands', { method: 'POST', headers });
  assert.doesNotThrow(() => assertSameOrigin(request({ origin: 'https://bot.example', 'sec-fetch-site': 'same-origin' }), env));
  const invalidHeaders: Record<string, string>[] = [{}, { origin: 'null' }, { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' },
    { origin: 'https://bot.example', 'sec-fetch-site': 'cross-site' }, { origin: 'https://bot.example.evil' }];
  for (const headers of invalidHeaders) {
    assert.throws(() => assertSameOrigin(request(headers), env), (e: AuthError) => e.status === 403);
  }
});

test('schema tokens reject absent, wrong-length, empty configuration and oversized inputs', () => {
  assert.equal(validSchemaToken('strong-token', 'strong-token'), true);
  for (const token of [null, '', 'wrong', 'strong-token ', 'x'.repeat(4097)]) assert.equal(validSchemaToken(token, 'strong-token'), false);
  assert.equal(validSchemaToken('anything', ''), false);
});

test('platform configuration refuses credential-bearing URLs and remote plaintext HTTP', () => {
  for (const url of ['https://user:secret@platform.example', 'http://platform.example', 'https://platform.example/redirect', 'ftp://platform.example']) {
    assert.throws(() => platformBaseUrl({ ...env, PLATFORM_URL: url }));
  }
  assert.equal(platformBaseUrl({ ...env, PLATFORM_URL: 'http://127.0.0.1:3000' }).origin, 'http://127.0.0.1:3000');
});
