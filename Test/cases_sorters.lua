-- sorters: comparators, tuple keys, reverse order, a search after sorting
local nums = {}
for i = 1, 40 do nums[i] = (i * 29) % 41 end
table.sort(nums)
print(table.concat(nums, ",", 1, 12))
table.sort(nums, function(a, b) return a > b end)
print(table.concat(nums, ",", 1, 6))

local function byAgeThenName(a, b)
  if a.age ~= b.age then return a.age < b.age end
  return a.name < b.name
end
local people = {
  { name = "ana", age = 34 },
  { name = "bo", age = 27 },
  { name = "cy", age = 34 },
  { name = "di", age = 19 },
  { name = "ed", age = 27 },
}
table.sort(people, byAgeThenName)
for i = 1, #people do print(people[i].name, people[i].age) end

local function bsearch(t, v)
  local lo, hi = 1, #t
  while lo <= hi do
    local mid = math.floor((lo + hi) / 2)
    if t[mid] == v then return mid end
    if t[mid] < v then lo = mid + 1 else hi = mid - 1 end
  end
  return -1
end
local sorted = { 2, 4, 6, 8, 10, 12, 14 }
print(bsearch(sorted, 10), bsearch(sorted, 7))

local words = { "pear", "apple", "fig", "banana" }
table.sort(words, function(a, b) return #a < #b or (#a == #b and a < b) end)
print(table.concat(words, " "))
