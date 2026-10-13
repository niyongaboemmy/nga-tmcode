#!/usr/bin/env bash
source "$(dirname "$0")/lib/grades.sh"

for pair in "Ada 91" "Ben 68" "Chloe 45"; do
  read -r name mark <<< "$pair"
  echo "$name: $mark -> $(grade "$mark")"
done
echo "Class average: $(average 91 68 45)"
