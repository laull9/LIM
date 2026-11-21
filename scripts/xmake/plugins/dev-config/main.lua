import("core.base.option")
local dev = import("devkit", {rootdir = path.absolute(path.join(os.scriptdir(), "..", ".."))})

function main()
    if option.get("show") then
        if not os.isfile(dev.config_path()) or not os.isfile(dev.token_path()) then
            raise("尚无开发配置，请先执行 xmake dev-config")
        end
        print(io.readfile(dev.config_path()))
        print("operator_token " .. io.readfile(dev.token_path()))
        return
    end

    local port = tonumber(option.get("port")) or 7400
    local backend = option.get("backend") or "sqlite"
    if backend == "postgresql" and not os.getenv("LIM_SERVER_PG") then
        raise("postgresql 后端需要环境变量 LIM_SERVER_PG（libpq 连接串）")
    end
    local state = dev.ensure_state({
        port = port, backend = backend, reset = option.get("reset"),
    })
    dev.print_config(state)
end
