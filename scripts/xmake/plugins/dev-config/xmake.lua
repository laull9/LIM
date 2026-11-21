task("dev-config")
    set_category("plugin")
    on_run("main")
    set_menu {
        usage = "xmake dev-config [options]",
        description = "生成或查看开发配置与操作员令牌，不启动服务。",
        options = {
            {'p', "port",    "kv", "7400",   "写入配置的监听端口。"},
            {nil, "backend", "kv", "sqlite", "存储后端。", values = {"sqlite", "postgresql"}},
            {nil, "reset",   "k",  nil,      "重新生成 generation 与操作员令牌。"},
            {nil, "show",    "k",  nil,      "只显示现有配置，不重新生成。"},
        }
    }
