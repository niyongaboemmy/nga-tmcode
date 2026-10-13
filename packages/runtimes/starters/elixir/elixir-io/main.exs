# Read one line with two whole numbers, e.g. "3 4".
[a, b] =
  IO.gets("")
  |> String.split()
  |> Enum.map(&String.to_integer/1)

IO.puts("Sum: #{a + b}")
