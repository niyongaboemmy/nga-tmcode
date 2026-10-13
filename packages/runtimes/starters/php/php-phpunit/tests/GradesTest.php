<?php

use App\Grades;
use PHPUnit\Framework\TestCase;

final class GradesTest extends TestCase
{
    public function testEightyAndAboveIsAnA(): void
    {
        $this->assertSame("A", Grades::grade(80));
        $this->assertSame("A", Grades::grade(100));
    }

    public function testBelowFiftyIsAnF(): void
    {
        $this->assertSame("F", Grades::grade(49));
    }

    public function testAverage(): void
    {
        $this->assertSame(75.0, Grades::average([70, 80]));
    }

    public function testRejectsAMarkAboveOneHundred(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Grades::grade(101);
    }
}
