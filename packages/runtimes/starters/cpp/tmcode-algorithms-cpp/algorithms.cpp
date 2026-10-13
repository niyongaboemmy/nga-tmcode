#include <iostream>
#include <vector>
#include <sstream>
#include <string>
using namespace std;

// Classic algorithms: sort, search, gcd. The Testing view (beaker) runs the input tests.
void insertionSort(vector<int>& a) {
    for (size_t i = 1; i < a.size(); i++) {
        int key = a[i];
        int j = (int)i - 1;
        while (j >= 0 && a[j] > key) {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = key;
    }
}

int binarySearch(const vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size() - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }

int main() {
    string line;
    getline(cin, line);
    istringstream in(line);
    vector<int> a;
    for (int x; in >> x;) a.push_back(x);
    int target;
    cin >> target;
    vector<int> sorted = a;
    insertionSort(sorted);
    cout << "Sorted:";
    for (int x : sorted) cout << ' ' << x;
    cout << "\nIndex of " << target << " = " << binarySearch(sorted, target) << "\n";
    cout << "GCD of first two: " << gcd(a[0], a[1]) << "\n";
}
