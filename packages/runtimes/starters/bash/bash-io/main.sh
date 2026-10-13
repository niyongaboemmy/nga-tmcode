#!/usr/bin/env bash

# Read one line with two whole numbers, e.g. "3 4".
read -r first second
echo "Sum: $((first + second))"
