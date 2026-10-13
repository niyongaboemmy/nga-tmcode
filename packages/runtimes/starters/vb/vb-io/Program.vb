Module Program
    Sub Main()
        ' Read one line with two whole numbers, e.g. "3 4".
        Dim parts = Console.ReadLine().Split(" "c, StringSplitOptions.RemoveEmptyEntries)
        Dim a = Long.Parse(parts(0))
        Dim b = Long.Parse(parts(1))
        Console.WriteLine($"Sum: {a + b}")
    End Sub
End Module
