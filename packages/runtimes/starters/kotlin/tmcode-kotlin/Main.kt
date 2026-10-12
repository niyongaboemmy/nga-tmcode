data class Student(val name: String, val marks: List<Int>) {
    val average get() = marks.average()
}

fun main() {
    val students = listOf(Student("Ada", listOf(90, 84, 77)), Student("Ben", listOf(65, 72, 80)))
    students.sortedByDescending { it.average }.forEach {
        println("${it.name}: ${"%.1f".format(it.average)}")
    }
}
