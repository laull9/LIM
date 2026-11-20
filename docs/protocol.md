# LIM 协议与数据契约

## 版本与基础类型

本文件定义首版行为契约。HTTP 前缀为 `/v1`，WebSocket 子协议为 `lim.v1`，负载字段使用 `snake_case`。M1 将此契约固化为机器可读 schema、编解码实现和黄金样例。

账号、设备、会话、加密组实例与客户端幂等键采用 UUID，文本形式统一小写。业务 `conversation_id` 稳定，`group_instance_id` 标识本次 MLS 组实例，重建组时更新。序号与 epoch 在数据库中使用非负 `bigint`，增长前检查溢出；JSON 使用十进制字符串，避免跨语言数值精度丢失。时间为服务端 UTC 时间，仅用于展示与审计，排序始终使用会话序号。

部署维护 `recovery_generation`：正常重启保持不变，数据库备份回退必须通过显式恢复命令产生新代次。认证就绪响应、写请求、事件和游标都携带该值；旧代次写请求返回 `recovery_required`。事件去重键为 `(recovery_generation, conversation_id, conversation_seq)`，客户端保留原代次本地历史，避免回退后的序号复用覆盖已保存内容。

`request_id` 关联一次请求和响应；`client_message_id` 标识一次逻辑写操作，跨网络重试保持不变。认证后的发送账号与设备由连接推导，外部字段必须与连接身份一致。

## 连接与帧格式

HTTP 控制接口使用 UTF-8 JSON。WS text message 承载认证、确认、错误和轻量控制；WS binary message 承载 MLS 原始字节，避免密文 Base64 膨胀。

二进制消息格式为 `4 字节大端 header_length | UTF-8 JSON header | MLS payload`。长度按字节计算，头长度必须落在已收到完整消息内。解析器先限制 WebSocket 聚合消息大小，再解析头和负载，分片重组同样受限制。默认关闭 WebSocket 压缩。

发送消息的 header 示例：

```json
{
  "v": 1,
  "type": "message.send",
  "request_id": "request-42",
  "recovery_generation": "01900000-0000-4000-8000-000000000004",
  "conversation_id": "01900000-0000-4000-8000-000000000001",
  "group_instance_id": "01900000-0000-4000-8000-000000000005",
  "sender_device_id": "01900000-0000-4000-8000-000000000002",
  "client_message_id": "01900000-0000-4000-8000-000000000003",
  "epoch": "7"
}
```

这里只展示头部；其后必须跟真实 MLS 密文字节。服务端添加的 `conversation_seq`、提交时间和投递信息属于外层元数据。接收端还要根据 MLS 验证身份、会话和加密绑定字段。

| 默认限制 | 数值 | 超限处理 |
| --- | --- | --- |
| WS JSON header | 4 KiB | 拒绝帧 |
| 应用密文 payload | 64 KiB | `payload_too_large` |
| MLS 控制 payload / 单个 Welcome | 1 MiB | 独立配额，拒绝超限 |
| HTTP 普通 JSON body | 64 KiB | HTTP 413 |
| 群变更控制批次 | 8 MiB | 包括 Commit 与全部 Welcome，独立并发限制 |
| 单连接待写队列 | 2 MiB 或 256 个事件 | 达任一上限关闭并要求补齐 |
| 全局待写队列 | 64 MiB | 触发准入背压与慢连接清理 |
| 未认证连接 | 5 秒、最多 2 个控制帧 | 关闭连接 |

上限是首版默认策略。队列记账包含头部，所有限额在分配内存前检查；单条最大控制消息须能放入空队列。按队列占用和全局预算执行准入，禁止超限后继续积压。

## 命令与事件

| 接口或事件 | 职责 |
| --- | --- |
| `POST /v1/auth/login`、`/refresh`、`/logout` | 获取、轮换和撤销账号令牌 |
| `POST /v1/devices`、`DELETE /v1/devices/{id}` | 验证设备授权、登记或触发撤销换钥 |
| `POST /v1/key-packages`、`/key-packages/claim` | 上传与原子领取公开 KeyPackage |
| `POST /v1/conversations` | 携带初始加密组材料、成员授权和 Welcome 创建会话 |
| `POST /v1/conversations/{id}/commits` | 带预期 epoch 提交成员或密钥变更 |
| `GET /v1/conversations/{id}/welcome` | 取得当前设备专属的入群材料及起始序号 |
| `GET /v1/sync/catalog` | 初始会话目录或账号目录增量 |
| `GET /v1/conversations/{id}/events` | 固定上界的会话事件补齐 |
| WS `session.authenticate`、`session.ready` | 设备挑战验证与连接就绪 |
| WS `message.send`、`message.accepted` | 提交密文并确认持久化结果 |
| WS `event.committed` | 推送应用密文或 MLS 控制事件 |
| WS `sync.hint` | 提示目录或会话高水位变化，可合并且可丢弃 |
| WS `device.cursor` | 报告当前设备已安全持久化的处理进度 |
| `GET /health/live`、`/health/ready` | 独立管理监听地址上的健康状态 |

普通元数据查询返回 JSON。Commit、Welcome 和补齐事件以 HTTP 二进制报文传输，复用相同的“头长度、JSON 头、原始字节”结构；批次在每条报文前再加 4 字节大端总长度，设总字节和条目上限。精确 Content-Type、批次 schema、认证挑战编码和错误 JSON 在 M1 一并冻结。

心跳使用 WebSocket ping/pong，默认 30 秒一次，60 秒无响应关闭。客户端采用带抖动的退避重连，最长等待 30 秒；恢复连接后立即补齐。每个 device_id 只允许一个活动写会话，新连接就绪时通过连接代次关闭旧连接，客户端禁止并行运行同一份 MLS 私有状态。

## 消息状态与幂等

| 状态 | 精确定义 |
| --- | --- |
| `pending` | 客户端已保存待发送消息和密文 |
| `accepted` | 服务端完成事件、幂等记录与 outbox 的持久化提交 |
| `received` | 接收设备已经保存事件或已解密结果；传输游标可用于恢复 |
| `read` | 接收用户主动产生的加密已读回执，客户端验证和解释 |
| `failed` | 明确拒绝，错误码决定修正方式 |
| `unknown` | 超时或断线，提交结果待原请求重试查明 |

产品界面分别显示待发送、服务器已接收和对方已读。首版服务器无权解密用户已读状态。`device.cursor` 是传输进度，可由设备跳过坏消息后继续推进；它不作为已读回执向其他用户发布。

写操作唯一键为 `(scope_id, sender_device_id, client_message_id)`；scope 为会话，建群等尚无会话的操作以账号作为 scope。记录保存操作种类、规范化业务字段和原始 payload；比较使用逐字段与字节比较。

- 同一键与同一请求返回原提交结果，`request_id` 可变化。
- 同一键对应不同操作或不同密文时返回 `idempotency_conflict`。
- 原请求已成功但 ACK 丢失时，即使群已进入新 epoch，仍返回原 `accepted`。设备已撤销或失去访问权限时返回权限错误。
- `epoch_conflict` 是明确未写入；客户端先同步新状态，然后可使用同一逻辑消息键重新加密并提交。结果为 `unknown` 时，必须先复用原始字节查明结果。
- 幂等记录保留到会话销毁。密文过期后保留键、原结果和已过期标记；重复请求返回 `idempotency_expired` 并带原事件标识，避免重新创建旧消息。

发送者从服务端收到自己的事件时，以本地已保存密文与提交结果推进序号，避免重复处理已经推进的发送密钥状态。同账号的其他设备作为独立 MLS 成员正常解密。

## 事务 顺序与权限

每个会话维护 `last_seq`、`group_instance_id`、`epoch` 和 `write_state`。应用密文、Commit 与必要的控制事件共享序号。事务内更新计数器，回滚恢复原值；应用层从不通过预分配全局自增 ID 推断提交顺序。组实例发生变化时客户端重新取得 Welcome，旧实例的新写入被拒绝。

普通发送事务执行：认证状态复查 → 会话行锁 → 当前成员授权 → 幂等结果查询 → epoch/冻结检查 → 写事件与 outbox → 提交。事件唯一约束为 `(conversation_id, conversation_seq)`，同时建立幂等唯一约束。

跨对象操作采用固定锁顺序：账号认证记录 → 按 ID 排序的设备 → 按 ID 排序的会话 → 按账号排序的目录计数器。发送和加入对相关设备取共享权限锁，撤销取排他锁；撤销锁定设备后再读取并锁定全部关联会话。新增关联也必须遵循此顺序，防止撤销扫描时漏掉并发入群。锁持有期间只进行数据库操作，避免网络 I/O 和密码验证。

Commit 事务通过 `expected_epoch` 条件更新决定唯一胜者，并原子写入事件、roster、epoch、Welcome 和目录变化。客户端验证实际 Commit；服务端验证外部权限与声明，拒绝超限或越权。成员变更后收到旧 epoch 的新应用消息时返回冲突，已提交消息由幂等规则处理。

## 同步与游标

两类游标分开维护：账号目录的 `catalog_seq` 与每个会话的 `conversation_seq`。二者由各自的事务计数器分配。目录只记录新增、移除、设备可见性变化和冻结状态等控制变化，普通聊天消息无需逐用户写目录事件。

首次同步在一次一致性快照内返回当前会话集合与 `catalog_seq`。集合受每账号 256 个活跃会话限制；其中标明当前设备可访问、待入群或待换钥状态。之后按目录游标拉取增量；每一页在快照内固定上界 `up_to`，下一页沿用该上界。初始快照最大 1 MiB；分页增量同时限制 100 条与 1 MiB，并仅推进到实际返回的最后序号。目录事件保留 90 天，超期游标返回 `cursor_expired`，客户端重新取完整快照并原子替换目录缓存。

会话同步流程：

1. WS 完成认证后立即启动补齐；在线提示只用于加速发现变化。
2. 请求携带 `after_seq` 和可选 `up_to`，首次响应固定当前可见高水位。服务端按序返回 `(after_seq, up_to]` 内事件，最多 100 条且不超过 2 MiB；单条最大控制事件必须能够完整返回。
3. 客户端逐条验证和持久化，连续处理完成后推进游标。发现缺口先补齐，禁止跳过缺失 Commit 解密后续 epoch。
4. 同步过程中实时推送可暂存或去重；暂存达到上限后丢弃提示和暂存副本，再从数据库继续补齐。
5. 达到固定上界后再次查询当前高水位。客户端重连及每 30 秒进行轻量目录与已授权会话高水位对账，修复丢失的实时提示。

新设备从 Welcome 绑定的 `join_seq` 建立状态，游标设为该起点，随后读取更大的序号。服务器校验设备当前授权及本次加入区间；成员退出后禁止新的历史读取，重新加入从新 Welcome 起点开始。已获得的本地历史保留由用户控制。

应用事件和加密控制事件默认保留 90 天。活跃设备最长离线窗口为 30 天；超出后走重新入群流程。已过保留期的游标返回保留边界与 `cursor_expired`。可识别的恶意应用密文验证失败时，客户端原子记录失败事件和错误占位再推进；损坏 Commit 导致群状态无法推进时进入隔离与重新入群流程。

## 数据模型

以下是关系与唯一约束设计，SQL 迁移在对应里程碑实现。外键、长度检查和非负约束在数据库与入口同时落实。

| 表 | 关键字段及约束 |
| --- | --- |
| `users` | `user_id`、唯一登录标识、密码验证串、身份公钥、状态 |
| `devices` | `device_id`、`user_id`、公开授权证书、状态、最近活动；设备 ID 全局唯一 |
| `sessions` | 令牌摘要、设备、到期时间、刷新族与撤销状态 |
| `instance_state` | 当前恢复代次与恢复状态；显式恢复命令更新 |
| `key_packages` | 包 ID、设备、公开材料、有效期、一次性发放状态 |
| `conversations` | `conversation_id`、类型、`last_seq`、`group_instance_id`、`epoch`、`write_state` |
| `direct_pairs` | 规范排序的双方账号唯一，绑定单聊会话；事务中防止重复创建 |
| `memberships` | 会话、账号、角色、加入代次、状态；每账号每会话至多一个当前成员记录 |
| `group_devices` | 会话、设备、加入代次、起始序号、MLS leaf 身份与状态 |
| `conversation_events` | 会话、序号、种类、epoch、发送设备、密文字节、提交时间 |
| `idempotency_records` | scope、设备、客户端消息键、原请求、原结果、过期标记；组合唯一 |
| `welcomes` | 会话、目标设备、加入代次、`join_seq`、Welcome 字节；目标组合唯一 |
| `delivery_outbox` | 会话、序号、任务状态、尝试次数、下次尝试时间；事件引用唯一 |
| `catalog_heads` / `catalog_events` | 每用户计数器；用户与目录序号组合唯一 |
| `device_cursors` | 设备、会话、加入代次、处理序号；单调更新且不超过可见高水位 |
| `schema_migrations` | 迁移版本、执行时间；管理命令按版本执行 |

主要索引覆盖会话序号范围读取、设备会话反查、用户成员目录、未完成 outbox 和会话令牌查询。密文只在事件表存一份，幂等请求字段尽量引用仍保留的事件内容；过期后将幂等记录转为小型墓碑。精确比较时忽略请求关联字段，保留全部影响业务和加密的字段。

## 错误与重试

错误响应包含 `request_id`、稳定字符串 `code`、安全的 `message`、`retryable` 和可选 `retry_after_ms`。服务端内部错误上下文进入受控日志，外部响应隐藏 SQL、凭据与其他用户信息。

| 错误码 | 客户端动作 |
| --- | --- |
| `unauthenticated` / `device_revoked` | 重新登录或重新登记，关闭旧连接 |
| `not_found_or_forbidden` | 停止访问；合并不存在与未授权的外部响应 |
| `invalid_argument` / `payload_too_large` | 修正请求，禁止自动重复 |
| `idempotency_conflict` | 保留原记录并报告客户端状态错误 |
| `idempotency_expired` | 使用返回的原事件标识处理，禁止生成重复消息 |
| `epoch_conflict` | 补齐控制事件，确认未提交后重新加密 |
| `rekey_required` | 等待或推动合法移除 Commit，应用消息留在本地 |
| `cursor_expired` | 重建目录，或按安全策略重新加入会话 |
| `recovery_required` | 停止自动重发，重新认证与同步，按新组实例建立状态 |
| `rate_limited` / `overloaded` | 遵循退避时间，保持原幂等键 |
| `temporarily_unavailable` | 保持原密文重试，处理可能已提交的结果 |

HTTP 分别使用 400、401、404、409、413、429、503 等状态；WS 使用相同业务错误码。协议主版本不兼容时在认证前拒绝连接；新增可选字段须保持旧客户端可解析，未知必需事件必须阻止游标越过该事件并要求升级。
