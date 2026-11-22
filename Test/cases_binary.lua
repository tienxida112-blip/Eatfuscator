-- binary: byte packing, hex, base64 in both directions
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function b64(data)
  local out = {}
  local i = 1
  while i <= #data do
    local b1, b2, b3 = data:byte(i, i + 2)
    local n = b1 * 65536 + (b2 or 0) * 256 + (b3 or 0)
    local c1 = math.floor(n / 262144) % 64
    local c2 = math.floor(n / 4096) % 64
    local c3 = math.floor(n / 64) % 64
    local c4 = n % 64
    out[#out + 1] = B64:sub(c1 + 1, c1 + 1) .. B64:sub(c2 + 1, c2 + 1)
      .. (b2 and B64:sub(c3 + 1, c3 + 1) or "=")
      .. (b3 and B64:sub(c4 + 1, c4 + 1) or "=")
    i = i + 3
  end
  return table.concat(out)
end
local function unb64(text)
  local out = {}
  for i = 1, #text, 4 do
    local chunk = text:sub(i, i + 3)
    local v = 0
    local pad = 0
    for j = 1, 4 do
      local c = chunk:sub(j, j)
      if c == "=" then
        pad = pad + 1
        v = v * 64
      else
        v = v * 64 + (B64:find(c, 1, true) - 1)
      end
    end
    out[#out + 1] = string.char(math.floor(v / 65536) % 256)
    if pad < 2 then out[#out + 1] = string.char(math.floor(v / 256) % 256) end
    if pad < 1 then out[#out + 1] = string.char(v % 256) end
  end
  return table.concat(out)
end

local payload = "Eatfuscator\x00\x01\x02 payload"
local enc = b64(payload)
print(enc)
print(unb64(enc) == payload, #payload, #enc)

local function hex(data)
  local out = {}
  for i = 1, #data do out[i] = string.format("%02x", data:byte(i)) end
  return table.concat(out)
end
print(hex("Luau"), hex("\255\0\16"))

local bytes = {}
for i = 0, 255, 17 do bytes[#bytes + 1] = string.format("%02X", i) end
print(table.concat(bytes, " "))
print(#b64(""), b64("ab"), b64("abc"))
