# Macros

Eatfuscator's macros are call sites in your source that mean something to the
build and nothing to a plain interpreter. There are seven, and the shape follows
Luraph's macro system: **ordinary global functions with a reserved prefix**, plus
no-op shims so the script still runs before it is obfuscated.

Two rules come with that shape.

* Every identifier starting with `EAT_` is reserved. An unknown one is a **build
  error**, not a call that quietly survives into the artifact. Declaring a macro
  name as a local is also an error - a shadow would change what a call site means.
* The shims must be inside `if not EAT_OBFUSCATED then ... end`. The build deletes
  that whole block, and only then does a call site mean the macro.

```lua
if not EAT_OBFUSCATED then
  function EAT_STRING(s) return s end
  function EAT_NUMBER(n) return n end
  function EAT_FUNCTION(f) return f end
  function EAT_ASSUME(value, expected) return expected end
  function EAT_OPAQUE(cond) return cond end
  function EAT_SECRET(s, expression, expected) return s end
end
```

A complete, runnable example lives in [`Test/macros.lua`](../Test/macros.lua); it
prints the same thing with `luau Test/macros.lua` and after obfuscation.

There is deliberately **no macro that changes how the build is made**. Flattening,
padding, the atlas, the VM, the trap - those are the build's decisions and the
seed is the only setting. A macro here passes *information the source has and the
obfuscator cannot infer*. That is the only thing worth a call site.

---

## `EAT_STRING(text)` — a literal in pieces

```lua
local s = EAT_STRING("a literal that is not stored as one piece")
```

Long literals are split into chunks and concatenated, so no single constant in the
source is the whole string. Bytes are preserved exactly.

## `EAT_NUMBER(value)` — a number that is not written as one

```lua
local n = EAT_NUMBER(1200)   -->  ((1200 * 7) / 7 + 5 - 5)
```

The value is unchanged; the arithmetic is build-specific.

## `EAT_FUNCTION(fn)` — pass a function literal through

```lua
local add = EAT_FUNCTION(function(a, b) return a + b end)
```

Validates that the argument is a function literal and passes it through.

## `EAT_ASSUME(value, expected)` — tell the build a fact

```lua
local place = EAT_ASSUME(game.PlaceId, 123456789)
```

The source states that `value` equals `expected` (a numeric literal). The build
believes it: the call site becomes that constant, and consumers of it can be
specialised. `value` is still evaluated, so side effects are preserved.

If the assumption is false at run time, the program behaves as if it were true -
that is what an assumption *is*. Use it for facts that cannot change for your
target (a place id, a fixed table size, an enum value).

## `EAT_OPAQUE(cond)` — a predicate that does not read as one

```lua
if EAT_OPAQUE(true) then ... else ... end
```

Always evaluates to the literal you passed, as an expression built from per-build
numbers rather than a constant. Useful for making dead branches look live.

## `EAT_SECRET(text, expression, expected)` — a string bound to a runtime fact

```lua
local key = EAT_SECRET("bound to a runtime fact", slot, 7)
```

Ordinary string constants are encrypted with a build key. This one is bound to a
**runtime value**: the decoder's key is derived from `expression - expected`, so
the text comes back when the expression equals the expected value. This is not
cryptographic security: the arithmetic is modulo 256, so values differing by
256 can also decode it. Other collisions are possible, and the key and decoder
are present in the artifact. Do not use this to protect actual secrets.

Use the real runtime expression directly. Passing the result of `EAT_ASSUME` as
the expression defeats this binding: an assumption substitutes the expected value.

## `EAT_RAGEBAIT()` — for the person who lifted the code

Prints a taunt and parks the thread. Not a security feature; it is a sign on the
door for whoever pasted the artifact into an empty script and expected it to work.

---

## Errors, not silence

A macro that cannot be read is a build failure often with a line number: a bad
argument type, an unknown `EAT_` name, a `local EAT_X`, or an unclosed
`EAT_OBFUSCATED` block. The build never emits an artifact with a half-expanded
macro in it, and a macro never turns into the string `"error: ..."` at run time.

## What the build does with the shims

The shim block is deleted before anything else runs, so the macro call sites are
the only thing left. Because of that, a script can be developed, run and tested
unobfuscated with exactly the same source that is later obfuscated - The sample was checked in plain and obfuscated form for seed 7.
