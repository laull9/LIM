task("dev-check")
    set_category("plugin")
    on_run("main")
    set_menu {
        usage = "xmake dev-check [options]",
        description = "一键校验：C++ 全套测试 + Web lint + Web 构建。",
        options = {
            {nil, "cpp-only", "k", nil, "只运行 C++ 全套测试。"},
            {nil, "web-only", "k", nil, "只运行 Web lint 与构建。"},
        }
    }
