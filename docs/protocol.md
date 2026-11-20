# LIM v1 协议草案

独立服务与嵌入调用共享提交与补齐语义。已实现宿主可读会话的二进制 HTTP 发送、分页与长轮询。设备使用 `Authorization: Bearer <token>`，建群、成员管理、会话目录和设备撤销使用 [HTTP JSON-RPC 2.0](rpc.md)。两个入口共享幂等键和会话序号。

WebSocket 子协议 `lim.v1`、MLS 控制面和下表中标注为计划的路由属于后续协议。当前服务只监听 IPv4 回环，部署与凭据配置见 [JSON-RPC 启动说明](rpc.md#启动)。

## 字段与记录

线上的 UUID 为带连字符的小写文本，内部用 16 字节。正序号从 1 开始，空会话高水位为 0。序号与 epoch 范围为 0 到 2⁶³−1，JSON 编为无符号十进制字符串，禁止多余前导零。恢复代次 `recovery_generation` 由实例分配，正常重启保持；回退备份后轮换。客户端以（代次，会话，序号）作事件键；旧代次停止自动重发。

单条记录为四字节无符号大端头长度、UTF-8 JSON 对象、剩余原始 payload。HTTP 使用 `application/vnd.lim.record`；WS 使用一条完整 binary message。JSON 头长 1–4096 字节，普通正文 1–65536 字节，单个 MLS 控制体上限 1 MiB。在接收 WS 分片或读取 HTTP body 时即限制累积长度，禁用 WS 压缩。拆帧后还需校验 JSON、字段、UTF-8 及内容类型。拒绝重复字段、未知必需类型、错误版本和不合法的数字。未知可选字段允许跳过。

宿主可读房间的 Agent 请求示例：下面是记录头，紧随其后的 UTF-8 字节为 `{"kind":"agent.reply","run_id":"run-7","in_reply_to":"41","text":"已完成"}`。核心保留原始字节，不重新序列化。

```json
{
  "v": 1,
  "type": "message.send",
  "request_id": "r42",
  "recovery_generation": "01900000-0000-4000-8000-000000000004",
  "conversation_id": "01900000-0000-4000-8000-000000000001",
  "client_message_id": "01900000-0000-4000-8000-000000000003",
  "profile": "host",
  "content_type": "application/json"
}
```

| 内容模式 | 必填字段 | 校验 |
| --- | --- | --- |
| `mls`（建群默认） | `group_instance_id`、`epoch`、`content_type: "mls"` | payload 为 MLS 字节；检查外层组状态，成员设备执行密码学验证 |
| `host`（显式开启） | `content_type` 为 `text/plain`、`application/json` 或 `application/octet-stream` | 文本要求 UTF-8，JSON 要求单个有效 JSON 值；不得带 MLS 组字段 |

每次发送的 profile 必须匹配存储中的会话属性。发送身份取自认证连接；若出现 sender 字段则必须匹配已认证设备。HTTP 路径与记录内的会话 ID 必须相等。幂等比较包含事件种类、模式、内容类型、MLS 绑定字段和完整 payload 字节，排除请求关联 ID。认证信息禁止进入 URL。

## 路由与应答

| 操作 | 输入 | 成功结果 |
| --- | --- | --- |
| `POST /v1/conversations`（计划） | 已认证创建者、幂等键、成员和模式；MLS 另附初始公开材料与逐设备 Welcome | 新会话 ID、模式、起始游标 |
| `POST /v1/conversations/{id}/messages` | `application/vnd.lim.record`，包含 JSON 头和原始正文 | HTTP 200 JSON `message.accepted`，首次与重试均含原序号 |
| `GET /v1/conversations/{id}/events?after_seq=41&up_to=48` | 排除下界，可选固定上界；HTTP 头 `LIM-Generation` 必填 | 二进制事件页 |
| `GET /v1/conversations/{id}/wait?after_seq=48` | 当前已同步序号，HTTP 头 `LIM-Generation` 必填 | HTTP 200 JSON `sync.hint` 或 204 等待超时 |
| `GET /v1/sync/catalog`（计划） | 代次与可选目录游标 | 首次返回设备可见会话、加入下界、各房间高水位和目录游标；增量返回成员/设备可见性变化 |
| WS text `subscribe` / `unsubscribe`（计划） | 认证后、带代次的会话集合，每连接至多 64 项 | 复查成员权限后确认；在线 `sync.hint` 含代次、会话、高水位 |
| `POST /v1/conversations/{id}/commits`、`GET /v1/conversations/{id}/welcome`（计划） | MLS 成员变更、预期 epoch 或设备身份 | 原子写入控制事件并分发设备专属 Welcome |
| `GET /health/live`、`GET /health/ready` | 本地管理监听 | 进程存活、数据库与接单状态 |

当前 HTTP 服务每次请求校验设备绑定的访问凭据，设备令牌由服务配置提供。计划中的账号与设备登记、令牌刷新、KeyPackage 上传及一次性领取见[信任设计](security.md)。

计划中的 WebSocket 先接收一次性挑战，再提交 `session.authenticate`，通过后得到 `session.ready` 与当前代次。未认证连接最多保留 5 秒及两个控制帧。默认 30 秒 ping，60 秒无响应关闭。

回执示例：`{"v":1,"type":"message.accepted","request_id":"r42","recovery_generation":"01900000-0000-4000-8000-000000000004","conversation_id":"01900000-0000-4000-8000-000000000001","conversation_seq":"42","replayed":false}`。

## 提交与重试

同一会话的所有设备共享严格递增序号；各会话之间独立排序。唯一键是（会话，已认证设备，客户端消息 UUID）。普通发送和 MLS Commit 都占用该序列。建群使用（账号，设备，客户端键）独立去重。

1. 在写事务内确认凭据、代次和当前设备的可见区间，再查幂等键。越权、已退出或不属于本次加入区间的旧回执均不泄露。
2. 已有键且内容相同，返回原序号并置 `replayed=true`，即使当前 epoch 已推进。已有键且内容不同返回冲突。已清理正文的键返回过期错误和原序号。
3. 对新键再检查当前模式、epoch、冻结和配额，事务内写入事件；只有提交成功才返回 accepted。accepted 表示服务端已保存。用户已读回执由终端另发应用消息。
4. 超时或断线视为结果未知，重试复用原键和原始字节。明确收到 epoch 冲突时先补齐，再重新加密。设备在发送前原子保存待发字节、幂等键及 MLS 状态。

## HTTP 长轮询

客户端先拉取事件页，再以最后已持久化的序号调用 `/wait`。响应 200 包含 `type: "sync.hint"`、会话 ID、恢复代次及当前 `up_to`，收到后继续拉取事件。5 秒内无变更返回 204，两种成功响应都带 `LIM-Generation` 和 `LIM-Up-To`。收到 204 后可以复用原游标发起下一次等待。

服务每次准备返回提示时复查权限和保留边界。被移除的设备收到 404，已撤销设备收到 401，过期游标收到 410 及当前下界。最多 16 个并发等待，请求过载返回 503 和 `Retry-After`。等待计时在网络线程挂起，数据库工作线程仅执行短检查。本进程提交后通常在下一次 100 ms 检查点唤醒等待者，外部写入由每秒的数据库检查发现。

## 补齐和订阅

事件页 Content-Type 为 `application/vnd.lim.events`。每条记录前再加四字节大端记录总长度，随后是上述单条记录。事件头含 `v`、`type`（`event.message` 或 `event.mls_commit`）、代次、会话、序号、发送设备、客户端幂等键、模式及相应内容字段。HTTP 响应头 `LIM-Generation` 和 `LIM-Up-To` 在空页也必须存在。每页最多 100 条、编码后最多 2 MiB。每次读取复查设备权限。

- 在同一读快照内固定上界并查询 `after_seq < seq <= up_to`。后续页沿用首次返回的上界；只把游标推进到最后一条已在客户端安全保存的连续事件。达到上界时返回成功，空会话的首个请求为 `after_seq=0`。
- 设下界为本次加入起点与保留边界的较大值。首次目录返回该值；游标低于下界返回 `cursor_expired` 和当前下界。拒绝负值、逆序范围和超过可见高水位的上界或游标。退群设备不能继续翻历史页。
- 客户端在订阅确认后立即拉取，重连时重做。30 秒一次对账通过完整目录快照获得当前高水位；目录增量只记录成员等控制变化。v1 每账号最多 256 个活跃会话，完整目录限制 1 MiB。达到容量上限的新增成员事务明确失败。
- 接收提示只触发拉取。授权失效时取消订阅并清理待发提示，发送前复查权限。慢连接断开后凭最后已持久化游标继续，无需服务器保存每个离线收件箱。
- MLS 新设备从 Welcome 绑定的加入序号开始；缺少 Commit 时停止推进，按 MLS 恢复路径重新入群。宿主可读消费者遇到已过期历史时显式报告缺口。默认事件保留 90 天，幂等键墓碑保留至会话销毁。

## 错误

错误 JSON 包含 `request_id`、`code` 和 `retryable`；过载可额外携带 `retry_after_ms`。客户端根据错误类别处理。库的 Error 枚举使用对应 PascalCase；HTTP 认证和限频还可在调用核心之前失败。

| HTTP | code | 处理 |
| --- | --- | --- |
| 400 / 413 | invalid_argument / payload_too_large | 修正输入 |
| 401 / 404 | unauthenticated、device_revoked / not_found_or_forbidden | 更新凭据或停止访问 |
| 409 | profile_mismatch、idempotency_conflict、idempotency_expired | 校验会话模式或本地待发送状态；过期返回原序号 |
| 409 | epoch_conflict、rekey_required、recovery_required | 补齐换钥或停止重发，按新代次恢复 |
| 410 | cursor_expired | 根据返回下界恢复或重新获准入群 |
| 429 / 503 | rate_limited / overloaded、temporarily_unavailable | 退避，保留原始请求与键 |
