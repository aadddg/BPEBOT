> **实现状态（2026-11-08）**：管理界面、指令配置、QQ 签名验证和被动回复基础链路已实现；真实 QQ 应用联调及部分群管理功能仍待完成。下文保留原始设计，不代表全部功能已经交付。
>
> 启动与配置见 [DEVELOPMENT.md](./DEVELOPMENT.md)，实际进度与后续工作见 [HANDOFF.md](./HANDOFF.md)，协议说明见 [PROTOCOL.md](./PROTOCOL.md)。
>
> **许可证**：沿用上级项目的 GNU Affero General Public License v3.0，完整文本见 [LICENSE](./LICENSE)。

# BreezeverPlatform Evolution BOT · Design Specification V0.1

**Document status**: Draft · Ready for development  
**Document version**: V0.1.0 (includes database initialization constraints and group moderation feature additions)  
**Design baseline**: shadcn/ui Neutral theme · Next.js App Router · Vercel Serverless · Neon Postgres  
**One-sentence positioning**: Do not rebuild the user system; only bridge “QQ identity ↔ platform identity.” Do not build a skin over database tables; only answer the administrator’s questions: “Is anything wrong now?” and “Is my configuration working?”

---

## 1. Project Positioning and Boundaries

### 1.1 Positioning

BreezeverPlatform Evolution BOT (hereinafter “BPE BOT”) is the QQ-side extension of BreezeverPlatform and is responsible for four things:

1. **Message ingestion**: Receive QQ group @-mention messages and group join request events, and perform passive replies or automatic approvals according to platform configuration.
2. **Identity bridging**: Map `member_openid` from QQ events to existing platform users, reusing the platform’s administrator/regular-user roles.
3. **Group order**: Provide two basic group moderation capabilities under administrator permission: Warn (@-mention warning) and Ban (mute).
4. **Operational observability**: Allow administrators to determine whether the bot is healthy, which commands are working, and which join requests were rejected, without reading log files.

### 1.2 Explicitly Out of Scope for V0.1

- Do not rebuild the account system; do not provide platform user registration, passwords, or role editing.
- Do not store QQ numbers; do not attempt to obtain QQ numbers.
- Do not use WebSocket long connections.
- Do not perform time-consuming queries (such as Minecraft server status) inside the Webhook function; such capabilities are deferred to the asynchronous task endpoint in V0.3.
- Do not support multiple bot instances; V0.1 serves only a single AppID.
- Do not implement kicking users (the official group chat API does not provide this).
- Do not implement a rules engine for automatic enforcement (Warn/Ban are triggered manually by administrators only).

### 1.3 Relationship with the Platform

The platform is the **authoritative source of identity and roles**. BPE BOT adds only platform-related tables: `user_bindings` (binding relationships) and `bot_logs` (runtime records). The platform’s user table and role table are neither copied nor modified.

---

## 2. Design Principles

The V0.1 interface design follows four principles, in descending priority:

**P1 Answer “Is anything wrong?” first, then show data.**  
The first screen of the homepage is not a set of metric cards, but a status banner and an action-item list. When everything is normal, show only one sentence; when abnormal, list items by severity, each with a “Go handle it” action.

**P2 Show effects before configuration.**  
The commands page first shows “which commands are active, how many hits recently, which one has not been triggered,” and then enters editing. Configuration items (priority, match mode) are placed in details and do not occupy the main visual focus.

**P3 Configuration and runtime records are bidirectionally navigable.**  
Clicking a command name in the logs opens the corresponding command card; a command card shows recent hit records, and clicking one opens the logs.

**P4 Preview before saving.**  
The command edit dialog includes a simulated message input and shows in real time whether the message “hits this command” or “is captured by a higher-priority command.” Join-approval rules and moderation commands also provide previews.

---

## 3. System Architecture

```
QQ Open Platform
   │  POST /api/webhook (Ed25519 signature)
   ▼
Vercel Route Handler (Node.js Runtime)
   ├─ Read raw request body → verify signature → dispatch events
   ├─ Command matching (query commands table)
   ├─ Identity mapping (query user_bindings table)
   ├─ Moderation execution (Warn → send Markdown; Ban → restrict_chat_setting)
   ├─ Join approval (query join_policies table)
   ├─ Call QQ REST APIs for passive reply / approval / mute
   └─ Write bot_logs
        │
        ├─ Neon Postgres (primary storage)
        └─ Upstash Redis (token cache + rate limiting, optional)
```

**Runtime constraints**: Webhook processing must complete within the Vercel function time limit; message sending and log writing must be completed before the response; do not attach asynchronous tasks after the response.

---

## 4. Information Architecture

### 4.1 Navigation Structure

| Group         | Page               | Route                 | V0.1 Status                                                |
| ------------- | ------------------ | --------------------- | ---------------------------------------------------------- |
| Operations    | Overview           | `/dashboard`          | Fully implemented                                          |
| Operations    | Command Management | `/dashboard/commands` | Fully implemented (including built-in moderation commands) |
| Operations    | Message Logs       | `/dashboard/logs`     | List + detail drawer + quick moderation                    |
| Configuration | Join Approval      | `/dashboard/approval` | Rule CRUD + immediate approval                             |
| System        | Webhook Status     | `/dashboard/webhook`  | Recent requests + signature results                        |
| System        | System Settings    | `/dashboard/settings` | Read-only info + schema mode + danger zone                 |

### 4.2 Page Responsibilities

- **Overview**: Status banner → action items → today’s narrative → group activity → recent timeline.
- **Command Management**: Summary → command card list (active status, 7-day sparkline, recent hits, test entry) → built-in moderation command section → create/edit dialog (with preview).
- **Message Logs**: Filter bar → table → detail drawer (raw event fields, reply content, error reason, quick moderation actions).
- **Join Approval**: Path explanation Alert → rule list → rule dialog → sync official strategy button.
- **Webhook Status**: Callback URL + recent request metrics + troubleshooting tips + request table.
- **System Settings**: Bot information, token status, environment variable checklist, schema mode display, clear-logs danger zone.

---

## 5. Visual Design System

### 5.1 Design Tokens

V0.1 uses shadcn/ui Neutral theme tokens. All colors are stored as HSL triplets, and components reference only semantic variables, never raw color values.

| Token                    | Light value      | Usage                                       |
| ------------------------ | ---------------- | ------------------------------------------- |
| `--background`           | `0 0% 100%`      | Page background                             |
| `--foreground`           | `240 10% 3.9%`   | Primary text                                |
| `--card`                 | `0 0% 100%`      | Card background                             |
| `--card-foreground`      | `240 10% 3.9%`   | Card text                                   |
| `--primary`              | `240 5.9% 10%`   | Primary buttons, selected state, sparklines |
| `--primary-foreground`   | `0 0% 98%`       | Primary button text                         |
| `--secondary`            | `240 4.8% 95.9%` | Secondary buttons, sidebar active state     |
| `--secondary-foreground` | `240 5.9% 10%`   | Secondary button text                       |
| `--muted`                | `240 4.8% 95.9%` | Placeholder background, progress track      |
| `--muted-foreground`     | `240 3.8% 46.1%` | Helper text, descriptions                   |
| `--accent`               | `240 4.8% 95.9%` | Hover background                            |
| `--accent-foreground`    | `240 5.9% 10%`   | Hover text                                  |
| `--destructive`          | `0 84.2% 60.2%`  | Dangerous actions                           |
| `--border`               | `240 5.9% 90%`   | Borders, dividers                           |
| `--input`                | `240 5.9% 90%`   | Input borders, Switch track                 |
| `--ring`                 | `240 5.9% 10%`   | Focus ring                                  |
| `--radius`               | `0.5rem`         | Base radius                                 |

**Derived radii**: `--radius-sm = calc(var(--radius) * 0.6)`, `--radius-md = calc(var(--radius) * 0.8)`, `--radius-lg = var(--radius)`, `--radius-xl = calc(var(--radius) * 1.5)`. Buttons and inputs use `radius-sm`; cards use `0.75rem` (shadcn Card default); badges use `999px`.

### 5.2 Typography

- Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`.
- Size scale: `xs 12px` / `sm 14px` / `base 16px` / `lg 18px` / `2xl 24px`.
- Line height: body `1.5`, headings `1.3`, compact labels `1`.
- Font weights: regular `400`, labels/buttons `500`, headings `600`.

### 5.3 Spacing and Sizing

- Base spacing unit `4px`; common values `4 / 8 / 12 / 16 / 24 / 32`.
- Control heights: default **36px**, small **32px**, icon button **36×36**.
- Card padding: `16px`; card gap: `12–16px`.
- Page container padding: desktop `24px`, mobile `16px`.
- Sidebar width: `240px`; header height: `56px`.

### 5.4 Shadows and Borders

- Card: `border 1px --border` + `shadow: 0 1px 2px rgb(0 0 0 / 0.05)`. Do not use large shadows.
- Dialog: `shadow-xl`, overlay `bg-black/40`.
- Focus: `box-shadow: 0 0 0 2px hsl(var(--ring) / 0.2)`.

### 5.5 Status Colors (Semantic Extension)

In addition to the Neutral tokens, V0.1 defines four status semantics for badges, status dots, and timelines:

| Semantic | Background   | Text/dot          | Usage                                                  |
| -------- | ------------ | ----------------- | ------------------------------------------------------ |
| Success  | `emerald-50` | `emerald-600/700` | Replied, signature passed, rule approved, warning sent |
| Warning  | `amber-50`   | `amber-600/700`   | Not triggered in 7 days, signature failure pending     |
| Danger   | `red-50`     | `red-600/700`     | Reply failed, delete, reject, mute failed              |
| Info     | `blue-50`    | `blue-600/700`    | Join request, external event, moderation action        |

Status colors are used only for “status” itself, not for decoration. If more than three status colors appear on one page, check whether the information hierarchy has gotten out of control.

---

## 6. Component Specification

### 6.1 Button

| Variant       | Background      | Border     | Text                       | Usage                       |
| ------------- | --------------- | ---------- | -------------------------- | --------------------------- |
| `primary`     | `--primary`     | none       | `--primary-foreground`     | Main page action, save      |
| `outline`     | `--background`  | `--border` | `--foreground`             | Secondary action, cancel    |
| `ghost`       | transparent     | none       | `--foreground`             | Inline action, table button |
| `destructive` | `--destructive` | none       | `--destructive-foreground` | Delete, mute confirmation   |

Sizes: default 36px, `sm` 32px. Hover uniformly moves toward `--accent` or reduces primary opacity. Disabled state: `opacity-50` and not clickable.

### 6.2 Input / Select / Textarea

- Height 36px, border `--input`, radius `radius-sm`, padding `0 12px`.
- Placeholder uses `--muted-foreground`.
- On focus, border becomes `--ring` plus a 2px soft ring.
- Textarea minimum height 80px, vertically resizable.

### 6.3 Badge

- Height 22px, radius 999px, font size 12px, font weight 500.
- Variants: `secondary` (default, type label), `outline` (match mode), `destructive` (reject), status-color variants (reply status), `info` (moderation marker).
- One badge carries only one semantic; do not stack icons and multiple text segments.

### 6.4 Switch

- Track 36×20px, thumb 16×16px. When `data-state="checked"`, track is `--primary` and thumb translates 16px.
- Must have `role="switch"` and `aria-checked`.
- Toggling takes effect immediately with Toast feedback; no second confirmation (except for delete-type actions).

### 6.5 Card

- Radius 12px, border `--border`, background `--card`, shadow `sm`.
- Do not nest cards inside cards; use dividers or `--muted` background blocks for grouping.
- Card title 14px / 600; description 12px / `--muted-foreground`.

### 6.6 Dialog

- Max width 640px, mobile 94vw, max height 88vh.
- Fixed structure: title area (title + description), content area (scrollable), action area (right-aligned).
- Overlay click closes; dangerous-action dialogs must include a confirmation input or an explicit destructive button variant.

### 6.7 Table

- Header 40px, font 12px / 500 / `--muted-foreground`.
- Row height 44–48px, row divider `--border`, hover `--muted / 0.5`.
- Tables are used only for “homogeneous record lists” (logs, rules, requests), not for “configuration card lists.”
- On mobile, the table container scrolls horizontally, with key columns pinned left.

### 6.8 Sidebar

- Width 240px, background `--card`, right border `--border`.
- Group title 11px / uppercase / `--muted-foreground`.
- Menu item 36px high, radius `radius-sm`, default `--muted-foreground`, hover `--accent`, active `--secondary` + 500 weight.
- Collapsed by default on mobile; expanded as a drawer via the header button.

### 6.9 Status Dots and Sparklines

- **Status dot**: 8px dot + 12px text, three states: active (emerald), not triggered (amber), disabled (muted-foreground).
- **Sparkline**: 7 bars, 2px wide, height normalized by daily hit count; zero values use `--border`, non-zero use `--primary`. No axes; expresses trend only.

### 6.10 Toast

- Stacked at bottom right, radius `radius-md`, border + light background, font size 14px.
- Three semantics: success (emerald), failure (red), neutral (white).
- Fades out after 2.2s, removed after 2.6s. At most 3 at a time; older entries are removed immediately when exceeded.

---

## 7. Page Specification

### 7.1 Overview `/dashboard`

**Top-to-bottom structure**:

1. **Status banner**: When normal, green “Running normally; nothing needs your attention” + consecutive running days; when abnormal, amber “N items need your attention.”
2. **Action-item list**: Each item includes an icon, title, description, and “Go handle it” button. Sorted by severity, warnings first, then notices.
3. **Today’s narrative**: One sentence connecting today’s message count, hit count, failure count, approval count, and moderation action count; numbers in bold.
4. **Group activity**: Horizontal bar chart showing message volume and period-over-period trend for each group. Declines in red text, increases in green.
5. **Recent events**: Vertical timeline in reverse chronological order, with colored dots distinguishing message hits (green), join approvals (blue), moderation actions (blue), system errors (red), and misses (gray).

**Empty states**: When there are no action items, show only the status banner; when there is no group data, show “No group messages received yet.”

### 7.2 Command Management `/dashboard/commands`

**Structure**:

1. **Summary row**: Total commands, enabled count, total hits in the last 7 days, most active command name.
2. **Command card list**: Each card contains:
   - First row: keyword (large), match-mode badge, reply-type badge, status dot + status text, enable Switch, edit button.
   - Second row: first line of reply content preview, up to two lines.
   - Third row: 7-day sparkline + hit count, recent hit records (up to two, clickable to logs), “Test it” button.
   - Expanded area: simulated message input + real-time match result. If it hits this command, show a green reply preview; if captured by a higher-priority command, show an amber notice naming the capturer.
3. **Built-in moderation command section**: A separate group containing `/warn` and `/ban`. Cards carry a “Moderation” badge; permission is fixed to `group_admin` and cannot be downgraded. See 7.7.
4. **Create/edit dialog**:
   - Fields: keyword, match mode, priority, reply type, reply content, enabled, minimum role (`any` / `group_admin` / `platform_admin`).
   - Built-in “preview before saving”: enter a simulated message and see the match result in real time, using the current form values in priority comparison.
   - Save button is disabled when the keyword is empty.

**Sorting**: Custom commands are sorted by priority descending, matching runtime order; built-in moderation commands are fixed in the top section.

**Empty state**: Guide the user to create a `/help` template.

### 7.3 Message Logs `/dashboard/logs`

- **Filter bar**: Event type, reply status, group OpenID, action type (message / approval / moderation), time range (custom range added in V0.2).
- **Table columns**: Time, event type, group, sender, content summary, matched command, reply status, view.
- **Detail drawer**:
  - Full message content, key raw event fields (`msg_id`, `member_role`).
  - Reply content, failure reason, matched-command jump link.
  - **Quick moderation area**: If the log target is a regular member and the viewer has moderation permission, show “Warn this user” and “Mute this user” buttons; clicking opens the moderation confirmation dialog in 7.7.
- **Pagination**: 20 per page; filter conditions written to URL `searchParams`.
- **Empty-state distinction**: “No logs yet” vs. “No results for filters”; the latter provides “Clear filters.”

### 7.4 Join Approval `/dashboard/approval`

- **Top Alert**: Explains the two paths (event-driven immediate approval / official automatic strategy), execution-timing differences, and the group-admin prerequisite.
- **Rule table**: Group, rule type, rule value, action, enabled, operations.
- **Rule dialog**: Group OpenID, rule type (keyword / whitelist), rule value, action (approve / reject), reject reason (shown when action = reject), enabled.
- **Sync button**: Click, confirm, enter pending, then show success and failure counts via Toast + Alert.
- **Prerequisite notice**: If the bot is not a group admin, show a warning when saving a rule.

### 7.5 Webhook Status `/dashboard/webhook`

- **Callback URL card**: URL + copy button.
- **Metrics area**: Last request time, last signature result, last event type, HTTP status.
- **Troubleshooting tips card**: When signature verification fails, list checks (`QQ_CLIENT_SECRET`, raw request body, signature header).
- **Risk notice**: Explain that IP whitelisting may block Vercel callbacks.
- **Request table**: Time, event type, signature result, processing result, duration.

### 7.6 System Settings `/dashboard/settings`

- **Bot information**: Masked AppID, token status, remaining time, token cache source.
- **Database status**: Read-only display of the current `DB_SCHEMA_MODE`, `bot_schema_meta.version`, and the time/source of the most recent schema creation/migration (`auto` / `manual` / `ci`). Do not display `DB_SCHEMA_TOKEN`.
- **Environment variable checklist**: Show only “configured / not configured”; do not display values.
- **Danger zone**: Clear message logs; requires typing “confirm clear” before execution.

### 7.7 Group Moderation (Warn / Ban)

**Positioning**: Give the bot the most basic group-order maintenance capability, triggered by commands available to group administrators. V0.1 implements only **Warn (@-mention warning)** and **Ban (mute)**. Kicking users is outside the official capability boundary and is not included in V0.1.

#### Warn

- **Behavior**: Send a Markdown message in the group, marking the target user via `<qqbot-at-user id="{member_openid}" />`, with the message body set to the configured warning text.
- **Technical constraints**: In group chats, @-mentioning a user **supports only Markdown messages**; `id` must be the target member’s `member_openid`; the old format `<@userid>` is being deprecated and must not be used.
- **Triggers**:
  - In-group command: an administrator sends `/warn @someone reason`.
  - Panel action: click “Warn this user” on a log record in the detail drawer.
- **Permission guard**: The triggerer’s `member_role` is `admin` or `owner`, or the user is determined to be a platform administrator via `user_bindings`.
- **Text configuration**: The built-in `/warn` command card allows editing the warning text template, supporting placeholders `{target}` (@target), `{reason}`, and `{operator}`.

#### Ban (Mute)

- **Behavior**: Call the official group-member mute API to set a mute duration for the target `member_openid`. V0.1 presets: 10 minutes / 1 hour / 1 day / custom (maximum 30 days).
- **Official API**: `POST /v2/groups/{group_openid}/restrict_chat_setting`; in the `members` array, set `op` to `add`, `member_openid` to the target user, and `mute_expire_at` to the expiry time; to unmute, use `op: del`.
- **Hard limits**:
  - The bot **must be a group administrator**.
  - It **can operate only on regular members**; it cannot mute the group owner, other administrators, or itself.
  - API rate limit **60 QPM**.
  - At most **20 members** per request.
- **Batch support**: V0.1 allows muting up to 20 `member_openid`s at once; the panel’s batch selection limit aligns with the official constraint.
- **Confirmation interaction**: A Ban initiated from the panel must go through a confirmation dialog showing the target OpenID, mute duration, and reason; the confirm button uses the destructive variant. A Ban initiated by an in-group command echoes the result in the command reply.

#### Relationship with Accountability

- Every Warn and Ban execution writes to `bot_logs`, recording: action type (`warn` / `ban`), target `member_openid`, operator `member_openid`, `group_openid`, reason, mute duration (ban), execution result, and error reason.
- The log detail drawer shows quick actions “Warn this user again / Mute this user,” visible only when the current viewer has moderation permission.
- This is the **execution layer** of in-group accountability: platform accountability toward developers is an external constraint; Warn/Ban are self-discipline measures that administrators apply to specific openids within the group. The two are not conflated.

#### Admin Panel Placement

- The command management page adds two **built-in moderation commands** (not deletable; only text, duration presets, and enabled state are editable): `/warn`, `/ban`.
- Command cards carry a “Moderation” badge; the permission requirement is fixed to `group_admin` and cannot be downgraded to `any`.
- The `/ban` card embeds a mute-duration selector (multi-select presets); the `/warn` card embeds a warning-text editor.
- The log detail drawer shows quick action buttons for the target `member_openid`.

#### Explicitly Out of Scope for V0.1

- Kicking users (the official group chat API does not provide this).
- Mute-all (can be evaluated in V0.2).
- Automatic Warn/Ban triggering (V0.1 supports only manual command or panel-triggered actions; no rules-engine automatic enforcement).

---

## 8. Interaction Specification

### 8.1 Feedback

- All write operations: the button enters pending state (disabled + text change); on success, show Toast; on failure, show Toast + keep the dialog content for correction.
- Delete and mute operations: always require a second confirmation; the confirm button uses the destructive variant.
- List switching, filtering, pagination: use skeleton screens or translucent loading states; do not flash the whole page.

### 8.2 Preview

- The preview inside the command edit dialog updates in real time; no need to click a “Test” button.
- The preview result must distinguish three cases: hits this command, captured by another command, no match.
- Moderation command previews additionally show “whether it will be blocked due to insufficient permission” and “whether the target is a muteable member.”
- Previews do not write to the database and do not generate logs.

### 8.3 Navigation

- Clicking an action item on the overview goes directly to the corresponding page with positioning parameters (e.g., logs filtered by `event_id`).
- Clicking a command name in the logs opens command management and highlights the corresponding card.
- Clicking a recent hit record on a command card opens the logs with prefilled filters.
- After executing a quick moderation action in the log detail drawer, stay in the current drawer and refresh the record status.

### 8.4 Responsiveness

- Desktop sidebar is always present; mobile uses a drawer with overlay, closing automatically after selection.
- Tables scroll horizontally on narrow screens, with the first column and action column pinned.
- Dialogs occupy 94vw on narrow screens; content area scrolls independently.

### 8.5 Accessibility

- All interactive elements are keyboard-focusable; focus ring uses `--ring`.
- Switch, Dialog, and Toast carry necessary ARIA attributes.
- Status is not expressed by color alone; text must accompany status dots (“active / not triggered / disabled”).
- The mute confirmation dialog must clearly announce the target and duration.

---

## 9. Data Contract and Database Initialization Constraints

### 9.1 Core Tables

| Table             | Key fields                                                                                                                                                                                                                        | Description                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`        | `id`, `keyword`, `match_type`, `reply_type`, `reply_body`, `priority`, `enabled`, `min_role`, `builtin`, `builtin_key`                                                                                                            | Command configuration, matched by priority descending; built-in moderation commands have `builtin=true` and `builtin_key` of `warn` / `ban`; not deletable |
| `bot_logs`        | `id`, `event_id` (unique), `event_type`, `group_openid`, `member_openid`, `target_openid`, `operator_openid`, `content`, `matched_command_id`, `action_type`, `action_param`, `reply_status`, `reply_body`, `error`, `created_at` | Runtime records; unique index on `event_id` for deduplication; moderation operations recorded in `action_type` / `action_param`                            |
| `user_bindings`   | `id`, `platform_user_id`, `qq_member_openid`, `qq_app_id`, `status`, `bound_at`                                                                                                                                                   | Identity bridge; unique constraint on `(qq_app_id, qq_member_openid)`                                                                                      |
| `join_policies`   | `id`, `group_openid`, `rule_type`, `rule_value`, `action`, `enabled`                                                                                                                                                              | Join-approval rules                                                                                                                                        |
| `token_cache`     | `id` (fixed 1), `access_token`, `expires_at`                                                                                                                                                                                      | Token cache; can be replaced by Redis                                                                                                                      |
| `bot_schema_meta` | `id` (fixed 1), `version`, `applied_at`, `applied_by`                                                                                                                                                                             | Schema version metadata, maintained by the schema initialization process                                                                                   |

### 9.2 Identity and Permission Decision Order

1. After a command is matched, read `min_role`.
2. `any`: execute directly.
3. `group_admin`: check whether the event’s `member_role` is `admin` or `owner`.
4. `platform_admin`: look up `(app_id, member_openid)` in `user_bindings` → `platform_user_id` → query the platform role.
5. Moderation commands (`/warn`, `/ban`) strictly require `group_admin`; platform administrators cannot bypass the in-group role restriction to execute a mute (platform administrators may initiate from the panel, but are still subject to the official limit that administrators/owners cannot be operated on).
6. If not satisfied, write a log (`reply_status = denied`), do not reply, or reply with a fixed message.

**Constraints**: `member_openid` is not used as the platform user primary key; binding is initiated only from the QQ side; unbinding verifies that the initiator’s OpenID matches the binding record.

### 9.3 Schema Initialization Control Variables

Two environment variables are added; **both must exist**, neither is optional:

| Variable          | Values                     | Default  | Purpose                                                                            |
| ----------------- | -------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `DB_SCHEMA_MODE`  | `auto` / `skip` / `verify` | `verify` | Determines schema initialization behavior                                          |
| `DB_SCHEMA_TOKEN` | Any high-entropy string    | none     | Idempotent lock token for `auto` mode, and the credential for `/api/admin/migrate` |

**Three mode semantics**:

| Mode     | Behavior                                                                                                                                                                                                             | Use case                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `auto`   | Before the first database operation, check the `bot_schema_meta` table; if the table does not exist or the version is behind, run schema creation/migration; after successfully writing the version number, continue | First deployment, development, staging                                                                   |
| `skip`   | **Do not check and do not create tables**; execute reads/writes directly; if a table does not exist, the database reports an error and it is handled as a normal error                                               | Tables already created by an external tool (e.g., `drizzle-kit push` in CI); runtime only reads/writes   |
| `verify` | **Check only, do not create tables**: check that `bot_schema_meta` exists and its version equals the code’s expected value; if not, throw and return 503                                                             | Recommended production default; prevents silent operation when code and database schema are inconsistent |

**Constraint**: `auto` is not the production default. Production must explicitly set `auto` to allow runtime table creation, and that value should be used only for a one-time first deployment, then changed back to `verify`.

### 9.4 Schema Initialization Trigger Timing and Execution Location

Vercel Serverless **has no process startup hook**, so “create tables at startup” cannot be used. Constraints:

**Lazy one-time execution**: Schema checks are placed inside the database client initialization function, not manually called in every Route Handler:

```
getDb():
  1. Read module-level cached dbReady flag; if true, return the connection directly
  2. If DB_SCHEMA_MODE === 'skip' → mark ready and return
  3. Acquire a Postgres advisory lock (key derived from DB_SCHEMA_TOKEN hash, timeout 10s)
  4. Check whether bot_schema_meta exists and its version
  5. auto: if not satisfied, run schema creation/migration → write version → release lock → ready
     verify: if not satisfied, release lock → throw SchemaMismatchError
  6. Release lock, set dbReady = true
```

**Constraints**:

- The module-level cache guarantees only **within a single instance** that it runs once; cross-instance concurrency is handled by the advisory lock to prevent concurrent table creation.
- The lock must have a timeout (recommended 10s). If the lock cannot be acquired, **do not block the request**; instead follow `verify` logic to check the version, continue if correct, otherwise return 503.
- Schema creation logic must be **idempotent**: all `CREATE TABLE` use `IF NOT EXISTS`, all indexes use `CREATE INDEX IF NOT EXISTS`, migrations execute in increasing version order, and already-applied versions are skipped.

**Manual trigger endpoint**: Provide `POST /api/admin/migrate`:

- Validate that the `x-schema-token` header equals `DB_SCHEMA_TOKEN`; otherwise 401.
- Internal logic is the same as `auto` mode, but **ignores `DB_SCHEMA_MODE`**, used to manually create tables in `skip` mode.
- Returns `{ applied: [...], currentVersion, ok: true }`.
- This endpoint does not write business logs; it writes only `bot_schema_meta`.
- This endpoint must remain available in production but with authentication; do not rely on it for routine migrations; routine migrations are still recommended in CI.

### 9.5 Metadata Table Constraints

```
bot_schema_meta
  id            int primary key default 1  -- fixed single row
  version       int not null
  applied_at    timestamptz not null
  applied_by    text                       -- 'auto' | 'manual' | 'ci'
```

**Constraints**:

- `version` must equal the `SCHEMA_VERSION` constant in the code; if inconsistent, `verify` mode refuses to start.
- This table itself must also be created on the first run in any mode (except `skip` mode).
- Business code is not allowed to read or write this table directly.

### 9.6 Failure Matrix

| Scenario                        | `auto`                                                                       | `verify`                            | `skip`                                                                |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Metadata table does not exist   | Create and continue                                                          | Return 503, `SchemaMismatchError`   | Do not check; continue reads/writes (database error if table missing) |
| Version behind                  | Run migration and continue                                                   | Return 503, prompt to run migration | Do not check; continue reads/writes                                   |
| Version ahead (code older)      | Return 503; refuse downgrade                                                 | Return 503                          | Do not check                                                          |
| Cannot acquire advisory lock    | Follow verify logic to check version; continue if correct, otherwise 503     | Same as left                        | Not applicable                                                        |
| Schema creation execution fails | Record error, return 503, **do not cache ready flag**; retry on next request | Not applicable                      | Not applicable                                                        |

**Constraints**:

- When any mode returns 503, the Webhook endpoint must return 503 rather than 200, so QQ platform retries according to failure (combined with event deduplication, this will not cause duplicate processing).
- Error messages must not contain connection strings, tokens, or full SQL; record only error type and version number.

### 9.7 Permission and Connection Constraints

- **V0.1 simplification**: Schema creation and reads/writes share `DATABASE_URL`; no separate migration account is introduced. The premise is that the Neon connection string has DDL permission.
- **If a least-privilege account is introduced later**: `auto` and `/api/admin/migrate` must use a separate `DATABASE_MIGRATION_URL`; `DB_SCHEMA_MODE=auto` **must fail to start** when this variable is missing, and must not fall back to the read/write connection string.
- `DATABASE_URL` and `DB_SCHEMA_TOKEN` are injected only via Vercel environment variables; they must not be written to the codebase, logs, or displayed in the panel.

### 9.8 Relationship with CI/CD

Recommended production flow:

1. **CI stage**: Before deployment, run `drizzle-kit push` or a migration script using `DATABASE_MIGRATION_URL`, then write `bot_schema_meta`.
2. **Vercel environment variables**: Set production to `DB_SCHEMA_MODE=verify`; generate and store `DB_SCHEMA_TOKEN` randomly.
3. **First-deployment exception**: If CI is unavailable, temporarily set `DB_SCHEMA_MODE=auto` to complete the first schema creation, then immediately change it back to `verify` and redeploy.

**Constraint**: `auto` must not remain in production for more than one deployment cycle; the “System Settings” page displays the current `DB_SCHEMA_MODE` value (read-only) to detect configuration drift.

---

## 10. Non-Functional Requirements

| Category      | Requirement                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security      | Sensitive configuration injected only via environment variables; the panel does not display plaintext; binding relationships are read-only in the panel; `/api/admin/migrate` requires token authentication |
| Performance   | Command list first screen < 1s; Webhook processing P95 < 500ms; log pagination queries use indexes                                                                                                          |
| Reliability   | Event deduplication based on `event_id`; passive replies must carry `msg_id` and increment `msg_seq`; schema creation is idempotent and runs once per instance                                              |
| Observability | Each Webhook request records signature result, event type, processing result, and duration; moderation operations separately record target and result                                                       |
| Compatibility | Node.js Runtime; Neon serverless driver; do not use Edge Runtime’s TCP dependencies                                                                                                                         |
| Theme         | Light theme is default; tokens reserve `.dark` override capability; V0.1 does not provide a toggle                                                                                                          |
| Rate limiting | Sending is protected by a Redis sliding window; mute API respects 60 QPM and 20 members per request                                                                                                         |

---

## 11. Deployment Prerequisites and Risk List

Before V0.1 development begins, the following must be confirmed:

1. **Whether Webhook requires IP whitelisting**. If required, Vercel’s non-fixed outbound IPs are a blocker, and a fixed-IP reverse proxy is needed in front.
2. **Whether the `GROUP_JOIN_REQUEST` event is available for the target bot type**. The bot must actually be set as a group administrator and event push tested.
3. **Vercel function time limit**. The Webhook chain must complete within the limit; time-consuming queries must not run synchronously.
4. **Database access method**. Vercel’s built-in Postgres/KV are discontinued; connect to Neon/Upstash via Marketplace.
5. **Actual availability of the mute API**. The official group chat API explicitly exists, but `restrict_chat_setting` permissions and rate behavior must be tested after setting the bot as group administrator in the target group.
6. **Lack of kick capability**. The official group chat API does not provide kicking; if the business requires it, evaluate the risk of unofficial paths separately; not included in V0.1.

If any of the above is unconfirmed, the corresponding feature is marked “to be verified” and does not enter acceptance.

---

## 12. Acceptance Criteria

1. Administrators can log in and access `/dashboard/*`; unauthenticated users are redirected.
2. After creating a `/help` command, sending `/help` with an @-mention in a group receives the correct reply.
3. Command cards display the 7-day sparkline, recent hit records, and status dot.
4. The preview in the command edit dialog correctly distinguishes “hits this command,” “captured by higher priority,” and “no match.”
5. Log details show `msg_id`, reply content, and failure reason; command names are clickable.
6. After enabling a join rule, qualifying requests are automatically approved or rejected and written to logs.
7. The Webhook status page shows recent requests, signature results, and troubleshooting tips.
8. All delete operations require second confirmation; all write operations have pending and Toast feedback.
9. Mobile can complete command creation, test preview, and log viewing.
10. Pages do not display sensitive values such as ClientSecret or database connection strings.
11. With `DB_SCHEMA_MODE=auto` and an empty database, the first request automatically creates tables and writes `bot_schema_meta` with the correct version.
12. With `DB_SCHEMA_MODE=verify` and matching versions, reads/writes work normally and no DDL is executed.
13. With `DB_SCHEMA_MODE=verify` and mismatched versions, the Webhook returns 503 and error messages contain no sensitive fields.
14. With `DB_SCHEMA_MODE=skip` and tables created externally, reads/writes work normally and no schema-creation logs are produced.
15. When two Vercel instances make concurrent first requests, table creation runs only once and no duplicate DDL errors occur.
16. `/api/admin/migrate` returns 401 with a wrong token, and returns the applied version list with a correct token.
17. The system settings page displays `DB_SCHEMA_MODE` and `bot_schema_meta.version` read-only, and does not display `DB_SCHEMA_TOKEN`.
18. A group administrator sends `/warn @member reason`; a correct Markdown warning @-mentioning that member appears in the group, and the log is complete.
19. A group administrator sends `/ban @member 10m`; the member is muted, and `bot_logs` records target, operator, duration, and result.
20. A non-administrator sends `/warn` or `/ban`; it is rejected with `reply_status = denied`, and no visible group reply is produced, or only a fixed message is returned.
21. Executing `/ban` on the group owner or an administrator is rejected by the platform; the log records the failure reason and the bot does not crash.
22. The quick “Warn this user” / “Mute this user” actions in the log detail drawer are visible only to viewers with moderation permission, and the current record status refreshes after execution.
23. When a single mute operation targets more than 20 members, the frontend blocks it and shows the official limit.

---

## 13. Roadmap

| Version  | Content                                                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V0.1** | Overview, command management (including built-in moderation), logs (including quick moderation), join approval, Webhook status, system settings; identity bridge table; schema control variables and metadata table; passive reply + Warn/Ban loop |
| V0.2     | Log aggregation views (by group / by command), approval rule preview, time-range filtering, custom log retention policy, mute-all evaluation                                                                                                       |
| V0.3     | Asynchronous time-consuming commands (QStash + active messages), server status query configuration, batch moderation panel                                                                                                                         |
| Later    | Multiple bot instances, `union_openid` application and cross-application identity, dark theme toggle, evaluation of unofficial kick paths                                                                                                          |

---

## 14. Appendix

### 14.1 Identity and Accountability Notes

- **QQ numbers are unavailable**: Official bot scenarios return only `openid`; `union_openid` / `union_user_account` are not QQ numbers, require special application, and are returned only when member information is fetched separately.
- **Accountability targets the developer/operating entity**: When a bot violates rules, the platform takes action against the bot and the operating entity; it does not depend on locating a specific QQ user.
- **In-group execution layer**: Warn and Ban are both based on `member_openid` and do not require a QQ number; mute is an official native capability, kick is not.
- **Stability of `member_openid`**: It can be used as a scenario-specific association key, but should not be used as the platform user primary key; global keys must include `app_id`.

### 14.2 AT Syntax Reference

| Scenario               | Syntax                                   | Message type                 | Constraint                                         |
| ---------------------- | ---------------------------------------- | ---------------------------- | -------------------------------------------------- |
| Group chat @user       | `<qqbot-at-user id="{member_openid}" />` | Markdown                     | `id` is the group member’s `member_openid`         |
| Text sub-channel @user | `<qqbot-at-user id="{user_openid}" />`   | Text / rich media / Markdown | `id` is the user’s `user_openid`                   |
| @all members           | `<qqbot-at-everyone />`                  | Text / Markdown              | Bot is group administrator; once per group per day |
| Legacy format          | `<@userid>`                              | —                            | **Deprecated; must not be used**                   |

### 14.3 Passive Reply Constraints

- Passive replies must carry the triggering message’s `msg_id`.
- Validity period is approximately **5 minutes**; the API fails after timeout.
- Multiple replies to the same `msg_id` must increment `msg_seq`, otherwise they are treated as duplicates.
- Sending and log writing must complete before the Webhook response.

### 14.4 Mute API Constraints

- Endpoint: `POST /v2/groups/{group_openid}/restrict_chat_setting`.
- `op: add` mutes; `op: del` unmutes; `mute_expire_at` is the expiry time.
- Rate limit **60 QPM**; at most **20 members** per request.
- The bot must be a group administrator; it cannot operate on the group owner, other administrators, or itself.

---

**End of specification.** This document is the design baseline for V0.1. Any deviation must be justified in review and accompanied by a version update.
