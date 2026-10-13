#include <stdio.h>

/* Classic algorithms: selection sort, binary search, gcd. The Testing view (beaker) runs the input tests. */
void selection_sort(int a[], int n) {
    for (int i = 0; i < n - 1; i++) {
        int min = i;
        for (int j = i + 1; j < n; j++)
            if (a[j] < a[min]) min = j;
        int t = a[i];
        a[i] = a[min];
        a[min] = t;
    }
}

int binary_search(const int a[], int n, int target) {
    int lo = 0, hi = n - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }

int main(void) {
    int n, a[100], b[100], target;
    scanf("%d", &n);
    for (int i = 0; i < n; i++) {
        scanf("%d", &a[i]);
        b[i] = a[i];
    }
    scanf("%d", &target);
    selection_sort(b, n);
    printf("Sorted:");
    for (int i = 0; i < n; i++) printf(" %d", b[i]);
    printf("\nIndex of %d = %d\n", target, binary_search(b, n, target));
    printf("GCD of first two: %d\n", gcd(a[0], a[1]));
    return 0;
}
