package rw.ac.nga;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class AppTest {
    @Test
    void averagesMarks() {
        assertEquals(74.0, App.average(List.of(70, 78)), 1e-9);
    }

    @Test
    void averageOfNothingIsZero() {
        assertEquals(0.0, App.average(List.of()), 1e-9);
    }
}
