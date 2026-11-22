-- A script shaped like a real Roblox client script: services, instances, signals,
-- datatypes, task, coroutines, varargs, metatables and pcall. Deterministic on
-- purpose (no clock, no random) so `tools/robloxhost.lua` can produce the same
-- output for the original and for its obfuscated copy.
--
-- It exists because the loader bug fixed in 0.18.0 only appears on a host whose
-- environment has an `__index` (Roblox's own is a proxy): the loader read a
-- truthy-but-bogus `_ENV`, believed it, and the payload ran into a fake global
-- table - exit 0, no output, nothing to debug.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Lighting = game:GetService("Lighting")

local player = Players.LocalPlayer
print("player", typeof(player), player.ClassName, player.Name)

-- instances, parenting, signals
local folder = Instance.new("Folder")
folder.Name = "EatTest"
folder.Parent = workspace

local fires = 0
local conn = folder.ChildAdded:Connect(function(child)
  fires = fires + 1
end)
local part = Instance.new("Part")
part.Name = "Brick"
part.Size = Vector3.new(4, 1, 2)
part.Position = Vector3.new(1, 5, -2)
part.Anchored = true
part.Parent = folder

print("children", #folder:GetChildren(), folder:FindFirstChild("Brick") == part)
print("isa", part:IsA("BasePart"), part:IsA("Model"), typeof(part))
print("fires", fires)
conn:Disconnect()

-- datatype maths, the way a movement script would use it
local moved = part.Position + Vector3.new(0, 3, 0) * 2
print("pos", moved.X, moved.Y, moved.Z)
local magnitude = moved.Magnitude
print("mag", magnitude > 7 and "big" or "small")

-- tables, sorting, string work
local names = {}
for i = 1, #folder:GetChildren() do
  names[#names + 1] = folder:GetChildren()[i].Name
end
table.sort(names)
print("names", table.concat(names, ","), string.upper(names[1] or "?"))

-- varargs and closures
local function sum(...)
  local total = 0
  for i = 1, select("#", ...) do
    total = total + (select(i, ...))
  end
  return total
end
local adder = function(step)
  return function(v) return v + step end
end
print("sum", sum(1, 2, 3, 4, 5), adder(10)(5))

-- coroutines
local co = coroutine.create(function(a)
  local b = coroutine.yield(a + 1)
  return b * 2
end)
local ok1, v1 = coroutine.resume(co, 1)
local ok2, v2 = coroutine.resume(co, 21)
print("coro", ok1, v1, ok2, v2, coroutine.status(co))

-- metatables
local point = setmetatable({ x = 3, y = 4 }, {
  __add = function(a, b) return setmetatable({ x = a.x + b.x, y = a.y + b.y }, getmetatable(a)) end,
  __tostring = function(a) return "(" .. a.x .. "," .. a.y .. ")" end,
})
print("meta", tostring(point + point))

-- pcall, warn, task
local okp, err = pcall(function() error("boom") end)
print("pcall", okp, tostring(err):sub(-5))
warn("warned")
task.spawn(function() print("spawned") end)

-- services that are not a data model
print("services", typeof(RunService), typeof(Lighting), RunService:IsA("Instance"))
print("clock", Lighting.ClockTime > 0 and "day" or "night")

-- a loop that touches the host every pass, like a render step would
local acc = 0
for i = 1, 50 do
  local p = part.Position + Vector3.new(i, 0, 0)
  acc = acc + p.X
end
print("acc", acc)

print("done", script.ClassName)
