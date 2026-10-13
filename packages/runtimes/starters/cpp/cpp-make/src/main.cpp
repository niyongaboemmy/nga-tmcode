#include <iomanip>
#include <iostream>

#include "shapes.hpp"

int main() {
    Rectangle r(3, 4);
    Circle c(1.5);
    std::cout << std::fixed << std::setprecision(2);
    std::cout << "Rectangle area: " << r.area() << ", perimeter: " << r.perimeter() << "\n";
    std::cout << "Circle area: " << c.area() << std::endl;
    return 0;
}
