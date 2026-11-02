-- state_machine: a table-driven tokeniser
local KIND = {
  ["+"] = "plus", ["-"] = "minus", ["*"] = "star", ["/"] = "slash",
  ["("] = "lparen", [")"] = "rparen", ["%d"] = "number", ["%a"] = "name",
}

local function tokenize(text)
  local tokens = {}
  local i, n = 1, #text
  while i <= n do
    local c = text:sub(i, i)
    if c:match("%s") then
      i = i + 1
    elseif c:match("%d") then
      local num = text:match("^%d+%.?%d*", i)
      tokens[#tokens + 1] = { kind = "number", value = num }
      i = i + #num
    elseif c:match("%a") then
      local name = text:match("^%a%w*", i)
      tokens[#tokens + 1] = { kind = "name", value = name }
      i = i + #name
    else
      tokens[#tokens + 1] = { kind = KIND[c] or "unknown", value = c }
      i = i + 1
    end
  end
  return tokens
end

local source = "3 + foo * (12 - bar) / 4"
local tokens = tokenize(source)
local out = {}
for _, t in ipairs(tokens) do out[#out + 1] = t.kind .. ":" .. t.value end
print(table.concat(out, " "))
print(#tokens)

-- precedence climbing parser over the same token list
local pos = 1
local function peek() return tokens[pos] end
local function take() local t = tokens[pos] pos = pos + 1 return t end
local parseExpr
local vars = { foo = 2, bar = 3 }
local function parseAtom()
  local t = take()
  if t.kind == "number" then return tonumber(t.value) end
  if t.kind == "name" then return vars[t.value] or 0 end
  if t.kind == "lparen" then
    local v = parseExpr()
    take()
    return v
  end
  error("unexpected " .. t.kind)
end
local function parseTerm()
  local left = parseAtom()
  while peek() and (peek().kind == "star" or peek().kind == "slash") do
    local op = take().kind
    local right = parseAtom()
    if op == "star" then left = left * right else left = left / right end
  end
  return left
end
function parseExpr()
  local left = parseTerm()
  while peek() and (peek().kind == "plus" or peek().kind == "minus") do
    local op = take().kind
    local right = parseTerm()
    if op == "plus" then left = left + right else left = left - right end
  end
  return left
end
local ok, value = pcall(function() return parseExpr() end)
print(ok, value, pos, #tokens)
