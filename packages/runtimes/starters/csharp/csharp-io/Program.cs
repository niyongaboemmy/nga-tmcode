// Read one line with two whole numbers, e.g. "3 4".
string line = Console.ReadLine() ?? "";
string[] parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
long a = long.Parse(parts[0]);
long b = long.Parse(parts[1]);
Console.WriteLine($"Sum: {a + b}");
