<?php

require_once __DIR__ . '/Grades.php';

use App\Grades;

$marks = ["Ada" => 91, "Ben" => 68, "Chloe" => 45];
foreach ($marks as $name => $mark) {
    echo "$name: $mark -> " . Grades::grade($mark) . "\n";
}
echo "Class average: " . round(Grades::average(array_values($marks)), 1) . "\n";
