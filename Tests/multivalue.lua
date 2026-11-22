local function f(...) return ... end
print(f(1, nil, 3))
local function g(...) return 1, ... end
print(g(4, 5, 6))
local function h(...) local a, b, c = ... return a, b, c end
print(h(7, nil, 9))
local function k(...) return select("#", ...), ... end
print(k(10, nil, 12))
local function m(...) local t = {n = select("#", ...), ...} return t.n, t[1], t[3] end
print(m(13, nil, 15))
print((function(...) return ... end)(16, 17))
local function f(...) return ... end
local function g() return 1, 2, 3 end
print(f(1, 2, 3))
print(g())
print((g()))
print(g(), g())
local t1 = {g()}
local t2 = {1, g()}
local t3 = {g(), g()}
print(#t1, #t2, #t3, t2[2], t3[2])
local a, b, c = g()
print(a, b, c)
local d = g()
print(d)
local e, h = 0, g()
print(e, h)
local x, y
x, y = g()
print(x, y)
print(select("#", g()))
print(select("#", (g())))
print(f(g()))
print(f(g(), g()))
local n, m = f(7, 8)
print(n, m)
print(table.unpack({g(), 9}))
print((f(1, 2)), f(3, 4))
