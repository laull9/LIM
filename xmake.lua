-- 项目元数据
set_project("my_project")
set_version("1.0.0", { build = "%Y%m%d%H%M" })
set_warnings("none")
vcpkg_triplet = "x64-$(os)"

xmake_requires = {
	"fmt","spdlog", "nlohmann-json",
}

test_requires = {
    "catch2"
}
add_requires(xmake_requires)
add_requires(test_requires)

-- 通用编译选项
set_languages("c++23")

-- 生成compile_commands.json供clangd使用
add_rules("plugin.compile_commands.autoupdate")

-- 主程序
target("my_app")
    set_kind("binary")
    add_files("src/*.cpp")
    add_headerfiles("inc/(**.h)")
    add_packages(xmake_requires)

    -- 输出目录保持与原脚本一致
    set_targetdir("$(builddir)/bin/$(os)/$(arch)")
    set_objectdir("$(builddir)/obj/$(os)/$(arch)")

    -- 链接库
    if is_plat("linux") then
        add_links("GL")
    elseif is_plat("windows") then
        add_links("opengl32")
    end

-- tests
includes("tests")
