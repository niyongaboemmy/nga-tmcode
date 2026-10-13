# Read one line with two whole numbers, e.g. "3 4".
$line = [Console]::In.ReadLine()
$a, $b = $line.Trim() -split '\s+' | ForEach-Object { [long]$_ }
Write-Output "Sum: $($a + $b)"
