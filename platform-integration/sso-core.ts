import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type SsoDatabase = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export class SsoError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export const ssoSchema = `
CREATE TABLE IF NOT EXISTS public.bpebot_sso_grants (
  code_hash text PRIMARY KEY,
  session_id text NOT NULL REFERENCES public."session"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  token_hash text UNIQUE,
  token_expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS bpebot_sso_expiry_idx ON public.bpebot_sso_grants (created_at);
`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const challengeFor = (value: string) => createHash('sha256').update(value).digest('base64url');
export function createSsoService(db: SsoDatabase, config: { secret: string; redirectUri: string }) {
  if (config.secret.length < 32) throw new Error('SSO secret must contain at least 32 characters');
  const callback = new URL(config.redirectUri);
  if ((callback.protocol !== 'https:' && !(callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname))) || callback.username || callback.password || callback.hash || callback.search || callback.pathname !== '/api/sso/callback') throw new Error('Invalid SSO redirect URI');
  function client(secret: unknown) {
    if (typeof secret !== 'string' || secret.length > 4096 || !timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(hash(config.secret)))) throw new SsoError(401, 'invalid_client');
  }
  function authorization(input: Record<string, unknown>) {
    if (input.client_id !== 'bpebot' || input.redirect_uri !== config.redirectUri || input.response_type !== 'code' || input.code_challenge_method !== 'S256' || typeof input.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge) || typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(input.state)) throw new SsoError(400, 'invalid_request');
    return { challenge: input.code_challenge, state: input.state };
  }
  async function issue(input: Record<string, unknown>, account: { userId: string; sessionId: string }) {
    const { challenge, state } = authorization(input);
    const code = randomBytes(32).toString('base64url');
    await db.query(`DELETE FROM public.bpebot_sso_grants WHERE COALESCE(token_expires_at,expires_at) < now() - interval '1 day'`);
    const result = await db.query(`INSERT INTO public.bpebot_sso_grants (code_hash,session_id,user_id,challenge,redirect_uri)
      SELECT $1,s.id,u.id,$4,$5 FROM public."session" s JOIN public."user" u ON u.id=s."userId"
      WHERE s.id=$2 AND u.id=$3 AND s."expiresAt">now() AND u.role='admin'
      AND (SELECT count(*) FROM public.bpebot_sso_grants WHERE session_id=$2 AND created_at>now()-interval '1 minute') < 20
      RETURNING code_hash`, [hash(code), account.sessionId, account.userId, challenge, config.redirectUri]);
    if (!result.rows.length) throw new SsoError(403, 'authorization_denied');
    const redirect = new URL(config.redirectUri);
    redirect.searchParams.set('code', code); redirect.searchParams.set('state', state);
    return redirect.href;
  }
  async function exchange(input: Record<string, unknown>, secret: unknown) {
    client(secret);
    if (input.client_id !== 'bpebot' || input.grant_type !== 'authorization_code' || input.redirect_uri !== config.redirectUri || typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.code) || typeof input.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw new SsoError(400, 'invalid_grant');
    const token = randomBytes(32).toString('base64url');
    const result = await db.query(`UPDATE public.bpebot_sso_grants g SET consumed_at=now(),token_hash=$4,
      token_expires_at=LEAST(s."expiresAt",now()+interval '8 hours')
      FROM public."session" s JOIN public."user" u ON u.id=s."userId"
      WHERE g.code_hash=$1 AND g.challenge=$2 AND g.redirect_uri=$3 AND g.consumed_at IS NULL AND g.expires_at>now()
      AND g.session_id=s.id AND g.user_id=u.id AND s."expiresAt">now() AND u.role='admin'
      RETURNING g.token_expires_at`, [hash(input.code), challengeFor(input.code_verifier), config.redirectUri, hash(token)]);
    if (!result.rows.length) throw new SsoError(400, 'invalid_grant');
    return { access_token: token, token_type: 'Bearer', expires_at: new Date(result.rows[0].token_expires_at as string).toISOString() };
  }
  async function introspect(token: unknown, secret: unknown) {
    client(secret);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SsoError(401, 'invalid_token');
    const result = await db.query(`SELECT u.id,u.name,u.role,s.id AS session_id,g.token_expires_at
      FROM public.bpebot_sso_grants g JOIN public."session" s ON s.id=g.session_id
      JOIN public."user" u ON u.id=g.user_id AND u.id=s."userId"
      WHERE g.token_hash=$1 AND g.revoked_at IS NULL AND g.token_expires_at>now() AND s."expiresAt">now()`, [hash(token)]);
    const row = result.rows[0];
    if (!row) throw new SsoError(401, 'invalid_token');
    if (row.role !== 'admin') throw new SsoError(403, 'authorization_denied');
    return { user: { id: row.id, name: row.name, role: 'admin' }, session: { id: row.session_id, userId: row.id, expiresAt: new Date(row.token_expires_at as string).toISOString() } };
  }
  async function revoke(token: unknown, secret: unknown) {
    client(secret);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SsoError(400, 'invalid_token');
    await db.query('UPDATE public.bpebot_sso_grants SET revoked_at=now() WHERE token_hash=$1', [hash(token)]);
  }
  return { authorization, issue, exchange, introspect, revoke };
}
