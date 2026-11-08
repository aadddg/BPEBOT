import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { parse } from 'dotenv';
import { createSsoService, ssoSchema, SsoError } from '../platform-integration/sso-core';

test('SSO authorization lifecycle against isolated real PostgreSQL', { skip: process.env.BPEBOT_SSO_INTEGRATION !== '1' }, async (t) => {
  const file = parse(await readFile(new URL('../../.env', import.meta.url), 'utf8').catch(() => ''));
  const env = { ...file, ...process.env };
  const source = { host: env.PGHOST || '127.0.0.1', port: Number(env.PGPORT || 55432), user: env.PGUSER || 'radioweb2', password: env.PGPASSWORD, connectionTimeoutMillis: 5000 };
  assert.ok(['127.0.0.1', 'localhost'].includes(source.host), 'Integration tests require local PostgreSQL');
  const name = 'bpebot_sso_' + randomBytes(8).toString('hex');
  const maintenance = new Client({ ...source, database: 'postgres' });
  let db: Pool | undefined;
  let created = false;
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`); created = true;
    db = new Pool({ ...source, database: name, max: 5 });
    await db.query('CREATE TABLE public."user" (id text PRIMARY KEY,name text,role text); CREATE TABLE public."session" (id text PRIMARY KEY,"userId" text REFERENCES public."user"(id),"expiresAt" timestamptz)');
    await db.query("INSERT INTO public.\"user\" VALUES ('admin','Administrator','admin'),('member','Member','user')");
    await db.query("INSERT INTO public.\"session\" VALUES ('session-admin','admin',now()+interval '1 hour'),('session-member','member',now()+interval '1 hour')");
    await db.query(ssoSchema);
    const config = { secret: 'integration-test-secret-'.repeat(3), redirectUri: 'https://bot.example/api/sso/callback' };
    const service = createSsoService(db, config);
    const verifier = randomBytes(32).toString('base64url');
    const input = { client_id: 'bpebot', response_type: 'code', redirect_uri: config.redirectUri, state: randomBytes(32).toString('base64url'), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
    const issue = async () => new URL(await service.issue(input, { userId: 'admin', sessionId: 'session-admin' })).searchParams.get('code')!;
    const grant = (code: string) => ({ client_id: 'bpebot', grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri });
    const failure = (status: number) => (error: SsoError) => error.status === status;
    await t.test('strict redirect allowlist and PKCE method', () => {
      for (const change of [{ redirect_uri: 'https://evil.example/api/sso/callback' }, { code_challenge_method: 'plain' }, { state: ['invalid'] }, { client_id: 'another-client' }]) assert.throws(() => service.authorization({ ...input, ...change }), failure(400));
    });
    await t.test('non-admin and mismatched sessions cannot issue codes', async () => {
      await assert.rejects(service.issue(input, { userId: 'member', sessionId: 'session-member' }), failure(403));
      await assert.rejects(service.issue(input, { userId: 'admin', sessionId: 'session-member' }), failure(403));
    });
    await t.test('client authentication and PKCE are mandatory, failed attempts do not consume code', async () => {
      const code = await issue();
      await assert.rejects(service.exchange(grant(code), 'wrong-secret'), failure(401));
      await assert.rejects(service.exchange({ ...grant(code), code_verifier: randomBytes(32).toString('base64url') }, config.secret), failure(400));
      await assert.rejects(service.exchange({ ...grant(code), redirect_uri: 'https://evil.example' }, config.secret), failure(400));
      const token = await service.exchange(grant(code), config.secret);
      assert.equal((await service.introspect(token.access_token, config.secret)).user.id, 'admin');
      await assert.rejects(service.exchange(grant(code), config.secret), failure(400));
    });
    await t.test('concurrent exchanges accept a code exactly once across connections', async () => {
      const code = await issue();
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.exchange(grant(code), config.secret)));
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(results.filter(value => value.status === 'rejected').length, 4);
    });
    await t.test('expired authorization code cannot be exchanged', async () => {
      const code = await issue();
      await db!.query("UPDATE public.bpebot_sso_grants SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [createHash('sha256').update(code).digest('hex')]);
      await assert.rejects(service.exchange(grant(code), config.secret), failure(400));
    });
    await t.test('revoked role is enforced by token introspection and exchange', async () => {
      const code = await issue(); const pending = await issue(); const token = await service.exchange(grant(code), config.secret);
      await db!.query("UPDATE public.\"user\" SET role='user' WHERE id='admin'");
      await assert.rejects(service.introspect(token.access_token, config.secret), failure(403));
      await assert.rejects(service.exchange(grant(pending), config.secret), failure(400));
      await db!.query("UPDATE public.\"user\" SET role='admin' WHERE id='admin'");
    });
    await t.test('logout revokes a token and cannot be bypassed with a platform cookie', async () => {
      const token = await service.exchange(grant(await issue()), config.secret);
      await assert.rejects(service.introspect(token.access_token, ''), failure(401));
      await service.revoke(token.access_token, config.secret);
      await assert.rejects(service.introspect(token.access_token, config.secret), failure(401));
    });
    await t.test('expired token, expired parent session and deleted parent session are rejected', async () => {
      const token = await service.exchange(grant(await issue()), config.secret);
      await db!.query("UPDATE public.bpebot_sso_grants SET token_expires_at=now()-interval '1 second'");
      await assert.rejects(service.introspect(token.access_token, config.secret), failure(401));
      const next = await service.exchange(grant(await issue()), config.secret);
      await db!.query("UPDATE public.\"session\" SET \"expiresAt\"=now()-interval '1 second' WHERE id='session-admin'");
      await assert.rejects(service.introspect(next.access_token, config.secret), failure(401));
      await db!.query("DELETE FROM public.\"session\" WHERE id='session-admin'");
      await assert.rejects(service.introspect(next.access_token, config.secret), failure(401));
    });
    await t.test('database never stores raw codes or access tokens', async () => {
      const rows = (await db!.query('SELECT code_hash,token_hash FROM public.bpebot_sso_grants')).rows;
      for (const row of rows) { assert.match(row.code_hash, /^[a-f0-9]{64}$/); if (row.token_hash) assert.match(row.token_hash, /^[a-f0-9]{64}$/); }
    });
  } finally {
    await db?.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenance.end();
  }
});
