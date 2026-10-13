# The letter grade for a mark from 0 to 100.
grade <- function(mark) {
  if (mark < 0 || mark > 100) stop("mark must be from 0 to 100")
  if (mark >= 80) "A"
  else if (mark >= 70) "B"
  else if (mark >= 60) "C"
  else if (mark >= 50) "D"
  else "F"
}

# The average of a vector of marks.
average <- function(marks) {
  if (length(marks) == 0) 0 else mean(marks)
}
