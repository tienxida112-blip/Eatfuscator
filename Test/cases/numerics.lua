-- numerics: floats, exact integers, mod, floor, powers, formatting
print(7 % 3, -7 % 3, 7.5 % 2)
print(math.floor(3.9), math.ceil(3.1), math.abs(-0))
print(2 ^ 10, 2 ^ -1, math.sqrt(144))
print(math.max(1, 9, 4), math.min(1, 9, 4))
local acc = 0
for i = 1, 100 do acc = acc + i * 0.01 end
print(string.format("%.4f", acc))
print(0.1 + 0.2 == 0.30000000000000004)
print(tostring(1e15), tostring(123456789))
print(math.huge > 1e308, -math.huge < 0)
local big = 9007199254740991
print(big, big + 0)
print(tonumber("0x1F"), tonumber("  42  "), tonumber("nope"))
local q = 0
for i = 1, 64 do q = (q * 7 + i) % 1000003 end
print(q)
