-- recursion, sorting, string building
local function fib(n)
  if n < 2 then return n end
  return fib(n - 1) + fib(n - 2)
end
local vals = {}
for i = 0, 12 do vals[#vals + 1] = fib(i) end
print("fib", table.concat(vals, ","))

local words = { "delta", "alpha", "charlie", "bravo" }
table.sort(words)
print("sorted", table.concat(words, " "))

local buf = {}
for i = 1, 10 do buf[#buf + 1] = tostring(i * i) end
print("squares", table.concat(buf, "|"))

local acc = ""
for i = 1, 5 do acc = acc .. string.char(64 + i) end
print("chars", acc, #acc)
