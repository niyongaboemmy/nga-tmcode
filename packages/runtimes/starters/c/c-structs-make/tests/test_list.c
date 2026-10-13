/* A tiny test runner: prints TAP ("ok 1 - ...") and fails the build on a wrong answer. */
#include <stdio.h>
#include "list.h"

static int failures = 0, count = 0;

static void check(int ok, const char *name) {
    count++;
    if (!ok) failures++;
    printf("%sok %d - %s\n", ok ? "" : "not ", count, name);
}

int main(void) {
    Node *list = NULL;
    check(list_length(list) == 0, "an empty list has length 0");
    list = list_push(list, 3);
    list = list_push(list, 4);
    check(list_length(list) == 2, "push adds to the list");
    check(list_sum(list) == 7, "sum adds the values");
    check(list->value == 4, "push puts the new value first");
    list_free(list);
    printf("1..%d\n", count);
    return failures ? 1 : 0;
}
