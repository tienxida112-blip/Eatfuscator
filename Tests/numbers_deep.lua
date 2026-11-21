-- numbers_deep: parsing, printing, and arithmetic at the edges
print(tonumber("42"), tonumber(" 42 "), tonumber("4.5e2"), tonumber("0x10"))
print(tonumber("abc"), tonumber(""), tonumber("1 2"))
print(tostring(42), tostring(42.0), tostring(-0.5), tostring(1 / 3))
print(string.format("%d %i %.3f %e %g", 42, 42, 3.14159, 1234.5, 0.00001234))
print(math.floor(-0.5), math.ceil(-0.5), math.floor(0.5))
local exact = 0
for i = 1, 1000 do exact = exact + 1 end
print(exact, exact == 1000)
local thirds = 0
for i = 1, 300 do thirds = thirds + 1 / 3 end
print(thirds > 99.99 and thirds < 100.01)
print(2 ^ 53, 2 ^ 53 + 1, (2 ^ 53 + 1) - 2 ^ 53)
print(1e308 * 10 > 1e308, -1e308 * 10 < -1e308)
print(math.max(1, 2, 3) + math.min(1, 2, 3))
local function ibin(n)
  if n == 0 then return "0" end
  local out = {}
  while n > 0 do
    out[#out + 1] = tostring(n % 2)
    n = math.floor(n / 2)
  end
  return table.concat(out):reverse()
end
print(ibin(0), ibin(5), ibin(255), ibin(1024))
print(("%5.2f"):format(-1.005), ("%08.3f"):format(3.5))
