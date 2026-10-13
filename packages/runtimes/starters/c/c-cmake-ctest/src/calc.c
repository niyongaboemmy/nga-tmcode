#include "calc.h"

int add(int a, int b) { return a + b; }

int multiply(int a, int b) { return a * b; }

long long power(int base, int exp) {
    long long r = 1;
    while (exp-- > 0) r *= base;
    return r;
}
