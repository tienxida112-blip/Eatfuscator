-- json: a tiny encoder and a recursive-descent decoder
local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end
local function quote(s)
  s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n")
  return '"' .. s .. '"'
end
local encode
function encode(v)
  local ty = type(v)
  if ty == "nil" then return "null" end
  if ty == "boolean" or ty == "number" then return tostring(v) end
  if ty == "string" then return quote(v) end
  if ty == "table" then
    if isArray(v) then
      local parts = {}
      for i = 1, #v do parts[i] = encode(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys)
    local parts = {}
    for i, k in ipairs(keys) do parts[i] = quote(k) .. ":" .. encode(v[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local data = {
  name = "eatfuscator",
  tags = { "lua", "luau", "vm" },
  nested = { ok = true, depth = 3, empty = {} },
  text = 'say "hi"\nbye',
}
local text = encode(data)
print(text)
print(#text)

local function decode(s)
  local pos = 1
  local function skip() pos = s:find("[^ \t\r\n]", pos) or #s + 1 end
  local value
  local function stringlit()
    local out = {}
    pos = pos + 1
    while true do
      local c = s:sub(pos, pos)
      if c == "" then error("unterminated string") end
      if c == '"' then pos = pos + 1 break end
      if c == "\\" then
        local n = s:sub(pos + 1, pos + 1)
        out[#out + 1] = ({ n = "\n", t = "\t", ['"'] = '"', ["\\"] = "\\" })[n] or n
        pos = pos + 2
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    return table.concat(out)
  end
  function value()
    skip()
    local c = s:sub(pos, pos)
    if c == "{" then
      local obj = {}
      pos = pos + 1
      skip()
      if s:sub(pos, pos) == "}" then pos = pos + 1 return obj end
      while true do
        skip()
        local k = stringlit()
        skip()
        pos = pos + 1 -- ':'
        obj[k] = value()
        skip()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return obj end
      end
    elseif c == "[" then
      local arr = {}
      pos = pos + 1
      skip()
      if s:sub(pos, pos) == "]" then pos = pos + 1 return arr end
      while true do
        arr[#arr + 1] = value()
        skip()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return arr end
      end
    elseif c == '"' then
      return stringlit()
    elseif s:sub(pos, pos + 3) == "true" then pos = pos + 4 return true
    elseif s:sub(pos, pos + 4) == "false" then pos = pos + 5 return false
    elseif s:sub(pos, pos + 3) == "null" then pos = pos + 4 return nil
    else
      local num = s:match("^-?%d+%.?%d*", pos)
      pos = pos + #num
      return tonumber(num)
    end
  end
  local out = value()
  skip()
  assert(pos > #s, "trailing input at " .. pos)
  return out
end

local back = decode(text)
print(back.name, back.tags[2], back.nested.depth, back.nested.ok)
print(back.text == data.text, #back.tags)
print(encode(decode('{"b":[1,2,{"c":null}],"a":"x"}')))
