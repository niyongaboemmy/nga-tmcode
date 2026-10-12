import java.util.Locale;
import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in).useLocale(Locale.ROOT);
        int count = 0;
        double sum = 0;
        while (in.hasNextDouble()) {
            sum += in.nextDouble();
            count++;
        }
        if (count == 0) {
            System.out.println("No numbers");
            return;
        }
        System.out.println("Count: " + count);
        System.out.printf(Locale.ROOT, "Average: %.2f%n", sum / count);
    }
}
