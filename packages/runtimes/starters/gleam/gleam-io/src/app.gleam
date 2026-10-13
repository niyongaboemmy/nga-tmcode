import gleam/int
import gleam/io
import gleam/list
import gleam/string

// read_line is written in Erlang (src/app_ffi.erl): Gleam's standard library has no stdin.
@external(erlang, "app_ffi", "read_line")
fn read_line() -> String

pub fn main() {
  // Read one line with two whole numbers, e.g. "3 4".
  let numbers =
    read_line()
    |> string.split(" ")
    |> list.filter_map(fn(word) { int.parse(string.trim(word)) })

  case numbers {
    [a, b, ..] -> io.println("Sum: " <> int.to_string(a + b))
    _ -> io.println("Please enter two whole numbers")
  }
}
