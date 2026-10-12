#include <gtest/gtest.h>

#include "bank.hpp"

TEST(Account, DepositThenWithdraw) {
    Account acc("Aline");
    acc.deposit(5000);
    EXPECT_TRUE(acc.withdraw(1200));
    EXPECT_EQ(acc.balance(), 3800);
}

TEST(Account, CannotOverdraw) {
    Account acc("Eric");
    acc.deposit(100);
    EXPECT_FALSE(acc.withdraw(500));
    EXPECT_EQ(acc.balance(), 100);
}
