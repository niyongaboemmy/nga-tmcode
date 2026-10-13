# Read one line with two whole numbers, e.g. "3 4".
gets stdin line
lassign [regexp -all -inline {\S+} $line] a b
puts "Sum: [expr {$a + $b}]"
