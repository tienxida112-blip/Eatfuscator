local t = {}
for i = 1, 30000 do t[#t+1] = (i * 7919) % 30011 end
table.sort(t)
local h = {}
for i = 1, #t do h[t[i]] = (h[t[i]] or 0) + 1 end
local sum = 0
for k, v in pairs(h) do sum = sum + k * v end
print("tables", #t, t[1], t[#t], sum)
