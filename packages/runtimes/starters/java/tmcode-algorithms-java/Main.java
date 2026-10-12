import java.util.*;

// Classic algorithms: merge sort, binary search, gcd. The Testing view (beaker) runs the input tests.
public class Main {
    static int[] mergeSort(int[] a) {
        if (a.length < 2) return a;
        int[] left = mergeSort(Arrays.copyOfRange(a, 0, a.length / 2));
        int[] right = mergeSort(Arrays.copyOfRange(a, a.length / 2, a.length));
        int[] out = new int[a.length];
        int i = 0, j = 0, k = 0;
        while (i < left.length && j < right.length) out[k++] = left[i] <= right[j] ? left[i++] : right[j++];
        while (i < left.length) out[k++] = left[i++];
        while (j < right.length) out[k++] = right[j++];
        return out;
    }

    static int binarySearch(int[] a, int target) {
        int lo = 0, hi = a.length - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (a[mid] == target) return mid;
            if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
        }
        return -1;
    }

    static int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int[] a = Arrays.stream(in.nextLine().trim().split("\\s+")).mapToInt(Integer::parseInt).toArray();
        int target = in.nextInt();
        int[] sorted = mergeSort(a);
        StringBuilder sb = new StringBuilder("Sorted:");
        for (int x : sorted) sb.append(' ').append(x);
        System.out.println(sb);
        System.out.println("Index of " + target + " = " + binarySearch(sorted, target));
        System.out.println("GCD of first two: " + gcd(a[0], a[1]));
    }
}
