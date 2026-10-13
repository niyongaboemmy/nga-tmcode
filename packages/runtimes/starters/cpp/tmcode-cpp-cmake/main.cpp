#include <iostream>
#include <vector>
#include <numeric>

int main() {
    std::vector<int> v{3, 1, 4, 1, 5, 9, 2, 6};
    std::cout << "Sum: " << std::accumulate(v.begin(), v.end(), 0) << std::endl;
    return 0;
}
