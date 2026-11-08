# 平台授权码单点登录

这是本项目两个站点之间的专用 SSO 接入，不是通用 OAuth/OIDC 服务。

## 登录流程

1. 在 Bot 登录页点击“使用平台账号安全登录”。Bot 写入五分钟有效的加密登录事务 Cookie，生成 state 和 PKCE S256 校验值。
2. 浏览器跳转到上级平台 `/api/bot-sso/authorize`。平台使用自己域名下的登录 Cookie；不会把该 Cookie 发送给 Bot。
3. 未登录或平台的 Strict Cookie 在首次跨站导航中未发送时，页面提供 `/#/account` 登录链接。登录后回到授权页点击“已完成登录，继续授权”。
4. 平台实时确认会话和管理员角色，签发一分钟有效、只可兑换一次的授权码。回调地址必须与平台配置完全一致。
5. Bot 校验 state，再通过服务器请求携带 PKCE verifier 和专用客户端密钥兑换令牌。浏览器不会得到专用密钥、verifier 或平台会话 Cookie。
6. Bot 用独立的 `__Host-bpebot_session` Cookie 保存加密令牌。该 Cookie 使用 Secure、HttpOnly、SameSite=Lax，没有共享 Domain。
7. 每次访问管理接口都会向平台验证令牌、原会话是否有效和当前管理员角色。上级平台注销、会话过期或管理员权限撤销后拒绝访问。
8. Bot 顶栏“退出登录”会先撤销平台令牌，再清除 Bot Cookie；平台退出不可用时返回失败，允许重试。

Bot 的管理写入继续要求同源 Origin。SSO 的服务器 POST 接口不依赖浏览器 Cookie，必须提供专用客户端密钥；它们与其他业务 API 的来源验证分开处理。

## 两端配置

| 环境 | 配置 |
| --- | --- |
| Bot / Vercel | `PLATFORM_AUTH_MODE=sso` |
| Bot / Vercel | `PLATFORM_URL=https://radio.breezever.com` |
| Bot / Vercel | `APP_URL=https://bpebot.breezever.com` |
| 两端 | `BPEBOT_SSO_CLIENT_SECRET`，同一个随机密钥，至少 32 字符 |
| 上级平台 | `BPEBOT_SSO_REDIRECT_URI=https://bpebot.breezever.com/api/sso/callback` |

不需要填写 `PLATFORM_DATABASE_URL`。Bot 自己的 `DATABASE_URL` 仍用于机器人指令、日志等业务数据；SSO 登录本身不使用 Bot 数据库。

SSO 仅用于浏览器管理登录。QQ 侧按绑定的平台用户 ID 判断管理员的专用授权适配仍待实现；不能拿浏览器 SSO 令牌冒充任意 QQ 用户。

## 上级平台代码接入与持续部署

本次已修改父项目 `server/bot-sso.ts`、`server/bot-sso-core.ts`，并在 `server/api.ts` 挂载 `/api/bot-sso` 路由；挂载位于通用浏览器 CSRF 检查之前，路由自身验证服务器凭据。`platform-integration/sso-core.ts` 是核心源码副本，`platform-integration/bot-sso.ts.template` 是路由源码副本，便于独立仓库交接。同步修改时保持两份核心一致。

首次有效访问时在平台私有数据库创建独立表 `public.bpebot_sso_grants`，引用已有用户和会话，不新增账号系统。数据库只保存授权码和令牌的 SHA-256 摘要，不保存明文。兑换通过数据库原子更新防止跨实例重放。

父项目 Compose 显式传入两个 SSO 配置项。原网站限制访问地域，因此 Nginx 仅对 `POST /api/bot-sso/token`、`introspect`、`revoke` 放行跨地域的服务器请求；这些接口仍必须校验客户端密钥。其他网站访问限制保持原策略。

上级平台已用当前生产镜像的最小覆盖部署，镜像标签 `breezever-app:bpebot-sso-20261108`。回退材料保存在服务器 `/opt/breezever/backups/bpebot-sso-20261108`，发布覆盖材料位于 `/opt/breezever/releases/bpebot-sso-20261108`。环境文件含凭据，不得复制进 Git。后续完整发布必须包含父项目本次 SSO 源码和 Compose 配置，不能只保留临时镜像。

## 验证

```powershell
npm test
npx playwright test --config playwright.sso.config.ts
$env:BPEBOT_SSO_INTEGRATION='1'
npx tsx --test tests/sso-integration.test.ts
```

集成检查只创建并清理本机临时数据库，覆盖角色撤销、原会话失效、令牌撤销和并发一次性兑换。真实管理员账号的线上交互仍需账号持有人完成；测试不创建生产管理员，也不绕过登录。

## 当前部署验证

用户在部署过程中绑定了自定义域名并配置了云端数据库和 QQ 凭据。线上 APP_URL 和平台回调已统一为 https://bpebot.breezever.com。部署 f9aae30 已 Ready；自定义域名登录页返回 200，SSO 启动返回 303，匿名管理接口返回 401；中国网络访问平台授权桥接返回 200。迁移接口已实际返回 200、ok=true、currentVersion=1、applied=[1]，机器人 Schema 初始化完成，保持 verify 模式。平台管理员本人尚需完成一次真实登录；QQ 平台握手和消息闭环尚未验收。
