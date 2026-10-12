use strict;
use warnings;

# Read one line with two whole numbers, e.g. "3 4".
my $line = <STDIN> // '';
my ($first, $second) = split ' ', $line;
print "Sum: ", $first + $second, "\n";
