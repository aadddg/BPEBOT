import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSso, SsoFailure } from '../lib/sso';
import { createAuth, AuthError, platformLoginUrl } from '../lib/auth';

const env = { ...process.env, PLATFORM_AUTH_MODE: 'sso', PLATFORM_URL: 'https://platform.example', APP_URL: 'https://bot.example', BPEBOT_SSO_CLIENT_SECRET: 'sso-test-only-secret-'.repeat(3), PLATFORM_DATABASE_URL: '' };
const token = randomBytes(32).toString('base64url');
const identity = { user: { id: 'admin-1', name: 'SSO Admin', role: 'admin' }, session: { id: 'session-1', userId: 'admin-1', expiresAt: '2030-01-01T00:00:00Z' } };
const cookieFrom = (response: Response, prefix: string) => response.headers.getSetCookie().find(value => value.startsWith(prefix + '='))!.split(';')[0];

async function login(fetcher?: typeof fetch) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const transport = fetcher ?? (async (url, options) => {
    const path = new URL(String(url)).pathname;
    assert.equal(new Headers(options?.headers).get('cookie'), null);
    assert.equal(new Headers(options?.headers).get('x-bpebot-client-secret'), env.BPEBOT_SSO_CLIENT_SECRET);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.cache, 'no-store');
    const body = JSON.parse(String(options?.body)); calls.push({ path, body });
    if (path.endsWith('/token')) return Response.json({ access_token: token, expires_at: identity.session.expiresAt });
    if (path.endsWith('/revoke')) return Response.json({ status: 'ok' });
    return Response.json(identity);
  }) as typeof fetch;
  const sso = createSso({ env, fetch: transport });
  const start = sso.start(); const authorize = new URL(start.headers.get('location')!);
  const transaction = cookieFrom(start, '__Host-bpebot_login');
  const callback = new URL('/api/sso/callback', env.APP_URL);
  callback.searchParams.set('code', randomBytes(32).toString('base64url')); callback.searchParams.set('state', authorize.searchParams.get('state')!);
  const response = await sso.callback(new Request(callback, { headers: { cookie: transaction } }));
  return { sso, start, authorize, transaction, callback, response, calls, transport };
}
test('SSO uses PKCE, host-only encrypted cookies and server-only token exchange', async () => {
  const fixture = await login();
  assert.equal(platformLoginUrl(env), '/api/sso/start');
  assert.equal(fixture.authorize.origin, env.PLATFORM_URL);
  assert.equal(fixture.authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(fixture.authorize.searchParams.get('redirect_uri'), 'https://bot.example/api/sso/callback');
  assert.ok(!fixture.authorize.href.includes(env.BPEBOT_SSO_CLIENT_SECRET));
  assert.equal(fixture.response.headers.get('location'), 'https://bot.example/dashboard');
  const session = cookieFrom(fixture.response, '__Host-bpebot_session');
  assert.ok(!session.includes(token));
  const full = fixture.response.headers.getSetCookie().find(value => value.startsWith('__Host-bpebot_session='))!;
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(full.includes(flag));
  assert.ok(!full.includes('Domain='));
  assert.equal(fixture.calls[0].path, '/api/bot-sso/token');
  assert.equal(typeof fixture.calls[0].body.code_verifier, 'string');
  assert.deepEqual(await fixture.sso.session(new Headers({ cookie: session })), identity);
  const auth = createAuth({ env, fetch: fixture.transport });
  assert.equal((await auth.requireAdmin(new Headers({ cookie: session }))).user.id, 'admin-1');
});
test('SSO rejects missing, changed, duplicate, expired state and tampered login cookies before exchange', async () => {
  let calls = 0; let now = Date.now();
  const sso = createSso({ env, now: () => now, fetch: (async () => { calls++; throw new Error('must not exchange'); }) as typeof fetch });
  const start = sso.start(); const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const transaction = cookieFrom(start, '__Host-bpebot_login');
  const base = 'https://bot.example/api/sso/callback?code=' + 'a'.repeat(43) + '&state=';
  for (const [stateValue, cookie] of [[state, ''], ['b'.repeat(43), transaction], [state + '&state=' + state, transaction], [state, transaction + 'x']]) {
    const result = await sso.callback(new Request(base + stateValue, { headers: { cookie } }));
    assert.ok(result.headers.get('location')!.includes('/login?reason=unavailable'));
    assert.ok(result.headers.getSetCookie()[0].includes('Max-Age=0'));
  }
  now += 300001;
  await sso.callback(new Request(base + state, { headers: { cookie: transaction } }));
  assert.equal(calls, 0);
});
test('SSO requires live upstream identity, honors revocation and never falls back to platform cookies', async () => {
  const fixture = await login(); const session = cookieFrom(fixture.response, '__Host-bpebot_session');
  for (const status of [401, 403, 503]) {
    const auth = createAuth({ env, fetch: (async () => Response.json({}, { status })) as typeof fetch });
    await assert.rejects(auth.requireAdmin(new Headers({ cookie: session })), (error: AuthError) => error.status === status);
  }
  const auth = createAuth({ env, fetch: fixture.transport });
  await assert.rejects(auth.requireAdmin(new Headers({ cookie: 'breezever.session_token=platform-cookie' })), (error: AuthError) => error.status === 401);
  await assert.rejects(auth.requireAdmin(new Headers({ cookie: session + 'x' })), (error: AuthError) => error.status === 401);
  const badIdentity = createAuth({ env, fetch: (async () => Response.json({ ...identity, user: { ...identity.user, role: 'user' } })) as typeof fetch });
  await assert.rejects(badIdentity.requireAdmin(new Headers({ cookie: session })), (error: AuthError) => error.status === 401);
});
test('logout is same-origin POST, revokes upstream token before clearing the cookie', async () => {
  const fixture = await login(); const session = cookieFrom(fixture.response, '__Host-bpebot_session');
  const endpoint = 'https://bot.example/api/sso/logout';
  assert.equal((await fixture.sso.logout(new Request(endpoint, { method: 'POST', headers: { cookie: session, origin: 'https://evil.example' } }))).status, 403);
  const result = await fixture.sso.logout(new Request(endpoint, { method: 'POST', headers: { cookie: session, origin: env.APP_URL } }));
  assert.equal(result.status, 303);
  assert.equal(fixture.calls.at(-1)?.path, '/api/bot-sso/revoke');
  assert.equal(fixture.calls.at(-1)?.body.token, token);
  assert.ok(result.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
});
test('SSO refuses unsafe configuration and invalid or oversized upstream payloads', async () => {
  for (const settings of [{ ...env, BPEBOT_SSO_CLIENT_SECRET: '' }, { ...env, PLATFORM_URL: 'http://remote.example' }, { ...env, APP_URL: 'https://bot.example/unsafe' }]) {
    assert.throws(() => createSso({ env: settings }).start());
  }
  for (const response of [() => Response.json({}), () => new Response('x'.repeat(17000)), () => new Response('<html>')]) {
    const fixture = await login((async () => response()) as typeof fetch);
    assert.ok(fixture.response.headers.get('location')!.includes('/login?reason=unavailable'));
  }
  const fixture = await login(); const session = cookieFrom(fixture.response, '__Host-bpebot_session');
  await assert.rejects(createSso({ env, now: () => Date.parse('2031-01-01') }).session(new Headers({ cookie: session })), (error: SsoFailure) => error.status === 401);
});
