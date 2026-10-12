#include <stdio.h>

/* Reads whole numbers until the end of input and prints their sum. */
int main(void) {
    long long x, sum = 0;
    while (scanf("%lld", &x) == 1) {
        sum += x;
    }
    printf("%lld\n", sum);
    return 0;
}
