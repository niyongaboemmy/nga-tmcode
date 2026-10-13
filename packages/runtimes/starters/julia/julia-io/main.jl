# Read one line with two whole numbers, e.g. "3 4".
a, b = parse.(Int, split(readline()))
println("Sum: ", a + b)
