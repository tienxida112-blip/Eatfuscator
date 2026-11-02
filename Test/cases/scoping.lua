-- scoping: shadowing, recursion, mutual recursion, method dispatch, early return
local x = "outer"
do
  local x = "inner"
  print(x)
end
print(x)

local function fact(n) if n <= 1 then return 1 end return n * fact(n - 1) end
print(fact(10))

local isEven, isOdd
function isEven(n) if n == 0 then return true end return isOdd(n - 1) end
function isOdd(n) if n == 0 then return false end return isEven(n - 1) end
print(isEven(20), isOdd(7))

local Class = {}
Class.__index = Class
function Class.new(name, hp)
  return setmetatable({ name = name, hp = hp }, Class)
end
function Class:hit(dmg)
  self.hp = self.hp - dmg
  if self.hp <= 0 then return self.name .. " down" end
  return self.name .. " " .. self.hp
end
local Sub = setmetatable({}, { __index = Class })
Sub.__index = Sub
function Sub.new(name) local o = Class.new(name, 20) return setmetatable(o, Sub) end
function Sub:hit(dmg) return "sub:" .. Class.hit(self, dmg) end
print(Class.new("orc", 9):hit(4))
print(Sub.new("troll"):hit(25))

local function early(n)
  for i = 1, 10 do
    if i * i > n then return i, i * i end
  end
  return "none"
end
print(early(20), early(1000))

local a, b, c = (function() return 1, 2, 3 end)()
print(a, b, c)
