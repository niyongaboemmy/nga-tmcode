import scala.io.StdIn

@main def sum(): Unit =
  // Read one line with two whole numbers, e.g. "3 4".
  val numbers = StdIn.readLine().trim.split("\\s+").map(_.toLong)
  println(s"Sum: ${numbers(0) + numbers(1)}")
