--!strict
-- Luau-only surface syntax: this fixture must compile, obfuscate and run with
-- exactly the same output as the Luau reference interpreter.
type Pair = { a: number, b: number }

local function clamp(v: number, lo: number, hi: number): number
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

local acc: number = 0
local items: { number } = { 1, 2, 3, 4, 5, 6, 7 }
for _, v in items do
  acc += v
end

local skipped = 0
local total = 0
for i = 1, 30 do
  if i % 3 == 0 then
    skipped += 1
    continue
  end
  total += i
end

local q = 100 // 7
local r = 100 % 7
local p: Pair = { a = q, b = r }
p.a += 1
p.b -= 1
p.a //= 2

local label = if q > 10 then "big" else "small"
local neg = -7 // 2

print("acc", acc)
print("skipped", skipped, "total", total)
print("q", q, "r", r, "a", p.a, "b", p.b)
print("label", label, "neg", neg, "clamp", clamp(50, 0, 10))
