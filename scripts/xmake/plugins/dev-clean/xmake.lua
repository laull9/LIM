task("dev-clean")
    set_category("plugin")
    on_run("main")
    set_menu {
        usage = "xmake dev-clean [options]",
        description = "清理 build/dev/ 下的开发数据库、配置与令牌（只删固定文件）。",
        options = {
            {nil, "dry-run", "k", nil, "只列出将清理的文件，不执行删除。"},
        }
    }
