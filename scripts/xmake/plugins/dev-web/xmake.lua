task("dev-web")
    set_category("plugin")
    on_run("main")
    set_menu {
        usage = "xmake dev-web [options]",
        description = "单独启动 Vite，连接已有 lim-server（默认 127.0.0.1:7400）。",
        options = {
            {'p', "port",         "kv", "5173",                     "Vite 端口。"},
            {nil, "backend-url",  "kv", "http://127.0.0.1:7400",   "转发目标，作为 LIM_SERVER_URL 传给 Vite。"},
            {nil, "preview",      "k",  nil,                        "以 vite preview 运行已构建产物。"},
            {nil, "build",        "k",  nil,                        "运行 preview 前先执行 pnpm build。"},
            {nil, "install",      "k",  nil,                        "缺少 web/node_modules 时自动执行 pnpm install。"},
        }
    }
