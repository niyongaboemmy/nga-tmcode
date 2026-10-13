import std/[strutils, sequtils]

# Read one line with two whole numbers, e.g. "3 4".
let numbers = stdin.readLine().splitWhitespace().map(parseInt)
echo "Sum: ", numbers[0] + numbers[1]
