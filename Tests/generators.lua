-- generators: coroutine iterators feeding for-loops, with early exit
local function range(from, to, step)
  step = step or 1
  return coroutine.wrap(function()
    for i = from, to, step do coroutine.yield(i) end
  end)
end
local sum = 0
for i in range(1, 10) do sum = sum + i end
print(sum, range(1, 3, 2)())

local function take(gen, n)
  local out = {}
  for i = 1, n do
    local v = gen()
    if v == nil then break end
    out[i] = v
  end
  return out
end
local squares = coroutine.wrap(function()
  local i = 0
  while true do
    i = i + 1
    coroutine.yield(i * i)
  end
end)
print(table.concat(take(squares, 6), ","))

local function permute(list)
  local pool = { unpack(list) }
  local used, picked = {}, {}
  return coroutine.wrap(function()
    local function walk()
      if #picked == #pool then
        coroutine.yield(table.concat(picked))
        return
      end
      for i = 1, #pool do
        if not used[i] then
          used[i] = true
          picked[#picked + 1] = pool[i]
          walk()
          picked[#picked] = nil
          used[i] = false
        end
      end
    end
    walk()
  end)
end
local count = 0
local firstThree = {}
for p in permute({ "a", "b", "c" }) do
  count = count + 1
  if count <= 3 then firstThree[count] = p end
  if count > 5 then break end
end
print(count, table.concat(firstThree, " "))

local pipeline = coroutine.wrap(function()
  local inner = coroutine.wrap(function()
    for _, v in ipairs({ 1, 2, 3 }) do coroutine.yield(v) end
  end)
  while true do
    local v = inner()
    if v == nil then break end
    coroutine.yield(v * 10)
  end
end)
local stages = {}
for v in pipeline do stages[#stages + 1] = v end
print(table.concat(stages, "-"))
