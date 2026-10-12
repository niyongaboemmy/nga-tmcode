fun main() {
    // Read one line with two whole numbers, e.g. "3 4".
    val numbers = readln().trim().split(Regex("\\s+")).map { it.toLong() }
    println("Sum: ${numbers[0] + numbers[1]}")
}
