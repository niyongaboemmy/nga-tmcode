module Grades
  # The letter grade for a mark from 0 to 100.
  def self.grade(mark)
    raise ArgumentError, "mark must be from 0 to 100" unless (0..100).cover?(mark)

    if mark >= 80 then "A"
    elsif mark >= 70 then "B"
    elsif mark >= 60 then "C"
    elsif mark >= 50 then "D"
    else "F"
    end
  end

  # The average of a list of marks.
  def self.average(marks)
    return 0.0 if marks.empty?

    marks.sum.to_f / marks.size
  end
end
