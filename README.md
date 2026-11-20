# LIM

LIM 是一个可嵌入的轻量聊天服务器。目标部署形态是一个 `lim-server` 进程和本机 SQLite 数据目录。C++ 应用也可以把同一套会话、发送、补齐接口链接进自己的进程。单聊、邀请制小群和 Agent Harness 共用一条按会话排序的事件日志。

普通聊天默认采用 MLS 端到端加密。需要读取上下文的 Agent 可以作为受邀的加密端点入群；受信宿主还可以显式创建宿主可读的会话，直接保存文本、JSON 或字节。会话建立后固定内容模式。

## 当前可用

- C++23 静态库目标 `lim::core`。模块 `lim.chat` 导出身份、消息、回执、分页及同步调用接口；`lim.frame` 实现有界、借用输入的二进制拆帧。
- 可单独执行的 SQLite 日志设计和约束测试。服务监听、C++ SQLite 适配器、凭据管理和 MLS 客户端仍在实施路线中。目前没有可运行的 IM 守护进程。
- 源码集成使用 `add_subdirectory(path/to/LIM)` 和 `target_link_libraries(my_app PRIVATE lim::core)`，然后在 C++23 消费目标中 `import lim.chat;`。同一工具链从源码构建模块。

| 从哪里读 | 内容 |
| --- | --- |
| [系统架构](docs/architecture.md) | 嵌入与部署、宿主边界、SQLite 写入、内存预算 |
| [协议](docs/protocol.md) | HTTP/WS、Agent 消息示例、幂等与补齐 |
| [加密与信任](docs/security.md) | MLS、设备授权、宿主可读会话的信任边界 |
| [实施与验收](docs/roadmap.md) | 发布切片、可重现的内存和延迟验收 |
| [日志结构](design/sqlite/event_log.sql) | 可执行的 SQLite 事件与幂等约束草案 |

## Agent 侧的调用形状

宿主为每次逻辑答复生成并持久化一个 UUID，和已经编码的字节一起保存。重试时取回两者。下面的函数可由宿主的写入线程调用；具体 Chat 适配器由宿主注入。

```cpp
#include <cstddef>
#include <span>
import lim.chat;

lim::Result<lim::Receipt> send_reply(lim::Chat& chat, const lim::Session& session,
                                     lim::Id room, lim::Id message_id,
                                     std::span<const std::byte> json) {
    return chat.append(session, {room, message_id, lim::HostContent::Json, json});
}
```

## 构建与验证

CMake 入口要求 3.28+ 和 Ninja 1.11+。xmake 入口要求 3.0.6+。C++ 编译器与标准库需支持 named modules 和 `std::expected`。Linux x86-64 已验证 GCC/libstdc++ 14.2、CMake 3.31.6、Ninja 1.11.1 与 xmake 3.0.6；核心无需下载第三方包。使用 clang-format 19 的 LLVM 风格。

```sh
cmake --preset debug
cmake --build build/cmake/Linux/debug
ctest --test-dir build/cmake/Linux/debug --output-on-failure

xmake f -m debug -o build/xmake
xmake build lim_frame_test
xmake test

# 可选的存储设计验证，Python 3.11+ 与 SQLite 3.37+
python3 design/sqlite/check_event_log.py
```

本次 Linux 验证中，ASan 拆帧测试通过（运行环境限制，关闭 leak 检查）。GCC 14.2 在启用 UBSan 编译模块接口时出现内部编译器错误，UBSan 验证待换工具链复测。

Release 构建可选 `cmake --preset release` 并构建对应的 release 目录，或 `xmake f -m release -o build/xmake && xmake`。贡献规范见 [AGENTS.md](AGENTS.md)。
