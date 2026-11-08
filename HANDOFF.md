# BPE BOT 开发交接

更新日期：2026-11-08（Asia/Shanghai）。此文件记录实际代码状态；`README.md` 是原始产品设计，不代表所有验收项已完成。

## 本轮交付

在 `BPEBOT/` 建立了独立、可构建的 Next.js App Router 应用，六个管理页面已接真实管理 API。主要闭环为：复用平台管理员身份 → 指令配置与预览 → 接收签名事件 → 权限检查与去重 → 被动回复 → 查询日志。审批、警告、禁言目前保留草稿或显式未支持状态，不能对外宣称完整 V0.1 已上线。

本轮只新增或编辑 `BPEBOT/` 内文件，未修改主平台业务代码及账号表。仓库已有大量其他未提交修改，均不属于本轮交付；不要执行整仓库重置或清理。BPEBOT 现作为独立 Git 仓库维护；尚未部署。

## 接续入口

| 文件 | 职责 |
| --- | --- |
| `app/dashboard/[[...section]]/page.tsx` | 页面身份检查、未知路由处理、控制台入口 |
| `components/console.tsx` | 六个页面与主要交互，已格式化便于继续拆分 |
| `app/login/page.tsx` | 原平台登录链接、无权限 / 连接失败提示 |
| `app/api/admin/[...path]/route.ts` | Node.js 管理接口入口 |
| `app/api/webhook/route.ts` | Node.js QQ 回调入口 |
| `lib/auth.ts` | 平台会话转发、实时角色查询、同源检查、迁移 Token 验证 |
| `lib/api.ts` | 请求体限制、管理接口分发、QQ 回调处理和审计 |
| `lib/commands.ts` | 指令验证、匹配、预览、权限和管理指令解析 |
| `lib/qq.ts` | Ed25519、握手、Token 缓存、被动消息发送 |
| `lib/store.ts` | SQL 读写、筛选、趋势、事件声明与完成记录 |
| `lib/schema.ts`、`lib/db.ts` | 三种 Schema 模式、单实例初始化、跨实例迁移锁 |
| `migrations/001_initial.ts` | Schema 版本 1，全部位于 `bpe_bot` 命名空间 |
| `lib/types.ts` | 浏览器端数据类型，修改 API 时同步维护 |
| `DEVELOPMENT.md` | 启动、环境变量、平台登录前提与已知限制 |
| `PROTOCOL.md` | QQ 协议参考、消息格式和未开放能力 |

## 已验证

以下结果来自本机实际执行；浏览器与数据库测试使用独立临时数据库，结束后清理：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过；生产构建也执行了 TypeScript 检查 |
| `npm test` | 71 项通过，真实数据库集成入口默认跳过 1 项 |
| `BPEBOT_SCHEMA_INTEGRATION=1` 下 `npm run test:db` | 13 项通过，PostgreSQL 16.15 |
| `npm run test:ui` | 6 项通过，Windows 本机 Edge，无生产登录绕过逻辑 |
| `npm run build` | 通过，生成三个动态业务入口及登录页 |

数据库检查覆盖空库 auto / verify / skip、独立连接池并发初始化、服务器强制只读连接、幂等 DDL、真实 CRUD、去重声明、日志清空后继续去重、版本超前 / 落后、手动迁移、DDL 失败回滚与重试、两次真实 10 秒锁超时回退。

浏览器检查覆盖未登录及真实非管理员角色拦截、指令创建 / 编辑 / 重新加载持久化 / 启停 / 删除确认、三种预览结果、20 条日志分页及 URL 筛选和详情、设置脱敏、清空确认、审批草稿保存与拒绝启用、跨站写入拒绝、390px 手机导航和表单。

截图输出为本机忽略文件：`test-results/settings-desktop.png`、`test-results/command-mobile.png`，再次运行测试会重建。截图使用测试数据，不含真实平台凭据。

## 继续运行

```powershell
Set-Location D:/android_project/RadioWeb2/BPEBOT
npm ci
# 首次配置时复制 .env.example 为 .env.local，并填写自己的值
npm run dev
```

开发端口为 `3100`，管理入口 `/dashboard`。本轮没有生成可用于真实 QQ 应用的 `.env.local`，也没有把父目录密钥复制进 BPEBOT。需要 `DATABASE_URL`、显式的 `DB_SCHEMA_MODE`、高熵 `DB_SCHEMA_TOKEN`、平台连接地址及自己的 QQ 凭据。

登录依赖真实原平台会话，以及平台数据库 `public."user"` 中的实时管理员角色。生产独立域名若不能共享平台 Cookie，需先完成正式 SSO 设计；不能用固定管理员账号、浏览器 Token 或测试 Cookie 替代。开发时平台与 BPEBOT 使用同一主机名，不要混用 `localhost` 与 `127.0.0.1`。

本机 PostgreSQL 已启动以运行测试；临时浏览器服务 `3109` 和测试平台服务由测试关闭，临时数据库已删除。若重新开机需先在主项目目录执行 `npm run db:start`。单独部署本目录时，集成测试所需连接参数可由进程环境提供；测试也会读取父目录 `.env`。

## 不应破坏的约束

1. `verify` 不执行 DDL，`skip` 不初始化，失败不缓存 ready；手动迁移先验证请求头再接触数据库。Schema 升级应新增有序迁移，不要静默更改已部署版本。
2. 平台会话中的角色不是权威来源，管理员权限每次从平台数据库检查。所有管理写入检查实际 `Origin`；不要用请求的转发 Host 作为信任来源。
3. 预览和事件处理统一调用 `resolveCommand`，包含去除前导机器人 mention、trim 和 `/warn` / `/ban` 保留命名空间规则。`matchCommand` 是底层字面量匹配函数，不负责这些预处理。
4. QQ 消息 ID 允许标点，例如 `ROBOT1.0_...`；不要套用成员 OpenID 的正则。业务验签使用原始请求体字节，不能先 JSON 解析再重新序列化。无签名请求仅兼容两个签名头均缺失的 `op=13` URL 验证，不会执行业务事件；带有错误签名头的握手仍拒绝。
5. 内置管理指令不可删除或降低群管理员权限。当前无论平台管理员身份如何，群内管理指令都不能绕过群角色限制。
6. 发送外部消息前，先在数据库事务中声明事件和写入初始日志。清空日志必须保留 `event_claims`。发送超时后不自动重发，避免重复操作。
7. 审批规则当前默认关闭，服务端拒绝保存 `enabled=true`。开放真实执行前不能只改前端开关或移除 501 返回。
8. 日志时间、七日趋势采用上海时间。概览只代表最近最多 500 条日志，请勿将其改文案为完整全天统计而不改查询。

## 后续工作顺序

1. 使用目标 QQ 应用完成回调握手与 `/help` 真机闭环，验证网络白名单、群事件实际字段、Markdown 权限和重试时间戳。当前签名时间窗默认 300 秒 / 未来容忍 30 秒，属于本地策略。
2. 确定部署方式与平台会话共享方案；用真实平台完成管理员 / 普通用户 / 被撤销权限验证。
3. 核实目标机器人可用的入群申请、官方策略、禁言接口与管理员权限，再实现实际 Warn / Ban、审批执行、快捷管理与执行日志。目前 `approveJoin`、`muteMembers` 为显式未支持。
4. 实现 QQ 侧绑定 / 解绑流程，复用平台发起的一次性绑定凭据；不要另建用户系统，不保存 QQ 号码。
5. 接入共享 Redis Token 缓存和发送滑动窗口限流，并设计外部发送结果不确定、进程中断、事件声明悬挂后的人工对账与恢复。特别是外部发送成功但完成事务失败后，当前重试不会修复 pending 记录；不同顶层事件 ID 对应同一群消息时，还缺少数据库消息级幂等声明。这两项是已知待办，不应通过直接删除事件声明解决。
6. 根据生产连接方式评估 Neon serverless 驱动。当前为 `pg` 连接池，每实例最多 5 个机器人连接，平台角色池最多 3 个；未完成设计要求的驱动切换。
7. 继续补全全天聚合、环比、Token 剩余寿命等运维内容，并将原设计第 12 节逐项标记真实验收证据。此前不要标记 V0.1 全部完成。

目前没有正在运行的子任务需要依赖；代码、测试和交接信息均已落盘。

## 独立仓库交接（2026-11-08）

用户授权仅发布 BPEBOT，仓库名为 BPEBOT，公开可见；许可证原样沿用上级项目 AGPL-3.0。父项目代码、父项目 Git 历史、依赖目录、构建产物、测试截图和真实环境配置不进入此独立仓库。后续在本目录内进行提交。发布仓库不等于已部署，也不代表 Vercel CI 已启用。

## Vercel 部署交接（2026-11-08）

用户已授权通过 CLI 操作 Vercel，并已完成账号登录。原平台公网地址为 `https://radio.breezever.com`；首页与匿名 `/api/auth/get-session` 均验证 HTTP 200，匿名会话返回 null。

已创建并部署项目 `669497935qqcoms-projects/bpebot`，项目 ID `prj_tESwINAAps2PrxMP3JZEgMbBpAIX`，正式访问地址 `https://bpebot.vercel.app`。首轮部署 ID `dpl_97frbunqcfj8Log5ATbLPQqeZhXu` 已 Ready。GitHub 仓库 `aadddg/BPEBOT` 已连接自动部署。项目根目录为 `.`，Next.js 框架，云端 Node.js 26.x。本机重新执行生产构建通过。

已配置生产环境的 `PLATFORM_URL`、`APP_URL`、`DB_SCHEMA_MODE=verify`、随机生成的 `DB_SCHEMA_TOKEN`；平台地址同时配置了 Preview。迁移令牌只存 Vercel Secret 和本机被忽略的 `.env.local`，不要输出或提交。`.vercel/` 和 `.env.local` 均忽略。

待用户在 Vercel 项目设置中补充生产环境的 `DATABASE_URL`、`PLATFORM_DATABASE_URL`、`QQ_APP_ID`、`QQ_CLIENT_SECRET`，然后重新部署。若两个业务共用同一云端数据库，平台连接地址也可使用同一地址；不要上传父项目本机数据库口令，也不要使用 localhost。配置完成后以 `x-schema-token` 调用 `POST /api/admin/migrate` 初始化机器人 schema，验证后保持 verify 模式。尚未完成数据库初始化和真实 QQ 验收，不能称为完整上线。

生产登录仍待解决：上级网站 auth.ts 仅设置默认 Cookie 属性，没有跨子域 Cookie 配置；vercel.app 与 breezever.com 不能直接共享登录状态，仅给 Bot 分配兄弟子域也不保证会话自动共享。需要正式共享 Cookie 或同域代理/SSO 方案，不得绕过管理员身份检查。QQ 回调路径为 `/api/webhook`；接入前核对部署保护是否允许 QQ 的外部请求。

### 部署后验证补充

提交 `7ae51a5` 已由 GitHub 自动触发部署 `dpl_5wWJQynqYRZE8Zj6cV7Mth3Rk3Mi`，Vercel 显示 Ready，正式别名仍为 `https://bpebot.vercel.app`。本机对该域名的普通 HTTP 检查和 CLI curl 检查均超时，因此没有宣称页面访问或 QQ 回调已验证成功。CLI curl 自动创建了项目级 Protection Bypass for Automation secret；该 secret 未写入源码或输出值，后续可在 Deployment Protection 中撤销。未关闭部署保护。
