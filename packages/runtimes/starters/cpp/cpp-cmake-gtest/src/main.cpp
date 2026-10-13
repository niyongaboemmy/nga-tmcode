#include <iostream>

#include "bank.hpp"

int main() {
    Account acc("Aline");
    acc.deposit(5000);
    acc.withdraw(1200);
    std::cout << acc.owner() << " has " << acc.balance() << " RWF" << std::endl;
    return 0;
}
