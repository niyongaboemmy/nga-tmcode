require_relative "lib/grades"

marks = { "Ada" => 91, "Ben" => 68, "Chloe" => 45 }
marks.each { |name, mark| puts "#{name}: #{mark} -> #{Grades.grade(mark)}" }
puts "Class average: #{Grades.average(marks.values).round(1)}"
