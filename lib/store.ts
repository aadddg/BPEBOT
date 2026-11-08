import { randomUUID } from 'node:crypto';
import { getDb, schemaStatus, SCHEMA_VERSION } from './db';
import { validateCommand, type Command } from './commands';
import { QQ_CAPABILITIES } from './qq';
import { platformBaseUrl } from './auth';

export type Log = {
  id: string; event_id: string | null; event_type: string; group_openid: string | null;
  member_openid: string | null; target_openid: string | null; operator_openid: string | null;
  content: string | null; matched_command_id: string | null; action_type: string;
  action_param: Record<string, unknown>; reply_status: string; reply_body: string | null;
  error: string | null; msg_id: string | null; member_role: string | null;
  raw_event: unknown; created_at: string;
};
export type JoinPolicy = {
  id: string; group_openid: string; rule_type: 'keyword' | 'whitelist'; rule_value: string;
  action: 'approve' | 'reject'; reject_reason: string | null; enabled: boolean;
};
export type Policy = JoinPolicy;
export type WebhookRequest = {
  id: string; event_id: string | null; event_type: string | null; signature_valid: boolean;
  processing_result: string; http_status: number; duration_ms: number; error: string | null; created_at: string;
};
export type Settings = {
  appIdMasked: string; platformUrl: string; webhookUrl: string; schemaMode: string;
  schemaVersion: number | null; expectedSchemaVersion: number; schemaAppliedAt: string | null; schemaAppliedBy: string | null; configured: Record<string, boolean>;
  capabilities: { passiveGroupReply: boolean; joinApproval: boolean; mute: boolean; moderation: boolean };
};
export type EnhancedCommand = Command & { hits: number[]; recent: Log[] };
export type BotState = { commands: EnhancedCommand[]; logs: Log[]; policies: JoinPolicy[]; requests: WebhookRequest[]; settings: Settings };
export type LogFilters = {
  page?: number; limit?: number; event_type?: string; reply_status?: string; group_openid?: string;
  action_type?: string; matched_command_id?: string; event_id?: string; from?: string; to?: string;
};
export class StoreError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'INVALID_INPUT') { super(message); this.name = 'StoreError'; }
}
const commandFields = ['keyword', 'match_type', 'reply_type', 'reply_body', 'priority', 'enabled', 'min_role', 'builtin', 'builtin_key'] as const;
const policyFields = ['group_openid', 'rule_type', 'rule_value', 'action', 'reject_reason', 'enabled'] as const;
const commandRow = (row: Record<string, unknown>): Command => Object.fromEntries(['id', ...commandFields].map(key => [key, row[key]])) as Command;
const policyRow = (row: Record<string, unknown>): JoinPolicy => Object.fromEntries(['id', ...policyFields].map(key => [key, row[key]])) as JoinPolicy;
export const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError(400, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function validatePolicy(input: unknown, existing?: JoinPolicy): JoinPolicy {
  const value = objectInput(input);
  if (Object.keys(value).some(key => !['id', ...policyFields].includes(key))) throw new StoreError(400, 'Unknown policy field.');
  const policy = { id: randomUUID(), reject_reason: null, enabled: false, ...existing, ...value } as JoinPolicy;
  if (!uuid(policy.id) || (existing && policy.id !== existing.id) ||
      typeof policy.group_openid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(policy.group_openid) ||
      !['keyword', 'whitelist'].includes(policy.rule_type) || !['approve', 'reject'].includes(policy.action) ||
      typeof policy.rule_value !== 'string' || !policy.rule_value.trim() || policy.rule_value.length > 4000 ||
      typeof policy.enabled !== 'boolean' || (policy.reject_reason !== null && (typeof policy.reject_reason !== 'string' || policy.reject_reason.length > 1000))) {
    throw new StoreError(400, 'Invalid join policy.');
  }
  return policy;
}

function safePublicUrl(value: string | undefined, path = '/'): string {
  try { const url = new URL(path, value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
function maskedId(value: string | undefined): string { return value ? `${'*'.repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.length > 4 ? value.slice(-4) : ''}` : ''; }
const serial = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

export function createStore(database = getDb, inspectSchema = schemaStatus, env: NodeJS.ProcessEnv = process.env) {
  async function getCommands(): Promise<Command[]> {
    return (await (await database()).query('SELECT * FROM bpe_bot.commands ORDER BY priority DESC,id')).rows.map(commandRow);
  }
  async function getPolicies(): Promise<JoinPolicy[]> {
    return (await (await database()).query('SELECT * FROM bpe_bot.join_policies ORDER BY created_at DESC,id')).rows.map(policyRow);
  }
  async function settings(): Promise<Settings> {
    const schema = await inspectSchema();
    let platformUrl = '';
    try { platformUrl = platformBaseUrl(env).origin; } catch { /* Display only a configured, public origin. */ }
    return {
      appIdMasked: maskedId(env.QQ_APP_ID), platformUrl, webhookUrl: safePublicUrl(env.APP_URL, '/api/webhook'),
      schemaMode: schema.mode, schemaVersion: schema.currentVersion, expectedSchemaVersion: SCHEMA_VERSION,
      schemaAppliedAt: schema.appliedAt, schemaAppliedBy: schema.appliedBy,
      configured: Object.fromEntries(['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'PLATFORM_URL', 'APP_URL', 'QQ_APP_ID', 'QQ_CLIENT_SECRET', 'DB_SCHEMA_MODE', 'DB_SCHEMA_TOKEN'].map(key => [key, !!env[key]?.trim()])),
      capabilities: { ...QQ_CAPABILITIES, moderation: false },
    };
  }
  async function listLogs(filters: LogFilters = {}) {
    const page = Math.max(1, filters.page ?? 1), limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    const values: unknown[] = [], where: string[] = [];
    for (const key of ['event_type', 'reply_status', 'group_openid', 'action_type', 'matched_command_id', 'event_id'] as const) {
      if (filters[key]) { values.push(filters[key]); where.push(`${key}=$${values.length}`); }
    }
    for (const [key, operator] of [['from', '>='], ['to', '<=']] as const) {
      if (filters[key]) { values.push(filters[key]); where.push(`created_at ${operator} $${values.length}::timestamptz`); }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const db = await database();
    const [count, rows] = await Promise.all([
      db.query(`SELECT count(*)::integer AS total FROM bpe_bot.bot_logs ${clause}`, values),
      db.query(`SELECT * FROM bpe_bot.bot_logs ${clause} ORDER BY created_at DESC,id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, (page - 1) * limit]),
    ]);
    return serial<{ logs: Log[]; total: number; page: number; limit: number }>({ logs: rows.rows, total: count.rows[0].total, page, limit });
  }
  async function getState(): Promise<BotState> {
    const db = await database();
    const [commands, logs, policies, requests, metrics, recent, configuration] = await Promise.all([
      getCommands(), db.query('SELECT * FROM bpe_bot.bot_logs ORDER BY created_at DESC,id LIMIT 500'), getPolicies(),
      db.query('SELECT * FROM bpe_bot.webhook_requests ORDER BY created_at DESC,id LIMIT 100'),
      db.query(`SELECT matched_command_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day, count(*)::integer AS hits
        FROM bpe_bot.bot_logs WHERE matched_command_id IS NOT NULL AND reply_status='replied'
        AND created_at >= (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') - interval '6 days') AT TIME ZONE 'Asia/Shanghai'
        GROUP BY matched_command_id,day`),
      db.query(`SELECT l.* FROM bpe_bot.commands c CROSS JOIN LATERAL
        (SELECT * FROM bpe_bot.bot_logs WHERE matched_command_id=c.id AND reply_status='replied' ORDER BY created_at DESC,id LIMIT 2) l`),
      settings(),
    ]);
    const days = Array.from({ length: 7 }, (_, index) => new Date(Date.now() + 8 * 3600000 - (6 - index) * 86400000).toISOString().slice(0, 10));
    return serial<BotState>({ commands: commands.map(command => ({ ...command,
      hits: days.map(day => metrics.rows.find(row => row.matched_command_id === command.id && row.day === day)?.hits ?? 0),
      recent: recent.rows.filter(row => row.matched_command_id === command.id),
    })), logs: logs.rows, policies, requests: requests.rows, settings: configuration });
  }
  async function saveCommand(input: unknown, id?: string): Promise<Command> {
    const value = objectInput(input), db = await database();
    const existing: Command | undefined = id ? (await db.query('SELECT * FROM bpe_bot.commands WHERE id=$1', [id])).rows[0] : undefined;
    if (id && !existing) throw new StoreError(404, 'Command not found.', 'NOT_FOUND');
    // State responses contain display-only fields; callers must submit the Command fields only.
    const cleanExisting = existing ? Object.fromEntries(['id', ...commandFields].map(key => [key, existing[key as keyof Command]])) as Command : undefined;
    const candidate = validateCommand({ id: randomUUID(), keyword: '', match_type: 'exact', reply_type: 'text', reply_body: '', priority: 0, enabled: true, min_role: 'any', builtin: false, builtin_key: null, ...cleanExisting, ...value }, cleanExisting);
    if (!uuid(candidate.id)) throw new StoreError(400, 'Invalid command ID.');
    if (!id && candidate.builtin) throw new StoreError(400, 'Built-in commands cannot be created.');
    const values = [candidate.id, ...commandFields.map(key => candidate[key])];
    const result = id
      ? await db.query(`UPDATE bpe_bot.commands SET ${commandFields.map((key, index) => `${key}=$${index + 2}`).join(',')},updated_at=now() WHERE id=$1 RETURNING *`, values)
      : await db.query(`INSERT INTO bpe_bot.commands (id,${commandFields.join(',')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`, values);
    return commandRow(result.rows[0]);
  }
  async function deleteCommand(id: string): Promise<void> {
    const result = await (await database()).query('DELETE FROM bpe_bot.commands WHERE id=$1 AND builtin=false RETURNING id', [id]);
    if (!result.rowCount) throw new StoreError(409, 'Command does not exist or is built in.', 'CONFLICT');
  }
  async function savePolicy(input: unknown, id?: string): Promise<JoinPolicy> {
    const db = await database();
    const existing = id ? (await db.query('SELECT * FROM bpe_bot.join_policies WHERE id=$1', [id])).rows[0] : undefined;
    if (id && !existing) throw new StoreError(404, 'Policy not found.', 'NOT_FOUND');
    const policy = validatePolicy(input, existing);
    if (policy.enabled) throw new StoreError(501, 'Join approval execution is not available; save a disabled draft.', 'UNSUPPORTED');
    const values = [policy.id, ...policyFields.map(key => policy[key])];
    const result = id
      ? await db.query(`UPDATE bpe_bot.join_policies SET ${policyFields.map((key, index) => `${key}=$${index + 2}`).join(',')},updated_at=now() WHERE id=$1 RETURNING *`, values)
      : await db.query(`INSERT INTO bpe_bot.join_policies (id,${policyFields.join(',')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`, values);
    return policyRow(result.rows[0]);
  }
  async function deletePolicy(id: string): Promise<void> {
    const result = await (await database()).query('DELETE FROM bpe_bot.join_policies WHERE id=$1 RETURNING id', [id]);
    if (!result.rowCount) throw new StoreError(404, 'Policy not found.', 'NOT_FOUND');
  }
  async function clearLogs(): Promise<void> {
    // Event claims deliberately survive clearing logs, preserving webhook deduplication.
    await (await database()).query('DELETE FROM bpe_bot.bot_logs');
  }
  async function boundPlatformUser(memberId: string, appId: string): Promise<string | null> {
    const result = await (await database()).query("SELECT platform_user_id FROM bpe_bot.user_bindings WHERE qq_member_openid=$1 AND qq_app_id=$2 AND status='active'", [memberId, appId]);
    return result.rows[0]?.platform_user_id ?? null;
  }
  async function recordWebhook(request: Omit<WebhookRequest, 'id' | 'created_at'>): Promise<void> {
    await (await database()).query(`INSERT INTO bpe_bot.webhook_requests
      (event_id,event_type,signature_valid,processing_result,http_status,duration_ms,error) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [request.event_id, request.event_type, request.signature_valid, request.processing_result, request.http_status, request.duration_ms, request.error]);
  }
  async function beginEvent(log: Omit<Log, 'id' | 'created_at'>): Promise<boolean> {
    const client = await (await database()).connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query('INSERT INTO bpe_bot.event_claims(event_id,msg_seq) VALUES($1,1) ON CONFLICT DO NOTHING RETURNING event_id', [log.event_id]);
      if (!claim.rowCount) { await client.query('ROLLBACK'); return false; }
      const fields = ['event_id', 'event_type', 'group_openid', 'member_openid', 'target_openid', 'operator_openid', 'content', 'matched_command_id', 'action_type', 'action_param', 'reply_status', 'reply_body', 'error', 'msg_id', 'member_role', 'raw_event'] as const;
      await client.query(`INSERT INTO bpe_bot.bot_logs(${fields.join(',')}) VALUES(${fields.map((_, index) => `$${index + 1}`).join(',')})`, fields.map(field => ['action_param', 'raw_event'].includes(field) ? JSON.stringify(log[field]) : log[field]));
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async function finishEvent(eventId: string, status: string, replyBody: string | null, error: string | null): Promise<void> {
    const client = await (await database()).connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE bpe_bot.bot_logs SET reply_status=$2,reply_body=$3,error=$4 WHERE event_id=$1', [eventId, status, replyBody, error]);
      await client.query('UPDATE bpe_bot.event_claims SET status=$2,completed_at=now() WHERE event_id=$1', [eventId, status === 'failed' ? 'failed' : 'completed']);
      await client.query('COMMIT');
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; } finally { client.release(); }
  }
  return { getState, getCommands, getPolicies, listLogs, saveCommand, deleteCommand, savePolicy, deletePolicy, clearLogs, boundPlatformUser, recordWebhook, beginEvent, finishEvent };
}
export const store = createStore();
export type BotStore = ReturnType<typeof createStore>;
