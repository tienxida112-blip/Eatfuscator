#!/usr/bin/env node
/*
 * tools/bench.js - how much slower is the artifact than the source?
 *
 * The VM is an interpreter, so "some lag" is expected; this tool makes the
 * number visible instead of folklore, and it is the thing to look at after any
 * change to the dispatch loop or the decoder.
 *
 *   node tools/bench.js                 # default set
 *   node tools/bench.js Test/life.lua   # one file
 *   node tools/bench.js --runs 5
 *   node tools/bench.js --json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const luau = require("../src/Toolchain/luaucli");
const { obfuscate } = require("../src/Core/obfuscate");

const ROOT = path.join(__dirname, "..");
const bin = luau.find("luau");

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function timeRun(code) {
  // The Luau CLI has no stdin mode: write a temp file per run.
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "eat-bench-"));
  const file = path.join(dir, "chunk.lua");
  fs.writeFileSync(file, code);
  const started = process.hrtime.bigint();
  const res = spawnSync(bin, [file], {
    encoding: "utf8",
    timeout: 120000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function main() {
  if (!bin) {
    console.error("luau missing (set LUAU_BIN)");
    process.exit(2);
  }
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.endsWith(".lua"));
  const targets = files.length
    ? files
    : ["Bench/fib.lua", "Bench/sieve.lua", "Bench/strings.lua", "Bench/tables.lua", "Test/life.lua"];
  const runs = Number(argOf("runs", 3));
  const seed = Number(argOf("seed", 5));
  const asJson = Boolean(argOf("json", false));
  const shim = luau.robloxShim();
  const rows = [];

  for (const target of targets) {
    const file = path.isAbsolute(target) ? target : path.join(ROOT, target);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const base = []; const art = [];
    for (let i = 0; i < runs; i++) base.push(timeRun(shim + "\n" + source).ms);
    // One artifact, timed `runs` times; warm file cache for both.
    const code = obfuscate(source, { seed, bloat: 0 });
    for (let i = 0; i < runs; i++) art.push(timeRun(shim + "\n" + code).ms);
    const b = median(base);
    const a = median(art);
    rows.push({
      file: path.basename(file),
      sourceMs: Number(b.toFixed(1)),
      artifactMs: Number(a.toFixed(1)),
      ratio: Number((a / b).toFixed(1)),
      bytes: code.length,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log("file            source    artifact   ratio   bytes");
    for (const r of rows) {
      console.log(
        `${r.file.padEnd(15)} ${String(r.sourceMs).padStart(7)}ms ${String(r.artifactMs).padStart(9)}ms ${(r.ratio + "x").padStart(7)} ${String(r.bytes).padStart(7)}`
      );
    }
    const slow = rows.map((r) => r.ratio);
    if (slow.length) console.log(`\nmedian slowdown ${median(slow)}x (load time included for both)`);
  }
}

main();
