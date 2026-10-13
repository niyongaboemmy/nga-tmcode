cmake_minimum_required(VERSION 3.16)
project(calc C)
set(CMAKE_C_STANDARD 17)

add_library(calc src/calc.c)
target_include_directories(calc PUBLIC include)

add_executable(app src/main.c)
target_link_libraries(app calc)

enable_testing()
add_executable(test_calc tests/test_calc.c)
target_link_libraries(test_calc calc)
add_test(NAME calc COMMAND test_calc)
