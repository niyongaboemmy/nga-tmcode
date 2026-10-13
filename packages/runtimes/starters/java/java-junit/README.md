# Java – class with JUnit 5 tests

`Grades.java` turns a mark into a letter grade; `GradesTest.java` checks it with JUnit 5.
There is no build tool: the files are compiled with `javac` and the tests run with the
JUnit console launcher.

- **Run** prints a few example grades (`Main.java`).
- **Run tests** runs `GradesTest`.

Try it: add a test for a mark of 60, see it pass, then change a boundary in `Grades.java`
and watch the tests tell you.
