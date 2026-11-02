-- memo: memoisation, currying, composition, call counting
local function memoize(fn)
  local cache, calls = {}, 0
  return function(x)
    calls = calls + 1
    local hit = cache[x]
    if hit == nil then
      hit = fn(x)
      cache[x] = hit
    end
    return hit, calls
  end
end
local slowSquare = memoize(function(x) return x * x end)
for _, v in ipairs({ 3, 4, 3, 5, 4, 3 }) do
  local r, n = slowSquare(v)
  print(v, r, n)
end

local slowFib
slowFib = memoize(function(n)
  if n < 2 then return n end
  return slowFib(n - 1) + slowFib(n - 2)
end)
print(slowFib(25))

local function curry3(fn)
  return function(a) return function(b) return function(c) return fn(a, b, c) end end end
end
local volume = curry3(function(a, b, c) return a * b * c end)
print(volume(2)(3)(4), type(volume(2)(3)))

local function compose(...)
  local fns = { ... }
  return function(x)
    for i = #fns, 1, -1 do x = fns[i](x) end
    return x
  end
end
local pipeline = compose(function(x) return x + 1 end, function(x) return x * 2 end, tostring)
print(pipeline(5))

local function once(fn)
  local done, value = false, nil
  return function(...)
    if not done then
      done = true
      value = fn(...)
    end
    return value
  end
end
local init = once(function(tag) return tag .. "!" end)
print(init("first"), init("second"))
