/** Bundled SQL: no filesystem access is needed in a Next.js server deployment. */
export const initialSchemaSql = `
CREATE SCHEMA IF NOT EXISTS bpe_bot;

CREATE TABLE IF NOT EXISTS bpe_bot.bot_schema_meta (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version integer NOT NULL CHECK (version >= 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text CHECK (applied_by IN ('auto', 'manual', 'ci'))
);

CREATE TABLE IF NOT EXISTS bpe_bot.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL CHECK (length(btrim(keyword)) > 0),
  match_type text NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact', 'prefix', 'contains')),
  reply_type text NOT NULL DEFAULT 'text' CHECK (reply_type IN ('text', 'markdown')),
  reply_body text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  min_role text NOT NULL DEFAULT 'any' CHECK (min_role IN ('any', 'group_admin', 'platform_admin')),
  builtin boolean NOT NULL DEFAULT false,
  builtin_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((NOT builtin AND builtin_key IS NULL) OR
    (builtin AND builtin_key IS NOT NULL AND builtin_key IN ('warn', 'ban') AND min_role = 'group_admin'))
);
CREATE INDEX IF NOT EXISTS commands_matching_idx ON bpe_bot.commands (enabled, priority DESC, id);

CREATE OR REPLACE FUNCTION bpe_bot.protect_builtin_command() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.builtin THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Built-in commands cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF NEW.builtin IS DISTINCT FROM true OR NEW.builtin_key IS DISTINCT FROM OLD.builtin_key
       OR NEW.min_role IS DISTINCT FROM 'group_admin' THEN
      RAISE EXCEPTION 'Built-in command identity and permission are fixed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER commands_builtin_guard BEFORE UPDATE OR DELETE ON bpe_bot.commands
FOR EACH ROW EXECUTE FUNCTION bpe_bot.protect_builtin_command();

CREATE TABLE IF NOT EXISTS bpe_bot.bot_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text UNIQUE,
  event_type text NOT NULL,
  group_openid text,
  member_openid text,
  target_openid text,
  operator_openid text,
  content text,
  matched_command_id uuid REFERENCES bpe_bot.commands(id) ON DELETE SET NULL,
  action_type text NOT NULL DEFAULT 'message' CHECK (action_type IN ('message', 'approval', 'moderation', 'system')),
  action_param jsonb NOT NULL DEFAULT '{}'::jsonb,
  reply_status text NOT NULL DEFAULT 'pending',
  reply_body text,
  error text,
  msg_id text,
  member_role text,
  raw_event jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_logs_created_idx ON bpe_bot.bot_logs (created_at DESC, id);
CREATE INDEX IF NOT EXISTS bot_logs_group_created_idx ON bpe_bot.bot_logs (group_openid, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_logs_command_created_idx ON bpe_bot.bot_logs (matched_command_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_logs_status_created_idx ON bpe_bot.bot_logs (reply_status, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_logs_type_created_idx ON bpe_bot.bot_logs (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_logs_action_created_idx ON bpe_bot.bot_logs (action_type, created_at DESC);

CREATE TABLE IF NOT EXISTS bpe_bot.user_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id text NOT NULL,
  qq_member_openid text NOT NULL,
  qq_app_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (qq_app_id, qq_member_openid)
);
CREATE INDEX IF NOT EXISTS user_bindings_platform_idx ON bpe_bot.user_bindings (platform_user_id);

CREATE TABLE IF NOT EXISTS bpe_bot.join_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_openid text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('keyword', 'whitelist')),
  rule_value text NOT NULL,
  action text NOT NULL CHECK (action IN ('approve', 'reject')),
  reject_reason text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS join_policies_group_idx ON bpe_bot.join_policies (group_openid, enabled);

CREATE TABLE IF NOT EXISTS bpe_bot.token_cache (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bpe_bot.webhook_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text,
  event_type text,
  signature_valid boolean NOT NULL,
  processing_result text NOT NULL,
  http_status integer NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_requests_created_idx ON bpe_bot.webhook_requests (created_at DESC, id);

-- Claim BEFORE external side effects with INSERT ... ON CONFLICT DO NOTHING RETURNING event_id.
-- A failed/completed claim must be handled explicitly; lease expiry alone cannot prove
-- an external QQ API call was never delivered. Do not blindly replay uncertain sends.
CREATE TABLE IF NOT EXISTS bpe_bot.event_claims (
  event_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  msg_seq integer NOT NULL DEFAULT 0 CHECK (msg_seq >= 0)
);
CREATE INDEX IF NOT EXISTS event_claims_claimed_idx ON bpe_bot.event_claims (claimed_at);

INSERT INTO bpe_bot.commands
  (keyword, match_type, reply_type, reply_body, priority, min_role, builtin, builtin_key)
VALUES
  ('/warn', 'prefix', 'markdown', 'Please follow the group rules.', 1000, 'group_admin', true, 'warn'),
  ('/ban', 'prefix', 'text', 'Member muted.', 1000, 'group_admin', true, 'ban')
ON CONFLICT (builtin_key) DO NOTHING;
`;
