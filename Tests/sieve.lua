local N = 60000
local is = {}
for i = 2, N do is[i] = true end
for i = 2, math.floor(math.sqrt(N)) do
  if is[i] then for j = i*i, N, i do is[j] = false end end
end
local count = 0
for i = 2, N do if is[i] then count = count + 1 end end
print("primes", count)
