-- control flow: early exits, nested loops, repeat/while, else-if chains
local function grade(score)
  if score >= 90 then return "A"
  elseif score >= 80 then return "B"
  elseif score >= 70 then return "C"
  elseif score >= 60 then return "D"
  else return "F" end
end
local dist = {}
for _, s in ipairs({ 95, 83, 71, 60, 12, 88, 91, 70 }) do
  local g = grade(s)
  dist[g] = (dist[g] or 0) + 1
end
local order = { "A", "B", "C", "D", "F" }
local cells = {}
for i, g in ipairs(order) do cells[i] = g .. "=" .. tostring(dist[g] or 0) end
print(table.concat(cells, " "))

local function findPair(list, target)
  for i = 1, #list do
    for j = i + 1, #list do
      if list[i] + list[j] == target then return i, j end
    end
  end
  return nil
end
print(findPair({ 3, 8, 12, 5, 9 }, 17))
print(findPair({ 1, 2 }, 99))

local n, steps = 27, 0
repeat
  n = (n % 2 == 0) and n / 2 or 3 * n + 1
  steps = steps + 1
until n == 1
print(steps)

local i, acc = 0, {}
while i < 5 do
  i = i + 1
  if i == 3 then acc[#acc + 1] = "skip" else acc[#acc + 1] = i end
end
print(table.concat(acc, ","))

local found
for x = 1, 50 do
  if x * x > 200 then
    found = x
    break
  end
end
print(found)
