-- bigint: decimal arithmetic on digit arrays, no floats in the result path
local function normalise(a)
  local i = #a
  while i > 1 and a[i] == 0 do
    a[i] = nil
    i = i - 1
  end
  return a
end
local function fromNumber(n)
  local a = {}
  if n == 0 then return { 0 } end
  while n > 0 do
    a[#a + 1] = n % 10
    n = math.floor(n / 10)
  end
  return a
end
local function add(a, b)
  local out, carry = {}, 0
  for i = 1, math.max(#a, #b) do
    local sum = (a[i] or 0) + (b[i] or 0) + carry
    out[i] = sum % 10
    carry = math.floor(sum / 10)
  end
  if carry > 0 then out[#out + 1] = carry end
  return out
end
local function mul(a, b)
  local out = {}
  for i = 1, #a + #b do out[i] = 0 end
  for i = 1, #a do
    local carry = 0
    for j = 1, #b do
      local cur = out[i + j - 1] + a[i] * b[j] + carry
      out[i + j - 1] = cur % 10
      carry = math.floor(cur / 10)
    end
    local k = i + #b
    while carry > 0 do
      local cur = out[k] + carry
      out[k] = cur % 10
      carry = math.floor(cur / 10)
      k = k + 1
    end
  end
  return normalise(out)
end
local function show(a)
  local out = {}
  for i = #a, 1, -1 do out[#out + 1] = tostring(a[i]) end
  return table.concat(out)
end
local function factorial(n)
  local acc = { 1 }
  for i = 2, n do acc = mul(acc, fromNumber(i)) end
  return acc
end

print(show(add(fromNumber(999999), fromNumber(1))))
print(show(mul(fromNumber(123456789), fromNumber(987654321))))
print(show(factorial(20)))
print(show(factorial(30)))
print(#show(factorial(50)))
local fib1, fib2 = { 1 }, { 1 }
for i = 3, 40 do fib1, fib2 = fib2, add(fib1, fib2) end
print(show(fib2))
