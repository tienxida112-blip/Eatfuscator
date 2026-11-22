## 0.34.0

Shuffled VM blocks now have variable lengths, with branch targets relocated even
when they land inside a block. The image forge uses seeded opcode mappings and
variable reversible recipes per word. These add work for static inspection, but
an observer can still trace or patch the shipped runtime. The outer compression
layer remains extractable.

Fixed seed plumbing for forge randomization and made the suite choose safe Lua
long-string delimiters when embedding generated artifacts. The forge test
round-tripped 26,200 words across 100 seeded layouts. Locally, 1,252 structural
checks passed; 45/45 padded behavior cases and 28/28 host profiles passed; the
40-run tamper exercise caught 32/32 edits with no inert or silently changed cases.
The modeled neutralized-handler regression passed on nine seeds.

The seed-7 life artifact measured 104,492 bytes and its extracted loader 1,095,316
bytes. The local benchmark median was 162.3x slower including loading; individual
workloads varied. Real Roblox and Termux were not tested.

## 0.33.0

The compression layer is still just packaging. Added `tools/extract_stage.js`
to extract the loader without running it; this doesn't recover the original
source or decode the VM. Ten padded builds were checked against their exact
uncompressed loaders.

Inside the VM, opcode masks now vary by prototype and instruction position.
The loader verifies and caches the masked words; the dispatcher unmasks the
opcode at the point of execution. This makes a single opcode lookup table less
useful for inspecting a decoded image, but the mask and decoder are still in
the client and can be traced. The digest-failure return instruction uses the
same position-dependent encoding.

Tests covered 5,760 words across 24 instruction layouts, three keys and two
prototypes. Locally, 1,252 structural checks passed without padding; 45/45
padded behavioral tests matched across five seeds; 28/28 host profiles passed;
and the 40-run tamper exercise caught 32/32 edits, with no inert or silently
changed cases. The modeled neutralized-handler test passed across nine seeds.

The seed-7 life output was 104,516 bytes; its extracted loader was 1,095,301
bytes. A local benchmark measured a 277.4x median slowdown including loading.
Neither real Roblox nor Termux hardware was tested.

## 0.32.0

A sandbox report showed the payload running after the fatal handler was
neutralized. The host gate's verdict now feeds the VM instruction-decoding
schedule, so a failed verdict produces a different key even if the handler
returns. The API atlas also contributes its failure verdict to that schedule.
This does not make a client-side runtime trustworthy: the verdict, decoder or
payload can still be patched or observed, and the compressed loader can still
be extracted.

Fixed the VM's failed-digest return sentinel: it used to assume the opcode was
in the low byte, which could make a rejected program loop or error depending on
the selected instruction layout. It is now encoded using the actual layout.

The trap-bypass regression replaces the handler with a no-op, tests a fake host
and a forced bad verdict, and checks a positive control without the new key
binding. Nine seeds passed; this models the report, not a replay of its exact
patch or sandbox.

Local results: 1,252 structural checks passed without padding, 45/45 padded
behavior tests matched across five seeds, and 28/28 host profiles passed. The
40-run tamper exercise caught 32/32 tested edits, with no inert or silently
changed cases. The simulated wide client returned in 1,253 ms.

A local benchmark measured a 305.1x median slowdown including loading; test
performance on your own workload. The seed-7 life sample was 105,348 bytes,
with a 1,095,368-byte uncompressed loader. No real Roblox or Termux device was
tested in this run.

## 0.31.1

- Compile retries keep the same seed and try smaller flattened layouts when a
  loader hits Luau's local-register limit. They no longer silently drop the
  flattening pass. If no layout compiles, the build reports the error.
- The CLI prints the actual random seed, so a failed build can be reproduced.
- Tool discovery skips binaries that exist but cannot run, which helps when a
  bundled binary is for a different CPU or sits on a no-exec mount. The CLI
  warns when no usable compiler is available for checking the loader.
- A regression test covers seed reuse, the retry path, error propagation and
  whether the retried loader remains flattened.

Locally, 120 seeds compiled and ran the small regression sample with padding
turned off. The structural suite passed 1,252 checks, padded behavior tests
matched 45/45 across five seeds, and host tests passed 28/28. The tamper run
caught 31/32 edits; one edit was inert and none changed output silently. These
were run on x86-64 Linux, not Termux.

## 0.31.0

The decoded entry point was easy to follow in a deobfuscation report: its real
instructions sat together, and the unused child prototypes could be ignored.
The VM compiler now splits instructions into shuffled blocks connected by jumps,
relocating conditional skips and loop targets along with them. This changes the
actual execution path, not just the unreachable decoys. It does not make that
path impossible to reconstruct: a tracer or control-flow simplifier can follow
those jumps. Prototypes too large for the signed jump range keep their original
layout rather than being broken or truncated.

Also fixed the noise pass's last-opcode check to use the selected word layout,
instead of assuming that the opcode always occupies the low byte. Added a flow
relocation test covering forward and backward branches, field layouts, seeds,
and the size limit.

Local checks: 1,252 structural checks passed (without padding); 45/45 padded
behavioral checks matched across five seeds; 28/28 simulated host profiles passed.
The tamper run caught 31/32 edits, with one inert edit and no silent changes.
The wide simulated client returned in 853 ms. These aren't Roblox device tests.

This adds execution work. On one local benchmark the median slowdown was 301.7x
including loading; the tested workloads ranged from 60x to 1,157.1x. Test your
own script before using the output, especially if it has hot loops.

## 0.30.0

- The VM now reseals cached instructions with a per-prototype schedule and opens
  one word at a time during execution. This raises the effort for a simple cached
  table dump; it does not stop a runtime observer from capturing instructions.
- The flattened loader tracks the state path instead of only counting visited
  blocks. The final check catches a wrong digest, including some reorderings that
  preserve the number of blocks. Like any in-process check, it can be patched.
- Fixed an environment-probe helper whose literal local names could shadow a
  generated function name. This caused valid programs to fail on some seeds.
- The compile guard now reports a loader that still fails compilation after all
  retries instead of returning it as if it were usable.
- Added a pipeline diagram to the README.

The per-instruction decoding has a substantial runtime cost. In one local Luau
benchmark run the median slowdown was 169.8x, including load time; individual
workloads ranged from 72.3x to 595.9x. These numbers vary by host and workload.

Checks: 1,252 structural tests passed with padding disabled; 45/45 padded
behavioral checks matched across five seeds, and 28/28 host profiles passed.
The 40-run tamper exercise reported 32/32 caught, with no inert or silently
changed cases. The wide simulated client test returned in 826 ms.

## 0.29.0

### Output sizing and validation

A generated, uncalled decoy closure is compressed with the loader. This adds
bulk, not a guarantee of protection: automated analysis can identify inert code.
For Test/life.lua at seed 7, the output measured 103,440 bytes and its matching
uncompressed loader source measured 1,095,338 bytes. Larger inputs may exceed
the approximate 100 KiB target. Loading and compilation add significant cost.

The tuner now searches the compressibility mix while maintaining the expanded
size floor, and does not fail merely because an unusually large input exceeds
the target. Each build tunes independently to keep builds deterministic.

Validation: structural suite 1252 checks, zero failed (padding disabled for that
suite); padded behavioural verification 18/18, host profiles 28/28. Tamper
exercise: 31/32 caught, one inert edit and zero silently changed. Benchmark median
slowdown 64.6x with load time included; wide host client test returned in 804 ms.
These are local test results, not security guarantees or real Roblox measurements.
A bare Luau environment produced no stdout but did report an error on stderr.

### Macros, after Luraph's shape

`src/Steps/Macro` grew three macros and a reserved prefix, following the model in
Luraph's macro documentation: global functions with a reserved prefix, no-op shims
inside `if not EAT_OBFUSCATED then ... end` that the build deletes, and an unknown
macro is a build error rather than a call that survives.

- `EAT_ASSUME(value, expected)` - the source states a numeric fact; the build
  specialises on it.
- `EAT_OPAQUE(cond)` - a predicate built from per-build numbers.
- `EAT_SECRET(text, expression, expected)` - a string constant whose decoding key
  is derived from a runtime expression, with modulo-256 arithmetic. Collisions occur; this does not securely protect secrets.
- `EAT_OBFUSCATED` is the shim flag; `local EAT_*` and unknown `EAT_*` are errors
  with line numbers.
- Reference: `docs/macros.md`. Runnable sample: `Test/macros.lua`, which produces
  identical output unobfuscated and obfuscated in a seed-7 check.
- No preset, no toggle, nothing that duplicates an existing feature: a macro only
  passes information the source has and the obfuscator cannot infer.

### Bugs fixed

Three, all found while building the above:

- `EAT_OPAQUE(false)` returned **true**: the expansion was written `cond and X or Y`,
  and in Lua `true and false or true` is `true`. Replaced with an equality against
  the wanted literal.
- Corrected `EAT_SECRET` key arithmetic for the expected runtime value. The
  encoding is reversible, and modulo-256 collisions mean it is not secret storage.
- The bulk generator could emit `local do = {...}` (keyword as an identifier),
  which made the payload unparseable. Names are now filtered.

### Also

- `EAT_NO_VIRTUALIZE` is the name of the switch that skips the VM and emits the
  flat envelope. The old `EATFUSCATOR_SIMPLE` / `FULLVM` pair still works.
- A VM build failure now fails the build. It used to fall back to the flat
  envelope silently, which meant a broken VM shipped as "obfuscated" output.

# Changelog

## 0.28.0 — the interpreter checks its own program, not eight words of it

The inner layer is the part that has to notice a patch made *after* the file was
loaded, and it was thin: the loader verified a sealed digest over each program
once, at load, and then the interpreter re-checked **eight sampled words**,
forever, at the same eight positions. Everything else in the program could be
rewritten in memory and nothing would notice.

**The guard covers the whole program now.** Each program is split into twelve
slices and each slice's rolling checksum is recorded when the program is unsealed.
The interpreter checks one slice per tick, and *which* slice comes from the
program counter - so the window moves on every tick and the same tick that reads
an instruction also moves the window past it. A patcher cannot pin the guard to a
slice they left alone, and cannot see the whole of what is checked from any single
tick. Twelve ticks of real execution cover the program end to end.

**The length is pinned.** Appending words to jump somewhere the program never went,
or cutting off a tail that a patched branch would run, is a mismatch on the first
tick that follows.

**The constant table and the string decoder are checked too.** The interpreter
keeps the identity of the constant table it was handed, so swapping the table for
one of a different shape is visible even with the code untouched, and it decodes a
fixed synthetic string through the real string cipher every fourth tick: that is
the check a reader who patches the string path to dump payload strings runs into.
The probe allocates a schedule, so it is throttled; the code slices are not.

**A failed guard ends the frame instead of deserting it.** It used to hand back a
poisoned register table and keep going - a program that ran on garbage. Now the
constant table is dropped, the marks are dropped, the registers are poisoned and
the program counter is moved past the end, so the next instruction fetch dies. No
result, no state, nothing for a pcall-and-replay logger to keep.

**Proven, not asserted.** A new internal build option (`guardProbe`) breaks the
length pin *after* the digest and the slice marks have been computed - which is
exactly what a post-load patch looks like: the artifact still loads, the code is
still the code that was sealed, so only the interpreter's own guard can catch it.
The suite runs both builds: the honest one prints, the probed one produces nothing.
Two honest-host checks were the reason the first version of this guard was wrong -
the string probe was seeded with the program index at load and with a constant at
run time, and the constant count was taken before the lazy table was filled - and
both are pinned down in the suite by the `Test/life.lua` and `Test/graphs.lua`
builds running to the same checksum as the source.

**A failed VM build is an error now.** It used to fall back to the flat envelope -
obfuscated, but not the product, and a tenth of the size. Silently, too, so a
regression in the interpreter surfaced as a small artifact that still ran instead
of as a failure. That is how the first version of this guard shipped with a
mistyped slot index: the build threw, the fallback hid it, and the artifact
printed. The downgrade is opt-in (`fallback: true`) for callers that want it.

Gates for this cut: suite **1234/0** (197.6 s), hosts **28/28**, verify **18/18**
(33.9 s), tamper **32/32** (100%, 0 inert, 0 silent), client **51 ms**, bench
median **26.3x** (was 31.2x - the guard is not free), 12-seed sweep clean.
Sample: seed 7 over `Test/life.lua`, **38 740 B**, `life checksum: 669876783`.

## 0.27.0 — no string escapes, no name collisions, and a verdict that cannot be answered one clause at a time

Round 9's logger work had a tail: three classes of "weak spot" that were not
about loggers at all, and one of them was the reason a build could die on a seed
nobody had tried.

**Every string literal that can be a long bracket is one.** `[[...]]` (or `[=[`,
or higher, when the body contains the closer) has no escape processing, which
means the one place the emitter could silently disagree with the decoder is
gone: no `\NNN` running into the next digit, no `$` in a replacement pattern, no
hand-written escape to get wrong. The alphabet table is ninety-one long brackets,
the payload and tail blobs are long brackets, and so are the service and class
names the atlas compares against. A body with a CR or LF stays escaped, because
Lua folds any of CR, LF, CRLF and LFCR inside a long string to one LF and that
would change the bytes.

**Eighteen parameter names were going out in the clear.** The token rewriter
matched `__V<digits>__` and not `__V<digits><letter>__`, so the unpack routine's
own parameters were emitted as `__V0420a__`…`__V0420r__` - a readable record of
how the emitter names things, inside the one function that decodes the image. Both
rewriter passes match the letter form now, so a token the emitter never asked for
by name still leaves as an obfuscated identifier.

**The identifier factory could mint a name the templates already used.** The
unpack loop's locals were literal text (`i`, `oi`, `v`, `q`, `w`, `d`, `e`, `j`),
and the factory cannot see literal text. On seed 5 it minted `oi` for the char
function and the loop's counter of the same name shadowed it: `attempt to call a
number value`, at load, before the payload. Those locals are minted now, and the
factory reserves every identifier the runtime template spells - collected from the
file, not listed by hand, because a hand list is exactly what went stale. A
41-seed sweep over 0–24 and 300–315 is clean.

**The host gate no longer answers one clause at a time.** It used to write
nineteen independent booleans into a sink and trap if any of them was false, which
means each clause stood alone: a hook only had to satisfy the ones it cared about.
The verdict is now one value accumulated in order - per-build multiplier,
per-build weights, the index folded in - and the artifact compares it against a
constant that only comes out if every clause answers as a real client would, in
order. A substituted answer cannot be compensated by any other entry in the
vector, and reordering the clauses is also a failure.

**The inflate length table is checksummed.** The tail of the code-length order
table is never read by a stream that does not use those lengths, so an edit there
was inert: the artifact ran with an identical output and the tamper sweep scored a
miss. A weighted checksum now corrupts a live entry when the table is wrong, which
fails closed and does not depend on the trap being reachable. Three consecutive
tamper runs: 32/32, 0 inert, 0 silent.

Gates for this cut: suite **1232/0** (248.8 s), hosts **28/28**, verify **18/18**
(35.4 s), tamper **32/32** (100%, 0 inert, 0 silent), client **42 ms**, bench
median **30.9x**, seed sweep **41 seeds** (0-24, 300-315) with no failures.
Sample: `obfuscated.lua`, seed 7 over `Test/life.lua`, **38 439 B**, prints
`life checksum: 669876783` under the rich host. The release was re-verified from
a fresh unzip: the shipped sample runs and six seeds build and run from the
extracted tree.

## 0.26.0 — the two defects behind the seed lottery, and a trap that fails closed

Round 9 was supposed to be about environment loggers. Re-reading a real logger
dump made the build harder in a dozen small ways, and then the seed sweep found
something worse: two ways to ship an artifact that cannot run at all, both of
them seed-dependent, both of them invisible unless you drew the right (wrong)
seed. Those are fixed first, because "defeats the logger" is not worth much if
the file refuses an honest client one seed in fifteen.

**A `$` in the ciphertext used to eat a byte.** The emitter assembles the
artifact out of a template with `String.prototype.replace`, and a *string*
replacement is not literal text: `$$`, `$&`, `` $` `` and `$'` are patterns. Every
packed blob - the name bank, the const pool, the layer stack, the runners - can
contain those byte sequences, so a build whose ciphertext happened to contain
`$$` lost a byte in the emitted literal. The artifact then unpacked to
something one byte short and the payload simply produced nothing. It hit about
one seed in ten, which is exactly why it survived a suite that mostly ran seed 7.
Every replacement in the emitter is now a function (`() => payload`), and the
suite decodes the emitted bank and compares it byte for byte against the
emitter's own output.

**Luau allows 200 locals in one function.** The flattener is what turns the
loader's blocks into a dispatch over shuffled chunks, and it does that by
hoisting cross-block names into `local` declarations - up to 260 of them. On
some seeds the flattened loader crossed the 200-register line, `luau-compile`
refused to compile it, `loadstring` handed back `nil`, and the artifact trapped
at load with an *empty* error string: indistinguishable, from the outside, from
the anti-tamper path doing its job. This was the seed 303/315/334 class reported
in 0.25.0.

**The build now compiles the loader it is about to ship.** `luau-compile --null`
is run on the emitted loader (a full compile, so the register limit is checked -
`--only-parse` does not see it). If Luau refuses it, the build is retried with a
smaller hoist budget (150, 110, 70) instead of being written out. The vendored
compiler ships with the release; without it the guard degrades to a no-op rather
than failing the build. A 40-seed sweep of the range that used to fail (300-339)
is now clean, as is the mixed sweep across 5-202.

**The atlas reuses the chain's locals, and still owns its own.** Its twelve
locals were what pushed the loader over the register limit, so it now borrows
names the chain has already released. It keeps one local of its own, because the
interpreter folds that name into its code salt: a build with the atlas deleted
is missing a name the payload depends on and cannot decode. That property is
asserted (`dropAtlas`) rather than assumed.

**Filler slots are no longer inert.** The constant slots past the ones the
interpreter reads were never used, so an edit there produced an identical output
and the tamper sweep counted a miss. One relation over all of them (summed mod
2^24 against a stored total) makes every such edit visible. The sweep is back to
29/29 with 0 inert and 0 silent.

**The trap destroys key material before it raises.** The trap used to call
`error("", 0)` and stop there. A logger that pcalls the artifact catches that
error and keeps whatever the chunk left behind - including the constant bank,
which is the key material every decode step reads. The bank is now set to `nil`
before the raise (the error string is unchanged), so there is nothing left to
replay.

**Honest limits.** A statement logger that is also a *faithful* host - one that
forwards every call to a real environment - still sees the payload, because from
inside the chunk it is a real environment. What is defeated now is the other
class, the logger that answers questions itself and replays recorded answers:
the trace proxy, the recorded-gate replayer, the dumped-service host, the
fresh-singleton atlas. `tools/hosts.js` runs all of them as named profiles, and
the two genuine hosts still print the payload.

Gates for this cut: suite 1232/0 (195 s), hosts 28/28, verify 18/18, client 43 ms,
bench median 31.9x, seed sweeps 0 failures over 5-202 and 300-339.

Tamper is **28 of 29** in this cut, not the 29/29 the filler relation bought. The
one that gets through is a digit edit that lands inside the frozen length table
of the inflate routine - specifically in the tail entries that the current
compressed stream never reads, which is why the artifact runs with an identical
output. Which site it lands on depends on the artifact's byte layout, so the
count moves between 28 and 29 from cut to cut. It is a random-position tool, and
a table whose unused tail is by construction dead data is a site it can land on;
the same relation trick that closed the filler slots would close this one, and it
is queued for the next cut rather than claimed for this one.


## 0.25.0 — one knob, one loadstring, and a smaller file

Round 8 cut the product back to a single decision — the seed — and then made the
thing that comes out of it smaller, flatter and harder to read.

**Seed is the only setting.** `cli.js` used to take `minify`, `bloat`, `flatten`,
`blocks`, `trap`, `target`, `loadstring`, `hostprobe`, `verbose`, `watermark`.
Every one of them was a way to ask for a build *weaker* than the default, and a
build the tests had to be run against separately. They are gone: the parser
accepts `--setting seed:<number>` and exits 2 on anything else, printing what the
supported form is. Omit the seed and one is drawn and printed so the build can be
reproduced. Everything the old flags selected is now derived from the seed.

**`loadstring` exists for one thing.** The word does not appear in the artifact —
the bootstrap fetches it by name out of the encrypted name bank — and its single
use is `loadstring(inflated_source)`, the decompressed program. There is no
source-form loader in the default build and no second call site. The suite's
`loadstring: false` twin (the 0.23.0-shaped loader, kept because the differential
tests need a build that is not compressed) is an internal option now, unreachable
from the CLI.

**The compressed table is prefixed `EAT-`.** The payload literal starts with the
three characters `EAT-` followed by the ciphertext, so a scan for the product's
own artifacts is a substring match. Both the marker and an envelope-size ceiling
(artifact < 0.85 × the source-form twin) are asserted by the suite.

**5 symbols per 4 bytes.** The pack was 4/3 over a 64-symbol alphabet (exact:
64^4 = 2^24). It is now 5/4 over a 91-symbol alphabet (91^5 > 2^32, so every
32-bit word still has exactly one spelling), which is 6.7 % narrower on the same
bytes for a handful of extra multiplies at load. On the seed matrix (12 seeds,
`print("hi")`, no padding) artifacts run 29 377–31 471 B against 30 948–33 054 B
at 4/3.

**Padding is off.** `bloat` used to default to 512 KiB of filler banks: it made
the file look like a Luraph artifact and cost half a megabyte. Default 0. The
same Life demo that shipped as 475 903 B in 0.24.0 is **39 951 B** now.

**ZipString was measured and rejected.** The referenced project
(github.com/tienxida112-blip/ZipString) is LZ77 + Huffman-or-range-coder plus
ASCII85. On the loader text that this tool compresses it produced 24 072
characters where the existing deflate path produced 20 894 — 15 % *worse* — so
the codec was not adopted; re-measuring is not worth a second attempt. What was
adopted is the idea of the 5-into-4 printable framing over a per-build alphabet,
which is where the size win above comes from.

**Fixed:** the name-bank blob escaped `"`, `\` and non-printables but emitted a
raw space. The artifact is collapsed onto one line at the end of the build and
that pass squeezes whitespace runs, so a bank containing two spaces in a row lost
a byte, every interned name decoded to nil, and the load-time integrity chain
trapped. Found by a 40-seed sweep; it accounted for one of four seed-dependent
build failures.

**Known defect, carried into this release.** A seed sweep (300–339, plain loader,
fixed program) still fails on **303, 315 and 334** — about 7.5 % of seeds. In
those builds the name bank decodes only its first 18 of 152 words, so every
interned name is nil and the chain traps with `eat:nil`. What is known: the
literal in the file is byte-identical to the emitter's own buffer (checked
against `EAT_DUMP`), so the single-line collapse is not the cause; `flatten:
false` and `blocks: false` fail identically, so the flattener is not the cause;
no single keystream byte reconstructs the stream, so the encoded bytes and the
load-time decode disagree from about byte 126 on, inside `nameBankLua`. Seeds
5, 7, 13, 21, 22, 31, 41, 47, 61, 62, 101 and 202 build and pass, and the
delivered `obfuscated.lua` is seed 7. Until this is fixed, a build should be run
once before it is shipped; the suite takes 167 s and covers it.

**Numbers** (this tree): suite 1227 checks / 0 failed (166.6 s) · verify 18/18
(30.8 s) · hosts 26/26 · tamper 29/29 (100 %), 0 inert, 0 silently changed ·
client 43 ms · bench median 32.5× (fib 45.4×, sieve 32.5×, strings 31×,
tables 22.7×, life 112.4×).

## 0.24.0 — the loader is data, and loadstring is what turns it back into code

Every artifact so far shipped its loader as source: one line, obfuscated past
recognition, but *there*, in the file, in an order a reader can follow with a
disassembler and a lot of patience. That is the one structural difference that
made the "it's not Luraph" complaint stick, because a Luraph-class product does
not ship a loader. It ships something that *becomes* a loader.

0.24.0 does that. The whole program — interpreter, payload bank, name bank,
anti-tamper, the user's code — is deflated (RFC 1951, zlib level 9) and encrypted
with a per-build keystream, packed into printable symbols, and the file that is
left is a 20-line bootstrap:

```
the file      471 216 symbols of a 64-symbol alphabet (per build, shuffled)
              encrypted with  b[i] = (p[i] + i*k1 + k2) mod 256,  k1 odd
the bootstrap unpacks 3 bytes from 4 symbols, un-keystreams, inflates with a
              renamed copy of the runtime's own RFC 1951 decoder, and hands the
              result to loadstring
loadstring    returns the program; the bootstrap calls it with the chunk's own
              varargs and returns what it returns
```

What this buys, concretely:

- **The loader does not exist in the file.** `return({function(...)` — the way
  every artifact since 0.13.0 began — is no longer in the output. What is there
  is 4/3-expanded ciphertext. A reader who wants the loader has to find the
  alphabet, recover the keystream, inflate, and only then start the work that
  used to be step one.
- **The alphabet is per build and rebuilt at load.** The 64 symbols are shuffled
  from the printable set (minus `"`, `\`, `%` and all whitespace) and the
  lookup table is built by a 64-iteration loop at run time, so the mapping is not
  in the file either.
- **The inflate travels under a different name.** The RFC 1951 decoder is copied
  out of `Template/runtime.lua` between its `--<INFLATE>` fences and emitted into
  the bootstrap with every local renamed from the per-build name pool: the
  decoder in the artifact shares no identifier with the template it came from.
- **Errors are unchanged.** The chunk name handed to `loadstring` is empty on
  purpose: with no chunk name every message a program raises is prefixed with a
  fragment of the payload's own source — a leak, and a behaviour change inside
  `pcall`. `Test/cases/errors.lua` compares byte for byte.

Sizes, on the same program (seed 7, default bloat):

| | bytes | vs source |
|---|---|---|
| 0.23.0 (loader as source) | 535 755 | — |
| 0.24.0 (loader as data) | 475 903 | −11.2 % |

The payload itself deflates to 66.0 % (535 148 → 353 452 B in 21 ms); packing
that back into printable symbols costs 4/3, so the file lands at 88.8 % of what
it was. A 5-characters-per-4-bytes base-91 pack would recover most of the rest;
it is not in this release because the 4/3 pack is exact (64^4 = 2^24) and the
extra arithmetic is not worth a decoder bug in the one place a bug is fatal.

Costs, stated plainly:

- **Load time.** The artifact unpacks and inflates once, on entry. `tools/bench.js`
  measures median 30.5× (fib 37.4, sieve 30.5, strings 26, tables 21, life 112.1)
  against 28× in 0.23.0; the difference is the one-off inflate, not throughput.
- **`loadstring` is now required.** A Roblox host with `LoadStringEnabled` off
  cannot run the artifact, and there is no fallback: the loader is not in the
  file to fall back to. This is the same bargain Luraph-class loaders make, and
  it is the direct consequence of "compression must use loadstring". Builds made
  with `--setting loadstring:false` still produce the old source-form loader for
  hosts where that matters.

The suite had to learn the difference between the artifact and the loader. Shape
checks that describe the loader (the wrapper, the readable-name audit, the
anti-tamper shape) now run on a compressed-off twin of the same build, while the
shipped file is checked for the opposite: that the loader's shape is *not* in it,
that it is one code line, and that `getfenv` appears exactly twice — once for the
loader, once for the bootstrap — and nothing else readable does.

Gates: suite **1129 checks / 0 failed** (152.7 s), hosts **26/26**, verify
**18/18** (29.3 s), tamper **16/17 caught (94 %), 1 inert, 0 silent**, client
parity 44 ms, bench median **30.5×**.


## 0.23.0 — the instruction set is a build decision

The interpreter was the same program in every artifact. The seed changed what it
*read* — opcode numbers, cipher keys, dispatch shape — but not what it *was*, so a
reverse engineer learned the skeleton once and every later build was the same file
with different numbers in it. That is the gap behind "it's not Luraph": Luraph does
not ship a VM, it ships a VM *generator*.

This release moves the instruction encoding itself into the build. The instruction
word is four bytes; which byte holds the opcode, which holds A, which holds B and
which holds C is now chosen per build, from the seed, before a single word is
packed:

```
seed   7   layout {op: 65536,  a: 1,      b: 16777216, c: 256}
seed   9   layout {op: 256,    a: 1,      b: 65536,    c: 16777216}
seed  11   layout {op: 256,    a: 65536,  b: 1,        c: 16777216}
seed  13   layout {op: 65536,  a: 256,    b: 1,        c: 16777216}
```

The interpreter is generated from the same decision. `emitFields` writes the
decode, `emitFlip` writes the runtime opcode un-flip, and both are emitted into the
template at build time — so two artifacts do not share an instruction set, and a
word lifted out of one means nothing in the other even if you have already cracked
the Feistel chain, the position term and the per-proto opcode numbering.

What had to move with it, because everything downstream of the compiler reads the
word: `emit.js` (opcode/A extraction while patching jumps), `cipher.js` (the
per-proto opcode flip, which used to assume the opcode was the low byte), and
`pool.js` (the constant shuffle, which read all four fields at fixed offsets).

**It costs nothing at run time.** The first version of the generated decode peeled
each field with its own modulo and division, and the benchmark said so: median
32× → 52×, `life.lua` 190×. The bytes are peeled in order — one modulo, one
subtraction each, the shape the hand-written code had — and then *named* according
to where the build put them. Median is back to **28×**, the best this pipeline has
measured.

Two new suite checks hold the claim up: six builds must produce at least three
distinct layouts, and every field must round-trip through its own position.

Gates (0.23.0 tree):
- suite **982 checks, 0 failed** (141 s)
- host profiles **26/26**
- tamper **21/24 caught (88%), 3 inert, 0 silently changed**
- verify **18/18**; client parity on the wide host identical to the source
- bench median **28×** (fib 40×, sieve 33×, strings 21×, tables 27×, life 64×)
- deliverable `obfuscated.lua`: 535 755 B

**Still not Luraph, and where exactly.** Their handlers are regenerated per build —
different *code*, not different constants — and the image passes through more than
one machine. Ours still shares one interpreter skeleton across builds; what varies
is the ISA, the numbering, the dispatch shape, the cipher and the field order. The
next step is the handler generator: emit each opcode's body from a description with
per-build structure, so there is no stable skeleton left to learn. That is a real
project and I am not going to claim it in a changelog line.

## 0.22.0 — the name pool (no character-code strings anywhere)

The artifact had two signatures that a deobfuscator folds in one pass: decimal
escape literals (`"\98\121\116\101"`) and chains of character-code calls glued
with `..` (`UX(0x74)..UX(0xBF)..UX(0x70)..UX(0x65)`). Every name the loader asked
for was one or the other, so the first thing an analyst saw was a readable, foldable
perimeter — `type`, `pcall`, `string`, `table`, `Instance`, every service name.

**Both are gone.** Names now live in one pool: cipher symbols packed four to a
number, decoded by arithmetic, cached on first use.

```
local A={" ","[","&","y",...}            -- the alphabet (printable, permuted per build)
local P={13953775, ...}                   -- cipher symbols, four per number
local O={0,4,8,11,17,...}                 -- where each entry starts
...  e < k branches by byte index
r = r .. A[(e - (a*mult+add) % 93) % 93 + 1]
```

Four properties, each of them a thing the old code got wrong:

- **No escape sequences.** The alphabet is a table of one-character literals, so
  the artifact contains **zero** `\ddd` strings (was 6). This also stopped a real
  bug: Luau has no decimal escapes, so the parser was rewriting `"\99"` into
  `"\\99"` behind my back — the loader was indexing `("")` with a literal
  backslash and getting `nil`.
- **No string constructor.** Nothing needs `string.char`, so nothing needs `("")`
  and its metatable, and nothing can be folded into a literal.
- **No constant-foldable concatenation.** The artifact went from 6 foldable
  `char(0x..)..char(0x..)` chains to **0**; the `..` that remain (78, down from
  101) are all string building on *variables* — the decoder's accumulator, the
  alphabet builder, the interpreter's own concatenation. There is nothing left for
  a constant folder to eat.
- **No vocabulary.** A 220-word scan of the deliverable — services, classes,
  members, `Instance`, `GetService`, `FindFirstChild`, `IsA`, `GetChildren`,
  `Parent`, `Connect`, `Humanoid`, `table`, `math` — comes back with exactly one
  hit: `getfenv`. It has to be there; the loader cannot decode anything until a
  host hands it an environment.

**Where it lives.** The decoder is one statement and one local — an IIFE that
closes over its own tables and returns the lookup function — because the
control-flow flattener rewrites the loader's statements into a state machine and
had other ideas: in the first two attempts it swallowed the decoder's tables into
a single state, where their locals were out of scope for everything after it. The
declaration goes at the top of the preamble (so the flattener hoists it), the
assignment goes where the placeholder is, and the whole decoder is opaque to the
pass that made the mess.

Gates (0.22.0 tree):
- suite **980 checks, 0 failed** (148 s)
- host profiles **26/26**
- tamper **23/24 caught (96%), 1 inert, 0 silently changed**
- bench median **32×**; client parity on the wide host identical to the source
- deliverable `obfuscated.lua`: 537 367 B, prints `hi` on `roblog` and `robloxhost`

**Where this still falls short of a commercial VM, plainly.** The interpreter is
structurally the same from build to build: what the seed changes is the opcode
numbering, the dispatch shape, the cipher keys and the position offsets. Luraph and
its peers *generate* the handler set per build — different code, not different
constants — and stage the image through more than one machine. The layers we do
have (Feistel-CBC word chain with a position term, per-proto opcode renumbering,
shaped dispatch, stack-program forge with a digest quarantine, fused
register/stack loop) are real and tested, but a from-scratch reverse engineer gets
a stable skeleton to learn once. Closing that is the next round's work, not this
one's, and it is not something to claim until the suite proves it.

## 0.21.0 — static resistance + the API atlas

Round 3 answered "can the loader tell a host from a client?" and said nothing
about the far cheaper question an analyst asks first: *what does the file say?*
Read the artifact and the vocabulary was all there — service names, class names,
`Instance.new`, `GetService`, `PlayerAdded` — because every one of them was a
string literal in the attest block. Deleting that block was a find-and-delete
exercise, and a loader that names the API it audits has told the analyst which
part of the API to stub.

**The name bank.** Every name the loader resolves at run time now comes out of one
encrypted blob. `NAMEBANK[i]` is a byte string, decrypted with a key built from
the constant bank (`key = (codeSalt + ring.k2) mod 253`, keystream
`(k*(i+1)) mod 253`, delimiter `1`) and decoded through `("")["byte"/"char"/"sub"]`
— the same trick the rest of the loader uses, so the artifact spells no library,
no service, no class, and no member. Scan of the 533 729 B deliverable for a
220-word API vocabulary (`GetService`, `FindFirstChild`, `IsA`, `ClassName`,
`Instance`, `GetChildren`, `Players`, `RunService`, `ReplicatedStorage`,
`CollectionService`, `TweenService`, `UserInputService`, `Workspace`, `Parent`,
`Connect`, `Humanoid`, …): **zero**. The one identifier still spelled is
`getfenv`, because the loader has to be *handed* an environment before it can
decode anything at all; every name after that is assembled from character codes.

**The API atlas (v3).** The attest pass no longer audits only the Lua stdlib. It
now resolves a per-seed catalogue of services and asks each one to be *a service*,
six independent ways, all of which a real client answers and a table of handles
cannot:

| probe | what a client does | what a stub does |
| --- | --- | --- |
| `typeof(svc) == "Instance"` | true | usually false |
| `svc.ClassName == name` | true | often forgotten |
| `svc.Parent == game` | true | often nil |
| `svc:IsA(name)` | true | missing or lying |
| `game:FindFirstChild(name) == svc` | true | a second table |
| `game:GetService(name) == svc` | true, twice | a new table per call |

Then it checks the *shape* of the DataModel rather than a hard-coded list: every
child of `game` must be an Instance parented to `game`, and a host whose child
list is longer than the number of services it can actually resolve (by more than
the tolerance for services the catalogue does not name) is a table of handles with
a child list bolted on. Class names are audited the other way round: the 20
classes the loader probes must all exist, and `Instance.new("…")` must **reject a
class that is not one**. A real `Instance.new` raises; a host that answers every
class name with a table cannot be asked what a class is, so the artifact asks it
for something that is not a class.

**Scoring, and why it does not shoot honest hosts.** Each of the six consistency
probes is one vote; a member a service *lacks* is one miss; an invented class is
eight votes; a child list that disagrees with the service count is eight votes.
The verdict fires at four of either. A thin-but-honest host (`tools/roblog.lua`,
three services, no `PlayerAdded` on `Players`) scores **vote 0, miss 2** and runs;
the wide host (`tools/robloxhost.lua`, four services plus `Lighting`) scores
**0/0** and runs; a client with sixty-odd services scores 0 and runs. The three
new host profiles — `atlas-fresh-singleton`, `atlas-fat-child-list`,
`atlas-invented-class` — stop.

**Deleting the atlas breaks the payload.** The atlas contributes its own word to
the interpreter's code salt (`T_CODE_SALT = (al_code_salt + al_attest + al_atlas)
mod 2^24`), so a build with the whole block removed is missing a local the
interpreter folds in: `tools/tamper.js` gained a `noatlas` kind that builds
exactly that mutant, and it dies with a decode error instead of running.

**Honesty about the harness.** Two bugs the atlas found in my *own* shims, fixed
in the shims rather than papered over in the atlas: `roblog` and `robloxhost`
returned `nil` for `.Parent` on a service (the field was stored under a private
slot), and both `Instance.new`s accepted class names that do not exist. Both were
real infidelities — a host that answers every class name is not more permissive,
it is wrong — and both are now what a client does: services are parented to the
DataModel, and `Instance.new("__EAT_NOT_A_CLASS__")` raises.

Gates (0.21.0 tree):
- suite **980 checks, 0 failed** (145 s) — four new `atlas ·` checks: a consistent
  host runs, a deleted atlas does not decode, a non-singleton service stops the
  artifact, and no service/class name is spelled in the file
- host profiles **26/26**
- tamper **22/24 caught (92%), 2 inert (both `digit` edits into inert bytes), 0
  silently changed**
- bench median **30.6×**; client parity on the wide host identical to the source
- deliverable `obfuscated.lua`: 533 729 B, prints `hi` on `roblog`, `robloxhost`
  and the wide client host

## 0.20.0 — anti-tamper v1 + v2

The layer-3 digest (0.19.1) proves the *program* was not edited. It says nothing
about the *host* the loader is standing in, and a host that has been patched —
`pcall` replaced, `getfenv` wrapped, `debug.info` taken away, a global swapped
while the artifact runs — could still read the decoded payload. This release adds
two rounds of host attestation to the loader, both built per seed.

**v1 — the sanity pass.** Twenty-three checks over the semantics a patched host
breaks first: `type` dispatch, `pcall` handing back the identical value, `error`'s
identity, `xpcall`'s handler firing exactly once, `pcall` on a non-function,
`select("#", ...)` with holes, `next`, `string.byte`/`char`/`gsub`/`format`,
`table.concat`, `unpack` with a hole in the middle, coroutine suspend/resume with
values, `__index` versus `rawget`, `rawequal` as identity, number round trips,
arithmetic and `#`, `setmetatable` identity, `assert` through `pcall`, `typeof`
agreeing with `type`, and two provenance checks: `debug.info(pcall, "s")` and
`debug.info(getfenv, "s")` must both be `"[C]"`.

**v2 — chained, not listed.**
- Every check returns a tag of its own and the pass is a *tag match*, so a check
  that has been swapped with its neighbour — or replaced by a stub that answers
  `true` — fails on identity, not on truthiness.
- The run folds one rolling word, `h = (h*33 + pass*salt[i] + i*5) mod 2^24`, from
  a seeded start, with one seeded salt per check. The build folds the same word
  from its own list, so skipping, reordering or re-salting a check changes the
  verdict even when every remaining check passes.
- The verdict word is added into the interpreter's **code salt**. Deleting the
  whole block therefore does not remove the anti-tamper: layer 3 can no longer be
  decoded. `tools/tamper.js` grows a `noattest` mutant that proves it.
- Around thirty host references are captured by identity at load and compared
  again from inside `vm_guard` on every tick. A global swapped **while the
  artifact is running** — the executor case — ends the thread within one tick.

**Opaque, as required.** No check names, counts or diagnostics; every name is
assembled from character codes, and the suite pins the artifact's readable
vocabulary at zero for `pcall`, `debug`, `rawequal`, `"userdata"`, `"[C]"`,
`attest` and `tamper`, with `getfenv` at exactly one occurrence.

**Thin hosts degrade, they do not die.** A check whose facility is missing answers
`true`, so the Luau CLI harness and the portable target keep working; `debug.info`
is the deliberate exception (Luau always has it, so its absence is a finding).

Gates (0.20.0 tree):
- suite **976 checks, 0 failed** (150 s)
- host profiles **23/23** — four new ones: `pcall-wrapped`, `getfenv-wrapped`,
  `debug-info-removed`, `instance-new-replaced`
- tamper **20/22 caught (91%), 0 silently changed** — the two `noattest` mutants
  both die with a decode error, which is the point of the coupling
- bench median **32.2×** (fib 39.8×, sieve 32.2×, strings 22.2×, tables 19×,
  life 119.1×), sizes 60–70 KB
- client parity on the wide host: trace identical to the source, `acc 1325`
- deliverable `obfuscated.lua`: 542 908 B, two lines, output byte-identical to
  `Test/roblox_client.lua`

## 0.19.1

- layer-3 tamper hole closed: the stack stream now ends with a per-proto digest of
  the words it will produce, taken **after** decoding; a mismatch replaces the
  proto with a single `RETURN` before the first instruction runs
- `tools/tamper.js` gained a `forge` kind (mutant built with a flipped token, not a
  text edit); sweeps reached 18/20 (90%), zero silently changed
- `tools/robloxclient.js` derives its budget from a reference run instead of a
  fixed size formula
