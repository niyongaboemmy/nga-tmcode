#pragma once
#include <string>

class Account {
public:
    explicit Account(std::string owner);
    const std::string& owner() const { return owner_; }
    long balance() const { return balance_; }
    void deposit(long amount);
    // Returns false (and changes nothing) when there isn't enough money.
    bool withdraw(long amount);

private:
    std::string owner_;
    long balance_ = 0;
};
