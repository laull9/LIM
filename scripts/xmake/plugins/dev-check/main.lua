import("core.base.option")
local dev = import("devkit", {rootdir = path.absolute(path.join(os.scriptdir(), "..", ".."))})

function main()
    local cpp = not option.get("web-only")
    local web = not option.get("cpp-only")
    if cpp then
        dev.run_checked("C++ 全套测试", os.programfile(),
            {"test", "--output-on-failure"}, {curdir = dev.project_root()})
    end
    if web then
        dev.ensure_web_deps(false)
        dev.run_checked("Web lint", "pnpm", {"--dir", dev.web_dir(), "lint"},
            {curdir = dev.project_root()})
        dev.run_checked("Web build", "pnpm", {"--dir", dev.web_dir(), "build"},
            {curdir = dev.project_root()})
    end
    cprint("${green}→ 开发检查全部通过")
end
