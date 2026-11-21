-- closures: shared upvalues, counters, iterators
local function counter(start)
  local n = start
  return function(step) n = n + (step or 1) return n end,
         function() return n end
end
local bump, peek = counter(10)
bump(); bump(5)
print(peek(), bump())

local function makeAdder(x) return function(y) return x + y end end
local add3 = makeAdder(3)
print(add3(4), makeAdder(-1)(1))

local function iterate(n)
  local i = 0
  return function()
    i = i + 1
    if i <= n then return i, i * i end
  end
end
local acc = 0
for i, sq in iterate(5) do acc = acc + i * sq end
print(acc)

local fns = {}
for i = 1, 4 do fns[i] = function() return i end end
print(fns[1](), fns[4]())

local shared = 0
local function inc() shared = shared + 1 end
local function get() return shared end
for i = 1, 7 do inc() end
print(get())
