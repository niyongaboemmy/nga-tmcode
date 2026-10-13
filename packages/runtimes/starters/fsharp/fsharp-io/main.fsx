// Read one line with two whole numbers, e.g. "3 4".
let line = stdin.ReadLine()
let numbers = line.Split(' ', System.StringSplitOptions.RemoveEmptyEntries) |> Array.map int64
printfn "Sum: %d" (numbers.[0] + numbers.[1])
