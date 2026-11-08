export type Command = {
  id: string;
  keyword: string;
  match_type: "exact" | "prefix" | "contains";
  reply_type: "text" | "markdown";
  reply_body: string;
  priority: number;
  enabled: boolean;
  min_role: "any" | "group_admin" | "platform_admin";
  builtin: boolean;
  builtin_key: "warn" | "ban" | null;
};

export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

const fields = [
  "id",
  "keyword",
  "match_type",
  "reply_type",
  "reply_body",
  "priority",
  "enabled",
  "min_role",
  "builtin",
  "builtin_key",
] as const;
function fail(message: string): never {
  throw new CommandValidationError(message);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Command must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    fail(`Invalid ${field}`);
  return value;
}

/** Full input validation. Pass the persisted command when editing to protect built-ins. */
export function validateCommand(input: unknown, existing?: Command): Command {
  const value = record(input);
  if (
    Object.keys(value).some(
      (key) => !(fields as readonly string[]).includes(key),
    )
  )
    fail("Unknown command field");
  for (const field of fields)
    if (!Object.hasOwn(value, field)) fail(`Missing ${field}`);
  const id = text(value.id, "id", 128);
  const keyword = text(value.keyword, "keyword", 200);
  if (id !== id.trim() || /\s/u.test(id)) fail("Invalid id");
  if (keyword !== keyword.trim() || /[\r\n\t]/u.test(keyword))
    fail("Invalid keyword");
  text(value.reply_body, "reply_body", 10000);
  if (!["exact", "prefix", "contains"].includes(value.match_type as string))
    fail("Invalid match_type");
  if (!["text", "markdown"].includes(value.reply_type as string))
    fail("Invalid reply_type");
  if (
    !["any", "group_admin", "platform_admin"].includes(value.min_role as string)
  )
    fail("Invalid min_role");
  if (
    !Number.isSafeInteger(value.priority) ||
    Math.abs(value.priority as number) > 1000000
  )
    fail("Invalid priority");
  if (typeof value.enabled !== "boolean" || typeof value.builtin !== "boolean")
    fail("Invalid boolean");
  if (
    value.builtin_key !== null &&
    value.builtin_key !== "warn" &&
    value.builtin_key !== "ban"
  )
    fail("Invalid builtin_key");
  if (value.builtin) {
    if (
      !value.builtin_key ||
      keyword !== `/${value.builtin_key}` ||
      value.match_type !== "prefix" ||
      value.min_role !== "group_admin"
    )
      fail("Invalid built-in moderation constraints");
    if (value.builtin_key === "warn" && value.reply_type !== "markdown")
      fail("Warnings require markdown");
  } else if (
    value.builtin_key !== null ||
    /^\/(warn|ban)(?:\s|$)/iu.test(keyword)
  ) {
    fail("Reserved moderation command");
  }
  const command = Object.fromEntries(
    fields.map((field) => [field, value[field]]),
  ) as Command;
  if (existing) {
    if (command.id !== existing.id) fail("Command id cannot change");
    if (
      command.builtin !== existing.builtin ||
      command.builtin_key !== existing.builtin_key
    )
      fail("Built-in identity cannot change");
    if (existing.builtin) {
      for (const field of [
        "keyword",
        "match_type",
        "reply_type",
        "priority",
        "min_role",
      ] as const) {
        if (command[field] !== existing[field])
          fail(`Built-in ${field} cannot change`);
      }
    }
  }
  return command;
}

function matches(command: Command, message: string): boolean {
  if (!command.enabled || !command.keyword) return false;
  switch (command.match_type) {
    case "exact":
      return message === command.keyword;
    case "prefix":
      return (
        message.startsWith(command.keyword) &&
        (!command.builtin ||
          message.length === command.keyword.length ||
          /^\s/u.test(message.slice(command.keyword.length)))
      );
    case "contains":
      return message.includes(command.keyword);
    default:
      return false;
  }
}

/** Case-sensitive literal matching; caller owns stripping the bot mention. Does not mutate input. */
export function matchCommand(
  commands: readonly Command[],
  message: string,
): Command | null {
  return (
    commands
      .filter((command) => matches(command, message))
      .sort(
        (a, b) =>
          b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0] ?? null
  );
}

/** Apply the same QQ message normalization and reserved namespace policy in previews and dispatch. */
export function normalizeCommandMessage(message: string): string {
  return message.replace(/^(?:\s*<@!?[A-Za-z0-9_-]+>\s*)+/u, "").trim();
}
export function resolveCommand(
  commands: readonly Command[],
  rawMessage: string,
): Command | null {
  const message = normalizeCommandMessage(rawMessage);
  const reserved = /^\/(warn|ban)(?=\s|$)/iu.exec(message);
  if (reserved)
    return (
      commands.find(
        (command) =>
          command.enabled &&
          command.builtin &&
          command.builtin_key === reserved[1].toLowerCase(),
      ) ?? null
    );
  return matchCommand(
    commands.filter((command) => !command.builtin),
    message,
  );
}

export type CommandPreview =
  | { state: "matched" | "captured"; command: Command }
  | { state: "miss"; command: null };
export function previewCommand(
  commands: readonly Command[],
  draft: Command,
  message: string,
): CommandPreview {
  const command = resolveCommand(
    [...commands.filter((item) => item.id !== draft.id), draft],
    message,
  );
  return command
    ? { state: command.id === draft.id ? "matched" : "captured", command }
    : { state: "miss", command: null };
}

export function hasPermission(
  command: Command,
  memberRole: string | null | undefined,
  platformAdmin: boolean,
): boolean {
  const groupAdmin = memberRole === "admin" || memberRole === "owner";
  if (command.builtin || command.builtin_key !== null) return groupAdmin;
  switch (command.min_role) {
    case "any":
      return true;
    case "group_admin":
      return groupAdmin;
    case "platform_admin":
      return platformAdmin === true;
    default:
      return false;
  }
}

export const MAX_MODERATION_TARGETS = 20;
export const MAX_MUTE_SECONDS = 30 * 24 * 60 * 60;
export type ModerationAction = {
  action: "warn" | "ban";
  targets: string[];
  reason: string;
  durationSeconds: number | null;
};

/** Pure parser only. Targets must be explicit OpenIDs or official mention tags, never QQ numbers. */
export function parseModerationCommand(
  command: Command,
  message: string,
): ModerationAction {
  validateCommand(command);
  if (
    !command.builtin ||
    !command.builtin_key ||
    !matches(command, message) ||
    message.length > 12000
  )
    fail("Invalid moderation command");
  let rest = message.slice(command.keyword.length).trim();
  const targets: string[] = [];
  while (rest) {
    const mention =
      /^(?:<qqbot-at-user\s+id="([A-Za-z0-9_-]{1,128})"\s*\/>|@([A-Za-z0-9_-]{1,128}))(?=\s|$)/u.exec(
        rest,
      );
    if (!mention) break;
    const target = mention[1] ?? mention[2]!;
    if (targets.includes(target)) fail("Duplicate moderation target");
    targets.push(target);
    if (targets.length > MAX_MODERATION_TARGETS)
      fail("At most 20 moderation targets");
    rest = rest.slice(mention[0].length).trim();
  }
  if (!targets.length) fail("Explicit moderation target required");
  let durationSeconds: number | null = null;
  if (command.builtin_key === "ban") {
    const duration = /^([1-9][0-9]{0,7})(s|m|h|d)(?=\s|$)/u.exec(rest);
    if (!duration)
      fail(
        "Mute duration must be a positive integer followed by s, m, h, or d",
      );
    durationSeconds =
      Number(duration[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[duration[2]!]!;
    if (durationSeconds > MAX_MUTE_SECONDS)
      fail("Mute duration exceeds 30 days");
    rest = rest.slice(duration[0].length).trim();
  }
  if (
    rest.length > 2000 ||
    /[\u0000-\u001f\u007f]/u.test(rest) ||
    /<[^>]*>|@[A-Za-z0-9_-]/u.test(rest)
  )
    fail("Invalid moderation reason");
  return {
    action: command.builtin_key,
    targets,
    reason: rest,
    durationSeconds,
  };
}

/** Only server-generated OpenID mentions may enter the warning markup. */
export function renderWarning(command: Command, action: ModerationAction, operator: string): string {
  if (command.builtin_key !== 'warn' || action.action !== 'warn' || !/^[A-Za-z0-9_-]{1,256}$/u.test(operator)) fail('Invalid warning');
  const mention = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) fail('Invalid warning target');
    return `<qqbot-at-user id="${id}" />`;
  };
  const target = action.targets.map(mention).join(' ');
  const reason = (action.reason || '请遵守群规。').replace(/[\\`*_{}\[\]()#+.!|>~<&]/gu, '\\$&');
  const variables: Record<string, string> = { target, reason, operator: `<qqbot-at-user id="${operator}" />` };
  const body = command.reply_body.replace(/\{(target|reason|operator)\}/gu, (_, key: string) => variables[key]!);
  // Seeded templates predate placeholders; always show who is being warned and why.
  const result = [command.reply_body.includes('{target}') ? '' : target, body,
    command.reply_body.includes('{reason}') ? '' : reason].filter(Boolean).join('\n');
  if (!result.trim() || result.length > 10000) fail('Warning exceeds reply limit');
  return result;
}
