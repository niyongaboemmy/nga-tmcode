local grades = require("grades")

describe("grades", function()
  it("gives an A for 80 and above", function()
    assert.are.equal("A", grades.grade(80))
    assert.are.equal("A", grades.grade(100))
  end)

  it("gives an F below 50", function()
    assert.are.equal("F", grades.grade(49))
  end)

  it("averages the marks", function()
    assert.are.equal(75, grades.average({ 70, 80 }))
  end)

  it("rejects a mark above 100", function()
    assert.has_error(function() grades.grade(101) end)
  end)
end)
