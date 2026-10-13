#include <stdio.h>
#include "calc.h"

int main(void) {
    printf("2 + 3 = %d\n", add(2, 3));
    printf("4 x 5 = %d\n", multiply(4, 5));
    printf("2 ^ 10 = %lld\n", power(2, 10));
    return 0;
}
