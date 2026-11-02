-- coroutines: resume/yield values, status, wrap, error propagation
local co = coroutine.create(function(a, b)
  local c = coroutine.yield(a + b)
  local d = coroutine.yield(c * 2)
  return d + 1
end)
print(coroutine.status(co))
local ok1, v1 = coroutine.resume(co, 2, 3)
print(ok1, v1, coroutine.status(co))
local ok2, v2 = coroutine.resume(co, 10)
print(ok2, v2)
local ok3, v3 = coroutine.resume(co, 100)
print(ok3, v3, coroutine.status(co))

local gen = coroutine.wrap(function()
  for i = 1, 4 do coroutine.yield(i * 10) end
end)
print(gen(), gen(), gen(), gen())

local bad = coroutine.create(function() error("boom") end)
local okb, errb = coroutine.resume(bad)
print(okb, type(errb), coroutine.status(bad))
