#!/usr/bin/env node
/*
 * tools/robloxclient.js - run an artifact on a host shaped like a real Roblox
 * client, and fail if it does not come back.
 *
 * `tools/hosts.js` asks "did the payload print, and only where it should". This
 * asks the one question that mattered in 0.17.0: **does the artifact return?** A
 * guard that fires on a genuine client does not raise there, it parks, and Roblox
 * runs script code on the frame thread - so the client stops drawing instead of
 * reporting an error. That is what "i ran on roblox and fps stopped" was, and no
 * amount of caught-tamper reporting makes up for it.
 *
 * The quirks modelled here are the ones an engine actually has and a hand-built
 * shim usually does not:
 *
 *   - built-in metatables are locked, so getmetatable("x") is the string
 *     "This metatable is locked" rather than a table
 *   - _G is shared between scripts and may already hold whatever another script
 *     put there
 *   - the client debug table is info/traceback/profilebegin, and a debugger or
 *     profiler attaches a hook to it
 *
 *   node tools/robloxclient.js                          # default payload
 *   node tools/robloxclient.js --src Test/smoke_test.lua
 *   node tools/robloxclient.js --seed 91 --budget 2000
 *   node tools/robloxclient.js --probe                  # host-gate report
 *   node tools/robloxclient.js --compare                # also run the reference source
 *   node tools/robloxclient.js --rich --compare --src Test/roblox_client.lua
 *   node tools/robloxclient.js --rich --compare --src uploads/third_party.lua
 */
"use strict";

const fs = require("fs");
const path = require("path");
const luau = require("../src/Toolchain/luaucli");
const { obfuscate } = require("../src/Core/obfuscate");

const ROOT = path.join(__dirname, "..");
const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

// The client, written as the engine behaves rather than as a convenient fake.
const CLIENT_QUIRKS = [
  'local __eatgm=getmetatable getmetatable=function(v) local t=type(v) if t=="string" or t=="number" or t=="boolean" or t=="function" then return "This metatable is locked" end return __eatgm(v) end',
  "local _G={string=string,table=table,math=math,typeof=function() return nil end,tolerance=0}",
  "local debug=setmetatable({info=debug.info,traceback=debug.traceback,profilebegin=function() end,profileend=function() end,gethook=function() return function() end end},{__index=debug})",
];

const DEFAULTS = {
  seed: 5,
  budget: null,  // null = derive from artifact size; --budget overrides
  src: null,
  source: 'print("EATFUSCATOR_CLIENT", 6 * 7)\n',
  target: "luau",
};

function run(artifact, budget, rich) {
  const host = rich ? luau.richHost() : `${luau.robloxShim()}\n${CLIENT_QUIRKS.join("\n")}`;
  const body = `${host}\n${artifact}\n`;
  const t0 = Date.now();
  const res = luau.runFile(body, { timeout: budget });
  return { res, ms: Date.now() - t0 };
}

function main() {
  if (!luau.available("luau")) {
    console.error("no Luau toolchain found: set LUAU_BIN or install into vendor/luau/bin");
    process.exit(2);
  }
  const opts = { ...DEFAULTS };
  const seed = argOf("seed", null);
  if (seed) opts.seed = Number(seed);
  const budget = argOf("budget", null);
  if (budget) opts.budget = Number(budget);
  const src = argOf("src", null);
  if (src && src !== true) opts.src = path.resolve(ROOT, String(src));
  const probe = process.argv.includes("--probe");
  const compare = process.argv.includes("--compare");
  // --rich swaps the thin, strict host for tools/robloxhost.lua: services,
  // instances, signals,datatypes - enough that a third-party script runs to
  // completion, which is what a parity check needs.
  const rich = process.argv.includes("--rich");

  const source = opts.src ? fs.readFileSync(opts.src, "utf8") : opts.source;
  const artifact = obfuscate(source, {
    seed: opts.seed,
    bloat: 0,
    target: opts.target,
    hostProbe: probe,
  });

  // A fixed 4 s budget made a big-but-healthy artifact look like a parked thread
  // (a 650 KB build needs ~4.5 s just to reach its first error). The budget now
  // scales with size, so "never came back" means the run really did not end.
  // Budget: the larger of "big file needs time to load" and "the original itself
  // is slow here". A fixed number made a healthy 650 KB artifact look like a
  // parked thread twice; the second time was on a loaded machine, so size alone
  // is not enough either - the reference run is the honest yardstick.
  const sizeBudget = Math.ceil(artifact.length / 100) + 1000;
  let autoBudget = opts.budget ?? Math.max(4000, sizeBudget);
  if (opts.budget == null && compare && !probe) {
    const refStart = Date.now();
    const quick = rich
      ? luau.runFile(`${luau.richHost()}\n${source}`, { timeout: Math.max(8000, sizeBudget) })
      : luau.run(source, { timeout: Math.max(8000, sizeBudget) });
    const refMs = Date.now() - refStart;
    if (!quick.timedOut) autoBudget = Math.max(autoBudget, Math.ceil(refMs * 8) + 3000);
  }

  console.log(
    `${BOLD}client${RESET} ${DIM}${opts.src || "(inline payload)"} · seed ${opts.seed} · ` +
    `${artifact.length} B · budget ${autoBudget} ms` +
    `${rich ? " · wide host" : ""}${probe ? " · host probe" : ""}${RESET}`
  );

  const { res, ms } = run(artifact, autoBudget, rich);
  const out = String(res.stdout || "").replace(/\s+$/, "");

  // The reference is what decides "did obfuscation preserve behaviour". For a
  // third-party script the host is often too thin to finish it, and then the only
  // honest claim is that the copy fails in exactly the same place as the original.
  let ref = null;
  if (compare && !probe) {
    ref = rich
      ? luau.runFile(`${luau.richHost()}\n${source}`, { timeout: autoBudget })
      : luau.run(source, { timeout: autoBudget });
  }
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const errTail = (r) => clean(String(r.stderr || "").split("\n")[0]).slice(-90);

  console.log("");
  let verdict = null;

  if (res.timedOut) {
    verdict = { ok: false, line: `the artifact never came back after ${ms} ms ` +
      `${DIM}(a parked thread: on a client this is a frozen frame, not an error)${RESET}` };
  } else if (ref && ref.timedOut) {
    verdict = { ok: false, line: `the source itself never came back after ${opts.budget} ms ` +
      `${DIM}(the host is not driving it; nothing to compare)${RESET}` };
  } else if (ref && ref.status === res.status && clean(out) === clean(ref.stdout)) {
    if (res.status === 0) {
      verdict = { ok: true, line: `returned in ${ms} ms and printed exactly what the source printed` };
    } else {
      verdict = { ok: true, line: `fails identically to the source, after ${ms} ms ` +
        `${DIM}(the host is thinner than Roblox here: ${errTail(res).slice(0, 60)})${RESET}`, dim: true };
    }
  } else if (ref && (ref.status !== res.status || errTail(ref) !== errTail(res))) {
    verdict = { ok: false, line: `behaviour diverged from the source: ` +
      `exit ${res.status} vs ${ref.status}${errTail(res) !== errTail(ref) ? `, error ${JSON.stringify(errTail(res).slice(-40))} vs ${JSON.stringify(errTail(ref).slice(-40))}` : ""}` };
  } else if (res.status !== 0) {
    verdict = { ok: false, line: `the artifact raised after ${ms} ms ${DIM}${errTail(res).slice(0, 110)}${RESET}` };
  } else {
    verdict = { ok: true, line: `returned in ${ms} ms${ref ? " (no reference output to compare)" : ""}` };
  }

  console.log(`${verdict.ok ? GREEN + "+" : RED + "x"}${RESET} ${verdict.line}`);
  if (out) {
    for (const line of out.split("\n").slice(0, 24)) console.log(`  ${line}`);
  }
  if (ref && verdict.ok && res.status !== 0 && !out) {
    console.log(`  ${DIM}both sides stop at: ${errTail(ref)}${RESET}`);
  }

  if (probe) console.log(`${DIM}(probe build: the payload runs even when a clause disagrees)${RESET}`);

  process.exit(verdict.ok ? 0 : 1);
}

main();
