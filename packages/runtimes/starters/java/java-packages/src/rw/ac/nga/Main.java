package rw.ac.nga;

import java.util.List;
import rw.ac.nga.model.Student;

public class Main {
    public static void main(String[] args) {
        List<Student> students = List.of(new Student("Aline", 86), new Student("Eric", 64), new Student("Grace", 91));
        for (Student s : students) {
            System.out.println(s);
        }
        double average = students.stream().mapToInt(Student::mark).average().orElse(0);
        System.out.printf("Class average: %.1f%n", average);
    }
}
