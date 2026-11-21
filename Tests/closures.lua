-- closures, varargs, metatables, pcall
local function counter(start)
  local n = start or 0
  return function(step)
    n = n + (step or 1)
    return n
  end
end
local c = counter(10)
print("c1", c(), "c2", c(5), "c3", c())

local function sum(...)
  local s = 0
  for _, v in ipairs({ ... }) do s = s + v end
  return s, select("#", ...)
end
print("sum", sum(1, 2, 3, 4, 5))

local mt = { __index = function(_, k) return "missing:" .. k end }
local obj = setmetatable({ a = 1 }, mt)
print("a", obj.a, "b", obj.b)

local ok, err = pcall(function() error("boom") end)
print("pcall", ok, tostring(err):match("boom") ~= nil)
