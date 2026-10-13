local M = {}

-- The letter grade for a mark from 0 to 100.
function M.grade(mark)
  if mark < 0 or mark > 100 then error("mark must be from 0 to 100") end
  if mark >= 80 then return "A" end
  if mark >= 70 then return "B" end
  if mark >= 60 then return "C" end
  if mark >= 50 then return "D" end
  return "F"
end

-- The average of a list of marks.
function M.average(marks)
  if #marks == 0 then return 0 end
  local total = 0
  for _, mark in ipairs(marks) do total = total + mark end
  return total / #marks
end

return M
