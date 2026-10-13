import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class GradesTest {
    @Test
    void topMarksAreAnA() {
        assertEquals("A", Grades.letter(92));
    }

    @Test
    void boundariesBelongToTheHigherGrade() {
        assertEquals("B", Grades.letter(70));
        assertEquals("D", Grades.letter(50));
    }

    @Test
    void lowMarksAreAnF() {
        assertEquals("F", Grades.letter(12));
    }

    @Test
    void marksOutsideZeroToHundredAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> Grades.letter(101));
    }
}
