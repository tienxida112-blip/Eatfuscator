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
