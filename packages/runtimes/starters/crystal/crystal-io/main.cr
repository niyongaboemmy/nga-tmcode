# Read one line with two whole numbers, e.g. "3 4".
line = gets || ""
numbers = line.split.map(&.to_i64)
puts "Sum: #{numbers[0] + numbers[1]}"
