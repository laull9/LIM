# LIM JSON-RPC 2.0

独立服务在 `127.0.0.1` 监听 HTTP，`POST /rpc` 接受 `application/json`。远程访问由同机 TLS 反向代理终止连接。代理向 LIM 转发带单一 `Content-Length` 的请求，配置连接数与请求速率限制。

服务使用 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 的请求和响应对象、关联 ID、通知与批处理。业务方法接受命名参数对象。常规响应使用 HTTP 200。合法通知执行操作但省略 RPC 响应，整批只有通知时返回 HTTP 204。批处理按提交次序执行，每次调用独立提交。HTTP 层拒绝不支持的方法和内容类型。

## 启动

先初始化仓库固定版本的 LTool 子模块。除 SQLite 和 libpq 外，服务需要 pkg-config 可识别的 OpenSSL 3.0+ `libcrypto`。HTTP 使用 LTool 的 LWeb 和它自带的 standalone Asio，JSON 使用 LJson，二进制转换使用 LString。OpenSSL 用于令牌摘要和常量时间比较。

```sh
git submodule update --init inc/ltool
xmake build lim-server
xmake run lim-server --config /absolute/path/lim.json
```

配置包含恢复代次、存储、管理凭据摘要及设备列表。生成令牌时使用 32 字节密码学随机量，编码为 64 位小写十六进制。`*_sha256` 是该 **ASCII 字符串**的 SHA-256，小写十六进制。用 `Authorization: Bearer <token>` 传令牌。管理令牌和设备令牌相互独立，服务端配置只保存摘要。设备 `credential` 是内部 UUID，与数据库绑定，轮换令牌时保留该 UUID。启动时登记配置中的设备，数据库中撤销的设备重启后仍保持撤销。

```json
{
  "port": 7400,
  "generation": "6dfda533-17f4-4f29-9146-835c283a0221",
  "storage": {"backend": "sqlite", "file": "lim.db"},
  "operator_token_sha256": "<64 位小写十六进制 SHA-256>",
  "devices": [
    {
      "account": "2dad3081-2e25-4936-88b6-c47b7349ef87",
      "device": "31359d56-2638-4bc3-9912-cf6433d8f7df",
      "credential": "4346410b-31c8-4e57-8804-f44836014fee",
      "token_sha256": "<设备令牌的 SHA-256>"
    }
  ]
}
```

SQLite 路径以配置文件所在目录为基准。PostgreSQL 改用 `{"backend":"postgresql"}`，并通过 `LIM_SERVER_PG` 提供 libpq 连接信息。正常重启提供同一恢复代次。端口可设为 `0` 让系统分配，实际端口出现在启动输出中。探针为 `GET /health/live` 和 `GET /health/ready`，后者检查数据库与恢复代次。

## 调用

除 `session.info` 外，所有方法均要求 `generation`。UUID 使用带连字符的小写文本，序号为无前导零的十进制字符串。先用操作员令牌创建 `host` 会话并添加设备，然后从设备客户端收发。

| 方法 | 凭据 | 业务参数 |
| --- | --- | --- |
| `session.info` | 设备 | 无，返回 `generation`、`account`、`device` |
| `conversation.create` | 操作员 | `conversation_id`、`profile: "host"` |
| `conversation.set_member` | 操作员 | `conversation_id`、`device_id`、布尔值 `active` |
| `conversation.list` | 设备 | 可选会话 UUID `after`，逐页返回成员可读下界、会话高水位和 `next_after` |
| `message.send` | 设备 | `conversation_id`、`client_message_id`、`content_type`、正文 |
| `conversation.events` | 设备 | `conversation_id`、排除下界 `after`、可选固定上界 `up_to` |
| `conversation.expire` | 操作员 | `conversation_id`、`through`，清理截至该序号的正文并保留幂等键 |
| `device.revoke` | 操作员 | `device_id`，撤销设备并移除其成员资格 |

```json
{"jsonrpc":"2.0","id":"send-1","method":"message.send","params":{
  "generation":"6dfda533-17f4-4f29-9146-835c283a0221",
  "conversation_id":"5d22b2aa-30bd-4f4c-bba5-1ae59a53cb7c",
  "client_message_id":"ae6b2cdb-e54b-4857-b0d0-f28b5f601ded",
  "content_type":"text/plain",
  "text":"你好"
}}
```

`text/plain` 和 `application/json` 在 `text` 中发送 UTF-8 正文。JSON 正文会校验语法，并逐字节保存输入。二进制使用 `application/octet-stream` 和标准 Base64 字段 `payload_base64`。补齐结果的 `events` 对所有类型都提供 `payload_base64` 以保留原始字节。大页可改用 [二进制 HTTP](protocol.md)，直接接收原始字节。同一个设备、会话和客户端键跨两个入口共享幂等回执。第一页取得的 `up_to` 可在后续请求中固定，使用上次 `next_after` 跟进。发送返回 `seq` 和 `replayed`，重试保留原消息键、内容类型和原文字节。

标准 JSON-RPC 错误码包含解析失败 `-32700`、无效请求 `-32600`、未知方法 `-32601`、无效参数 `-32602` 和内部错误 `-32603`。业务错误放在 `-32000` 至 `-32099`，结构化字段可提供 `data.name`、`data.retryable` 和 `data.sequence`。设备凭据与账号由服务端配置解析，提交和补齐的权限由数据库事务复查。

当前限制为 8 KiB 请求头、512 KiB HTTP 正文、16 个调用一批和 2 MiB RPC 响应。慢请求由 LWeb 连接超时回收，服务最多同时容纳四个入队或正在回包的 RPC/就绪检查。大页提前停止在可续读的游标处。服务收到 SIGINT/SIGTERM 时关闭连接，已提交的发送仍可用同键重试。

## JSON-RPC 与 gRPC 的数据开销

用相同的事件字段计算未压缩响应体。JSON-RPC 使用本页公开的补齐字段，Protobuf 使用 `uint64` 序号、两个 16 字节 ID、内容枚举和 `bytes` 正文，用 `protoc --encode` 实际编码后计入 gRPC 的 5 字节消息前缀。省略 HTTP 头与帧开销。

| 原始正文 | JSON-RPC | Protobuf＋gRPC 前缀 | 大小比 |
| ---: | ---: | ---: | ---: |
| 128 B | 431 B | 183 B | 2.36× |
| 1,024 B | 1,627 B | 1,079 B | 1.51× |
| 65,536 B | 87,643 B | 65,593 B | 1.34× |

小正文中，字段名、字符串 UUID 和请求关联信封的固定开销明显。大正文主要由 Base64 增加传输字节。gRPC 具备生成的强类型客户端、HTTP/2 多路复用和流式调用，适合二进制补齐与长期订阅。两条传输路线都受数据库提交和写事务竞争约束。表中只有编码体积，实际延迟、吞吐和 RSS 以同库、同数据、同连接复用条件的压测为准。 [Protobuf 编码](https://protobuf.dev/programming-guides/encoding/) · [gRPC HTTP/2 帧](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md) · [gRPC 性能指南](https://grpc.io/docs/guides/performance/)
