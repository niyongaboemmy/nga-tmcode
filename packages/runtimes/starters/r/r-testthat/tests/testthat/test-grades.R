source("../../R/grades.R")

test_that("80 and above is an A", {
  expect_equal(grade(80), "A")
  expect_equal(grade(100), "A")
})

test_that("below 50 is an F", {
  expect_equal(grade(49), "F")
})

test_that("average of 70 and 80 is 75", {
  expect_equal(average(c(70, 80)), 75)
})

test_that("a mark above 100 is rejected", {
  expect_error(grade(101))
})
