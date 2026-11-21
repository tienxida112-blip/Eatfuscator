-- sets: union, intersection, difference, subset, a word bag
local function toSet(list)
  local s = {}
  for _, v in ipairs(list) do s[v] = true end
  return s
end
local function members(s)
  local out = {}
  for k in pairs(s) do out[#out + 1] = k end
  table.sort(out)
  return out
end
local function union(a, b)
  local out = {}
  for k in pairs(a) do out[k] = true end
  for k in pairs(b) do out[k] = true end
  return out
end
local function intersect(a, b)
  local out = {}
  for k in pairs(a) do if b[k] then out[k] = true end end
  return out
end
local function difference(a, b)
  local out = {}
  for k in pairs(a) do if not b[k] then out[k] = true end end
  return out
end
local function subset(a, b)
  for k in pairs(a) do if not b[k] then return false end end
  return true
end

local a = toSet({ "a", "b", "c", "d" })
local b = toSet({ "c", "d", "e" })
print(table.concat(members(union(a, b)), ""))
print(table.concat(members(intersect(a, b)), ""))
print(table.concat(members(difference(a, b)), ""))
print(subset(intersect(a, b), a), subset(union(a, b), a))

local bag = {}
for word in ("a b a c b a"):gmatch("%a") do bag[word] = (bag[word] or 0) + 1 end
print(bag.a, bag.b, bag.c, bag.d)
local keys = members(bag)
local counts = {}
for i, k in ipairs(keys) do counts[i] = k .. ":" .. bag[k] end
print(table.concat(counts, " "))
