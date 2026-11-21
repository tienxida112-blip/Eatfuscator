-- deterministic workload: exercises numeric loops, tables, string ops
local acc = 0
local t = {}
for i = 1, 4000 do
  t[i] = (i * 2654435761) % 1000
  acc = (acc + t[i] * i) % 1000000007
end
local s = {}
for i = 1, #t do
  s[#s + 1] = tostring(t[i] % 97)
end
local joined = table.concat(s, ",")
print("acc", acc)
print("len", #joined)
print("fingerprint", #joined * 31 + acc % 9973)
