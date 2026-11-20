cmake_minimum_required(VERSION 3.28)
project(LIM VERSION 0.1.0 LANGUAGES CXX)

add_library(lim_core STATIC)
add_library(lim::core ALIAS lim_core)
target_sources(lim_core PUBLIC FILE_SET CXX_MODULES FILES
    src/core/chat.cppm
    src/protocol/frame.cppm
)
target_compile_features(lim_core PUBLIC cxx_std_23)
set_target_properties(lim_core PROPERTIES CXX_EXTENSIONS OFF)
if(CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
    target_compile_options(lim_core PRIVATE /W4)
else()
    target_compile_options(lim_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(PROJECT_IS_TOP_LEVEL)
    include(CTest)
    if(BUILD_TESTING)
        add_executable(lim_frame_test tests/frame.cpp)
        target_link_libraries(lim_frame_test PRIVATE lim::core)
        set_target_properties(lim_frame_test PROPERTIES CXX_EXTENSIONS OFF)
        add_test(NAME frame COMMAND lim_frame_test)
    endif()
endif()
