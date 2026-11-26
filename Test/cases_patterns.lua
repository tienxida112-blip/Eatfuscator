-- patterns: captures, frontiers, balance, repetition
print(("key = value"):match("(%w+)%s*=%s*(%w+)"))
print(("2026-11-02"):match("(%d+)-(%d+)-(%d+)"))
print(("abc123def"):find("%d+"))
print(("abc123def"):find("%d+", 1, true))
print(("a.b.c"):gsub("%.", "/"))
print((("  x  "):gsub("^%s+", ""):gsub("%s+$", "")))
print(("word1 word2"):gsub("(%w+)", "<%1>"))
print(("abc"):gsub("", "-"))
print(("aaa"):match("a-"), ("aaa"):match("a*"))
print(("hello world"):match("^(%w+)%s+(%w+)$"))
print(("[[x]]"):match("%[(%b[])%]"))
print(("abc"):gsub("%a", { a = "1", b = "2" }))
print(("%d"):format(7), ("%s|%s"):format("a", "b"))
print(("CamelCaseString"):gsub("(%u)", function(c) return "_" .. c:lower() end))
local indent = 0
local formatted = ("a(b(c))"):gsub("[()]", function(p)
  if p == "(" then indent = indent + 1 return "[" end
  local old = indent
  indent = indent - 1
  return "]" .. old
end)
print(formatted, indent)
