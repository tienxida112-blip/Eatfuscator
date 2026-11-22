"use strict";

/**
 * Behavioural verification: obfuscate a program, run the original and the
 * artifact on the real Luau CLI, and require identical output.
 *
 * This is the gate that matters. `npm test` checks shape and anti-tamper
 * properties; this checks the only thing a user actually cares about — that the
 * obfuscated program still does what the original did.
 *
 *   node tools/verify.js                     # built-in corpus, seeds 5 and 13
 *   node tools/verify.js --seeds=5,7,99      # more seeds
 *   node tools/verify.js --files=Test/aes128.lua,/tmp/x.lua
 *   node tools/verify.js --verbose
 *
 * Environment: LUAU_BIN (directory holding the luau binaries) or vendor/luau/bin.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { obfuscate } = require(path.join(ROOT, "src/Core/obfuscate"));
const { createRNG } = require(path.join(ROOT, "src/Core/rng"));
const macros = require(path.join(ROOT, "src/Steps/Macro"));
const luau = require(path.join(ROOT, "src/Toolchain/luaucli"));

const BUILTIN = [
  { name: "print", source: 'print("hello")' },
  {
    name: "literals",
    source: [
      'local t = {1, 2, 3, name = "eat", nested = {a = true}}',
      'local out, i = {}, 0',
      'for k, v in pairs(t) do i = i + 1 out[i] = tostring(k) .. "=" .. tostring(v) end',
      'table.sort(out)',
      "print(#out, table.concat(out, \",\"))",
      "print(string.format(\"%.3f\", 2 / 3), math.floor(-0.5), #\"hello\", select(\"#\", 1, nil, 3))",
    ].join("\n"),
  },
  {
    name: "control-flow",
    source: [
      "local total = 0",
      "for i = 1, 200 do",
      "  if i % 3 == 0 then total = total + i",
      "  elseif i % 5 == 0 then total = total - 1",
      "  else total = total + 2 end",
      "end",
      "local j = 0",
      "while j < 50 do j = j + 1 end",
      "local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end",
      'print(total, j, fib(15), pcall(error, "boom"))',
    ].join("\n"),
  },
  {
    name: "closures",
    source: [
      "local function counter()",
      "  local n = 0",
      "  return function() n = n + 1 return n end",
      "end",
      "local a, b = counter(), counter()",
      "a() a() b()",
      "print(a(), b())",
      'local s = "" for i = 1, 5 do s = s .. i end print(s, ("%q"):format("x"))',
    ].join("\n"),
  },
  {
    name: "strings",
    source: [
      'local raw = "a\\tb\\65\\x43\\z   d"',
      'print(#raw, raw:sub(1, 4), raw:byte(1, 3))',
      'print(raw:gsub("a", "z"), ("abc"):rep(3), ("x,y,z"):find(",y,"))',
    ].join("\n"),
  },
  {
    name: "macros",
    macros: true,
    source: [
      "if not EAT_OBFUSCATED then",
      "  function EAT_STRING(s) return s end",
      "  function EAT_NUMBER(n) return n end",
      "  function EAT_FUNCTION(f) return f end",
      "  function EAT_ASSUME(v, e) return e end",
      "  function EAT_OPAQUE(c) return c end",
      "  function EAT_SECRET(s, e, x) return s end",
      "end",
      'local s = EAT_STRING("hello macro")',
      "local n = EAT_NUMBER(42)",
      "local f = EAT_FUNCTION(function(a, b) return a + b end)",
      "local slot = EAT_ASSUME(7, 7)",
      "local yes = EAT_OPAQUE(true) and EAT_OPAQUE(false) == false",
      'local secret = EAT_SECRET("bound", slot, 7)',
      "print(s, n, f(2, 3), slot, yes, secret)",
    ].join("\n"),
  },
];

const DEFAULT_FILES = [
  "Test/smoke_test.lua",
  "Test/graphs.lua",
  "Test/life.lua",
];

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function parseArgs(argv) {
  const opts = { seeds: [5, 13], files: null, verbose: false, keep: false, quick: false, noTrip: false };
  for (const a of argv) {
    if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--quick") opts.quick = true;
    else if (a === "--no-trip") opts.noTrip = true;
    else if (a.startsWith("--seeds=")) opts.seeds = a.slice(8).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else if (a.startsWith("--files=")) opts.files = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!opts.seeds.length) opts.seeds = [5];
  return opts;
}

/** Drop timings, absolute paths and stack frames: everything else must match. */
function normalize(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => !/work time|script time|^stacktrace:/.test(line))
    .filter((line) => !/^[^\s]*\.lua:\d+/.test(line))
    .map((line) => line.replace(/^[^\s:]*\.lua:\d+: /, "LINE: "))
    // table/function addresses differ between runs by construction
    .map((line) => line.replace(/0x[0-9a-f]{5,}/g, "0xADDR"))
    .join("\n")
    .trim();
}

function compare(name, reference, artifact, seed, opts) {
  const ref = luau.run(reference, { timeout: 60000 });
  if (ref.skipped) return { name, seed, skipped: true };
  // Artifacts run inside the Roblox host shim: the default target refuses to
  // start anywhere else.
  const art = luau.run(artifact, { timeout: opts.quick ? 120000 : 300000 });
  const want = normalize(ref.stdout);
  const got = normalize(art.stdout);
  const ok = !art.timedOut && want === got;
  // ...and it must refuse to run without one. A bare interpreter gets a parked
  // thread and no output; anything else means the host gate regressed.
  let offPlatform = null;
  if (!opts.noTrip) {
    const bare = luau.run(artifact, { timeout: 4000, host: "bare" });
    offPlatform = { stopped: !!(bare.timedOut || bare.status !== 0), printed: normalize(bare.stdout) };
  }
  return { name, seed, ok, want, got, status: art.status, timedOut: !!art.timedOut, stderr: art.stderr, offPlatform };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bin = luau.describe();
  if (!bin.available) {
    console.error("no Luau toolchain found: set LUAU_BIN or install into vendor/luau/bin");
    process.exit(2);
  }

  const cases = [];
  for (const c of BUILTIN) cases.push(c);
  const files = opts.files || DEFAULT_FILES;
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(ROOT, f);
    if (!fs.existsSync(abs)) {
      console.error(`missing fixture: ${abs}`);
      process.exit(2);
    }
    cases.push({ name: path.basename(abs, ".lua"), source: fs.readFileSync(abs, "utf8") });
  }

  let total = 0;
  let bad = 0;
  const started = Date.now();
  for (const seed of opts.seeds) {
    for (const c of cases) {
      let artifact;
      try {
        artifact = obfuscate(c.source, { seed, bloat: 0 });
      } catch (e) {
        bad++;
        console.log(`${RED}x${RESET} ${c.name} @${seed} build failed: ${e.message}`);
        continue;
      }
      // Macro sites are expanded by the pipeline, so the reference program is
      // the same expansion (replayed with the same seed) rather than raw source.
      const reference = c.macros
        ? macros.expand(c.source, { rng: createRNG((seed ^ 0x5bf03635) >>> 0) }).code
        : c.source;
      const out = compare(c.name, reference, artifact, seed, opts);
      total++;
      if (out.skipped) {
        console.log(`${DIM}-${RESET} ${c.name} @${seed} skipped (no luau)`);
        continue;
      }
      const tripBad = out.offPlatform && (!out.offPlatform.stopped || out.offPlatform.printed);
      if (out.ok && tripBad) {
        bad++;
        console.log(`${RED}x${RESET} ${c.name} @${seed} ran outside a Roblox host ${DIM}(gate regressed)${RESET}`);
        continue;
      }
      if (out.ok) {
        console.log(`${GREEN}+${RESET} ${c.name} @${seed} ${DIM}${artifact.length}B · off-platform: stopped${RESET}`);
        if (opts.keep) fs.writeFileSync(path.join(require("os").tmpdir(), `verify-${c.name}-${seed}.lua`), artifact);
      } else {
        bad++;
        console.log(`${RED}x${RESET} ${c.name} @${seed} ${out.timedOut ? "timed out (trap fired?)" : "output mismatch"}`);
        if (opts.verbose) {
          console.log(`   expected: ${JSON.stringify(out.want).slice(0, 400)}`);
          console.log(`   actual:   ${JSON.stringify(out.got).slice(0, 400)}`);
          if (out.stderr) console.log(`   stderr:   ${String(out.stderr).split("\n")[0]}`);
        }
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (bad) {
    console.log(`\n${RED}${bad} of ${total} failed${RESET} ${DIM}(${secs}s)${RESET}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}${total} of ${total} matched${RESET} ${DIM}(${secs}s)${RESET}`);
}

if (require.main === module) main();

module.exports = { normalize, BUILTIN };
