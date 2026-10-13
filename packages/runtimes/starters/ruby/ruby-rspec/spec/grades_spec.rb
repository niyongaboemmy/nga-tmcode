require_relative "../lib/grades"

RSpec.describe Grades do
  it "gives an A for 80 and above" do
    expect(Grades.grade(80)).to eq("A")
    expect(Grades.grade(100)).to eq("A")
  end

  it "gives an F below 50" do
    expect(Grades.grade(49)).to eq("F")
  end

  it "averages the marks" do
    expect(Grades.average([70, 80])).to eq(75.0)
  end

  it "rejects a mark above 100" do
    expect { Grades.grade(101) }.to raise_error(ArgumentError)
  end
end
