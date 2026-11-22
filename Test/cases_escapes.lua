local z = "ab\z
     cd"
print(#z, z)
local u = "a\u{41}b\x42c\67d"
print(#u, u)
local mixed = 'q\tt\v u\065'
print(#mixed, mixed:byte(1, #mixed))
print("a\z" .. "b", "x\z   \z   y")
local long = [[keep \z raw]]
print(#long, long)
local nested = ("inner"):upper() .. "\z
   tail"
print(nested)
