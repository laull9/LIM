-- 项目元数据
set_project("lim")
set_version("0.0.1", { build = "%Y%m%d%H%M" })
set_warnings("none")
vcpkg_triplet = "x64-$(os)"

xmake_requires = {}

test_requires = {
    "catch2"
}
add_requires(xmake_requires)
add_requires(test_requires)

-- 通用编译选项
set_languages("c++23")

-- macOS 使用 PATH 中的 LLVM clang，避免项目配置到缺失的 Xcode SDK。
if is_plat("macosx") and not get_config("toolchain") then
    set_toolchains("clang")
end

-- 生成compile_commands.json供clangd使用
add_rules("plugin.compile_commands.autoupdate")

-- 主程序
target("my_app")
    set_kind("binary")
    add_files("src/*.cppm")
    add_files("inc/ltool/modules/ltool.cppm")
    add_headerfiles("inc/(**.h)")
    add_includedirs("inc")
    add_includedirs("inc/ltool")
    add_includedirs("inc/ltool/pkgs/range-v3/include")
    add_packages(xmake_requires)
    set_policy("build.c++.modules", true)

    -- 输出目录保持与原脚本一致
    set_targetdir("$(builddir)/bin/$(os)/$(arch)")
    set_objectdir("$(builddir)/obj/$(os)/$(arch)")

-- tests
includes("tests")
