#include <stdio.h>

/* Reads numbers until the end of input and prints their sum and average. */
int main(void) {
    double x, sum = 0;
    int n = 0;
    while (scanf("%lf", &x) == 1) {
        sum += x;
        n++;
    }
    if (n == 0) {
        printf("No numbers\n");
        return 0;
    }
    printf("Count: %d\nSum: %.2f\nAverage: %.2f\n", n, sum, sum / n);
    return 0;
}
