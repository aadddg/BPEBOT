# QQ 协议实现边界

`lib/qq.ts` 与 `lib/api.ts` 的签名、握手、被动回复使用原始请求字节与明确的传输字段。`tests/qq.test.ts` 包含公钥及握手签名向量测试；仍须在真实 QQ 应用中完成联调。

## 参考来源

- QQ 签名：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
- QQ Token：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
- QQ 事件回调：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- QQ 群消息：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
- 腾讯官方 Node SDK 签名：https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/transport/webhook-verify.ts
- 腾讯官方 SDK Token 地址：https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/api/token.ts
- 腾讯官方 SDK API 地址：https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/api/routes.ts
- 腾讯官方 SDK 消息体：https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/api/messages.ts

## 当前行为

- Token 地址为 `https://bots.qq.com/app/getAppAccessToken`，参照上述官方 SDK 的 Token 配置；群消息采用 `https://api.sgroup.qq.com/v2/groups/{group_openid}/messages`。目标应用仍需实际联调验证。
- Ed25519 的签名输入为原始时间戳文本与原始请求字节的拼接，不重新序列化 JSON。
- `op=13` 握手签名输入为 `event_ts + plain_token`，响应字段为 `plain_token`、`signature`。
- URL 验证兼容两个签名请求头均缺失的 `op=13`；此分支只能返回验证签名，不会声明或执行业务事件。提供了签名头但验证失败的握手仍拒绝。无签名握手单独记为 `handshake_unsigned`，不会错误显示为业务验签失败。
- 本地增加时间窗检查：默认最多过去 300 秒，容忍未来 30 秒。该时间窗是本应用策略；真实 QQ 重试若携带较早签名，需评估并调整。
- 普通文本回复携带 `msg_type=0`、`content`；Markdown 携带 `msg_type=2`、`markdown.content`。两者均携带触发消息的 `msg_id` 和 `msg_seq`。
- 消息 ID 是不透明字符串，允许官方示例中的 `ROBOT1.0_` 等标点，不将其当成员 OpenID 验证。
- 机器人当前对每个事件只发送一次回复，序号为 1；扩展多回复时须使用数据库中的序号保证跨实例递增，不能仅依赖内存 Map。
- `/warn` 与 `/ban` 命名空间不能被自定义高优先级指令覆盖，预览与实际处理共用同一策略。Markdown 内容不插入未经处理的 HTML。

## 未开放的执行能力

`GROUP_JOIN_REQUEST` 是否可订阅、入群策略与禁言接口均待目标应用验证。`QQClient.approveJoin()`、`muteMembers()` 会抛出明确的未支持错误；管理 API 返回 501。警告、禁言、快捷群管理目前也不执行，不能把解析器或界面配置视为联调完成。

Token 只缓存于单实例内存；共享 Redis 缓存和发送限流尚未接入。外部发送超时可能已经送达，当前保留事件声明而不自动重发；中断后的对账与人工重试机制是下一阶段任务。

还需处理的可靠性边界：外部发送成功后完成日志事务失败，QQ 重试会被已有事件声明拦截，记录可能仍停留在 pending；当前不会尝试盲目重发或自动修复。若平台用不同顶层事件 ID 重复推送同一个消息，当前事件去重尚未同时建立 `(group_openid, msg_id)` 的数据库唯一声明；外部消息序号去重不能替代本地消息级幂等设计。
