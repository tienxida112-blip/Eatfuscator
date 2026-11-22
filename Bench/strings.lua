local parts = {}
for i = 1, 4000 do parts[#parts+1] = string.format("%d:%s", i, string.rep("ab", i % 7)) end
local s = table.concat(parts, ",")
local n = 0
for w in s:gmatch("[^,]+") do if #w > 6 then n = n + 1 end end
print("strings", #s, n, select(2, string.gsub(s, ":", ":")))
