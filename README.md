# LIM

LIM 是面向单聊、小群和 Agent Harness 的轻量聊天服务器项目。当前可作为 C++23 库嵌入宿主进程，支持用 SQLite 文件或 PostgreSQL 数据库持久化宿主可读会话。两种后端使用同一个有序事件日志契约，支持发送、分页补齐、幂等重试、设备授权与撤销、重新加入和保留期清理。`lim-server` 提供本地 HTTP JSON-RPC 2.0 和二进制 HTTP，支持设备认证、会话管理、发送、补齐和长轮询。WebSocket 与 MLS 端到端加密在后续路线中。

| xmake 目标 | 模块 | 职责 |
| --- | --- | --- |
| `lim_core` | `lim.chat`、`lim.frame` | 发送与补齐接口、值类型、有界二进制拆帧 |
| `lim_storage` | `lim.storage` | 运行时选择 SQLite 或 PostgreSQL，初始化存储并实现 `Chat` 与可信宿主管理 |
| `lim-server` | 独立服务 | JSON-RPC 2.0、二进制 HTTP 和长轮询 |
| `lim_frame_test`、`lim_storage_test` | 测试入口 | 拆帧单测与两种真实数据库的共享契约测试 |

## 构建与测试

需要 xmake 3.1.2+、支持 C++23 命名模块和 `std::expected` 的工具链，以及 pkg-config 能找到的 SQLite 3.37+ 和 libpq 14+ 开发包。Clang 工具链需要同版本的 `clang-scan-deps`。使用包管理器安装系统库，配在非标准目录时用 `PKG_CONFIG_PATH` 指向对应的 `.pc` 目录。

```sh
git submodule update --init inc/ltool
xmake f -m debug --toolchain=clang -o build/xmake
xmake
xmake test --output-on-failure
```

PostgreSQL 集成测试需要 PostgreSQL 14+ 的 `initdb`、`pg_ctl`、`psql`、`pg_dump` 和 `pg_restore`，以及 Python 3.11+。测试创建私有临时集群，通过 Unix socket 连接，结束后关闭并清理。脚本通过 `pg_config --bindir` 查找 PostgreSQL 工具，也可用 `LIM_PG_BINDIR` 指定目录。SQLite 集成测试每次使用新的临时文件。完整测试可在 macOS 或 Linux 的普通用户下运行。

```sh
xmake test lim_frame_test/frame
xmake test lim_storage_test/sqlite
xmake test lim_storage_test/postgresql

# Release 使用相同的测试入口
xmake f -m release --toolchain=clang -o build/xmake
xmake test --output-on-failure
```

## 编辑器索引

Clice 读取 `build/ide/compile_commands.json`。xmake 构建时自动刷新编译数据库，模块、编译器及依赖参数取自当前构建配置。只更新索引参数时运行下面的命令。

```sh
xmake project -k compile_commands --lsp=clangd build/ide
```

在 VS Code 打开 LIM 根目录。首次切换配置后，可在命令面板运行 `clice: Restart Language Server` 重新加载。

## 独立服务

`lim-server` 使用 LTool 的 LWeb 和 LJson，通过 `--config FILE` 启动。依赖、设备和操作员凭据配置、方法表及请求示例见 [JSON-RPC 2.0](docs/rpc.md)。原始正文收发和低开销在线提示见 [二进制 HTTP](docs/protocol.md)。

## 首版 demo

每条命令启动一个独立进程。Alice 和 Bob 是可信宿主中的两个演示身份，共用一个持久化会话。下面用新的 SQLite 文件演示双向收发、退出后的补齐和幂等重试。

```sh
xmake build lim_demo
demo_db="$(mktemp -d)/lim-demo.db"

xmake run lim_demo --sqlite "$demo_db" init
xmake run lim_demo --sqlite "$demo_db" send alice 1 '你好，Bob'
xmake run lim_demo --sqlite "$demo_db" read bob 0
xmake run lim_demo --sqlite "$demo_db" send bob 1 '你好，Alice'
xmake run lim_demo --sqlite "$demo_db" read alice 1
xmake run lim_demo --sqlite "$demo_db" send alice 1 '你好，Bob'
```

第一次发送依次拿到序号 `1` 和 `2`。最后一条命令返回 `accepted seq=1 replayed=true`。消息键是每个发送者独立使用的正整数，同一个键须搭配原文重试。翻页时把 `next_after` 作为下一次 `read` 的游标，也可以附上首次返回的 `up_to` 固定本轮补齐上界。

PostgreSQL 使用单独的演示数据库。数据库角色需要有相应的 schema 建表权限。以下示例使用 libpq 默认的本机连接设置。

```sh
createdb lim_demo
export LIM_DEMO_PG='dbname=lim_demo'
xmake run lim_demo --postgresql init
xmake run lim_demo --postgresql send alice 1 '你好，Bob'
xmake run lim_demo --postgresql read bob 0
```

通过 `xmake test 'lim_demo/*'` 在两个隔离的真实数据库中重现演示。

## 嵌入宿主

在宿主的 `xmake.lua` 中引入 LIM 源码，同一工具链会构建双方使用的模块。

```lua
includes("vendor/LIM")

target("my_app")
    set_kind("binary")
    set_languages("cxx23")
    add_deps("lim_storage")
    add_files("src/main.cppm")
```

`open_store` 接受 `SqliteOptions{file}` 或 `PostgresOptions{connection_info}`，并接收宿主持久保存的恢复代次 ID。SQLite 文件的父目录由宿主创建。PostgreSQL 使用专用数据库和能在 `public` schema 建表的数据库角色，连接串由宿主配置，可用 libpq 的环境变量及凭据文件补充。初始化后重复打开必须提供同一恢复代次。

```cpp
#include <cstddef>
#include <span>

import lim.storage;

lim::Result<lim::Receipt> send_reply(lim::Chat& chat, const lim::Session& session,
                                     lim::Id room, lim::Id message_id,
                                     std::span<const std::byte> json) {
    return chat.append(session, {room, message_id, lim::HostContent::Json, json});
}
```

宿主先认证设备，通过 `register_device` 登记与该设备绑定的内部凭据 ID，再通过 `create_host_conversation` 和 `set_member` 配置会话访问。宿主验证 JSON 或 UTF-8，存储保留原始字节。一次逻辑发送使用稳定的客户端消息 ID，超时重试复用原始字节和 ID。每个存储句柄由宿主串行调用。

- [架构与存储事务](docs/architecture.md)
- [HTTP 协议与 WebSocket 草案](docs/protocol.md)
- [双库备份与恢复](docs/recovery.md)
- [回环性能基准](benchmarks/README.md)
- [加密与信任设计](docs/security.md)
- [实施与验收](docs/roadmap.md)
- [工程约定](AGENTS.md)
