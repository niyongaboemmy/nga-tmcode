local grades = require("grades")

local marks = { { "Ada", 91 }, { "Ben", 68 }, { "Chloe", 45 } }
local all = {}
for _, entry in ipairs(marks) do
  local name, mark = entry[1], entry[2]
  print(name .. ": " .. mark .. " -> " .. grades.grade(mark))
  all[#all + 1] = mark
end
print(string.format("Class average: %.1f", grades.average(all)))
