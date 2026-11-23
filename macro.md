# Macros

Use the shim block in the [README](README.md) to run source before obfuscation. The build removes that block. Names beginning with `EAT_` are reserved; unknown macros and local macro declarations are errors.

- `EAT_STRING("text")`: splits long string literals into chunks. VM string constants are separately encoded in the image.
- `EAT_NUMBER(1200)`: converts the number to round-tripping text, stored as a string constant and protected by the same VM cipher as `EAT_STRING`. It converts back to a number at runtime. With the VM disabled, the lowered text is not encrypted. The key and decoder ship with the output, so this is obfuscation, not secret storage.
- `EAT_FUNCTION(function(...) ... end)`: accepts and returns a function literal.
- `EAT_ASSUME(value, expected)`: evaluates `value`, then uses the numeric literal `expected`; incorrect assumptions change behavior.
- `EAT_OPAQUE(true)` or `EAT_OPAQUE(false)`: produces a build-dependent predicate.
- `EAT_SECRET("text", expression, expected)`: binds decoding to a runtime value. Arithmetic is modulo 256 and collisions occur; don't use it for passwords or keys.
- `EAT_RAGEBAIT()`: prints a taunt and parks the thread. Not a security feature.

The source in `Test/macros.lua` is runnable before and after obfuscation. `EAT_NO_VIRTUALIZE=1` skips the VM and provides less protection.
