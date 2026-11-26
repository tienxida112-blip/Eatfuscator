-- tables: insertion, removal, sorting, packing
local t = {}
for i = 1, 10 do t[i] = (i * 37) % 11 end
table.sort(t)
print(table.concat(t, " "))
table.remove(t, 1)
table.insert(t, 1, 99)
print(table.concat(t, " "))
local d = {}
for i, v in ipairs(t) do d[v] = (d[v] or 0) + i end
local keys = {}
for k in pairs(d) do keys[#keys + 1] = k end
table.sort(keys, function(a, b) return a > b end)
print(#keys, table.concat(keys, ","))
local packed = table.pack(1, nil, 3, nil)
print(packed.n, select("#", table.unpack(packed, 1, packed.n)))
local nested = { a = { b = { c = { 1, 2, 3 } } } }
print(nested.a.b.c[3], nested["a"]["b"]["c"][1])
local created = table.create(4, 7)
print(#created, created[4])
local copy = {}
for i = 1, #t do copy[i] = t[i] end
print(#copy, copy[#copy])
