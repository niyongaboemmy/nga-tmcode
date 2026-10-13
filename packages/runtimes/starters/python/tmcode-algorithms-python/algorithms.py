"""Classic algorithms. Run the tests in the Testing view (beaker), or ▶ and type input."""


def bubble_sort(a):
    a = list(a)
    for i in range(len(a)):
        swapped = False
        for j in range(len(a) - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
                swapped = True
        if not swapped:
            break
    return a


def binary_search(a, target):
    lo, hi = 0, len(a) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if a[mid] == target:
            return mid
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1


def gcd(a, b):
    while b:
        a, b = b, a % b
    return a


if __name__ == "__main__":
    # Input: a line of numbers, then a number to find.
    numbers = [int(x) for x in input().split()]
    target = int(input())
    ordered = bubble_sort(numbers)
    print("Sorted:", *ordered)
    print("Index of", target, "=", binary_search(ordered, target))
    print("GCD of first two:", gcd(numbers[0], numbers[1]))
