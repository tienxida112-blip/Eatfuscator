-- trampoline: recursion without growing the stack
local function trampoline(fn, ...)
  local result = fn(...)
  local calls = 0
  while type(result) == "function" do
    calls = calls + 1
    result = result()
  end
  return result, calls
end

local function sumTo(n, acc)
  acc = acc or 0
  if n == 0 then return acc end
  return function() return sumTo(n - 1, acc + n) end
end
print(trampoline(sumTo, 100000))

local even, odd
function even(n) if n == 0 then return true end return function() return odd(n - 1) end end
function odd(n) if n == 0 then return false end return function() return even(n - 1) end end
print(trampoline(even, 50000))
print(trampoline(odd, 49999))

-- proper tail calls still work without a trampoline
local function countdown(n, acc)
  if n == 0 then return acc end
  return countdown(n - 1, acc + 1)
end
print(countdown(2000, 0))

local function fib(n, a, b)
  if n == 0 then return a end
  return fib(n - 1, b, a + b)
end
print(fib(40, 0, 1))
