# BPE BOT 开发与运行

本目录是独立的 Next.js App Router 应用，开发版本为 V0.1.0。原始 `README.md` 保留为设计基线；本文记录实际实现范围，不能将设计中的“Fully implemented”视为验收结果。

## 启动

在本目录执行：

```powershell
npm install
Copy-Item .env.example .env.local
# 编辑 .env.local，填写自己的配置
npm run dev
```

控制台默认端口 `3100`，入口 `/dashboard`。生产环境执行 `npm run build` 和 `npm start`。Vercel 项目根目录选择 `BPEBOT`，运行时使用 Node.js。

首次使用空数据库可临时设置 `DB_SCHEMA_MODE=auto`；初始化完成后生产环境改回 `verify`。`DATABASE_URL`、`DB_SCHEMA_MODE`、`DB_SCHEMA_TOKEN` 均必须填写。`skip` 不检查也不创建表。手动迁移入口为 `POST /api/admin/migrate`，使用 `x-schema-token` 验证；不要将该值放入网页或浏览器代码。

## 接入原平台

没有新增注册、密码或角色系统。`PLATFORM_URL` 指向原平台，登录后由服务端转发当前 Cookie 至 `/api/auth/get-session` 验证会话，并从平台数据库 `public."user"` 实时查询管理员角色。`PLATFORM_DATABASE_URL` 应指向已有平台数据库；未设置时使用 `DATABASE_URL`，只有机器人与平台共用数据库时才适用。

浏览器必须把平台会话 Cookie 发给控制台。开发时同一个主机名的不同端口可共享 Cookie，请勿混用 `localhost` 和 `127.0.0.1`。生产建议通过反向代理使用同一主机，或由平台显式配置安全的共享 Cookie 域。单独部署到无关域名时不能直接复用 Cookie，仍需设计正式的单点登录交接。控制台使用 `/dashboard`，代理时注意与原平台的路径冲突。

`APP_URL` 必须等于浏览器访问控制台的源地址，写入操作检查 `Origin`，拒绝跨站请求。`PLATFORM_URL` 仅接受 HTTPS 或本机 HTTP 地址；配置异常、平台不可用、非管理员均拒绝访问。控制台不会为未登录用户展示机器人数据。

## 已实现

- 六个管理页面与桌面 / 移动端导航，真实空状态、错误提示、保存反馈。
- 自定义指令创建、编辑、立即启停、删除确认，七日命中趋势和最近记录。
- 同一份字面量匹配逻辑用于 Webhook 和预览，区分命中、被优先指令匹配、未命中；内置指令身份与权限不可降低。
- 日志服务端筛选、每页 20 条、URL 查询条件、详情和指令跳转。
- 审批规则草稿 CRUD 与本地匹配预览；未提供可误认为已生效的自动审批开关。
- 原始 Webhook 字节签名验证、回调握手、群聊被动文本 / Markdown 回复、权限检查、事件去重和请求审计。
- 独立 PostgreSQL `bpe_bot` 命名空间、版本化迁移、三种初始化模式、跨实例事务锁、手动迁移鉴权。
- 设置页脱敏配置检查、Schema 版本展示、危险日志清空确认；日志清空保留去重记录。

## 待完成与验收边界

- 实际 QQ AppID、密钥、订阅事件、目标群权限、网络白名单和被动回复必须使用自己的 QQ 应用联调。单元测试不能代替平台验收。
- `/warn`、`/ban`、快捷警告 / 禁言、自动审批和官方策略同步尚未开放执行；对应接口明确返回未支持，不会产生虚假成功。内置指令保留配置与严格群管理员权限约束。
- QQ 身份绑定表和角色查询适配层已建立，QQ 侧绑定 / 解绑流程尚未实现。
- Token 当前为实例内存缓存；共享 Redis Token 缓存、发送滑动窗口限流尚未实现，不应将当前实现当作完整生产发送链路。
- QQ 发送超时可能意味着已送达；当前保留去重声明且不盲目重发，故障记录需人工检查。进程在声明事件后中断的恢复任务尚未实现。
- 概览基于最多最近 500 条日志，Webhook 页面基于最近 100 条请求，明确显示统计范围；尚未提供完整全天聚合或环比数据。
- 数据库通过 `pg` 连接池连接 PostgreSQL，适用于 Neon 的 PostgreSQL 连接地址；尚未切换到设计指定的 Neon serverless 驱动。连接池每实例有上限，生产应配置合适的池化连接地址。
- 尚未执行部署，不会自动读取或复制主项目的真实密钥到本目录。

## 检查

```powershell
npm run typecheck
npm test
npm run build
npm run test:ui
# 可选真实数据库集成检查（会创建并清理临时数据库）
$env:BPEBOT_SCHEMA_INTEGRATION='1'
npm run test:db
```

数据库集成检查使用独立临时数据库，不修改平台数据库内容。浏览器检查使用独立测试平台会话与数据库，不在生产应用加入绕过登录的入口。两者默认从父目录 `.env` 读取本机 PostgreSQL 连接参数，需要数据库服务已启动并允许创建数据库；不会复制这些配置到应用文件。Windows 本机已安装 Edge 时自动使用 Edge，否则先执行 `npx playwright install chromium`，或用 `BPEBOT_BROWSER_CHANNEL` 指定已安装的浏览器。浏览器服务临时使用端口 `3109`，测试结束关闭并清理数据库。数据库集成检查未设置开关时会跳过，常规 `npm test` 不操作真实数据库。
