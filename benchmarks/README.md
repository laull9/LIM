# HTTP 回环基准

用 Release 构建和本机 HTTP/1.1 持久连接测量端到端延迟。每轮启动独立服务和临时 SQLite 文件或 PostgreSQL 集群。计时包含客户端编码、网络往返、服务端处理和客户端解码。SQLite 使用 WAL 和 `synchronous=FULL`。

```sh
xmake f -m release --toolchain=clang -o build/xmake
xmake build lim-server

# macOS arm64 上的 xmake 产物路径
server=build/xmake/macosx/arm64/release/lim-server
python3 -B benchmarks/rpc_http.py "$server" --backend sqlite --binary
python3 -B benchmarks/rpc_http.py "$server" --backend postgresql --binary
```

PostgreSQL 测试复用集成测试的本机工具配置，可通过 `LIM_PG_BINDIR` 指定 `initdb`、`pg_ctl` 和 `psql` 所在目录。输出为 JSON Lines，每行一轮。默认每种后端 3 轮，每轮 180 次 1 KiB 提交、180 次空页补齐和 60 次大页读取。用旧版二进制比较时去掉 `--binary`。可用 `--repeat 1` 交替运行，以降低系统状态变化的影响。

## 本轮结果

macOS arm64、Homebrew Clang 23.1.6、SQLite 3.54.1、PostgreSQL 18.3。改动前后的 Release 服务交替运行，各 5 轮。表中为各轮 P50 和 P99 的中位数，单位为毫秒。

| 路径 | SQLite 改动前 | SQLite 改动后 | PostgreSQL 改动前 | PostgreSQL 改动后 |
| --- | ---: | ---: | ---: | ---: |
| JSON-RPC 提交 1 KiB | 0.187 / 0.270 | 0.185 / 0.273 | 0.293 / 0.393 | 0.283 / 0.346 |
| JSON-RPC 空页补齐 | 0.097 / 0.143 | 0.067 / 0.100 | 0.219 / 0.270 | 0.152 / 0.182 |
| JSON-RPC 大页，按默认上限截断 | 8.516 / 8.801 | 8.115 / 8.393 | 9.719 / 10.123 | 9.757 / 10.692 |

在改动后的同一进程中，取固定上界的 16 条 64 KiB 消息。JSON-RPC 路径解码全部 Base64 正文，二进制路径解析全部事件头及正文边界。

| 后端 | JSON-RPC P50 / P99（ms） | 二进制 HTTP P50 / P99（ms） |
| --- | ---: | ---: |
| SQLite | 7.809 / 8.106 | 0.671 / 0.807 |
| PostgreSQL | 8.898 / 11.188 | 1.668 / 1.829 |

空页 P50 两个后端均下降约 31%。1 KiB 写入在这组负载下基本持平。固定大页改走二进制 HTTP 后，P50 分别缩短至原来的约 1/12 和 1/5。生产连接数、RSS、跨主机网络和 TLS 的测量列在路线图中。
