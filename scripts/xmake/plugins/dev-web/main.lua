import("core.base.option")
local dev = import("devkit", {rootdir = path.absolute(path.join(os.scriptdir(), "..", ".."))})

function main()
    dev.ensure_web_deps(option.get("install"))
    if option.get("build") then
        dev.run_checked("Web 生产构建", "pnpm", {"--dir", dev.web_dir(), "build"},
            {curdir = dev.project_root()})
    end

    local mode = option.get("preview") and "preview" or "dev"
    local port = tonumber(option.get("port")) or 5173
    local url = option.get("backend-url") or "http://127.0.0.1:7400"
    cprint("${bright}→ 启动 Vite " .. mode)
    print("   Web     http://127.0.0.1:" .. port .. "/")
    print("   代理    /rpc、/v1/ → " .. url)
    print("   等价命令 LIM_SERVER_URL=" .. url .. " pnpm --dir web " .. mode)
    dev.run_foreground("vite", "node",
        {dev.vite_js(), mode, "--host", "127.0.0.1", "--port", tostring(port), "--strictPort"},
        {curdir = dev.web_dir(), addenvs = {LIM_SERVER_URL = url}})
end
