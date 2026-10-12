#include "shapes.hpp"

#include <numbers>

double Rectangle::area() const { return w_ * h_; }
double Rectangle::perimeter() const { return 2 * (w_ + h_); }
double Circle::area() const { return std::numbers::pi * r_ * r_; }
