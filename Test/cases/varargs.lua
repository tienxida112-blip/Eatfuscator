-- varargs: select, packing, forwarding, mixed fixed+vararg
local function count(...) return select("#", ...) end
print(count(), count(nil), count(1, 2, 3), count(nil, nil))

local function sum(...)
  local total = 0
  for i = 1, select("#", ...) do
    local v = select(i, ...)
    if type(v) == "number" then total = total + v end
  end
  return total
end
print(sum(1, 2, 3), sum(1, "x", 3, nil, 5))

local function head(first, ...) return first, count(...) end
print(head("a", "b", "c"))

local function forward(...) return sum(...) end
print(forward(10, 20, 30))

local function tail(...) return ... end
print(tail(1, 2, 3))

local packed = table.pack(sum(1, 2), "s", nil)
print(packed.n, packed[1], packed[2], packed[3])

local function mixed(a, b, ...)
  local extra = table.pack(...)
  return a + b + extra.n
end
print(mixed(1, 2), mixed(1, 2, "x", "y", "z"))
