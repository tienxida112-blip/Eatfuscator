-- aliasing: tables are shared, strings are values
local shared = { n = 0 }
local function bump(t) t.n = t.n + 1 end
bump(shared); bump(shared)
print(shared.n)

local a = shared
a.n = 42
print(shared.n)

local s1 = "abc"
local s2 = s1
s1 = s1 .. "d"
print(s1, s2)

local deep = { list = { 1, 2, 3 }, meta = { tag = "root" } }
local function clone(t)
  local out = {}
  for k, v in pairs(t) do
    if type(v) == "table" then out[k] = clone(v) else out[k] = v end
  end
  return out
end
local copy = clone(deep)
copy.list[2] = 99
copy.meta.tag = "copy"
print(deep.list[2], copy.list[2], deep.meta.tag, copy.meta.tag)

local function swap(t, i, j) t[i], t[j] = t[j], t[i] end
local arr = { "a", "b", "c" }
swap(arr, 1, 3)
print(table.concat(arr, ","))

-- closure capture of a table sees later writes
local box = { v = 1 }
local peek = function() return box.v end
box.v = 7
print(peek())
