import os

fn main() {
	// Read one line with two whole numbers, e.g. "3 4".
	line := os.get_line()
	numbers := line.fields().map(it.i64())
	println('Sum: ${numbers[0] + numbers[1]}')
}
