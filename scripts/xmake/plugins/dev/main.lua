import("core.base.option")
local dev = import("devkit", {rootdir = path.absolute(path.join(os.scriptdir(), "..", ".."))})

function main()
    local port = tonumber(option.get("web-port")) or 5173
    dev.ensure_web_deps(option.get("install"))
    if not option.get("no-build") then
        dev.build_server()
    end
    local bin = dev.server_binary()
    dev.require_server(bin)

    cprint("${bright}→ 启动完整开发环境（临时 SQLite + 演示账号 + Vite）")
    print("   lim-server " .. bin)
    print("   Web        http://127.0.0.1:" .. port .. "/")
    print("   演示账号与密码由 web/demo.py 打印；Ctrl+C 停止并清理临时数据库。")
    dev.run_foreground("web/demo.py", "python3",
        {"-B", dev.demo_script(), bin, "--web-port", tostring(port)},
        {curdir = dev.project_root()})
end
