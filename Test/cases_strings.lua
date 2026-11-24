-- strings: the library, the methods, and the patterns
local s = "Eatfuscator protects Lua and Luau"
print(#s, s:upper():sub(1, 4), s:lower():find("luau"))
print(("a,b,,c"):gsub(",", ";"))
print(string.format("%s|%d|%05.2f|%x", "x", 42, 3.14159, 255))
print(("  trim me  "):match("^%s*(.-)%s*$"))
print(table.concat({ "a", "b", "c" }, "-"))
local parts = {}
for w in ("one two three"):gmatch("%a+") do parts[#parts + 1] = w:reverse() end
print(table.concat(parts, ","))
print(("abc"):byte(1, 3))
print(string.char(69, 65, 84))
local n = 0
for _ in ("bbbaaabb"):gmatch("a+") do n = n + 1 end
print("runs", n)
print(("MiXeD"):gsub("%u", function(c) return "_" .. c:lower() end))
print(("x=1,y=2"):gsub("(%a)=(%d)", "%2=%1"))
