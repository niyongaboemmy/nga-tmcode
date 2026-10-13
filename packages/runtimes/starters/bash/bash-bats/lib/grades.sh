# grade MARK: prints the letter grade for a whole-number mark from 0 to 100.
grade() {
  local mark=$1
  if ! [[ $mark =~ ^[0-9]+$ ]] || (( mark > 100 )); then
    echo "mark must be a whole number from 0 to 100" >&2
    return 1
  fi
  if (( mark >= 80 )); then echo "A"
  elif (( mark >= 70 )); then echo "B"
  elif (( mark >= 60 )); then echo "C"
  elif (( mark >= 50 )); then echo "D"
  else echo "F"
  fi
}

# average MARK...: prints the whole-number average (rounded down).
average() {
  local total=0 mark
  for mark in "$@"; do total=$((total + mark)); done
  echo $((total / $#))
}
