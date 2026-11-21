-- deterministic arithmetic / table / string exercise
local total = 0
local t = {}
for i = 1, 25 do
  t[i] = (i * 37) % 101
  total = total + t[i]
end
print("count", #t)
print("total", total)
print("first", t[1], "last", t[25])
local s = "eatfuscator"
print("upper", string.upper(s))
print("len", #s, "sub", string.sub(s, 4, 8))
print("concat", table.concat({ "a", "b", "c" }, "-"))
local fmt = string.format("%d/%d/%d", 7, 11, 13)
print("fmt", fmt)
