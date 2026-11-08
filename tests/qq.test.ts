import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { QQApiError, QQClient, QQ_CAPABILITIES, QQ_TOKEN_URL, signValidationResponse, verifyWebhookSignature } from '../lib/qq.ts';

const secret = 'test-secret';
const timestamp = '1794139200';
const now = Number(timestamp) * 1000;
// Independent reference key: official algorithm doubles then truncates secret to 32 bytes.
function key(value = secret) {
  let seed = Buffer.from(value);
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed.subarray(0, 32)]), type: 'pkcs8', format: 'der' });
}
function signature(body: string | Buffer, ts = timestamp, value = secret) { return sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), key(value)).toString('hex'); }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const reply = { groupOpenid: 'group_a', msgId: 'ROBOT1.0_message_a', replyType: 'text' as const, content: 'Hello' };

test('matches the published QQ official public key and validation challenge test vectors', () => {
  // Official sign.html and event-emit.html examples; these are public demo credentials.
  // The signature demo in sign.html does not verify against its displayed body;
  // use the published key and the independently valid handshake vector instead.
  const publicKey = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from([215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79, 227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58]),
  ]), format: 'der', type: 'spki' });
  const signed = signValidationResponse({ plainToken: 'challenge', eventTs: timestamp, botSecret: 'naOC0ocQE3shWLAfffVLB1rhYPG7' });
  assert.equal(verify(null, Buffer.from(timestamp + 'challenge'), publicKey, Buffer.from(signed.signature, 'hex')), true);
  assert.deepEqual(signValidationResponse({ plainToken: 'Arq0D5A61EgUu4OxUvOp', eventTs: '1725442341', botSecret: 'DG5g3B4j9X2KOErG' }), {
    plain_token: 'Arq0D5A61EgUu4OxUvOp',
    signature: '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
  });
});

test('Ed25519 verification signs exact timestamp plus raw bytes, including UTF-8 and whitespace', () => {
  const body = '{ "content": "你好", "n": 1 }\n';
  const options = { body, timestamp, signature: signature(body), botSecret: secret, now };
  assert.equal(verifyWebhookSignature(options), true);
  assert.equal(verifyWebhookSignature({ ...options, body: Buffer.from(body) }), true);
  assert.equal(verifyWebhookSignature({ ...options, body: JSON.stringify(JSON.parse(body)) }), false);
  assert.equal(verifyWebhookSignature({ ...options, body: body + ' ' }), false);
  assert.equal(verifyWebhookSignature({ ...options, botSecret: 'wrong' }), false);
  for (const botSecret of ['a', 'a'.repeat(32), 'b'.repeat(60), '密钥']) {
    assert.equal(verifyWebhookSignature({ ...options, botSecret, signature: signature(body, timestamp, botSecret) }), true);
  }
});

test('malformed/missing headers, stale/future timestamps, invalid secrets fail closed', () => {
  const body = '{}';
  const options = { body, timestamp, signature: signature(body), botSecret: secret, now };
  for (const bad of [undefined, null, '', 'aa', 'g'.repeat(128), options.signature + ',extra', ' ' + options.signature]) assert.equal(verifyWebhookSignature({ ...options, signature: bad }), false);
  for (const bad of [undefined, null, '', ' 1794139200', '1e9', '-1', timestamp + ',1', '0' + timestamp]) assert.equal(verifyWebhookSignature({ ...options, timestamp: bad }), false);
  assert.equal(verifyWebhookSignature({ ...options, now: now + 301000 }), false);
  assert.equal(verifyWebhookSignature({ ...options, now: now - 31000 }), false);
  assert.equal(verifyWebhookSignature({ ...options, now: now + 300000 }), true);
  assert.equal(verifyWebhookSignature({ ...options, now: NaN }), false);
  assert.equal(verifyWebhookSignature({ ...options, botSecret: '' }), false);
});

test('handshake signs event_ts + plain_token and returns exact snake-case response', () => {
  const result = signValidationResponse({ plainToken: 'challenge', eventTs: timestamp, botSecret: secret });
  assert.deepEqual(Object.keys(result), ['plain_token', 'signature']);
  assert.equal(result.plain_token, 'challenge');
  assert.equal(verify(null, Buffer.from(timestamp + 'challenge'), createPublicKey(key()), Buffer.from(result.signature, 'hex')), true);
  assert.equal(verify(null, Buffer.from('challenge' + timestamp), createPublicKey(key()), Buffer.from(result.signature, 'hex')), false);
  assert.throws(() => signValidationResponse({ plainToken: '', eventTs: timestamp, botSecret: secret }));
});

test('token request uses official endpoint, coalesces concurrency, caches then refreshes', async () => {
  let clock = now;
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), QQ_TOKEN_URL);
    assert.deepEqual(JSON.parse(init!.body as string), { appId: 'app', clientSecret: secret });
    assert.equal(init!.method, 'POST');
    assert.equal(init!.redirect, 'error');
    assert.ok(init!.signal instanceof AbortSignal);
    return json({ access_token: `token${calls}`, expires_in: '7200' });
  };
  const client = new QQClient({ appId: 'app', clientSecret: secret, fetch: fetcher, now: () => clock });
  assert.deepEqual(await Promise.all([client.getAccessToken(), client.getAccessToken()]), ['token1', 'token1']);
  assert.equal(calls, 1);
  assert.equal(await client.getAccessToken(), 'token1');
  clock += 7140000;
  assert.equal(await client.getAccessToken(), 'token2');
  assert.equal(calls, 2);
});

test('bad token payloads and API errors are rejected without reflecting secrets; failed refresh retries', async () => {
  for (const payload of [{ code: 40013, message: secret }, { access_token: '', expires_in: 7200 }, { access_token: 'token', expires_in: 0 }, { access_token: 'token', expires_in: 99999 }, null, []]) {
    const client = new QQClient({ appId: 'app', clientSecret: secret, fetch: async () => json(payload) });
    await assert.rejects(client.getAccessToken(), error => error instanceof QQApiError && !String(error).includes(secret));
  }
  let calls = 0;
  const client = new QQClient({ appId: 'app', clientSecret: secret, fetch: async () => { if (++calls === 1) throw new Error(secret); return json({ access_token: 'ok', expires_in: 7200 }); } });
  await assert.rejects(client.getAccessToken(), error => error instanceof QQApiError && !String(error).includes(secret));
  assert.equal(await client.getAccessToken(), 'ok');
});

test('passive text and markdown replies use correct authorization, msg_id and increasing concurrent sequences', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const client = new QQClient({ appId: 'app', clientSecret: secret, now: () => now, fetch: async (url, init) => {
    if (String(url) === QQ_TOKEN_URL) return json({ access_token: 'access', expires_in: 7200 });
    sent.push({ url: String(url), init: init! });
    return json({ id: 'reply_id' });
  } });
  await Promise.all([client.sendPassiveReply(reply), client.sendPassiveReply({ ...reply, replyType: 'markdown', content: '**hello**' })]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.url, 'https://api.sgroup.qq.com/v2/groups/group_a/messages');
  assert.equal(new Headers(sent[0]!.init.headers).get('Authorization'), 'QQBot access');
  assert.deepEqual(JSON.parse(sent[0]!.init.body as string), { msg_id: reply.msgId, msg_seq: 1, msg_type: 0, content: 'Hello' });
  assert.deepEqual(JSON.parse(sent[1]!.init.body as string), { msg_id: reply.msgId, msg_seq: 2, msg_type: 2, markdown: { content: '**hello**' } });
  await client.sendPassiveReply({ ...reply, msgSeq: 10 });
  await assert.rejects(client.sendPassiveReply({ ...reply, msgSeq: 10 }));
});

test('reply validates identifiers/payloads, never retries failed sends, hides remote body', async () => {
  let sends = 0;
  const client = new QQClient({ appId: 'app', clientSecret: secret, fetch: async (url) => {
    if (String(url) === QQ_TOKEN_URL) return json({ access_token: 'access', expires_in: 7200 });
    sends++;
    return json({ message: secret }, 401);
  } });
  for (const changes of [{ groupOpenid: '../evil' }, { msgId: '' }, { content: ' ' }, { msgSeq: 0 }, { msgSeq: 1.1 }]) await assert.rejects(client.sendPassiveReply({ ...reply, ...changes }));
  assert.equal(sends, 0);
  await assert.rejects(client.sendPassiveReply(reply), error => error instanceof QQApiError && error.status === 401 && !String(error).includes(secret));
  assert.equal(sends, 1);
});

test('unverified join and mute integrations explicitly report unsupported without network calls', async () => {
  const client = new QQClient({ appId: 'app', clientSecret: secret, fetch: async () => { assert.fail('No network calls expected'); } });
  assert.equal(QQ_CAPABILITIES.joinApproval, false);
  assert.equal(QQ_CAPABILITIES.mute, false);
  await assert.rejects(client.approveJoin(), /unsupported/u);
  await assert.rejects(client.muteMembers(), /unsupported/u);
});
