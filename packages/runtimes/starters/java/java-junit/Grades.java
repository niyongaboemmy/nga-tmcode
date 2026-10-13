/** Turns a mark out of 100 into a letter grade. */
public class Grades {
    public static String letter(int mark) {
        if (mark < 0 || mark > 100) {
            throw new IllegalArgumentException("A mark is between 0 and 100");
        }
        if (mark >= 80) return "A";
        if (mark >= 70) return "B";
        if (mark >= 60) return "C";
        if (mark >= 50) return "D";
        return "F";
    }
}
