set_xmakever("3.1.2")
set_project("lim")
set_version("0.1.0")
set_defaultmode("debug")
add_rules("mode.debug", "mode.release")

if os.projectdir() == os.scriptdir() then
    add_rules("plugin.compile_commands.autoupdate", {outputdir = "build/ide", lsp = "clangd"})
end

add_requires("pkgconfig::sqlite3 >=3.37", "pkgconfig::libpq >=14", {system = true})

target("lim_core")
    set_kind("static")
    set_languages("cxx23")
    set_warnings("allextra", "pedantic")
    add_files("src/core/public/*.cppm", "src/protocol/public/*.cppm", {public = true})

target("lim_storage")
    set_kind("static")
    set_languages("cxx23")
    set_warnings("allextra", "pedantic")
    add_deps("lim_core")
    add_packages("pkgconfig::sqlite3", "pkgconfig::libpq")
    add_files("src/storage/public/*.cppm", {public = true})
    add_files("src/storage/*.cppm")

target("lim_demo")
    set_kind("binary")
    set_default(false)
    set_languages("cxx23")
    set_warnings("allextra", "pedantic")
    add_deps("lim_storage")
    add_files("apps/demo/*.cppm")
    add_rules("lim.database_test")
    add_tests("sqlite", "postgresql", {runargs = {"--demo"}})
target_end()


if os.projectdir() == os.scriptdir() then
    add_requires("pkgconfig::libcrypto >=3.0", {system = true})

    target("lim-server")
        set_kind("binary")
        set_languages("cxx23")
        set_warnings("allextra", "pedantic")
        add_deps("lim_storage")
        add_packages("pkgconfig::libcrypto")
        add_sysincludedirs("inc/ltool")
        add_defines("LTOOL_USE_NLOHMANN_JSON=0", "LTOOL_USE_JSONCPP=0", "LTOOL_USE_SIMDJSON=0")
        add_files("apps/server/*.cppm")
        add_rules("lim.database_test")
        add_tests("sqlite", "postgresql", {runargs = {"--server"}})
    target_end()
end

includes("tests/xmake.lua")
