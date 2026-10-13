// Read one line with two whole numbers, e.g. "3 4".
let line = readLine() ?? ""
let numbers = line.split(separator: " ").compactMap { Int($0) }
print("Sum: \(numbers[0] + numbers[1])")
