import("core.base.option")
local dev = import("devkit", {rootdir = path.absolute(path.join(os.scriptdir(), "..", ".."))})

function main()
    local dryrun = option.get("dry-run")
    local count = 0
    for _, file in ipairs(dev.data_files()) do
        if os.isfile(file) then
            count = count + 1
            if dryrun then
                print("将删除 " .. file)
            else
                os.tryrm(file)
                print("已删除 " .. file)
            end
        end
    end
    if count == 0 then
        print("没有需要清理的开发数据（" .. dev.dev_dir() .. "）")
    elseif dryrun then
        print("共 " .. count .. " 个文件；去掉 --dry-run 执行清理。")
    else
        print("已清理 " .. count .. " 个文件；下次启动会生成新的 generation 与操作员令牌。")
    end
end
