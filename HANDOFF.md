# BPE BOT 开发交接

更新日期：2026-11-08（Asia/Shanghai）。此文件记录实际代码状态；`README.md` 是原始产品设计，不代表所有验收项已完成。

## 群聊警告指令修复（2026-11-08）

用户实群 `/warn` 回调验签通过但返回 unsupported，原因是此前执行分支仍为占位。现接通启用的内置 `/warn`：仅签名事件携带群主 / 管理员角色时发送被动 Markdown 警告，支持目标、原因与操作者模板。单独 `/warn` 或无效参数只发文字用法提示，日志 `action_param.outcome=usage`，不声称警告执行成功。保留禁用与权限检查、事件去重、失败不重发；禁言、审批和控制台快捷管理仍未开放。未改数据库版本或平台 SSO。

验证：常规测试 85 项通过、2 项按需数据库入口跳过，新增覆盖群主警告、实参缺失、禁用、权限拒绝、旧模板、嵌套角色、原因转义与发送失败去重。真实群的警告送达和 @成员展示需用户再次发送消息验收。详细行为见 `PROTOCOL.md`。

## 配置误报修复（2026-11-08）

概览和设置页共用的配置检查已按登录模式修正：`PLATFORM_DATABASE_URL` 为可选项，不再因未配置而告警；SSO 模式检查 `BPEBOT_SSO_CLIENT_SECRET`，接口兼容模式不要求此密钥。机器人自身 `DATABASE_URL` 等原有必填项仍正常检查，响应只返回配置是否存在，不返回密钥。已补充缺失 / 空白 SSO 密钥、两种登录模式及密钥脱敏回归测试。线上采用 SSO，无需开放上级平台数据库。

本轮验证：`npm test` 80 项通过、2 项按需集成入口跳过；`npm run build` 通过（含 TypeScript 检查）。

## 本轮交付

在 `BPEBOT/` 建立了独立、可构建的 Next.js App Router 应用，六个管理页面已接真实管理 API。主要闭环为：复用平台管理员身份 → 指令配置与预览 → 接收签名事件 → 权限检查与去重 → 被动回复 → 查询日志。审批、警告、禁言目前保留草稿或显式未支持状态，不能对外宣称完整 V0.1 已上线。

基础开发阶段只新增或编辑 `BPEBOT/` 内文件；后续 SSO 阶段对主平台做了专用增量接入，详见文末交接。仓库已有大量其他未提交修改，均不属于本轮交付；不要执行整仓库重置或清理。BPEBOT 现作为独立 Git 仓库维护；尚未部署。

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

待用户在 Vercel 项目设置中补充生产环境的 `DATABASE_URL`、`QQ_APP_ID`、`QQ_CLIENT_SECRET`，然后重新部署。若两个业务共用同一云端数据库，平台连接地址也可使用同一地址；不要上传父项目本机数据库口令，也不要使用 localhost。配置完成后以 `x-schema-token` 调用 `POST /api/admin/migrate` 初始化机器人 schema，验证后保持 verify 模式。尚未完成数据库初始化和真实 QQ 验收，不能称为完整上线。

生产登录仍待解决：上级网站 auth.ts 仅设置默认 Cookie 属性，没有跨子域 Cookie 配置；vercel.app 与 breezever.com 不能直接共享登录状态，仅给 Bot 分配兄弟子域也不保证会话自动共享。需要正式共享 Cookie 或同域代理/SSO 方案，不得绕过管理员身份检查。QQ 回调路径为 `/api/webhook`；接入前核对部署保护是否允许 QQ 的外部请求。

### 部署后验证补充

提交 `7ae51a5` 已由 GitHub 自动触发部署 `dpl_5wWJQynqYRZE8Zj6cV7Mth3Rk3Mi`，Vercel 显示 Ready，正式别名仍为 `https://bpebot.vercel.app`。本机对该域名的普通 HTTP 检查和 CLI curl 检查均超时，因此没有宣称页面访问或 QQ 回调已验证成功。CLI curl 自动创建了项目级 Protection Bypass for Automation secret；该 secret 未写入源码或输出值，后续可在 Deployment Protection 中撤销。未关闭部署保护。
## 内网平台数据库与登录链接修复（2026-11-08）

用户明确不填写 PLATFORM_DATABASE_URL：浏览器控制台现在默认通过平台已有 /api/account/admin-check 校验实时管理员权限，不访问平台数据库，也不再回退至 Bot 数据库。显式填写平台连接时保留直接查询模式。平台 admin-check 匿名访问已验证 401；真实管理员联调仍待共享登录接入。QQ 侧按绑定用户 ID 查平台管理员的接口适配尚未实现，无直接平台连接时明确拒绝，不能因此绕过角色限制。

修正平台登录链接为 https://radio.breezever.com/#/account：线上 /account、/login 均验证 404，本地平台采用 hash 路由。链接修复不解决 breezever.com 与 vercel.app 的会话共享。用户仍需配置机器人自己的云端 DATABASE_URL 和 QQ 凭据。该兼容接口阶段未修改平台代码；后续 SSO 阶段已新增专用接入，详见下节。

## 授权码 SSO 交接（2026-11-08，优先于前文 Cookie 接入限制）

用户要求改为 SSO，生产模式为 PLATFORM_AUTH_MODE=sso。Bot 端新增授权启动、回调、同源 POST 退出和独立加密 HttpOnly Cookie；上级平台新增授权码、令牌兑换、实时身份校验和撤销接口。不共享平台 Cookie，不连接平台数据库。state 五分钟、PKCE S256、授权码一分钟、数据库原子一次性兑换、专用服务器密钥和严格回调白名单均已实现。

上级平台已通过现有 SSH 配置完成最小覆盖部署，当前镜像 breezever-app:bpebot-sso-20261108，原镜像 breezever-app:2.0.0-20261107150331557 保留。服务器 /opt/breezever/backups/bpebot-sso-20261108 保存回退配置；只修改当前生产 API 的 SSO 挂载和新增模块、专用配置、受保护服务器端点的地域例外，没有全量发布父仓库未提交代码。父项目本地对应修改为 server/bot-sso.ts、server/bot-sso-core.ts、server/api.ts 的挂载、deploy/compose.yml 两项环境配置和 deploy/nginx.conf 的三个服务器 POST 端点地域例外。独立仓库含 platform-integration 源码副本和 SSO.md，后续完整平台发布须纳入这些变更。

两端共享密钥已生成，存放在 Vercel Secret、Bot 被忽略的 .env.local 和服务器受限环境文件中，不得输出或提交。Vercel 生产 PLATFORM_AUTH_MODE 已设置为 sso，需要本次新代码部署后生效。平台线上 authorize 桥接页验证 200，包含正确 /#/account 链接；匿名 token 请求 401，有专用密钥但无效授权码请求 400。父平台应用健康检查通过。

真实 PostgreSQL SSO 集成 10 项通过，覆盖并发兑换只能成功一次、过期码、错误 PKCE、错误密钥、非管理员、撤权、会话失效、退出撤销与摘要存储。浏览器及 Bot 单元验证结果见后续记录。Bot 自身数据库、QQ 凭据和真实管理员账号线上登录验收仍待完成。QQ 侧按用户 ID 的权限适配仍未实现，不得把管理员浏览器令牌用于其他用户。

SSO 验证最终结果：常规测试 79 项通过、2 项按需数据库入口跳过；真实 PostgreSQL SSO 集成 10 项通过；原控制台浏览器检查 6 项通过；SSO 浏览器检查 2 项通过（平台 localhost、Bot 127.0.0.1，使用不同主机名的 Cookie，覆盖完整登录、退出和旧 Cookie 重放被拒绝）。两端生产构建通过。本机临时数据库均由测试清理。

### SSO 上线最终状态

提交 f9aae30 已由 GitHub 自动部署，Vercel 部署 dpl_7UoNvUJodX6BTG38y5eiU51wXmPH 显示 Ready。期间检测到用户已绑定 bpebot.breezever.com、设置 APP_URL 并填入云端 DATABASE_URL 与 QQ 凭据；平台回调已同步更改为 https://bpebot.breezever.com/api/sso/callback，应用再次健康。机器人迁移通过已认证服务器调用完成，返回 HTTP 200、ok=true、currentVersion=1、applied=[1]。DB_SCHEMA_MODE 仍为 verify。

线上自定义域名 /login=200、包含 SSO 登录按钮；/api/sso/start=303，回调地址正确；匿名 /api/admin/state=401。中国网络访问上级 SSO authorize 桥接=200、包含正确 /#/account 登录链接。国外服务器访问浏览器授权页=403 符合原地域策略，服务器端 token/introspect/revoke 专用 POST 端点才有受保护例外。真实管理员线上登录和 QQ 握手仍需验收。传输用临时密钥文件已删除，两端配置及被忽略本地副本保留。
