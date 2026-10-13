class Student
  attr_reader :name, :marks

  def initialize(name, marks)
    @name = name
    @marks = marks
  end

  def average
    marks.sum.to_f / marks.size
  end
end

students = [Student.new("Ada", [90, 84, 77]), Student.new("Ben", [65, 72, 80])]
students.sort_by { |s| -s.average }.each do |s|
  puts "#{s.name}: #{s.average.round(1)}"
end
