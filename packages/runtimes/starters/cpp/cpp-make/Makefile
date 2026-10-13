CXX ?= c++
CXXFLAGS = -std=c++20 -Wall -Wextra -Iinclude

app: src/main.cpp src/shapes.cpp include/shapes.hpp
	$(CXX) $(CXXFLAGS) -o app src/main.cpp src/shapes.cpp

tests/run_tests: tests/test_shapes.cpp src/shapes.cpp include/shapes.hpp
	$(CXX) $(CXXFLAGS) -o tests/run_tests tests/test_shapes.cpp src/shapes.cpp

run: app
	./app

test: tests/run_tests
	./tests/run_tests

clean:
	rm -f app tests/run_tests

.PHONY: run test clean
