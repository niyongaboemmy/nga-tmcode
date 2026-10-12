"""Line 1: numbers to sort. Line 2: a number to find.
Prints the sorted list and where the number is (binary search), or "not found"."""
import sys


def insertion_sort(values):
    items = list(values)
    for i in range(1, len(items)):
        current = items[i]
        j = i - 1
        while j >= 0 and items[j] > current:
            items[j + 1] = items[j]
            j -= 1
        items[j + 1] = current
    return items


def binary_search(items, target):
    """Index of target in the sorted list, or -1."""
    lo, hi = 0, len(items) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if items[mid] == target:
            return mid
        if items[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1


def main():
    lines = sys.stdin.read().splitlines()
    numbers = [int(x) for x in lines[0].split()] if lines else []
    ordered = insertion_sort(numbers)
    print("Sorted:", " ".join(map(str, ordered)))
    if len(lines) > 1 and lines[1].strip():
        target = int(lines[1])
        at = binary_search(ordered, target)
        print(f"{target} found at position {at}" if at >= 0 else f"{target} not found")


if __name__ == "__main__":
    main()
