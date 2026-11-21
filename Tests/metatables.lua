-- metatables: index, newindex, call, arithmetic, tostring, eq, lt, len
local Store = {}
Store.__index = Store
function Store.new()
  return setmetatable({ n = 0, log = {} }, Store)
end
function Store:add(v)
  self.n = self.n + v
  self.log[#self.log + 1] = v
  return self
end
function Store.__tostring(s) return "Store(" .. s.n .. ")" end
function Store.__add(a, b) return Store.new():add(a.n):add(b.n) end
function Store.__eq(a, b) return a.n == b.n end
function Store.__lt(a, b) return a.n < b.n end
function Store.__len(s) return #s.log end
function Store.__call(s, extra) return s.n + extra end

local a = Store.new():add(3):add(4)
local b = Store.new():add(7)
print(tostring(a), tostring(a + b), a == b, a < b, #a, a(10))

local proxy = setmetatable({}, {
  __index = function(_, k) return k .. "!" end,
  __newindex = function(t, k, v) rawset(t, k, v * 2) end,
})
proxy.answer = 21
print(proxy.missing, proxy.answer)

local ro = setmetatable({ x = 1 }, { __metatable = "locked" })
print(getmetatable(ro) == "locked")

local arr = setmetatable({}, { __index = function(_, i) return i * i end })
print(arr[3], arr[9])
