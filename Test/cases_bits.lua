-- bits: bit operations spelled with arithmetic, so the fixture is 5.1-clean
local function band(a, b)
  local out, bit = 0, 1
  while a > 0 and b > 0 do
    if a % 2 == 1 and b % 2 == 1 then out = out + bit end
    a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
  end
  return out
end
local function bor(a, b)
  local out, bit = 0, 1
  while a > 0 or b > 0 do
    if a % 2 == 1 or b % 2 == 1 then out = out + bit end
    a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
  end
  return out
end
local function bxor(a, b)
  local out, bit = 0, 1
  while a > 0 or b > 0 do
    if (a % 2) ~= (b % 2) then out = out + bit end
    a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
  end
  return out
end
local function shl(a, n) return a * 2 ^ n end
local function shr(a, n) return math.floor(a / 2 ^ n) end
local function popcount(a)
  local n = 0
  while a > 0 do
    n = n + a % 2
    a = math.floor(a / 2)
  end
  return n
end

print(band(12, 10), bor(12, 10), bxor(12, 10))
print(shl(3, 4), shr(48, 4), popcount(255), popcount(1023))
local acc = 0
for i = 0, 15 do acc = acc + bxor(i, shr(i, 1)) end
print(acc)
print(band(0xFFFF, 0x0F0F), bor(0, 0), bxor(1, 1))
local pattern = {}
for i = 7, 0, -1 do pattern[#pattern + 1] = tostring(math.floor(170 / 2 ^ i) % 2) end
print(table.concat(pattern))
