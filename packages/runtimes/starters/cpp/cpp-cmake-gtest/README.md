# C++ – CMake project with GoogleTest

A bank account class built with CMake and tested with GoogleTest.

Build: `cmake -S . -B build && cmake --build build`, run `./build/app`.
Test: `ctest --test-dir build --output-on-failure` (needs GoogleTest installed).
