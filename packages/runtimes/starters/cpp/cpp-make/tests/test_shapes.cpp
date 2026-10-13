// A tiny test runner: prints TAP ("ok 1 - ...") and exits 1 on a wrong answer.
#include <cmath>
#include <iostream>

#include "shapes.hpp"

static int failures = 0, count = 0;

static void check(bool ok, const char* name) {
    ++count;
    if (!ok) ++failures;
    std::cout << (ok ? "" : "not ") << "ok " << count << " - " << name << "\n";
}

int main() {
    check(Rectangle(3, 4).area() == 12, "rectangle area");
    check(Rectangle(3, 4).perimeter() == 14, "rectangle perimeter");
    check(std::abs(Circle(1).area() - 3.14159) < 1e-4, "circle area");
    std::cout << "1.." << count << std::endl;
    return failures ? 1 : 0;
}
