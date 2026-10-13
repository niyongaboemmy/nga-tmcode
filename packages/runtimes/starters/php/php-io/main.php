<?php

// Read one line with two whole numbers, e.g. "3 4".
$line = trim(fgets(STDIN) ?: '');
[$first, $second] = array_map('intval', preg_split('/\s+/', $line));
echo "Sum: " . ($first + $second) . "\n";
