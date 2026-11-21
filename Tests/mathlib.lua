-- math library: integer and float edge cases that survive a round trip
print(math.floor(-3.5), math.ceil(-3.5), math.abs(-7))
print(math.fmod(7, 3), math.fmod(-7, 3))
print(math.huge, -math.huge, math.pi > 3.14 and math.pi < 3.15)
print(string.format("%.0f %.0f", 2.5, 3.5))
print(math.max(3, 3.5, -1), math.min(3, 3.5, -1))
print(math.sqrt(2) * math.sqrt(2))
print(math.exp(0), math.log(1))
local sum = 0
for i = 1, 30 do sum = sum + math.floor(i / 3) end
print(sum)
local frac = 0
for i = 1, 20 do frac = frac + i / 8 end
print(string.format("%.3f", frac))
print(tostring(3 // 2), tostring(7 % 4))
