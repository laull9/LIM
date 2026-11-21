# LIM

LIM 是面向单聊、小群和 Agent Harness 的轻量聊天服务器项目。当前账号版已贯通注册、登录、刷新恢复、自动设备登记、用户查找、私聊/小群创建、宿主可读文字收发、离线缓存和跨会话待发投递。消息仍为 `host`/宿主可读模式，MLS 端到端加密尚未实现。存储使用 SQLite 文件或 PostgreSQL，两种后端共享有序事件日志、幂等重试、补齐、恢复代次和保留期契约；`lim-server` 提供 JSON-RPC 2.0、二进制 HTTP 和长轮询。WebSocket 仍为后续路线。

| xmake 目标 | 模块 | 职责 |
| --- | --- | --- |
| `lim_core` | `lim.chat`、`lim.frame` | 发送与补齐接口、值类型、有界二进制拆帧 |
| `lim_storage` | `lim.storage` | 运行时选择 SQLite 或 PostgreSQL，初始化存储并实现 `Chat` 与可信宿主管理 |
| `lim-server` | 独立服务 | JSON-RPC 2.0、二进制 HTTP 和长轮询 |
| `lim_frame_test`、`lim_storage_test` | 测试入口 | 拆帧单测与两种真实数据库的共享契约测试 |

## 构建与测试

需要 xmake 3.1.2+、支持 C++23 命名模块和 `std::expected` 的工具链，以及 pkg-config 能找到的 SQLite 3.37+、libpq 14+ 和 OpenSSL 3.0+ `libcrypto` 开发包。Clang 工具链需要同版本的 `clang-scan-deps`。使用包管理器安装系统库，配在非标准目录时用 `PKG_CONFIG_PATH` 指向对应的 `.pc` 目录。

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

## 开发任务（xmake 插件）

`scripts/xmake/plugins/` 提供一组项目级 xmake 插件，把常用手工命令收敛成 `xmake dev*`。`xmake --help` 的 Plugins 段会列出它们，`xmake <任务> --help` 查看选项。

| 命令 | 作用 |
| --- | --- |
| `xmake dev` | 一键完整开发环境：构建 `lim-server`、临时 SQLite、注册 `alice` / `bob` 演示账号、启动 Vite。 |
| `xmake dev-server` | 只启动后端，使用 `build/dev/` 下的持久开发数据库，默认监听 7400。 |
| `xmake dev-web` | 只启动 Vite，默认把 `/rpc`、`/v1/` 代理到 `127.0.0.1:7400`。 |
| `xmake dev-check` | 一键校验：`xmake test` 全套 + `pnpm lint` + `pnpm build`。 |
| `xmake dev-config` | 生成或查看开发配置、本地操作员令牌（`--show`），不启动服务。 |
| `xmake dev-clean` | 清理 `build/dev/` 下的数据库、配置与令牌（`--dry-run` 仅预览）。 |

两个终端各跑一条命令即可开始持久开发，数据重启后保留：

```sh
xmake dev-server   # 终端 1：后端，首次运行会自动构建
xmake dev-web      # 终端 2：前端 http://127.0.0.1:5173/
```

只想快速看演示时，一条命令即可（每次都是全新的临时数据库）：

```sh
xmake dev
```

打开 [本地客户端](http://127.0.0.1:5173/)，用终端打印的 `alice` / `bob` 与统一密码 `lim-demo-pass` 分别在两个独立浏览器上下文登录。

几个约定：

- `dev-server` 把 `lim.json`、`lim-dev.db`、`operator.token` 放在 `build/dev/`（已忽略）；可用 `LIM_DEV_DIR` 改位置，`dev-clean` 只删这几个固定文件。
- **generation 与操作员令牌会持久化复用**：存储会核对恢复代次，每次启动换随机数会导致下次启动失败。只有 `--reset` 才重建数据库并更换两者；`dev-config --show` 可再次查看令牌。
- 配置的 `devices` 为空，普通用户走账号注册／登录；操作员令牌只用于本地调试旧版操作员 RPC，不要用于生产。
- `dev-server --backend=postgresql` 需要 `LIM_SERVER_PG` 连接串；`dev-web --backend-url` 可指向其他后端，`--preview --build` 用生产构建预览；`dev-check --cpp-only` / `--web-only` 可只跑一侧。
- 常驻任务都在前台运行，`Ctrl+C` 停止；子进程异常退出（端口占用、配置错误等）会让 xmake 以非零码失败。

## 编辑器索引

Clice 读取 `build/ide/compile_commands.json`。xmake 构建时自动刷新编译数据库，模块、编译器及依赖参数取自当前构建配置。只更新索引参数时运行下面的命令。

```sh
xmake project -k compile_commands --lsp=clangd build/ide
```

在 VS Code 打开 LIM 根目录。首次切换配置后，可在命令面板运行 `clice: Restart Language Server` 重新加载。

## 独立服务

`lim-server` 使用 LTool 的 LWeb 和 LJson，通过 `--config FILE` 启动。依赖、设备和操作员凭据配置、方法表及请求示例见 [JSON-RPC 2.0](docs/rpc.md)。原始正文收发和低开销在线提示见 [二进制 HTTP](docs/protocol.md)。

[LIM Web demo](web/README.md#启动双端-demo) 用临时 SQLite 数据库注册两个演示账号、登录并自动登记设备，在两个隔离浏览器上下文中完成收发。也可以连接现有服务；受控设备令牌入口仍然保留。

当前账号密码由 OpenSSL scrypt 保存，访问/刷新令牌只保存 SHA-256 摘要并支持轮换、注销和设备撤销。服务端仍可读取 `host` 会话正文，不能把它当作端到端加密使用；[MLS 设计](docs/security.md)尚未落地。

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
