source("R/grades.R")

marks <- c(Ada = 91, Ben = 68, Chloe = 45)
for (name in names(marks)) {
  cat(sprintf("%s: %d -> %s\n", name, marks[[name]], grade(marks[[name]])))
}
cat(sprintf("Class average: %.1f\n", average(marks)))
