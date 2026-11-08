import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, readBody, ADMIN_BODY_LIMIT } from '../lib/api';
import { AuthError } from '../lib/auth';
import { createStore, validatePolicy, type BotStore, type Log } from '../lib/store';
import type { Command } from '../lib/commands';
import type { PassiveReply } from '../lib/qq';

const env = { ...process.env, APP_URL: 'https://bot.example', DB_SCHEMA_TOKEN: 'schema-test-token', QQ_APP_ID: '12345', QQ_CLIENT_SECRET: 'not-a-real-secret', PLATFORM_URL: 'https://platform.example' };
const adminSession = { user: { id: 'u1', name: 'Admin', role: 'admin' as const }, session: { id: 's1', expiresAt: '2030-01-01' } };
const command: Command = { id: '00000000-0000-4000-8000-000000000001', keyword: '/help', match_type: 'exact', reply_type: 'text', reply_body: 'Hello', priority: 0, enabled: true, min_role: 'any', builtin: false, builtin_key: null };
function fixture(commands: Command[] = [command]) {
  const claims = new Set<string>(), logs: Omit<Log, 'id' | 'created_at'>[] = [], audits: unknown[] = [];
  let replies = 0, writes = 0;
  const sent: PassiveReply[] = [];
  const store = {
    getState: async () => ({ commands: [], logs: [], policies: [], requests: [], settings: {} }),
    getCommands: async () => commands, getPolicies: async () => [], listLogs: async () => ({ logs: [], total: 0, page: 1, limit: 20 }),
    saveCommand: async (value: unknown) => { writes++; return value; }, savePolicy: async (value: unknown) => { writes++; return value; },
    deleteCommand: async () => { writes++; }, deletePolicy: async () => { writes++; }, clearLogs: async () => { writes++; logs.length = 0; },
    boundPlatformUser: async () => 'bound-user', recordWebhook: async (value: unknown) => { audits.push(value); },
    beginEvent: async (log: Omit<Log, 'id' | 'created_at'>) => { if (claims.has(log.event_id!)) return false; claims.add(log.event_id!); logs.push(log); return true; },
    finishEvent: async (id: string, status: string, reply: string | null, error: string | null) => { const log = logs.find(item => item.event_id === id); if (log) { log.reply_status = status; log.reply_body = reply; log.error = error; } },
  } as unknown as BotStore;
  const api = createApi({ env, store, requireAdmin: async () => adminSession, isPlatformAdmin: async () => false,
    verifySignature: () => true, qq: { sendPassiveReply: async (reply) => { replies++; sent.push(reply); return {}; } } });
  return { api, store, logs, audits, claims, sent, replies: () => replies, writes: () => writes };
}
function adminRequest(path: string, method = 'GET', body?: unknown, origin = 'https://bot.example') {
  return new Request(`https://bot.example/api/admin/${path}`, { method, headers: { origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
function event(content = '/help', id = 'e1', role = 'member', type = 'GROUP_AT_MESSAGE_CREATE') {
  return new Request('https://bot.example/api/webhook', { method: 'POST', body: JSON.stringify({ op: 0, id, t: type, d: { id: 'msg1', group_openid: 'g1', author: { member_openid: 'm1' }, member_role: role, content } }) });
}

test('all admin routes deny unauthenticated callers before store access', async () => {
  const f = fixture();
  const api = createApi({ env, store: f.store, requireAdmin: async () => { throw new AuthError(401, 'Sign in.'); } });
  for (const [path, method] of [['state', 'GET'], ['commands', 'POST'], ['policies', 'POST'], ['logs', 'DELETE'], ['moderation', 'POST']]) {
    assert.equal((await api.admin(adminRequest(path, method))).status, 401);
  }
  assert.equal(f.writes(), 0);
});

test('mutations reject cross-origin and require exact clear confirmation', async () => {
  const f = fixture();
  assert.equal((await f.api.admin(adminRequest('commands', 'POST', command, 'https://evil.example'))).status, 403);
  assert.equal((await f.api.admin(adminRequest('logs', 'DELETE', { confirmation: 'clear' }))).status, 400);
  assert.equal(f.writes(), 0);
  assert.equal((await f.api.admin(adminRequest('logs', 'DELETE', { confirmation: 'confirm clear' }))).status, 200);
  assert.equal(f.writes(), 1);
});

test('command writes expose agreed response contracts', async () => {
  const f = fixture();
  const response = await f.api.admin(adminRequest('commands', 'POST', command));
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { command });
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.equal((await f.api.admin(adminRequest('commands/not-a-uuid', 'DELETE'))).status, 400);
  assert.equal((await f.api.admin(adminRequest('logs?matched_command_id=bad'))).status, 400);
});

test('unsupported approval/moderation never report fake success', async () => {
  const f = fixture();
  for (const path of ['approval', 'moderation', 'policies/sync']) {
    const response = await f.api.admin(adminRequest(path, 'POST', {}));
    assert.equal(response.status, 501); assert.equal((await response.json()).code, 'UNSUPPORTED');
  }
  assert.equal(f.writes(), 0);
});

test('migration uses only timing-safe token auth, never cookie/session or business store', async () => {
  let migrated = 0;
  const api = createApi({ env, requireAdmin: async () => { throw new Error('must not authenticate cookie'); }, migrate: async () => { migrated++; return { ok: true, applied: [1], currentVersion: 1 }; } });
  assert.equal((await api.admin(adminRequest('migrate', 'POST'))).status, 401);
  const request = new Request('https://bot.example/api/admin/migrate', { method: 'POST', headers: { 'x-schema-token': env.DB_SCHEMA_TOKEN } });
  assert.deepEqual(await (await api.admin(request)).json(), { ok: true, applied: [1], currentVersion: 1 });
  assert.equal(migrated, 1);
});

test('stream limits enforced even without content-length', async () => {
  await assert.rejects(readBody(new Request('https://bot.example', { method: 'POST', body: 'x'.repeat(ADMIN_BODY_LIMIT + 1) })), (e: { status: number }) => e.status === 413);
  const f = fixture();
  assert.equal((await f.api.admin(adminRequest('commands', 'POST', { huge: 'x'.repeat(ADMIN_BODY_LIMIT) }))).status, 413);
});

test('webhook verifies signature before parsing and audits rejection', async () => {
  const f = fixture();
  const api = createApi({ env, store: f.store, verifySignature: () => false });
  const response = await api.webhook(new Request('https://bot.example/api/webhook', { method: 'POST', body: 'invalid json' }));
  assert.equal(response.status, 401); assert.equal(f.logs.length, 0); assert.equal(f.audits.length, 1);
});

test('signed handshake returns QQ challenge without dispatching business event', async () => {
  const f = fixture();
  const response = await f.api.webhook(new Request('https://bot.example/api/webhook', { method: 'POST', body: JSON.stringify({ op: 13, d: { plain_token: 'challenge', event_ts: String(Math.floor(Date.now() / 1000)) } }) }));
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.plain_token, 'challenge'); assert.match(result.signature, /^[a-f0-9]{128}$/u);
  assert.equal(f.claims.size, 0);
});

test('unsigned URL validation is supported without allowing unsigned business dispatch', async () => {
  const f = fixture();
  const api = createApi({ env, store: f.store, verifySignature: () => false });
  const challenge = () => new Request('https://bot.example/api/webhook', { method: 'POST', body: JSON.stringify({ op: 13, d: { plain_token: 'bootstrap', event_ts: String(Math.floor(Date.now() / 1000)) } }) });
  const response = await api.webhook(challenge());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).plain_token, 'bootstrap');
  assert.equal((f.audits[0] as { processing_result: string }).processing_result, 'handshake_unsigned');
  assert.equal((await api.webhook(event())).status, 401);
  for (const headers of [{ 'x-signature-ed25519': 'bad' }, { 'x-signature-timestamp': 'bad' }, { 'x-signature-ed25519': 'bad', 'x-signature-timestamp': 'bad' }]) {
    const request = challenge();
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value!);
    assert.equal((await api.webhook(request)).status, 401);
  }
  const invalid = new Request('https://bot.example/api/webhook', { method: 'POST', body: JSON.stringify({ op: 13, d: {} }) });
  assert.equal((await api.webhook(invalid)).status, 400);
  assert.equal(f.replies(), 0);
  assert.equal(f.claims.size, 0);
});

test('passive reply is deduplicated across concurrent delivery and after clearing logs', async () => {
  const f = fixture();
  const responses = await Promise.all([f.api.webhook(event()), f.api.webhook(event())]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.replies(), 1); assert.equal(f.logs[0].reply_status, 'replied');
  await f.api.admin(adminRequest('logs', 'DELETE', { confirmation: 'confirm clear' }));
  await f.api.webhook(event()); assert.equal(f.replies(), 1);
});

test('denied platform command is logged without reply', async () => {
  const f = fixture([{ ...command, min_role: 'platform_admin' }]);
  await f.api.webhook(event()); assert.equal(f.logs[0].reply_status, 'denied'); assert.equal(f.replies(), 0);
});

test('opaque QQ message IDs survive dispatch and fallback deduplication', async () => {
  const f = fixture();
  const message = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'ROBOT1.0_example.message-id', group_openid: 'g1', author: { member_openid: 'm1' }, content: '/help' } };
  const request = () => new Request('https://bot.example/api/webhook', { method: 'POST', body: JSON.stringify(message) });
  assert.equal((await f.api.webhook(request())).status, 200);
  assert.equal((await f.api.webhook(request())).status, 200);
  assert.equal(f.replies(), 1);
  assert.equal(f.logs[0].msg_id, message.d.id);
});

test('reserved moderation namespace cannot be overridden by custom high-priority match', async () => {
  const f = fixture([{ ...command, keyword: '/', match_type: 'prefix', priority: 100000 }]);
  await f.api.webhook(event('/warn @target reason', 'e1'));
  assert.equal(f.logs[0].reply_status, 'denied');
  await f.api.webhook(event('/ban @target 10m', 'e2', 'admin'));
  assert.equal(f.logs[1].reply_status, 'unsupported'); assert.equal(f.replies(), 0);
  await f.api.webhook(event('', 'join1', 'member', 'GROUP_JOIN_REQUEST'));
  assert.equal(f.logs[2].reply_status, 'unsupported'); assert.equal(f.logs[2].action_type, 'approval');
});

const warning: Command = { ...command, keyword: '/warn', match_type: 'prefix', reply_type: 'markdown',
  reply_body: '{target} 请遵守群规。原因：{reason} 操作人：{operator}', min_role: 'group_admin', builtin: true, builtin_key: 'warn' };

test('owner warning sends a passive Markdown mention with audit fields and cannot replay', async () => {
  const f = fixture([warning]);
  const message = '/warn <qqbot-at-user id="target" /> 请勿刷屏';
  assert.equal((await f.api.webhook(event(message, 'warn1', 'owner'))).status, 200);
  assert.equal(f.logs[0].reply_status, 'replied');
  assert.equal(f.logs[0].target_openid, 'target');
  assert.equal(f.logs[0].operator_openid, 'm1');
  assert.equal(f.logs[0].action_param.outcome, 'warning');
  assert.deepEqual(f.sent[0], { groupOpenid: 'g1', msgId: 'msg1', msgSeq: 1, replyType: 'markdown',
    content: '<qqbot-at-user id="target" /> 请遵守群规。原因：请勿刷屏 操作人：<qqbot-at-user id="m1" />' });
  await f.api.webhook(event(message, 'warn1', 'owner'));
  assert.equal(f.replies(), 1);
});

test('bare or invalid warning returns text usage without claiming a warning was executed', async () => {
  for (const message of ['/warn', '/warn somebody', '/warn @target <script>bad</script>']) {
    const f = fixture([warning]);
    await f.api.webhook(event(message, 'usage', 'admin'));
    assert.equal(f.logs[0].reply_status, 'replied');
    assert.equal(f.logs[0].action_param.outcome, 'usage');
    assert.equal(f.logs[0].target_openid, null);
    assert.equal(f.sent[0].replyType, 'text');
    assert.match(f.sent[0].content, /\/warn/u);
  }
});

test('warnings enforce enabled command and signed group role, never platform-admin substitution', async () => {
  for (const role of ['member', '', 'administrator']) {
    const f = fixture([warning]);
    const api = createApi({ env, store: f.store, verifySignature: () => true, isPlatformAdmin: async () => true,
      qq: { sendPassiveReply: async () => { throw new Error('must not send'); } } });
    await api.webhook(event('/warn @target', 'denied', role));
    assert.equal(f.logs[0].reply_status, 'denied');
  }
  const f = fixture([{ ...warning, enabled: false }]);
  await f.api.webhook(event('/warn @target', 'disabled', 'owner'));
  assert.equal(f.logs[0].reply_status, 'ignored');
  assert.equal(f.replies(), 0);
});

test('warning escapes reason markup, fills old templates and supports nested author role', async () => {
  const f = fixture([{ ...warning, reply_body: 'Please follow the group rules.' }]);
  const request = new Request('https://bot.example/api/webhook', { method: 'POST', body: JSON.stringify({ op: 0, id: 'old-template', t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'msg1', group_openid: 'g1', author: { member_openid: 'm1', member_role: 'admin' }, content: '/warn @first @second **规则**' } }) });
  await f.api.webhook(request);
  assert.equal(f.logs[0].reply_status, 'replied');
  assert.match(f.sent[0].content, /^<qqbot-at-user id="first" \/> <qqbot-at-user id="second" \/>/u);
  assert.ok(f.sent[0].content.includes('\\*\\*规则\\*\\*'));
});

test('failed warning retains event claim and never reports success or retries', async () => {
  const f = fixture([warning]); let attempts = 0;
  const api = createApi({ env, store: f.store, verifySignature: () => true,
    qq: { sendPassiveReply: async () => { attempts++; throw new Error('private upstream failure'); } } });
  await api.webhook(event('/warn @target', 'failed-warn', 'owner'));
  await api.webhook(event('/warn @target', 'failed-warn', 'owner'));
  assert.equal(attempts, 1);
  assert.equal(f.logs[0].reply_status, 'failed');
  assert.ok(!f.logs[0].error?.includes('private'));
});

test('uncertain QQ delivery is retained and never retried', async () => {
  const f = fixture(); let attempts = 0;
  const api = createApi({ env, store: f.store, verifySignature: () => true, qq: { sendPassiveReply: async () => { attempts++; throw new Error('secret remote failure'); } } });
  await api.webhook(event()); await api.webhook(event());
  assert.equal(attempts, 1); assert.equal(f.logs[0].reply_status, 'failed');
  assert.ok(!f.logs[0].error?.includes('secret'));
});

test('database/schema unavailable returns 503 instead of acknowledging', async () => {
  const f = fixture();
  const api = createApi({ env, store: { ...f.store, recordWebhook: async () => { throw new Error('connection string secret'); } }, verifySignature: () => true });
  const response = await api.webhook(event());
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret'));
});

test('policy validator rejects unknown values and accepts partial updates', () => {
  const policy = validatePolicy({ group_openid: 'g1', rule_type: 'keyword', rule_value: 'hello', action: 'approve' });
  assert.equal(policy.enabled, false); assert.equal(validatePolicy({ enabled: false }, policy).enabled, false);
  for (const value of [{ ...policy, enabled: 'yes' }, { ...policy, rule_type: 'sql' }, { ...policy, secret: 'oops' }]) assert.throws(() => validatePolicy(value));
});

test('settings expose only masked id, public urls, booleans and schema metadata', async () => {
  const database = async () => ({ query: async () => ({ rows: [] }) }) as never;
  const configuration = { ...env, DATABASE_URL: 'postgresql://secret:password@db.example/private', PLATFORM_DATABASE_URL: 'postgresql://private', QQ_APP_ID: '1234567890', PLATFORM_AUTH_MODE: 'sso', BPEBOT_SSO_CLIENT_SECRET: 'private-sso-credential' };
  const store = createStore(database, async () => ({ mode: 'verify', expectedVersion: 1, currentVersion: 1, ready: true, appliedAt: null, appliedBy: null }), configuration);
  const state = await store.getState();
  assert.equal(state.settings.appIdMasked, '******7890');
  const serialized = JSON.stringify(state.settings);
  for (const secret of [configuration.DATABASE_URL, configuration.PLATFORM_DATABASE_URL, configuration.QQ_CLIENT_SECRET, configuration.DB_SCHEMA_TOKEN, configuration.QQ_APP_ID, configuration.BPEBOT_SSO_CLIENT_SECRET]) assert.ok(!serialized.includes(secret));
  assert.equal(state.settings.capabilities.joinApproval, false);
});

test('settings require SSO credentials only in SSO mode and never require the optional platform database', async () => {
  const database = async () => ({ query: async () => ({ rows: [] }) }) as never;
  const schema = async () => ({ mode: 'verify' as const, expectedVersion: 1, currentVersion: 1, ready: true, appliedAt: null, appliedBy: null });
  const base = { ...env, DATABASE_URL: 'postgresql://bot.example/bot', DB_SCHEMA_MODE: 'verify', PLATFORM_DATABASE_URL: '', BPEBOT_SSO_CLIENT_SECRET: '' };
  for (const mode of ['sso', 'api']) {
    for (const secret of ['', '   ', 'private-sso-credential']) {
      const state = await createStore(database, schema, { ...base, PLATFORM_AUTH_MODE: mode, BPEBOT_SSO_CLIENT_SECRET: secret }).getState();
      const configured = state.settings.configured;
      assert.equal(Object.hasOwn(configured, 'PLATFORM_DATABASE_URL'), false);
      assert.equal(Object.hasOwn(configured, 'BPEBOT_SSO_CLIENT_SECRET'), mode === 'sso');
      assert.deepEqual(Object.entries(configured).filter(([, present]) => !present).map(([key]) => key),
        mode === 'sso' && !secret.trim() ? ['BPEBOT_SSO_CLIENT_SECRET'] : []);
    }
  }
});
