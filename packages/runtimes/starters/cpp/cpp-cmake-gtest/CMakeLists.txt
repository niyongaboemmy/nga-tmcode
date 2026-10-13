cmake_minimum_required(VERSION 3.16)
project(bank CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(bank src/bank.cpp)
target_include_directories(bank PUBLIC include)

add_executable(app src/main.cpp)
target_link_libraries(app bank)

# GoogleTest from the system (Ubuntu: libgtest-dev); no download.
find_package(GTest REQUIRED)
enable_testing()
add_executable(bank_test tests/bank_test.cpp)
target_link_libraries(bank_test bank GTest::gtest_main)
include(GoogleTest)
gtest_discover_tests(bank_test)
