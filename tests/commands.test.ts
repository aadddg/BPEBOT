import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPermission, matchCommand, resolveCommand, parseModerationCommand, previewCommand, validateCommand, type Command } from '../lib/commands.ts';

const command = (changes: Partial<Command> = {}): Command => ({ id: 'a', keyword: 'hello', match_type: 'exact', reply_type: 'text', reply_body: 'Hello!', priority: 0, enabled: true, min_role: 'any', builtin: false, builtin_key: null, ...changes });
const builtin = (key: 'warn' | 'ban'): Command => command({ id: key, keyword: `/${key}`, builtin: true, builtin_key: key, min_role: 'group_admin', match_type: 'prefix', reply_type: 'markdown' });

test('dispatch and preview normalize identically and protect reserved moderation namespaces', () => {
  const warn = builtin('warn');
  const catchAll = command({ id: 'catch-all', keyword: '/', match_type: 'prefix', priority: 100000 });
  const input = ' <@!bot> /WARN @member reason ';
  assert.equal(resolveCommand([warn, catchAll], input), warn);
  assert.deepEqual(previewCommand([warn], catchAll, input), { state: 'captured', command: warn });
  assert.equal(resolveCommand([{ ...warn, enabled: false }, catchAll], input), null);
  assert.deepEqual(previewCommand([], catchAll, input), { state: 'miss', command: null });
  assert.equal(resolveCommand([command()], ' <@bot> hello ' )?.keyword, 'hello');
});

test('literal exact/prefix/contains matching, disabled exclusion, deterministic priority/id ordering', () => {
  const a = command();
  assert.equal(matchCommand([a], 'hello'), a);
  assert.equal(matchCommand([a], 'Hello'), null);
  assert.equal(matchCommand([a], ' hello '), null);
  const prefix = command({ id: 'b', match_type: 'prefix' });
  const contains = command({ id: 'c', match_type: 'contains', priority: 1 });
  const list = [prefix, a, contains];
  assert.equal(matchCommand(list, 'hello world'), contains);
  assert.equal(matchCommand([contains], 'say hello'), contains);
  assert.equal(matchCommand([prefix, a], 'hello'), a);
  assert.deepEqual(list, [prefix, a, contains]);
  assert.equal(matchCommand([command({ enabled: false })], 'hello'), null);
  assert.equal(matchCommand([], 'hello'), null);
  assert.equal(matchCommand([command({ keyword: '.*' })], 'anything'), null);
});

test('preview replaces persisted draft and reports all three states with winning command', () => {
  const saved = command({ priority: 100 });
  const draft = command({ keyword: 'new' });
  assert.deepEqual(previewCommand([saved], draft, 'new'), { state: 'matched', command: draft });
  assert.deepEqual(previewCommand([saved], draft, 'hello'), { state: 'miss', command: null });
  const other = command({ id: 'other', keyword: 'new', priority: 1 });
  assert.deepEqual(previewCommand([saved, other], draft, 'new'), { state: 'captured', command: other });
  assert.deepEqual(previewCommand([], { ...draft, enabled: false }, 'new'), { state: 'miss', command: null });
});

test('permission requires actual admin/owner for both moderation commands regardless of platform role', () => {
  for (const key of ['warn', 'ban'] as const) {
    for (const role of ['member', '', null, undefined, 'administrator']) assert.equal(hasPermission(builtin(key), role, true), false);
    for (const role of ['admin', 'owner']) assert.equal(hasPermission(builtin(key), role, false), true);
  }
  assert.equal(hasPermission(command(), null, false), true);
  assert.equal(hasPermission(command({ min_role: 'group_admin' }), 'member', true), false);
  assert.equal(hasPermission(command({ min_role: 'platform_admin' }), 'owner', false), false);
  assert.equal(hasPermission(command({ min_role: 'platform_admin' }), 'member', true), true);
});

test('validation rejects missing/unknown fields, coercion, unsafe bounds and malformed enums', () => {
  assert.deepEqual(validateCommand(command()), command());
  for (const input of [null, [], 'a', {}, { ...command(), extra: true }]) assert.throws(() => validateCommand(input));
  for (const changes of [
    { id: '' }, { id: ' bad' }, { keyword: ' ' }, { keyword: 'bad\nline' }, { reply_body: '' }, { reply_body: 'x'.repeat(10001) },
    { enabled: 'true' }, { builtin: 1 }, { priority: NaN }, { priority: Infinity }, { priority: 1.5 }, { priority: 1000001 },
    { match_type: 'regex' }, { reply_type: 'html' }, { min_role: 'admin' }, { builtin_key: 'kick' },
  ]) assert.throws(() => validateCommand({ ...command(), ...changes }));
});

test('built-in identities and permissions cannot be downgraded or replaced', () => {
  const warn = builtin('warn');
  assert.deepEqual(validateCommand(warn), warn);
  assert.deepEqual(validateCommand({ ...warn, enabled: false, reply_body: 'New warning' }, warn), { ...warn, enabled: false, reply_body: 'New warning' });
  for (const changes of [{ builtin: false, builtin_key: null }, { min_role: 'any' }, { keyword: '/other' }, { match_type: 'contains' }, { reply_type: 'text' }, { priority: 5 }, { id: 'other' }]) assert.throws(() => validateCommand({ ...warn, ...changes }, warn));
  assert.throws(() => validateCommand(command({ keyword: '/warn' })));
  assert.throws(() => validateCommand(command({ builtin_key: 'warn' })));
  assert.throws(() => validateCommand(warn, command({ id: 'warn' })));
});

test('moderation parser accepts official mentions and explicit OpenIDs without command prefix confusion', () => {
  const warn = builtin('warn');
  assert.deepEqual(parseModerationCommand(warn, '/warn <qqbot-at-user id="member_a" /> @member_b Be kind'), { action: 'warn', targets: ['member_a', 'member_b'], reason: 'Be kind', durationSeconds: null });
  assert.equal(matchCommand([warn], '/warning @member'), null);
  assert.throws(() => parseModerationCommand(warn, '/warning @member'));
  assert.throws(() => parseModerationCommand(warn, '/warn <@legacy> reason'));
  assert.throws(() => parseModerationCommand(warn, '/warn @user @user reason'));
  assert.throws(() => parseModerationCommand(warn, '/warn @user <script>bad</script>'));
});

test('mute parser enforces positive explicit duration, 30 day maximum and 20 target maximum', () => {
  const ban = builtin('ban');
  assert.equal(parseModerationCommand(ban, '/ban @member 10m spam').durationSeconds, 600);
  assert.equal(parseModerationCommand(ban, '/ban @member 30d').durationSeconds, 2592000);
  assert.equal(parseModerationCommand(ban, '/ban @member 2592000s').durationSeconds, 2592000);
  for (const duration of ['0m', '-1m', '1.5h', '31d', '2592001s', '10', '10mgarbage', 'Infinity', '1e3s']) assert.throws(() => parseModerationCommand(ban, `/ban @member ${duration}`));
  assert.throws(() => parseModerationCommand(ban, '/ban 10m'));
  const targets = Array.from({ length: 20 }, (_, i) => `@user_${i}`).join(' ');
  assert.equal(parseModerationCommand(ban, `/ban ${targets} 1h`).targets.length, 20);
  assert.throws(() => parseModerationCommand(ban, `/ban ${targets} @extra 1h`));
});
