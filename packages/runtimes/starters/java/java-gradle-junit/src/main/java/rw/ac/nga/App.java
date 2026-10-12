package rw.ac.nga;

import java.util.List;

public class App {
    /** The mean of the marks, or 0 for none. */
    public static double average(List<Integer> marks) {
        return marks.stream().mapToInt(Integer::intValue).average().orElse(0);
    }

    public static void main(String[] args) {
        List<Integer> marks = List.of(72, 85, 64);
        System.out.printf("Average of %s is %.2f%n", marks, average(marks));
    }
}
