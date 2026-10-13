// Read one line with two whole numbers, e.g. "3 4".
def line = System.in.newReader().readLine()
def (a, b) = line.trim().split(/\s+/).collect { it as long }
println "Sum: ${a + b}"
