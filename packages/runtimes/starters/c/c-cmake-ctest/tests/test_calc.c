#include <stdio.h>
#include "calc.h"

/* CTest counts a test as passed when it exits with 0. */
int main(void) {
    int failures = 0;
    if (add(2, 3) != 5) { puts("add(2, 3) should be 5"); failures++; }
    if (multiply(4, 5) != 20) { puts("multiply(4, 5) should be 20"); failures++; }
    if (power(2, 10) != 1024) { puts("power(2, 10) should be 1024"); failures++; }
    if (!failures) puts("all calc checks passed");
    return failures ? 1 : 0;
}
