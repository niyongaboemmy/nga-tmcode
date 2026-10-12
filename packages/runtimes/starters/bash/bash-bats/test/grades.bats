#!/usr/bin/env bats

setup() {
  source "$BATS_TEST_DIRNAME/../lib/grades.sh"
}

@test "80 and above is an A" {
  run grade 80
  [ "$status" -eq 0 ]
  [ "$output" = "A" ]
}

@test "below 50 is an F" {
  run grade 49
  [ "$output" = "F" ]
}

@test "average of 70 and 81 rounds down to 75" {
  run average 70 81
  [ "$output" = "75" ]
}

@test "a mark above 100 is rejected" {
  run grade 101
  [ "$status" -ne 0 ]
}
