-- Macro sample. Every macro below has a shim, so this file runs unchanged with a
-- plain interpreter and produces the same output once obfuscated. The shims live
-- in an `if not EAT_OBFUSCATED then` block, which the build deletes.
if not EAT_OBFUSCATED then
  function EAT_STRING(s) return s end
  function EAT_NUMBER(n) return n end
  function EAT_FUNCTION(f) return f end
  function EAT_ASSUME(value, expected) return expected end
  function EAT_OPAQUE(cond) return cond end
  function EAT_SECRET(s, expression, expected) return s end
end

-- A literal that is kept in more than one piece.
local banner = EAT_STRING("macros: string literal split across chunks")
-- A number that is not written as a number.
local rounds = EAT_NUMBER(1200)
-- A function literal passed through as-is.
local add = EAT_FUNCTION(function(a, b) return a + b end)

-- An assumption: the build is told this slot holds 7 and specialises on it.
local slot = 7
local width = EAT_ASSUME(slot, 7)

-- Two opaque predicates. The first is true, the second is false, and neither
-- reads like a literal in the artifact.
local always = EAT_OPAQUE(true)
local never = EAT_OPAQUE(false)

-- A string that only decodes when `slot` really is 7 at run time. With a wrong
-- value the decoder returns bytes instead of the text - deliberately.
local secret = EAT_SECRET("bound to a runtime fact", slot, 7)

local total = 0
for i = 1, 10 do
  if always then total = total + i end
  if never then total = total + 1000 end
end

print(banner)
print("rounds", rounds, "sum", total, "width", width)
print("add", add(2, width))
print("secret", secret)
print("secret hex", (secret:gsub(".", function(c) return string.format("%02x", c:byte()) end)))
