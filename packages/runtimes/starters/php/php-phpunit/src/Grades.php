<?php

namespace App;

final class Grades
{
    /** The letter grade for a mark from 0 to 100. */
    public static function grade(int $mark): string
    {
        if ($mark < 0 || $mark > 100) {
            throw new \InvalidArgumentException("mark must be from 0 to 100");
        }
        if ($mark >= 80) return "A";
        if ($mark >= 70) return "B";
        if ($mark >= 60) return "C";
        if ($mark >= 50) return "D";
        return "F";
    }

    /** The average of a list of marks. */
    public static function average(array $marks): float
    {
        return count($marks) === 0 ? 0.0 : array_sum($marks) / count($marks);
    }
}
