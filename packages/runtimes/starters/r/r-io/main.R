# Read one line with two whole numbers, e.g. "3 4".
line <- readLines(file("stdin"), n = 1)
nums <- as.integer(strsplit(trimws(line), "\\s+")[[1]])
cat(sprintf("Sum: %d\n", nums[1] + nums[2]))
