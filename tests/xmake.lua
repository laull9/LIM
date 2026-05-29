-- tests
--
-- 约定：tests 目录下每个 *.cpp 都会生成一个独立的测试可执行文件。
-- - 不参与默认构建（set_default(false)）
-- - 通过 `xmake test` 或 `xmake test <name>` 运行
--
-- 目标名 = 文件名（不带扩展名），例如 tests/test_example.cpp -> target("test_example")

for _, filepath in ipairs(os.files(path.join(os.scriptdir(), "*.cpp"))) do
    local name = path.basename(filepath)

    target(name)
        set_kind("binary")
        set_group("test")
        set_default(false)

        add_tests("default")

        add_files(filepath)
        add_includedirs("$(projectdir)/inc")

        add_packages("catch2")

        -- 输出路径与主工程保持同一个 builddir，但单独放到 tests 子目录
        set_targetdir("$(builddir)/bin/$(os)/$(arch)/tests")
        set_objectdir("$(builddir)/obj/$(os)/$(arch)/tests/" .. name)
end
