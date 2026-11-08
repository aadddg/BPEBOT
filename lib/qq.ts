import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** Protocol verified against QQ official sign/access-token docs and Tencent's SDK:
 * https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 * https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
 * https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 * https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
 * https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/transport/webhook-verify.ts
 * https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/api/messages.ts
 * https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/api/routes.ts
 * Timestamp freshness is local hardening, not part of QQ's signature derivation.
 */
export const QQ_API_BASE = 'https://api.sgroup.qq.com';
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
export const QQ_CAPABILITIES = Object.freeze({ passiveGroupReply: true, joinApproval: false, mute: false });

function privateKey(secret: string) {
  if (typeof secret !== 'string' || !secret || secret.length > 4096) throw new Error('Invalid QQ secret configuration');
  const bytes = Buffer.from(secret, 'utf8');
  const seed = Buffer.alloc(32);
  for (let i = 0; i < seed.length; i++) seed[i] = bytes[i % bytes.length]!;
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

export type VerifyWebhookOptions = {
  body: string | Uint8Array;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  botSecret: string;
  /** Epoch milliseconds. Default Date.now(). */
  now?: number;
  maxAgeSeconds?: number;
  futureToleranceSeconds?: number;
};
export function verifyWebhookSignature(options: VerifyWebhookOptions): boolean {
  try {
    const { body, timestamp, signature, botSecret, now = Date.now(), maxAgeSeconds = 300, futureToleranceSeconds = 30 } = options;
    if (typeof timestamp !== 'string' || !/^[1-9][0-9]{0,12}$/u.test(timestamp) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/iu.test(signature)) return false;
    if (!Number.isFinite(now) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0 || !Number.isFinite(futureToleranceSeconds) || futureToleranceSeconds < 0) return false;
    const age = now / 1000 - Number(timestamp);
    if (age > maxAgeSeconds || age < -futureToleranceSeconds) return false;
    const sig = Buffer.from(signature, 'hex');
    if ((sig[63]! & 224) !== 0) return false;
    const message = Buffer.concat([Buffer.from(timestamp, 'utf8'), typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)]);
    return verify(null, message, createPublicKey(privateKey(botSecret)), sig);
  } catch { return false; }
}

/** op:13 bootstrap response; QQ signs event_ts followed by plain_token (in that order). */
export function signValidationResponse(options: { plainToken: string; eventTs: string; botSecret: string }): { plain_token: string; signature: string } {
  const { plainToken, eventTs, botSecret } = options;
  if (typeof plainToken !== 'string' || !plainToken || plainToken.length > 4096 || typeof eventTs !== 'string' || !/^[1-9][0-9]{0,12}$/u.test(eventTs)) throw new Error('Invalid QQ validation challenge');
  return { plain_token: plainToken, signature: sign(null, Buffer.from(eventTs + plainToken, 'utf8'), privateKey(botSecret)).toString('hex') };
}

export class QQApiError extends Error {
  constructor(public readonly operation: 'token' | 'reply', public readonly status: number | null = null, public readonly code: number | null = null) {
    super(`QQ ${operation} request failed${status === null ? '' : ` (HTTP ${status})`}${code === null ? '' : ` (code ${code})`}`);
    this.name = 'QQApiError';
  }
}
export class QQUnsupportedError extends Error {
  constructor(capability: string) { super(`QQ ${capability} is unsupported: official API has not been verified`); this.name = 'QQUnsupportedError'; }
}
export type QQClientOptions = { appId: string; clientSecret: string; fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number };
export type PassiveReply = { groupOpenid: string; msgId: string; replyType: 'text' | 'markdown'; content: string; msgSeq?: number };
type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identifier(value: string): boolean { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value); }

/** Node-only, credential-scoped cache. Share a client per bot; no credentials in logs/errors.
 * For more than one reply across serverless instances, persist msgSeq externally and pass it.
 */
export class QQClient {
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private tokenRequest: Promise<string> | null = null;
  private readonly sequences = new Map<string, { sequence: number; expiresAt: number }>();

  constructor(options: QQClientOptions) {
    if (!identifier(options.appId) || typeof options.clientSecret !== 'string' || !options.clientSecret || options.clientSecret.length > 4096) throw new Error('Invalid QQ credentials configuration');
    this.appId = options.appId;
    this.clientSecret = options.clientSecret;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Invalid QQ timeout');
  }

  private async post(operation: 'token' | 'reply', url: string, body: unknown, token?: string): Promise<JsonObject> {
    try {
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `QQBot ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new QQApiError(operation, response.status);
      let value: unknown;
      try { value = await response.json(); } catch { throw new QQApiError(operation, response.status); }
      if (!isObject(value)) throw new QQApiError(operation, response.status);
      if (value.code !== undefined && value.code !== 0) throw new QQApiError(operation, response.status, typeof value.code === 'number' && Number.isSafeInteger(value.code) ? value.code : null);
      return value;
    } catch (error) {
      if (error instanceof QQApiError) throw error;
      // Fetch failures and remote messages can include credentials. Never propagate them.
      throw new QQApiError(operation);
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.now() < this.cachedToken.expiresAt) return this.cachedToken.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.loadToken();
    try { return await this.tokenRequest; } finally { this.tokenRequest = null; }
  }

  private async loadToken(): Promise<string> {
    const startedAt = this.now();
    const result = await this.post('token', QQ_TOKEN_URL, { appId: this.appId, clientSecret: this.clientSecret });
    const lifetime = typeof result.expires_in === 'string' && /^[1-9][0-9]*$/u.test(result.expires_in) ? Number(result.expires_in) : result.expires_in;
    if (typeof result.access_token !== 'string' || !result.access_token || /\s/u.test(result.access_token) || result.access_token.length > 8192 || typeof lifetime !== 'number' || !Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 7200) throw new QQApiError('token');
    this.cachedToken = { value: result.access_token, expiresAt: startedAt + Math.max(0, lifetime - Math.min(60, lifetime / 10)) * 1000 };
    return result.access_token;
  }

  async sendPassiveReply(reply: PassiveReply): Promise<JsonObject> {
    // Message IDs are opaque strings (official examples contain a ROBOT1.0_ prefix).
    if (!identifier(reply.groupOpenid) || typeof reply.msgId !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(reply.msgId) || !['text', 'markdown'].includes(reply.replyType) || typeof reply.content !== 'string' || !reply.content.trim() || reply.content.length > 10000) throw new Error('Invalid QQ passive reply');
    if (reply.msgSeq !== undefined && (!Number.isSafeInteger(reply.msgSeq) || reply.msgSeq < 1 || reply.msgSeq > 65535)) throw new Error('Invalid QQ reply sequence');
    const now = this.now();
    for (const [key, value] of this.sequences) if (value.expiresAt <= now) this.sequences.delete(key);
    const key = `${reply.groupOpenid}:${reply.msgId}`;
    const previous = this.sequences.get(key)?.sequence ?? 0;
    const sequence = reply.msgSeq ?? previous + 1;
    if (sequence <= previous || sequence > 65535) throw new Error('QQ reply sequence must increase');
    if (!this.sequences.has(key) && this.sequences.size >= 10000) throw new Error('QQ reply sequence capacity exceeded');
    // Reserve before awaiting so concurrent replies cannot reuse a sequence. Never retry sends.
    this.sequences.set(key, { sequence, expiresAt: now + 5 * 60 * 1000 });
    const token = await this.getAccessToken();
    const body = { msg_id: reply.msgId, msg_seq: sequence, ...(reply.replyType === 'markdown' ? { msg_type: 2, markdown: { content: reply.content } } : { msg_type: 0, content: reply.content }) };
    return this.post('reply', `${QQ_API_BASE}/v2/groups/${encodeURIComponent(reply.groupOpenid)}/messages`, body, token);
  }

  async approveJoin(): Promise<never> { throw new QQUnsupportedError('join approval'); }
  async muteMembers(): Promise<never> { throw new QQUnsupportedError('member mute'); }
}
