-- iteration: numeric for steps, ipairs, pairs, next, early break
local acc = {}
for i = 10, 1, -3 do acc[#acc + 1] = i end
print(table.concat(acc, ","))
local t = { 5, 6, 7 }
t.extra = "e"
local n = 0
for k, v in pairs(t) do n = n + 1 end
print(n)
local m = 0
for _, v in ipairs(t) do m = m + v end
print(m)
local k2, v2 = next(t)
print(k2 ~= nil, v2 ~= nil)
local list = { { 1, 2 }, { 3, 4 }, { 5 } }
local flat = 0
for _, row in ipairs(list) do
  for _, cell in ipairs(row) do flat = flat + cell end
end
print(flat)
local custom = setmetatable({}, {
  __index = function(_, i) return i <= 3 and i * 100 or nil end,
})
local c = 0
for i = 1, 10 do
  local v3 = custom[i]
  if v3 == nil then break end
  c = c + v3
end
print(c)
