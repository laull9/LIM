task("dev-server")
    set_category("plugin")
    on_run("main")
    set_menu {
        usage = "xmake dev-server [options]",
        description = "单独启动 lim-server，使用 build/dev/ 下的持久开发数据库。",
        options = {
            {'p', "port",     "kv", "7400",    "监听端口；Vite 默认代理到该端口。"},
            {nil, "backend",  "kv", "sqlite",  "存储后端。", values = {"sqlite", "postgresql"}},
            {nil, "reset",    "k",  nil,       "重建开发数据库，并更换 generation 与操作员令牌。"},
            {nil, "no-build", "k",  nil,       "跳过构建，直接使用现有 lim-server 产物。"},
        }
    }
