CC ?= cc
CFLAGS = -std=c17 -Wall -Wextra -Iinclude

app: src/main.c src/list.c include/list.h
	$(CC) $(CFLAGS) -o app src/main.c src/list.c

tests/run_tests: tests/test_list.c src/list.c include/list.h
	$(CC) $(CFLAGS) -o tests/run_tests tests/test_list.c src/list.c

run: app
	./app

test: tests/run_tests
	./tests/run_tests

clean:
	rm -f app tests/run_tests

.PHONY: run test clean
