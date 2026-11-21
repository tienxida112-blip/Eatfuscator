-- primes: sieve, twin primes, factorisation, sum of divisors
local LIMIT = 2000
local sieve = {}
for i = 2, LIMIT do sieve[i] = true end
for i = 2, math.floor(math.sqrt(LIMIT)) do
  if sieve[i] then
    for j = i * i, LIMIT, i do sieve[j] = false end
  end
end
local count, sum = 0, 0
local twins = {}
for i = 2, LIMIT do
  if sieve[i] then
    count = count + 1
    sum = sum + i
    if i > 2 and sieve[i - 2] then twins[#twins + 1] = "(" .. (i - 2) .. "," .. i .. ")" end
  end
end
print(count, sum)
print(#twins, twins[1], twins[#twins])

local function factor(n)
  local out = {}
  local d = 2
  while d * d <= n do
    while n % d == 0 do
      out[#out + 1] = d
      n = n / d
    end
    d = d + 1
  end
  if n > 1 then out[#out + 1] = n end
  return out
end
for _, n in ipairs({ 360, 9973, 123456, 65536 }) do
  print(n, table.concat(factor(n), "x"))
end
local function divisors(n)
  local out = {}
  for d = 1, n do if n % d == 0 then out[#out + 1] = d end end
  return out
end
local dsum = 0
for _, d in ipairs(divisors(496)) do dsum = dsum + d end
print(dsum, table.concat(divisors(28), ","))
