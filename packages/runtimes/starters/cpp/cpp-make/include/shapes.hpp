#pragma once

class Rectangle {
public:
    Rectangle(double width, double height) : w_(width), h_(height) {}
    double area() const;
    double perimeter() const;

private:
    double w_, h_;
};

class Circle {
public:
    explicit Circle(double radius) : r_(radius) {}
    double area() const;

private:
    double r_;
};
