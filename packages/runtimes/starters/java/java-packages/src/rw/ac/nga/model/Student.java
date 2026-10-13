package rw.ac.nga.model;

/** A student and their mark out of 100. */
public record Student(String name, int mark) {
    public boolean passed() {
        return mark >= 50;
    }

    @Override
    public String toString() {
        return name + ": " + mark + (passed() ? " (pass)" : " (fail)");
    }
}
