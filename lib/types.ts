import type { Command } from "./commands";

export type BotLog = {
  id: string;
  event_id: string;
  event_type: string;
  group_openid: string | null;
  member_openid: string | null;
  content: string | null;
  matched_command_id: string | null;
  reply_status: string;
  reply_body: string | null;
  error: string | null;
  created_at: string;
  action_type: string | null;
  action_param?: unknown;
  target_openid?: string | null;
  operator_openid?: string | null;
  msg_id?: string | null;
  member_role?: string | null;
};
export type Policy = {
  id: string;
  group_openid: string;
  rule_type: "keyword" | "whitelist";
  rule_value: string;
  action: "approve" | "reject";
  enabled: boolean;
  reject_reason?: string;
};
export type WebhookRequest = {
  id: string;
  created_at: string;
  event_type: string | null;
  signature_valid: boolean;
  processing_result: string;
  duration_ms: number;
  http_status?: number;
};
export type BotCommand = Command & { hits?: number[]; recent?: BotLog[] };
export type ConsoleState = {
  commands: BotCommand[];
  logs: BotLog[];
  policies: Policy[];
  requests: WebhookRequest[];
  settings: {
    configured: Record<string, boolean>;
    appId?: string;
    schemaMode?: string;
    schemaVersion?: number | null;
    schemaAppliedAt?: string | null;
    schemaAppliedBy?: string | null;
    token?: string;
    [key: string]: unknown;
  };
};
