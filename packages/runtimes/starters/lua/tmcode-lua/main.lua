local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end

for i = 0, 10 do
  io.write(fib(i), i < 10 and ", " or "\n")
end
