# C++ 项目编码与协作守则

本文件约束开发者与 AI coding agent 的实现、重构、构建和验证行为。目标是让现代 C++ 代码清晰、可靠、易于修改，并控制编译成本和依赖规模。

“必须／禁止”是硬约束；“默认／优先”允许有依据的例外。用户的明确任务要求优先；目录级规则可细化本文件。既有项目先遵循已确定的公共契约和工具配置，迁移规范应作为独立改动，不借小任务全仓重写。不得修改规则、测试或检查配置来掩盖实现缺陷。

## 1. 项目默认约定

新项目采用以下默认值；已有明确约定时保持一致。初始化时，把实际选择、最低工具版本和构建命令记录到 README，并落实到构建、格式化及忽略配置；只创建当前任务需要的文件和目录。

| 项目 | 默认约定 |
| --- | --- |
| 语言标准 | C++23，使用命名模块和 `std::expected` |
| 构建入口 | 仅维护 xmake |
| 标准扩展 | 本项目默认禁用 GNU 等非标准扩展；平台必需扩展集中封装 |
| 代码格式 | LLVM 风格基础，4 空格，100 列，左侧指针／引用符号 |
| 文件 | UTF-8、LF、文件末尾换行；自有 C++ 代码优先使用 `.cppm`，包括模块接口、实现单元和内部分区 |
| 命名 | 英文标识符；类型 `PascalCase`，函数／变量／命名空间 `snake_case` |
| 注释与文档 | 代码注释默认英文，面向维护者的文档默认中文；已有项目遵循其语言约定 |
| 内存与资源 | 值语义和 RAII；独占所有权优先，共享所有权须有实际用途 |
| 异常与 RTTI | 默认保留；禁用必须源于平台或产品要求，并有统一替代方案 |
| 第三方依赖 | 先评估标准库和已有依赖；新增依赖须有明确收益并固定版本 |
| 构建产物 | 按构建系统、平台、架构、配置分离，不写入 `src/`、`include/` 等源码目录或版本控制 |
| TODO.md | 保持精简、实时更新，300行以内，过时进度及时清理 |

## 2. AI 修改代码的工作方式

1. 修改前阅读本目录规则、构建入口、相关实现、调用方和测试；先理解所有权、错误契约和平台限制，再编辑。
2. 实现当前需求的最小完整方案。修复根因，不增加无关功能，不顺手改公共 API、格式或目录结构。
3. 新增外部依赖前先评估 `inc/ltool` 已有能力，优先复用适合的 LTool 接口。需要外部组件时说明缺口和版本，只接入必要的小库。禁止引入整套 Boost，网络组件按实际使用的 Asio、Beast 等独立依赖评估。优先复用现有模块和标准设施。没有明确复用需求，不创建通用框架、服务定位器、多层工厂或自定义对象系统。
4. 不确定 API、标准版本或编译选项时，查询对应版本的官方文档、仓库代码，必要时做最小编译验证。不得凭记忆编造接口。
5. 常规、可逆的实现选择自主完成并说明关键假设；需求不明且会改变公共行为、数据格式或兼容性时再澄清。
6. 保留用户已有改动。避免大面积改写第三方、生成文件或不相关模块；版本控制操作遵循当前任务授权。
7. 不通过空 `catch`、关闭告警、删除断言、跳过测试、伪造成功返回来让检查变绿。必要的局部抑制必须写明原因和范围。
8. 完成后报告：改了什么、为什么、实际运行的验证及结果、尚未验证的环境。没有运行的测试不得写成通过。

## 3. 格式与命名

格式由仓库 `.clang-format` 决定，不进行手工对齐竞赛。固定团队与 CI 使用的 clang-format 主版本；只格式化本次修改范围或相关文件。[1]

新项目可采用以下 `.clang-format` 内容；已有配置不自动覆盖：

```yaml
BasedOnStyle: LLVM
IndentWidth: 4
ContinuationIndentWidth: 4
ColumnLimit: 100
UseTab: Never
BreakBeforeBraces: Attach
PointerAlignment: Left
DerivePointerAlignment: false
ReferenceAlignment: Pointer
NamespaceIndentation: None
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false
```

| 对象 | 规则 | 示例 |
| --- | --- | --- |
| 类型、concept、枚举类型 | `PascalCase` | `FileReader`、`Readable`、`ErrorCode` |
| 函数、局部变量、参数 | `snake_case` | `read_file`、`buffer_size` |
| 命名空间、文件名 | 小写 `snake_case` | `app::io`、`file_reader.cpp` |
| 私有数据成员 | 尾随下划线 | `buffer_`、`is_open_` |
| 公开数据结构字段 | `snake_case` | `width`、`timeout` |
| 命名常量 | `kPascalCase` | `kDefaultTimeout` |
| 枚举项 | `PascalCase` | `ErrorCode::InvalidInput` |
| 必需的宏 | 项目前缀加大写下划线 | `APP_EXPORT` |

- `if`、`else`、循环均使用花括号；一个声明只声明一个变量。
- 优先提前返回，避免无意义嵌套。按职责拆函数，不为满足任意行数限制制造碎片函数。
- 避免含糊的 `data`、`manager`、`helper` 和数字后缀命名；名称说明业务含义、单位或所有权。
- 注释解释原因、不变量、复杂度和生命周期约束；不逐句翻译代码，不保留大段注释掉的旧实现。
- 公共接口说明输入约束、错误、所有权、线程安全；只有存在非显然约束时才补充详细注释。

## 4. 目录、头文件与模块边界

小项目保持简单；按需要使用以下位置，不为了套模板创建空层级：

| 位置 | 内容 |
| --- | --- |
| `src/` | 实现、内部头文件及按领域划分的子目录 |
| `include/<project>/` | 对外发布的库接口；纯应用无需强行建立公共头目录 |
| `apps/` | 多个可执行程序的薄入口；单一应用的入口可留在 `src/` |
| `tests/` | 行为测试、回归用例和小型测试数据 |
| `benchmarks/` | 可复现的性能基准，存在实际测量需求时再建立 |
| `scripts/` | 构建辅助与开发脚本 |
| `docs/` | 架构、兼容性、设计决策和使用说明 |

- 模块按领域职责拆分，避免全部堆入 `utils.hpp`。依赖方向清楚，不形成循环依赖；入口负责组装，不承载大量业务逻辑。[2]
- 新增自有 C++ 接口和实现优先用命名模块，文件统一用 `.cppm`。公共契约在接口单元用 `export` 明确声明，跨文件内部定义优先放到非导出的模块分区。
- `main` 仍属于全局模块。仓库用 `.cppm` 维护测试入口，由 xmake 按普通翻译单元编译。仅在工具链、C ABI 或第三方接口需要传统组织时使用 `.cpp` 或 `.hpp`。
- 头文件必须能独立包含。直接包含所使用设施的声明头，不依赖传递包含或预编译头碰巧提供声明。[3]
- 具有对应接口头的 `.cpp` 首先包含该头，再按项目配置组织其他头；不包含 `.cpp`、`bits/stdc++.h` 或整包巨型便利头。
- 头文件使用 `#pragma once`；目标工具链有特殊要求时使用带项目前缀的 include guard。不要重复叠加两套防护。
- 禁止头文件中的 `using namespace`；实现文件也不使用全局 `using namespace std`。需要时在小作用域引入具体名称。
- 非模板、非必要内联的实现放入模块实现单元；模板、`constexpr` 和必要内联定义按语言要求放置。头文件定义变量时正确处理 ODR，命名常量优先 `inline constexpr`。
- 内部辅助函数限制在翻译单元的匿名命名空间。禁止向 `std` 添加普通声明；只有标准明确允许的特化才能进入 `std`。
- 前置声明只用于本项目可控类型且确有解耦收益的场景；不手工前置声明标准库类型或猜测第三方内部声明。
- 不把 PImpl、header-only 或 C++ modules 作为全项目硬要求；根据 ABI、编译时间和工具支持选择。[2]

## 5. 现代 C++ 的使用范围

- 主动使用 `nullptr`、`enum class`、`using`、`override`、`= default`、`= delete`、`constexpr`、结构化绑定和范围 `for`；不沿用可以直接替换的旧式写法。
- 只读局部量和不修改对象的成员函数优先 `const`。初始化所有数据成员；局部变量尽量在首次使用处声明并初始化。
- `auto` 用于类型明显的初始化、迭代器和复杂表达式；数值宽度、所有权或公共接口需要强调时写明类型。注意 `auto` 和结构化绑定可能产生副本，按语义使用引用。
- 初始化形式服务于语义。`std::vector<int>(10, 0)` 创建十个零，`std::vector<int>{10, 0}` 创建两个元素；禁止机械地把所有圆括号替换为花括号。
- 连续序列优先 `std::vector`／`std::array`；可选值用 `std::optional`，有限互斥状态考虑 `std::variant`，时长用 `std::chrono`，路径用 `std::filesystem::path`。
- 算法和 ranges 在比循环更清晰时使用；不以长管道、深层模板或嵌套 lambda 牺牲调试性。泛型接口优先 concepts／`requires`，避免新增难读的 SFINAE 技巧。
- 常量和简单逻辑优先 `constexpr`、枚举、函数或模板，避免函数式宏；平台判断、导出和条件编译宏集中管理。
- 使用 C++23 标准库特性前，核对 xmake 工具链和目标平台的实际支持。[25]
- 检查库特性测试宏及最小编译探针；仅能接受 `-std=c++23` 不等于已实现相应标准库。不要滥用 `__cplusplus` 一次性推断所有特性。
- modules、协程和更新标准特性按实际需要引入，并验证格式化、静态分析、依赖扫描与xmake 构建；不为“现代化”重写已清楚可靠的代码。

## 6. 资源、所有权与生命周期

资源立即交给 RAII 对象；局部值优先，动态独占用 `std::unique_ptr`，确需共同拥有才用 `std::shared_ptr`。裸指针和引用默认借用；资源适配层以外不直接管理 `new/delete`、`malloc/free` 或系统句柄。优先 Rule of Zero；自定义资源类明确复制、移动和析构语义，析构不向外抛异常。[4]

声明析构函数（包括 `= default`）可能抑制隐式移动成员；自定义特殊成员时检查整组复制／移动行为，不为普通值类型无目的地手写五个特殊成员。[26]

必须主动检查以下问题：

| 场景 | 规则 |
| --- | --- |
| `std::string_view`／`std::span` | 不拥有底层存储；不得返回指向返回后已销毁对象的视图，保存视图前证明所有者活得更久。[5] |
| 视图传给 C API | `string_view::data()` 不保证视图末尾有 `\0`；需要零结尾时构造拥有型字符串，或调用接受长度的接口。[6] |
| 序列访问 | C++20 的 `span::operator[]` 不承诺自动边界检查；索引、空序列上的 `front/back` 均须满足前置条件。[7] |
| 容器变更 | 插入、删除、扩容、rehash 后按该容器规则重新取得可能失效的迭代器／指针／引用；不能把 `reserve` 当万能修复。 |
| ranges 与惰性求值 | 分别检查底层数据、view 自身和谓词捕获的生命周期；不能假定所有 view 都拥有数据，也不能假定全都不拥有。 |
| 异步回调 | 不捕获会提前失效的引用或 `this`；明确任务取消、对象销毁和回调完成的先后关系。 |
| 移动语义 | 不依赖移动后未指定的内容；只执行类型契约允许的操作，或重新赋值。对可执行 NRVO 的同型局部返回值，不随手加 `std::move`。[8] |
| 多态对象 | 通过基类指针删除对象时基类须有适当的虚析构；禁止按值复制多态基类导致切片。 |

避免把智能指针传遍所有接口。观察对象用引用或可空指针；接受／共享所有权时才使用相应智能指针参数。共享所有权环需要拆分或用 `weak_ptr`，但不要无目的地让所有对象相互持有。

## 7. 接口与错误处理

- 小型廉价类型按值传；较大只读对象通常用 `const T&`；输入借用文本可用 `string_view`、连续范围可用 `span`。需要持久保存的数据由被调方取得所有权。
- 用返回值表达结果，避免多重输出参数和隐藏修改。可能混淆的相邻同型参数采用有名称的参数结构或有意义的强类型。
- 除拷贝／移动构造外，可由单个实参调用的构造函数默认 `explicit`；确需隐式转换时说明用途。只在有实际语义时添加 `[[nodiscard]]`、`noexcept` 和运算符重载。
- 本项目默认：正常的“没有值”用 `optional`；需要错误原因的预期失败用统一错误类型；无法完成操作的异常失败可抛异常。采用已有库的结果类型或错误码约定，不创建多套不兼容体系。
- C++20 没有 `std::expected`。确需结果类型时选用已有依赖的成熟实现，或一个项目内统一的简单方案；不为单个函数建立庞大的 Result 框架。
- 失败必须保留可操作的上下文；禁止空结果、零值或空字符串伪装成功。只在能够处理、增加上下文或转换边界协议的位置捕获异常。
- `assert` 仅用于内部不变量，不能替代外部输入验证；断言表达式不得含必须执行的副作用。Release 下错误路径仍须正确。
- `noexcept` 是承诺，不是“性能标记”；确认所有调用路径。异常不越过 C ABI 或不允许抛出的系统回调边界；线程入口也须明确处理失败。
- 不在底层每一层重复记录同一错误；在适合处理的边界记录一次，并保留传播链。库不擅自退出进程或替调用者配置全局日志。

## 8. 数值、输入输出与平台差异

- 计算前检查长度、索引和乘法／加法溢出；把已经溢出的结果转换成更宽类型不能补救。避免无符号减法下溢和有符号／无符号混比；不得靠强制转换压制告警。[9]
- 用 C++ 命名转换代替 C 风格转换。窄化先做范围检查；对象表示转换按条件使用 `bit_cast` 或字节复制，不用 `reinterpret_cast` 绕过别名、对齐和生命周期规则。
- 不把结构体内存布局直接当文件或网络协议。序列化明确字段宽度、字节序、版本、长度上限及异常输入行为。
- 外部输入在边界解析并验证；检查部分读取／写入、EOF、失败和超时。不要把文件存在性预检查当作实际打开成功的保证。
- `std::filesystem::path` 负责路径运算；路径不是简单字符串拼接。明确文本编码与平台路径转换，不假定 Windows 窄字符路径天然是 UTF-8。
- 计时和超时使用单调时钟 `steady_clock`；日历时间按需求使用 `system_clock`。不硬编码平台相关整数宽度、路径分隔符或换行假设。
- 浮点比较、舍入和容差按业务定义；禁止默认启用 `fast-math`、`/fp:fast` 或 `-march=native` 作为通用发布配置。
- OS API 集中到小型适配模块；核心逻辑不散布大量平台宏。公开稳定插件 ABI 时单独规定边界，不随意跨不兼容运行库传递 STL 对象。

## 9. 并发与异步

- 默认先写可靠的同步逻辑；并发须来自实际响应性或吞吐需求。共享可变状态必须有明确同步；`volatile` 不能替代锁或原子操作。[10]
- 锁使用具名 RAII 对象；多个锁保持统一顺序，必要时使用 `scoped_lock`。避免持锁调用未知回调、长时间 I/O 或可重入代码。
- 对象被 `shared_ptr` 管理不代表对象本身线程安全；同一个智能指针实例的并发修改也需要适当同步。
- 有作用域生命周期的工作线程优先考虑 `std::jthread`／`stop_token`；停止是协作式的，必须有可退出路径。不得默认 `detach` 让线程生命周期失控。
- 等待条件变量使用谓词；每项后台任务明确取消、超时、所有权和关闭流程。不通过 `sleep` 猜测其他线程已经完成。
- 不引入未经论证的无锁结构或弱内存序；使用时说明同步关系和验证方法。简单互斥锁能满足需求时保持简单。
- 协程跨挂起点保存的数据必须仍有效；默认不跨挂起点持锁。带捕获的协程 lambda 需特别审查闭包生命周期，捕获 `shared_ptr` 也不能自动消除闭包销毁风险。[11]

## 10. xmake 构建规范

- xmake 是 LIM 的唯一构建入口。每个目标声明源码归属目录、依赖、模块可见性和语言标准。C++ 目标在目标作用域使用 `set_languages("cxx23")`。[18]
- 能通过稳定约定自动完成的重复工作，优先自动化。xmake 按目标归属目录用 `*.cppm` 收集源码，新增常规模块无需改构建清单。公共模块放在领域目录的 `public/` 下并标记为 `public`，实现和内部模块按各自目录收集。仅平台条件、生成文件或特殊编译选项需要单独声明，避免跨目标的全仓递归扫描。
- 构建输出放在 `build/xmake/` 下，区分平台、架构和配置。`.xmake/` 配置缓存及编译数据库不提交版本控制。
- 依赖通过 `add_deps`、`add_packages` 等目标 API 声明，私有编译选项和数据库驱动头不泄漏给嵌入方。
- SQLite 与 libpq 通过 pkg-config 消费系统开发包，构建配置明确最低版本。引入由 xmake 下载的依赖时固定版本并提交 `xmake-requires.lock`。[20]
- 通过 `add_tests` 注册单元测试与集成测试。SQLite 和 PostgreSQL 跑同一套存储契约，测试使用独立临时数据库。[21]
- xmake 构建自动刷新 `build/ide/compile_commands.json`。该路径供 Clice 使用，手动刷新使用 `xmake project -k compile_commands --lsp=clangd build/ide`。Sanitizer 通过 xmake policy 启用，并检查参数覆盖编译和链接。[19][22]

```sh
xmake f -m debug -o build/xmake
xmake
xmake test --output-on-failure
```

ASan 与 UBSan 使用支持相应检查的工具链。TSan 用单独配置。

```sh
xmake f -m debug -o build/xmake/asan --policies=build.sanitizer.address,build.sanitizer.undefined
xmake test --output-on-failure
```

`xmake f` 会更新当前工程配置，切回普通构建时显式恢复 policies。不同配置并行执行时使用独立工作目录。

## 11. 告警、静态分析与测试

- 本项目代码在约定告警级别下不新增告警。GCC／GNU 风格 Clang 从 `-Wall -Wextra -Wpedantic` 起步；MSVC 风格从 `/W4` 起步，严格一致性选项按支持情况配置。
- `-Wconversion`、`-Wsign-conversion`、`-Wshadow` 等按实际项目逐项启用并修复问题；不把所有编译器的所有告警一次性设成错误。CI 可对固定工具链启用 warnings-as-errors，分发给用户的构建保留关闭入口。
- clang-tidy 使用真实 `compile_commands.json`。选择与风险有关的 `clang-analyzer`、`bugprone`、`performance` 和具体现代化检查；禁止未经评估开启全部检查并自动全仓修复。[23]
- 内存和生命周期敏感改动运行支持平台上的 ASan＋UBSan；并发改动按需运行独立 TSan。Sanitizer 需要正确覆盖编译和链接，且只能发现实际执行到的部分问题。[9][24]
- 测试验证行为与契约：正常输入、边界、失败路径和对应回归；不为凑覆盖率复制实现逻辑，不只断言“没有崩溃”。不为纯格式或文字修改编写测试。
- 复用现有测试框架，避免混入第二套。测试应可重复；隔离临时文件、端口和全局状态，控制时钟和随机源，不依赖公网可用性或执行顺序。
- 构建入口注册完整的必要测试。实际检查测试数量和失败传播；“发现 0 个测试”不能当作功能已验证。

按改动风险选择验证范围，达到目的后停止重复检查：

| 改动 | 最小合理验证 |
| --- | --- |
| 纯文档／格式 | 检查内容与格式，不为此强行全量构建 |
| 普通实现修改 | 主入口增量构建＋受影响的行为测试 |
| 错误修复 | 能捕获该问题的回归用例＋相关测试 |
| 公共头／模板／ABI | 受影响消费者、承诺支持的编译器或针对性编译用例 |
| 构建／依赖／平台条件 | xmake 干净配置与构建＋对应测试 |
| 发布 | 按 README 承诺的矩阵验证干净构建、测试和实际分发／安装行为 |

## 12. 编译成本、依赖与发布

- 引入大模板库、header-only 依赖或公共头重型包含前，评估冷构建、增量构建、链接时间与产物体积。没有测量结果，不宣称某种写法“零成本”或“更快”。
- 常规实现放模块实现单元，减少接口依赖；编译瓶颈确认后再考虑显式模板实例化、PCH、modules、unity build 或构建缓存。
- PCH／unity build 不能掩盖缺失 include 或 ODR 问题。采用这些加速方案的项目保留普通独立编译的验证方式。
- 本地优先增量构建，不因小改动删除全部构建目录、全局依赖缓存或编译缓存；只清理明确失效的最小范围。
- 性能优化以代表性 Release 基准为依据，说明输入、编译器、优化配置和测量方式。避免为微小收益增加长期维护负担。
- 不默认禁用异常／RTTI、不默认打开 LTO、不默认强制全静态链接；按启动速度、分发要求、平台约束和实测结果选择。
- 新依赖检查维护状况、许可要求和传递依赖；不重复引入已有能力，也不自行重写成熟的密码学、TLS、JSON 或平台兼容层。
- 不跟随浮动分支或 `latest`；升级依赖是可追溯改动。源码仓库不提交 build／dist 产物、编译数据库、缓存、密钥或机器专属路径。
- 库的 public API、配置格式和命令行行为变化同步更新文档；需要兼容迁移时提供清楚的处理方式。

## 13. 完成检查

提交或交付前确认：

- 改动满足实际需求，没有无关重构、占位实现或未说明的行为变化。
- 所有权、借用生命周期、错误路径、数值边界和并发关闭逻辑已经检查。
- 涉及工程元数据时，xmake 构建、依赖和必要测试已同步。
- 适当范围的格式、构建、测试或分析已完成；失败与未验证项如实说明。
- 文档反映当前行为；diff 中没有意外产物、凭据、绝对路径或用户改动丢失。

## 参考资料

以下一手资料用于核对语言语义与工具行为；格式、目录和验证强度等规则是本项目的取舍。工具升级时以项目锁定版本的文档和实际验证为准。

1. [Clang Format 配置](https://clang.llvm.org/docs/ClangFormatStyleOptions.html)
2. [LLVM Coding Standards：头文件、模块依赖与编译成本](https://llvm.org/docs/CodingStandards.html)
3. [Google C++ Style Guide：Self contained Headers 与 Include What You Use](https://google.github.io/styleguide/cppguide.html#Header_Files)
4. [C++ Core Guidelines：资源和所有权](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines#S-resource)
5. [Clang Tidy：悬空 view／handle](https://clang.llvm.org/extra/clang-tidy/checks/bugprone/dangling-handle.html)
6. [C++ working draft：string view](https://eel.is/c++draft/string.view)
7. [C++20 N4861 草案文本：span 元素访问](https://timsong-cpp.github.io/cppwp/n4861/span.elem)
8. [Clang Tidy：移动后使用](https://clang.llvm.org/extra/clang-tidy/checks/bugprone/use-after-move.html)
9. [Clang UndefinedBehaviorSanitizer](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html)
10. [C++ working draft：数据竞争](https://eel.is/c++draft/intro.races)
11. [Clang Tidy：带捕获的协程 lambda](https://clang.llvm.org/extra/clang-tidy/checks/cppcoreguidelines/avoid-capturing-lambda-coroutines.html)
18. [xmake 目标配置 API](https://xmake.io/api/description/project-target.html)
19. [xmake 内置 policies](https://xmake.io/api/description/builtin-policies.html)
20. [xmake 依赖与锁文件](https://xmake.io/guide/package-management/using-official-packages.html)
21. [xmake 测试](https://xmake.io/guide/basic-commands/run-tests.html)
22. [xmake 内置插件与编译数据库](https://xmake.io/guide/extensions/builtin-plugins.html)
23. [Clang Tidy](https://clang.llvm.org/extra/clang-tidy/)
24. [Clang AddressSanitizer](https://clang.llvm.org/docs/AddressSanitizer.html) 与 [ThreadSanitizer](https://clang.llvm.org/docs/ThreadSanitizer.html)
25. [GCC libstdc++ 标准库实现状态与特性宏](https://gcc.gnu.org/onlinedocs/libstdc++/manual/status.html)
26. [C++ working draft：复制与移动构造](https://eel.is/c++draft/class.copy.ctor)
