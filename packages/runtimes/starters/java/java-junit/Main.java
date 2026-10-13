public class Main {
    public static void main(String[] args) {
        int[] marks = {92, 70, 55, 12};
        for (int mark : marks) {
            System.out.println(mark + " -> " + Grades.letter(mark));
        }
    }
}
