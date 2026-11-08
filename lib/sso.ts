import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

type SsoEnv = NodeJS.ProcessEnv;
type Dependencies = { env?: SsoEnv; fetch?: typeof fetch; now?: () => number };
const transactionCookie = '__Host-bpebot_login';
export const sessionCookie = '__Host-bpebot_session';
export class SsoFailure extends Error { constructor(public status: number) { super('Platform SSO unavailable'); } }
function configuration(env: SsoEnv) {
  const app = new URL(env.APP_URL || ''); const platform = new URL(env.PLATFORM_URL || '');
  for (const url of [app, platform]) {
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new SsoFailure(503);
  }
  const secret = env.BPEBOT_SSO_CLIENT_SECRET;
  if (!secret || secret.length < 32) throw new SsoFailure(503);
  return { app, platform, secret };
}
function seal(value: unknown, purpose: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('bpebot:' + purpose + ':' + secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function open(value: string, purpose: string, secret: string): Record<string, unknown> {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new SsoFailure(401);
  try {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('bpebot:' + purpose + ':' + secret).digest(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { throw new SsoFailure(401); }
}
function cookieValue(headers: Headers, name: string) {
  return headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
}
function cookie(name: string, value: string, age: number) {
  // The __Host- prefix requires Secure, even in local development (use localhost HTTPS).
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, age)}`;
}
export function createSso(dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env; const fetcher = dependencies.fetch ?? fetch; const now = dependencies.now ?? Date.now;
  async function post(path: string, body: unknown) {
    const config = configuration(env);
    try {
      const response = await fetcher(new URL('/api/bot-sso/' + path, config.platform), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bpebot-client-secret': config.secret },
        body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401 || response.status === 403) throw new SsoFailure(response.status);
      if (!response.ok || !response.body) throw new SsoFailure(503);
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 16384) { await reader.cancel(); throw new SsoFailure(503); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch (error) { if (error instanceof SsoFailure) throw error; throw new SsoFailure(503); }
  }
  function redirect(location: string, cookies: string[] = []) {
    const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    for (const value of cookies) headers.append('set-cookie', value);
    return new Response(null, { status: 303, headers });
  }
  function start() {
    const { app, platform, secret } = configuration(env);
    const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
    const target = new URL('/api/bot-sso/authorize', platform);
    const params = { client_id: 'bpebot', response_type: 'code', redirect_uri: new URL('/api/sso/callback', app).href,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state };
    target.search = new URLSearchParams(params).toString();
    return redirect(target.href, [cookie(transactionCookie, seal({ state, verifier, expires: now() + 300000 }, 'login', secret), 300)]);
  }
  async function callback(request: Request) {
    const { app, secret } = configuration(env);
    const clear = cookie(transactionCookie, '', 0);
    try {
      const url = new URL(request.url); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
      const encrypted = cookieValue(request.headers, transactionCookie);
      if (!encrypted || !code || !/^[A-Za-z0-9_-]{43}$/.test(code) || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) throw new SsoFailure(401);
      const transaction = open(encrypted, 'login', secret);
      if (typeof transaction.state !== 'string' || typeof transaction.verifier !== 'string' || typeof transaction.expires !== 'number' || transaction.expires <= now() || !timingSafeEqual(createHash('sha256').update(state).digest(), createHash('sha256').update(transaction.state).digest())) throw new SsoFailure(401);
      const token = await post('token', { client_id: 'bpebot', grant_type: 'authorization_code', code, code_verifier: transaction.verifier, redirect_uri: new URL('/api/sso/callback', app).href });
      if (typeof token.access_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token.access_token) || typeof token.expires_at !== 'string' || !Number.isFinite(Date.parse(token.expires_at)) || Date.parse(token.expires_at) <= now()) throw new SsoFailure(503);
      const expires = Math.min(Date.parse(token.expires_at), now() + 28800000);
      return redirect(new URL('/dashboard', app).href, [clear, cookie(sessionCookie, seal({ token: token.access_token, expires }, 'session', secret), Math.floor((expires - now()) / 1000))]);
    } catch { return redirect(new URL('/login?reason=unavailable', app).href, [clear]); }
  }
  async function session(headers: Headers) {
    if ((headers.get('cookie')?.length ?? 0) > 16384) throw new SsoFailure(401);
    const { secret } = configuration(env); const encrypted = cookieValue(headers, sessionCookie);
    if (!encrypted) throw new SsoFailure(401);
    const value = open(encrypted, 'session', secret);
    if (typeof value.token !== 'string' || typeof value.expires !== 'number' || value.expires <= now()) throw new SsoFailure(401);
    return post('introspect', { token: value.token });
  }
  async function logout(request: Request) {
    const { app, secret } = configuration(env);
    if (request.headers.get('origin') !== app.origin || request.headers.get('sec-fetch-site') === 'cross-site') return new Response(null, { status: 403 });
    const encrypted = cookieValue(request.headers, sessionCookie);
    if (encrypted) {
      let value: Record<string, unknown> | undefined;
      try { value = open(encrypted, 'session', secret); } catch { /* Clear an invalid cookie. */ }
      if (value?.token) { try { await post('revoke', { token: value.token }); } catch { return Response.json({ error: 'Sign-out unavailable. Retry to revoke the session.' }, { status: 503 }); } }
    }
    return redirect(new URL('/login', app).href, [cookie(sessionCookie, '', 0), cookie(transactionCookie, '', 0)]);
  }
  return { start, callback, session, logout };
}
