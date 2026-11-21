import("core.base.option")
local dev = import("devkit", {rootdir = path.absolute(path.join(os.scriptdir(), "..", ".."))})

function main()
    local port = tonumber(option.get("port")) or 7400
    local backend = option.get("backend") or "sqlite"
    if backend == "postgresql" and not os.getenv("LIM_SERVER_PG") then
        raise("postgresql 后端需要环境变量 LIM_SERVER_PG（libpq 连接串）")
    end

    local state = dev.ensure_state({
        port = port, backend = backend, reset = option.get("reset"),
    })
    if not option.get("no-build") then
        dev.build_server()
    end
    local bin = dev.server_binary()
    dev.require_server(bin)

    dev.print_config(state)
    print("另一个终端执行 xmake dev-web（默认已代理到 7400）；Ctrl+C 停止服务。")
    cprint("${bright}→ 启动 lim-server")
    dev.run_foreground("lim-server", bin, {"--config", dev.config_path()},
        {curdir = dev.dev_dir()})
end
