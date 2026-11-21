-- words: word frequency report from an embedded paragraph
local text = [[
the vm reads an image, the image holds a prototype tree
each prototype owns a code stream, a constant bank and children
the runtime walks the tree once and never looks at the source again
a string is only decrypted when the program asks for it
]]
local freq, total = {}, 0
for word in text:lower():gmatch("%a+") do
  freq[word] = (freq[word] or 0) + 1
  total = total + 1
end
local keys = {}
for k in pairs(freq) do keys[#keys + 1] = k end
table.sort(keys, function(a, b)
  if freq[a] ~= freq[b] then return freq[a] > freq[b] end
  return a < b
end)
print("total", total, "unique", #keys)
for i = 1, 8 do
  local k = keys[i]
  print(string.format("%-10s %2d %s", k, freq[k], string.rep("#", freq[k])))
end
local longest, shortest = "", keys[1]
for _, k in ipairs(keys) do
  if #k > #longest then longest = k end
  if #k < #shortest then shortest = k end
end
print(longest, shortest)
local lines = 0
for _ in text:gmatch("\n") do lines = lines + 1 end
print("lines", lines, "chars", #text)
