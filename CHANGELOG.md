## 0.48.0

Fail closed on unknown VM opcodes instead of spinning, even if the optional trap
is neutralized. Missing one optional builtin no longer disables the other builtin
checks. Missing APIs, coordinated patches and transparent hooks can still evade
checks; client-side protection does not prevent runtime observation.

## 0.47.0

Add an affine-partitioned dispatch family with shuffled partitions and per-group
search trees. Fix sparse bucket routing and prevent mismatched inverted leaves
from executing handlers. Dispatch diversity changes structure, not the basic VM
semantics; runtime tracing and constant observation remain possible.

## 0.46.0

Check native builtin identities, raw length, byte swap, numeric edge cases,
iteration callbacks and coroutine call frames at startup. Also check two Ray
distances, RunService state and detached Instance lifecycle where available.
These are runtime probes, not proof of an untampered host: missing optional APIs,
coordinated patches and transparent instrumentation can bypass them.

## 0.45.0

Add startup cross-checks for seeded Random, vector and dimension constructors,
MouseBehavior lookup and Ray distance. They detect certain inconsistent emulators,
not transparent wrappers. Missing APIs and exceptions are tolerated for host
compatibility, and coordinated edits can bypass the checks.

## 0.44.0

Cache the resident instruction schedule per prototype instead of rebuilding it
on every function call. Instruction decoding and integrity checks still run;
this helps call-heavy code more than tight loops. The cached schedule is client
state and can be modified by an observer controlling the runtime.

## 0.43.0

Flattened loader blocks now verify the expected path prefix before running each
block, with a fail-closed path even when the optional trap returns. VM resident
word tags now mix a per-position schedule value instead of being a simple sum.
Both checks can be bypassed by coordinated edits; they are not authentication
against someone who controls the client. Client tracing remains possible.

## 0.42.0

Reduced the flattened loader's hoist budget from 185 to 165 and retained retries
with smaller block counts. This leaves more register headroom for compilers that
allocate differently from the vendored Luau compiler. The reported 0.41.0 loader
failed to compile in the reporting executor with the 200-register limit; a new
seed-5 artifact compiled and ran there. Twenty seeds built locally. Different
executor/compiler versions and all possible seeds have not been tested.

This fixes the reported execution failure, not the Nebfuscator logging bypass.

## 0.41.0

The VM snapshots selected core environment functions and checks for changes at
entry, global reads and periodic guards. This catches a narrow post-initialization
replacement, but does not detect hooks already installed when the snapshot is
made, transparent proxies, or coordinated changes to both the hook and snapshot.
It can also reject a legitimate change to those functions while the VM runs.

The reported Nebfuscator output includes both host-probe activity and the actual
print call. No Nebfuscator binary or matching source was supplied for a repeatable
reproduction; no claim is made that this change blocks it. The host matrix's
transparent-logger control still runs, as intended for that compatibility profile.

In local tests, eight post-snapshot hook mutations were stopped; all eight
coordinated snapshot changes bypassed the check. The full suite passed 1,233
checks, and the host matrix passed 28/28.
A 20-mutation tamper run scored 18/19 caught, with one inert hex edit and no
silently changed output.

## 0.40.0

The VM re-encodes decoded instruction fields and checks them against the fetched
word before dispatch. A private fake-environment metatable canary checks its own
lookup path without altering payload globals. Both checks are patchable, and the
canary does not prove the absence of a logger. In eight seeds, isolated opcode,
operand and fake-environment substitutions were stopped; a coordinated edit to
both the decoded field and comparison value bypassed the dispatch check.

A freshly generated Hello World artifact ran in the reporting executor. The full
suite passed 1,233 checks; the local host matrix passed 28/28 profiles, and
19/19 scored tamper mutations were caught,
with zero inert and zero silently changed. These tests do not establish resistance
to the linked loggers or measure deobfuscation time. The dispatch check adds
work to each instruction.

## 0.39.0

Instruction operands are now masked per prototype and position, with each mask
bound to a preceding field. The resident instruction digest covers the masked
representation, and operands are recovered immediately before dispatch. This
complicates static interpretation of the cached instruction stream; it does not
prevent tracing, inspection, or patching while the code runs. No deobfuscation
resistance time has been measured for this change. The old opcode-only decoder
recovered 0 of 5,760 tested full words; a decoder updated for the new masks can
recover them. A freshly generated Hello World artifact ran in the reporting
executor. The full local suite passed 1,233 checks, the simulated host matrix
passed 28/28 profiles, and 19/19 scored tamper cases were caught (zero inert or
silently changed).

## 0.38.1

Fixed the host gate treating Roblox `Enum` and `Enum.PartType` as tables.
The gate now accepts Roblox's `Enums` and `Enum` types, while retaining support
for the existing table-based test hosts. A diagnostic copy of the originally
reported artifact ran successfully in the reporting executor with this correction.
The fix is in the generator; regenerate old artifacts to pick it up.

## 0.38.0

The VM checks each sealed resident instruction against a position- and
prototype-bound tag before dispatch. A guard failure now stops before the current
instruction executes, and leaves the VM in a failed state even if a payload
catches the error. Previously an already-decoded instruction could run after a
periodic guard failed.

The load-time instruction digest now uses 32 bits instead of 24. The earlier
calculation ignored changes confined to the high byte of an instruction word.
The new calculation detected 24,576 tested single-bit edits, with JS/Luau parity
on 24 streams. It is still a checksum, not cryptographic authentication.

The resident-guard tests cover ten seeds and include a coordinated modification
of both a word and its tag: that bypass succeeds, showing the limit of a check
shipped alongside the code. Six nested-frame tests and positive controls cover
caught failures. Client-side code can still be observed or patched; these changes
add runtime overhead.

Locally, 1,233 structural checks, 45/45 padded behavior cases across five seeds,
and 28/28 host profiles passed. A 40-run tamper exercise caught 32/32 scored
edits, with none inert or silently changed. The simulated rich client returned
in 770 ms. Real Roblox and Termux were not tested.

## 0.37.0

The host checks deliberately exercise protected errors. A logging environment can
record failures such as a numeric error marker, a non-function call, an assertion,
and a read-only property assignment even when the payload succeeds. Six simulated
logger runs reproduced those messages and still executed the payload. This does
not establish what happened in every actual environment.

The read-only property check now uses a disposable unparented Part rather than
attempting to write `game.ClassName`. The VM forge now checks its headers, token
budget, stack state and operands before executing a malformed stream. This limits
bad streams; it does not prevent a modified runtime from being patched or traced.

Locally, 1,233 structural checks, 45/45 padded behavior cases across five seeds,
28/28 host profiles and 60 malformed-forge cases passed. The 40-run tamper
exercise caught 32/32 edits, with none inert or silently changed. A simulated
rich client ran in 1,056 ms. Real Roblox and Termux were not tested.

## 0.36.0

Renamed the number macro to `EAT_NUMBER`; the old `EAT_NUM` spelling is no
longer accepted. Numbers are converted to round-tripping text and stored through
the same VM string-constant cipher used by `EAT_STRING`, then parsed at runtime.
Without the VM, that text is not encrypted. Neither decoder is secret storage.

Resident VM instructions are now interleaved over four key-dependent shards;
the fetch and integrity paths resolve the original logical instruction position.
Some forge recipes also perform reversible detours. Both can be simplified or
traced by someone controlling the runtime; padding is still just padding.

Tests: 1,233 structural checks passed; 18/18 padded behavior cases across two
seeds, 28/28 host profiles, and 7,998 shard cases passed. A 40-run tamper
exercise caught 31/32 edits; one digit edit was inert and none silently changed
output. Ten samples from different randomly selected inputs all matched their
original output; their artifacts were 102,783–105,580 bytes and each extracted
loader exceeded 1 MiB. The SHA workload needed a longer test timeout, so expect
substantial runtime cost. Real Roblox and Termux were not tested.

## 0.35.0

`EAT_NUM` (also available as `EAT_NUMBER`) encodes the round-tripping decimal representation into keyed bytes and reconstructs it at runtime. The decoder and key ship with the script; this is not secure secret storage. Added a runnable macro example to the README and a root `macro.md` reference.

Flattened the test corpus, cleaned up the project, and retained host and tamper regression tests with their fixtures under `tools`. Added randomized samples from distinct test inputs.

## 0.34.0

VM code uses shuffled variable-length blocks and a per-build randomized image forge. The outer compression layer can still be extracted. Runtime observation and patching remain possible.
