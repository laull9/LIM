task("dev")
    set_category("plugin")
    on_run("main")
    set_menu {
        usage = "xmake dev [options]",
        description = "一键启动完整开发环境：构建 lim-server、临时 SQLite、演示账号与 Vite。",
        options = {
            {nil, "web-port", "kv", "5173", "Web 开发服务器端口。"},
            {nil, "no-build", "k", nil, "跳过构建，直接使用现有 lim-server 产物。"},
            {nil, "install",  "k", nil, "缺少 web/node_modules 时自动执行 pnpm install。"},
        }
    }
