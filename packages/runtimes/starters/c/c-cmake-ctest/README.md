# C – CMake project with CTest

A calculator library and program built with CMake, with one CTest unit test.

Build: `cmake -S . -B build && cmake --build build`, run `./build/app`.
Test: `ctest --test-dir build --output-on-failure`.
