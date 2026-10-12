#include "bank.hpp"

#include <stdexcept>
#include <utility>

Account::Account(std::string owner) : owner_(std::move(owner)) {}

void Account::deposit(long amount) {
    if (amount <= 0) throw std::invalid_argument("deposit must be positive");
    balance_ += amount;
}

bool Account::withdraw(long amount) {
    if (amount <= 0 || amount > balance_) return false;
    balance_ -= amount;
    return true;
}
