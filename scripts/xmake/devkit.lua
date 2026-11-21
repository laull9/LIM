-- LIM 开发任务共享工具。
--
-- 这是 xmake 自定义模块（不是普通 lua 模块）：文件里定义的全局函数就是模块接口。
-- 插件里通过 `import("devkit", {rootdir = <scripts/xmake>})` 加载。
-- 所有路径都从工程根目录推导，开发数据固定放在 build/dev/（.gitignore 已忽略）。

function project_root()
    return os.projectdir()
end

function web_dir()
    return path.join(project_root(), "web")
end

-- 可用 LIM_DEV_DIR 指向其他位置；无论如何只增删下面 data_files() 列出的固定文件。
function dev_dir()
    local override = os.getenv("LIM_DEV_DIR")
    if override and override ~= "" then
        return path.absolute(override)
    end
    return path.join(project_root(), "build", "dev")
end

function config_path()
    return path.join(dev_dir(), "lim.json")
end

function state_path()
    return path.join(dev_dir(), "state.lua")
end

function token_path()
    return path.join(dev_dir(), "operator.token")
end

function database_path()
    return path.join(dev_dir(), "lim-dev.db")
end

function vite_js()
    return path.join(web_dir(), "node_modules", "vite", "bin", "vite.js")
end

function demo_script()
    return path.join(web_dir(), "demo.py")
end

function web_deps_ready()
    return os.isfile(vite_js())
end

function data_files()
    local dir = dev_dir()
    return {
        path.join(dir, "lim-dev.db"),
        path.join(dir, "lim-dev.db-wal"),
        path.join(dir, "lim-dev.db-shm"),
        path.join(dir, "lim-dev.db-journal"),
        config_path(),
        state_path(),
        token_path(),
    }
end

function ensure_dir()
    os.mkdir(dev_dir())
end

function remove_data_files()
    for _, file in ipairs(data_files()) do
        if os.isfile(file) then
            os.tryrm(file)
        end
    end
end

-- 64 位小写 hex 令牌。仅用于本地开发的操作员凭据，不用于生产。
function new_token()
    local function hex_uuid()
        return (hash.uuid4():gsub("-", "")):lower()
    end
    return hex_uuid() .. hex_uuid()
end

-- 生成或复用开发配置。
--
-- generation 必须持久化：open_store 会用它核对数据库的恢复代次，
-- 每次启动换一个随机数会导致第二次启动直接失败。操作员令牌同理，
-- 重启后保持不变才能用同一份凭据调用旧版操作员 RPC。
function ensure_state(opts)
    opts = opts or {}
    local port = tonumber(opts.port) or 7400
    local backend = opts.backend or "sqlite"
    if port < 1 or port > 65535 then
        raise("端口必须在 1 到 65535 之间，当前为 " .. tostring(opts.port))
    end
    if backend ~= "sqlite" and backend ~= "postgresql" then
        raise("存储后端只能是 sqlite 或 postgresql，当前为 " .. tostring(backend))
    end

    ensure_dir()
    local state = nil
    if not opts.reset and os.isfile(state_path()) then
        -- 沙箱没有 pcall，直接按 io.save 的文本格式读取，损坏时回退到重新生成。
        local saved = io.readfile(state_path())
        local generation = saved:match('generation%s*=%s*"([^"]+)"')
        local token = saved:match('operator_token%s*=%s*"([^"]+)"')
        if generation and token then
            state = {generation = generation, operator_token = token}
        end
    end
    if opts.reset then
        remove_data_files()
    end
    if not state then
        state = {
            generation = hash.uuid4():lower(),
            operator_token = new_token(),
        }
    end
    state.port = port
    state.backend = backend
    io.save(state_path(), state)

    -- token 文件本身是 sha256 的输入，必须不含换行；config 里只保存摘要。
    io.writefile(token_path(), state.operator_token)
    local digest = hash.sha256(token_path())
    local storage = backend == "postgresql"
        and '{"backend": "postgresql"}'
        or '{"backend": "sqlite", "file": "lim-dev.db"}'
    io.writefile(config_path(), string.format([[{
  "port": %d,
  "generation": "%s",
  "storage": %s,
  "operator_token_sha256": "%s",
  "devices": []
}
]], port, state.generation, storage, digest))
    return state
end

function print_config(state)
    print("开发目录   " .. dev_dir())
    print("配置文件   " .. config_path())
    if state.backend == "postgresql" then
        print("存储       PostgreSQL（LIM_SERVER_PG）")
    else
        print("SQLite     " .. database_path())
    end
    print("监听       http://127.0.0.1:" .. tostring(state.port))
    print("generation " .. state.generation)
    print("操作员令牌 " .. state.operator_token)
    print("令牌仅用于本地开发；再次查看用 xmake dev-config --show。")
end

function server_binary()
    local config = import("core.project.config")
    local project = import("core.project.project")
    config.load()
    local target = project.target("lim-server")
    if not target then
        return nil
    end
    return path.absolute(target:targetfile())
end

function build_server()
    cprint("${bright}→ 构建 lim-server")
    local code, errors = os.execv(os.programfile(), {"build", "lim-server"},
        {try = true, curdir = project_root()})
    if code ~= 0 then
        raise("xmake build lim-server 失败（退出码 " .. tostring(code) .. "）"
            .. (errors and (": " .. errors) or ""))
    end
end

function require_server(bin)
    if not bin or not os.isfile(bin) then
        raise("找不到 lim-server 产物：" .. tostring(bin)
            .. "；请去掉 --no-build 或先执行 xmake build lim-server")
    end
end

function ensure_web_deps(install)
    if web_deps_ready() then
        return
    end
    if not install then
        raise("缺少 web/node_modules/vite；请先执行 pnpm --dir web install --frozen-lockfile，"
            .. "或加 --install 让任务自动安装")
    end
    run_checked("安装 Web 依赖", "pnpm",
        {"--dir", web_dir(), "install", "--frozen-lockfile"}, {curdir = project_root()})
    if not web_deps_ready() then
        raise("pnpm install 结束后仍找不到 " .. vite_js())
    end
end

-- 一次性命令：失败立即报错，用于构建/测试/安装等步骤。
function run_checked(label, program, args, opt)
    cprint("${bright}→ " .. label)
    local options = opt or {}
    options.try = true
    local code, errors = os.execv(program, args, options)
    if code ~= 0 then
        raise(label .. " 失败（退出码 " .. tostring(code) .. "）"
            .. (errors and (": " .. errors) or ""))
    end
end

-- 常驻前台进程：Ctrl+C / SIGTERM 是正常停止，其余非零退出码要让任务失败，
-- 否则端口占用、配置错误之类的问题会被当成「命令执行成功」。
function run_foreground(label, program, args, opt)
    local options = opt or {}
    options.try = true
    local code = os.execv(program, args, options)
    if code ~= 0 then
        -- 2 是常见的中断返回；128+ 是信号终止（130=SIGINT、143=SIGTERM）。
        local interrupted = code == 2
            or (type(code) == "number" and (code >= 128 or code < 0))
        if interrupted then
            cprint("${yellow}" .. label .. " 已停止")
        else
            raise(label .. " 异常退出（退出码 " .. tostring(code)
                .. "），请查看上方子进程输出")
        end
    end
    return code
end
