#include <iomanip>
#include <iostream>

// A: 80+, B: 70+, C: 60+, D: 50+, otherwise F.
char grade(int mark) {
    if (mark >= 80) return 'A';
    if (mark >= 70) return 'B';
    if (mark >= 60) return 'C';
    if (mark >= 50) return 'D';
    return 'F';
}

int main() {
    int n;
    if (!(std::cin >> n) || n <= 0) {
        std::cout << "No marks" << std::endl;
        return 0;
    }
    double total = 0;
    for (int i = 0; i < n; i++) {
        int mark;
        std::cin >> mark;
        total += mark;
        std::cout << mark << " " << grade(mark) << "\n";
    }
    std::cout << "Average: " << std::fixed << std::setprecision(2) << total / n << std::endl;
    return 0;
}
