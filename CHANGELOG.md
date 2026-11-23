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
