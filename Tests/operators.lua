-- operators: precedence, short-circuit values, chained comparison
print(2 + 3 * 4, (2 + 3) * 4, 2 ^ 3 ^ 2)
print(10 - 2 - 3, 100 / 10 / 2, -2 ^ 2, (-2) ^ 2)
print(1 .. 2 .. 3, "v" .. 4 + 1)
print(nil == false, 1 == 1.0, "1" == 1, "a" < "b")
print(not nil, not 0, not not "", #"four")
local a, b = 1, 2
print(a < b, a <= a, b > a, b >= b, a ~= b)
print(false and error("never") or "ok")
print(nil or false or 0 or 1)
local x = -5
print(x > 0 and "pos" or "neg", math.abs(x) == 5)
local s = ""
for i = 1, 5 do s = s .. i .. "," end
print(s)
print(1 + 2 * 3 ^ 2 - 4 / 2, (1 + 2) * (3 ^ 2) - 4 / 2)
print(2 ^ 0.5 > 1.414, 7 % 2 == 1, -7 % 2 == 1)
