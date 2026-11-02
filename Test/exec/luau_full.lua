--!strict
-- Full Luau surface syntax. Runs identically as source and as an artifact.

export type Id<T> = { value: T }
type Point = { x: number, y: number }
type Union = string | number

local function dist2(a: Point, b: Point): number
  local dx = a.x - b.x
  local dy = a.y - b.y
  return dx * dx + dy * dy
end

local function id<T>(v: T): Id<T>
  return { value = v }
end

local p: Point = { x = 3, y = 4 }
local q: Point = { x = 0, y = 0 }

-- compound assignment on names, fields and indexes
local n = 10
n += 5
n -= 3
n *= 2
n /= 4
n %= 7
n ^= 2
local s = "a"
s ..= "b"

local box: Point = { x = 1, y = 2 }
box.x += 10
box.y -= 1
local arr = { 5, 6, 7 }
arr[1] += 1
arr[2] *= 2

-- integer floor division, including compound form
local fdiv = 100 // 7
local fneg = -7 // 2
local fmix = 7 // -2
local fcur = 100
fcur //= 7

-- if-expressions, nested
local grade = if n >= 20 then "high" elseif n >= 10 then "mid" else "low"
local sign = if fneg < 0 then -1 else 1

-- string interpolation
local tag = "tag"
local msg = `[{tag}] n={n} fdiv={fdiv} sum={fdiv + sign}`
local raw = `plain`
local nested = `a{`b{tag}d`}e`

-- continue, including nested loops
local evens = 0
for i = 1, 20 do
  if i % 2 == 1 then
    continue
  end
  evens += i
end

local coords = 0
for i = 1, 5 do
  for j = 1, 5 do
    if i * j > 12 then
      continue
    end
    coords += 1
  end
end

local kcount = 0
while kcount < 10 do
  kcount += 1
  if kcount == 3 then
    continue
  end
end

local rcount = 0
repeat
  rcount += 1
  if rcount == 2 then
    continue
  end
until rcount >= 4

-- generalized iteration
local total = 0
for _, v in { 1, 2, 3, 4 } do
  total += v
end

-- numbers: binary, separators, hex float, unicode escape
local bin = 0b1010
local sep = 1_000_000
local hf = 0x1F
local uni = "\u{48}\u{69}"
local esc = "\t|\\|\""

-- type cast
local cast = (n :: number) + 1

print("dist2", dist2(p, q))
print("id", id(7).value)
print("n", n, "s", s)
print("box", box.x, box.y, "arr", arr[1], arr[2], arr[3])
print("fdiv", fdiv, "fneg", fneg, "fmix", fmix, "fcur", fcur)
print("grade", grade, "sign", sign)
print("msg", msg)
print("raw", raw, "nested", nested)
print("evens", evens, "coords", coords, "kcount", kcount, "rcount", rcount)
print("total", total)
print("bin", bin, "sep", sep, "hf", hf, "uni", uni, "esc", #esc)
print("cast", cast)
local u: Union = "u"
print("union", u)
