# Read one line with two whole numbers, e.g. "3 4".
first, second = gets.to_s.split.map(&:to_i)
puts "Sum: #{first + second}"
