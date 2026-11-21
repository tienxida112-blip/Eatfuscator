local function fib(n) if n < 2 then return n end return fib(n-1) + fib(n-2) end
local total = 0
for i = 1, 20 do total = total + fib(i) end
print("fib", total, fib(21))
