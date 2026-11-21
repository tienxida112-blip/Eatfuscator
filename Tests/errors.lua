-- errors: pcall, error objects, xpcall, nested protection
-- error() prefixes a position; the position belongs to the file, not to the
-- program, so it is stripped before printing
local function strip(msg) return (tostring(msg):gsub("^[^:]*:%d+: ", "")) end

local function risky(n)
  if n < 0 then error({ code = "negative", n = n }) end
  if n == 0 then error("zero") end
  return n * 2
end
print(pcall(risky, 4))
local ok, e = pcall(risky, 0)
print(ok, strip(e))
local ok2, obj = pcall(risky, -3)
print(ok2, type(obj), obj.code, obj.n)

local function handler(err)
  return "handled: " .. tostring(type(err) == "table" and err.code or strip(err))
end
print(xpcall(function() error("inner") end, handler))
print(xpcall(function() return "fine" end, handler))

local depth = 0
local function nest(n)
  depth = depth + 1
  if n <= 0 then error("bottom") end
  local ok3, err2 = pcall(nest, n - 1)
  if not ok3 and n == 1 then return "propagated" end
  if not ok3 then error(err2, 0) end
  return "clean"
end
print(nest(3), depth)

local ok4, msg4 = pcall(function() local t = nil return t.x end)
print(ok4, strip(msg4))
