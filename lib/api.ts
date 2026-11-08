import { AuthError, assertSameOrigin, requireAdmin, isPlatformAdmin, validSchemaToken } from './auth';
import { migrate } from './db';
import { CommandValidationError, hasPermission, normalizeCommandMessage, resolveCommand, previewCommand, validateCommand, type Command } from './commands';
import { QQClient, verifyWebhookSignature, signValidationResponse } from './qq';
import { store, StoreError, objectInput, uuid, type BotStore, type Log, type LogFilters } from './store';

export const ADMIN_BODY_LIMIT = 64 * 1024;
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' } });
}
export function apiError(error: unknown): Response {
  if (error instanceof AuthError || error instanceof StoreError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof CommandValidationError) return json({ error: error.message, code: 'INVALID_COMMAND' }, 400);
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return json({ error: 'This record already exists.', code: 'CONFLICT' }, 409);
  // Never expose driver errors, SQL, upstream response bodies or connection strings.
  return json({ error: 'Service unavailable. Check platform connectivity and database schema.', code: 'SERVICE_UNAVAILABLE' }, 503);
}
export async function readBody(request: Request, limit = ADMIN_BODY_LIMIT): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) throw new StoreError(400, 'Invalid content length.');
  if (length && Number(length) > limit) throw new StoreError(413, 'Request body too large.', 'BODY_TOO_LARGE');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); throw new StoreError(413, 'Request body too large.', 'BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try { return objectInput(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new StoreError(400, 'Expected a valid JSON object.'); }
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new StoreError(415, 'Use application/json.', 'UNSUPPORTED_MEDIA_TYPE');
  return parseJson(await readBody(request));
}
function unsupported(capability: string): Response {
  return json({ error: `${capability} is unsupported until the official QQ API and bot permissions are verified. No action was performed.`, code: 'UNSUPPORTED' }, 501);
}
function filtersFrom(url: URL): LogFilters {
  const filters: LogFilters = {};
  for (const key of ['page', 'limit'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      if (!/^[1-9][0-9]{0,5}$/u.test(value) || (key === 'limit' && Number(value) > 100)) throw new StoreError(400, 'Invalid pagination.');
      filters[key] = Number(value);
    }
  }
  for (const key of ['event_type', 'reply_status', 'group_openid', 'action_type', 'matched_command_id', 'event_id', 'from', 'to'] as const) {
    const value = url.searchParams.get(key);
    if (value) {
      if (value.length > 256 || (key === 'matched_command_id' && !uuid(value)) || (['from', 'to'].includes(key) && !Number.isFinite(Date.parse(value)))) throw new StoreError(400, 'Invalid log filter.');
      filters[key] = value;
    }
  }
  return filters;
}

type ApiDependencies = {
  store?: BotStore; requireAdmin?: typeof requireAdmin; isPlatformAdmin?: typeof isPlatformAdmin;
  migrate?: typeof migrate; env?: NodeJS.ProcessEnv; now?: () => number;
  verifySignature?: typeof verifyWebhookSignature; signChallenge?: typeof signValidationResponse;
  qq?: Pick<QQClient, 'sendPassiveReply'>;
};
const boundedString = (value: unknown, max = 256): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const identifier = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value) ? value : null;

/** Standard Request/Response and injected boundaries make handlers testable without Next or network. */
export function createApi(dependencies: ApiDependencies = {}) {
  const db = dependencies.store ?? store;
  const authenticate = dependencies.requireAdmin ?? requireAdmin;
  const platformAdmin = dependencies.isPlatformAdmin ?? isPlatformAdmin;
  const migrateSchema = dependencies.migrate ?? migrate;
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const verifySignature = dependencies.verifySignature ?? verifyWebhookSignature;
  const signChallenge = dependencies.signChallenge ?? signValidationResponse;
  let qq = dependencies.qq;

  async function admin(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname.replace(/\/$/u, '').replace(/^\/api\/admin\/?/u, '');
      if (path === 'migrate') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!validSchemaToken(request.headers.get('x-schema-token'), env.DB_SCHEMA_TOKEN)) throw new AuthError(401, 'Invalid schema token.', 'INVALID_SCHEMA_TOKEN');
        await readBody(request, 1024);
        return json(await migrateSchema());
      }
      await authenticate(request);
      if (!['GET', 'HEAD'].includes(request.method)) assertSameOrigin(request, env);
      if (request.method === 'GET') {
        if (path === 'state') return json(await db.getState());
        if (path === 'commands') return json({ commands: await db.getCommands() });
        if (path === 'policies') return json({ policies: await db.getPolicies() });
        if (path === 'logs') return json(await db.listLogs(filtersFrom(url)));
      }
      if (request.method === 'POST' && ['moderation', 'approval', 'approval/sync', 'policies/sync'].includes(path)) {
        await readJson(request);
        return unsupported(path.startsWith('moderation') ? 'Moderation' : 'Join approval');
      }
      if (path === 'commands/preview' && request.method === 'POST') {
        const body = await readJson(request);
        if (typeof body.message !== 'string' || body.message.length > 12000) throw new StoreError(400, 'Invalid preview message.');
        const draft = validateCommand(body.command);
        return json(previewCommand(await db.getCommands(), draft, body.message));
      }
      if ((path === 'commands' || path === 'policies') && request.method === 'POST') {
        const body = await readJson(request);
        return path === 'commands' ? json({ command: await db.saveCommand(body) }, 201) : json({ policy: await db.savePolicy(body) }, 201);
      }
      const target = /^(commands|policies)\/([^/]+)$/u.exec(path);
      if (target && ['PATCH', 'DELETE'].includes(request.method)) {
        const [, collection, id] = target;
        if (!uuid(id)) throw new StoreError(400, 'Invalid record ID.');
        if (request.method === 'PATCH') {
          const body = await readJson(request);
          return collection === 'commands' ? json({ command: await db.saveCommand(body, id) }) : json({ policy: await db.savePolicy(body, id) });
        }
        await readBody(request, 1024);
        if (collection === 'commands') await db.deleteCommand(id); else await db.deletePolicy(id);
        return json({ ok: true });
      }
      if (path === 'logs' && request.method === 'DELETE') {
        const body = await readJson(request);
        if (body.confirmation !== 'confirm clear') throw new StoreError(400, 'Type confirm clear to clear logs.');
        await db.clearLogs();
        return json({ ok: true });
      }
      return json({ error: 'Endpoint or method not supported.', code: 'NOT_FOUND' }, 404);
    } catch (error) { return apiError(error); }
  }

  async function webhook(request: Request): Promise<Response> {
    const started = now();
    let signatureValid = false, eventId: string | null = null, eventType: string | null = null;
    async function respond(value: unknown, status: number, result: string, error: string | null = null): Promise<Response> {
      // Complete audit writes before responding; a database/schema failure returns 503 for QQ retry.
      await db.recordWebhook({ event_id: eventId, event_type: eventType, signature_valid: signatureValid,
        processing_result: result, http_status: status, duration_ms: Math.max(0, Math.round(now() - started)), error });
      return json(value, status);
    }
    try {
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      if (!env.QQ_CLIENT_SECRET || !env.QQ_APP_ID) throw new StoreError(503, 'QQ credentials are not configured.', 'QQ_UNAVAILABLE');
      const bytes = await readBody(request, WEBHOOK_BODY_LIMIT);
      signatureValid = verifySignature({ body: bytes, timestamp: request.headers.get('x-signature-timestamp'),
        signature: request.headers.get('x-signature-ed25519'), botSecret: env.QQ_CLIENT_SECRET, now: now() });
      let body: Record<string, unknown> | undefined;
      if (!signatureValid) {
        // QQ URL validation can arrive before signed event delivery is enabled.
        // Accept only op:13 with both signature headers absent; no business dispatch.
        if (!request.headers.has('x-signature-timestamp') && !request.headers.has('x-signature-ed25519')) {
          try { const candidate = parseJson(bytes); if (candidate.op === 13) body = candidate; } catch { /* All other unsigned payloads fail below. */ }
        }
        if (!body) return await respond({ error: 'Invalid webhook signature.', code: 'INVALID_SIGNATURE' }, 401, 'signature_rejected');
      }
      body ??= parseJson(bytes);
      if (body.op === 13) {
        const data = objectInput(body.d);
        if (typeof data.plain_token !== 'string' || typeof data.event_ts !== 'string') throw new StoreError(400, 'Invalid validation challenge.');
        const challenge = signChallenge({ plainToken: data.plain_token, eventTs: data.event_ts, botSecret: env.QQ_CLIENT_SECRET });
        return await respond(challenge, 200, signatureValid ? 'handshake' : 'handshake_unsigned');
      }
      if (body.op !== 0 || !boundedString(body.t, 100)) throw new StoreError(400, 'Invalid webhook event.');
      eventType = body.t as string;
      const data = objectInput(body.d);
      // Message IDs are opaque: official QQ IDs may contain punctuation such as ROBOT1.0_.
      const msgId = typeof data.id === 'string' && /^[\x21-\x7e]{1,4096}$/u.test(data.id) ? data.id : null;
      const group = identifier(data.group_openid);
      const author = data.author && typeof data.author === 'object' && !Array.isArray(data.author) ? data.author as Record<string, unknown> : {};
      const member = identifier(author.member_openid);
      // Top-level event id is authoritative. Message id fallback is scoped to type and group.
      eventId = boundedString(body.id, 256) ?? (msgId && group ? `${eventType}:${group}:${msgId}` : null);
      if (!eventId) throw new StoreError(400, 'Stable event ID required for deduplication.');
      const isMessage = eventType === 'GROUP_AT_MESSAGE_CREATE';
      const isJoin = eventType === 'GROUP_JOIN_REQUEST';
      const content = typeof data.content === 'string' ? data.content : '';
      if (isMessage && (!msgId || !group || !member || content.length > 12000)) throw new StoreError(400, 'Invalid group message.');
      // Only strip leading legacy bot mentions; explicit user mention tags remain intact.
      const message = normalizeCommandMessage(content);
      const memberRole = boundedString(data.member_role ?? author.member_role, 32);
      let command: Command | null = null, status = isJoin ? 'unsupported' : 'ignored', error: string | null = null;
      let reply: string | null = null;
      if (isMessage) {
        const commands = await db.getCommands();
        const reserved = /^\/(warn|ban)(?=\s|$)/iu.exec(message);
        // Reserve these namespaces even when built-ins are disabled or custom priority is higher.
        command = resolveCommand(commands, message);
        if (reserved) {
          status = memberRole === 'admin' || memberRole === 'owner' ? 'unsupported' : 'denied';
          error = status === 'denied' ? 'Group administrator permission required.' : 'Moderation API is not verified; no action performed.';
        } else if (command) {
          let admin = false;
          if (command.min_role === 'platform_admin') {
            const userId = await db.boundPlatformUser(member!, env.QQ_APP_ID);
            admin = userId ? await platformAdmin(userId) : false;
          }
          if (!hasPermission(command, memberRole, admin)) { status = 'denied'; error = 'Command permission denied.'; }
          else { status = 'pending'; reply = command.reply_body; }
        } else status = 'miss';
      }
      if (isJoin) error = 'Join approval API is not verified; no action performed.';
      const log: Omit<Log, 'id' | 'created_at'> = {
        event_id: eventId, event_type: eventType, group_openid: group, member_openid: member,
        target_openid: null, operator_openid: null, content: content.slice(0, 12000), matched_command_id: command?.id ?? null,
        action_type: isJoin ? 'approval' : /^\/(warn|ban)(?=\s|$)/iu.test(message) ? 'moderation' : 'message',
        action_param: {}, reply_status: status, reply_body: null, error, msg_id: msgId, member_role: memberRole, raw_event: body,
      };
      if (!await db.beginEvent(log)) return await respond({ op: 12, duplicate: true }, 200, 'duplicate');
      if (status === 'pending' && command) {
        try {
          qq ??= new QQClient({ appId: env.QQ_APP_ID, clientSecret: env.QQ_CLIENT_SECRET });
          await qq.sendPassiveReply({ groupOpenid: group!, msgId: msgId!, replyType: command.reply_type, content: reply!, msgSeq: 1 });
          status = 'replied';
        } catch {
          // A timeout may occur after delivery. Keep the event claim and never blindly replay sends.
          status = 'failed'; error = 'QQ reply failed or delivery is uncertain; automatic replay is disabled.';
        }
      }
      await db.finishEvent(eventId, status, status === 'replied' ? reply : null, error);
      return await respond({ op: 12, result: status }, 200, status, error);
    } catch (error) {
      const response = apiError(error);
      try {
        await db.recordWebhook({ event_id: eventId, event_type: eventType, signature_valid: signatureValid,
          processing_result: 'error', http_status: response.status, duration_ms: Math.max(0, Math.round(now() - started)),
          error: response.status === 503 ? 'Service or schema unavailable.' : 'Invalid webhook request.' });
      } catch { return json({ error: 'Database schema or audit storage unavailable.', code: 'SERVICE_UNAVAILABLE' }, 503); }
      return response;
    }
  }
  return { admin, webhook };
}

export const api = createApi();
