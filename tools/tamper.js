#!/usr/bin/env node
/*
 * tools/tamper.js - does a patched artifact still run?
 *
 * The suite proves a handful of hand-picked edits stop the load. This tool is
 * the shotgun version: it mangles the artifact in a lot of places, seeded and
 * reproducible, and reports how many mutants still print the payload.
 *
 *   node tools/tamper.js                    # 24 mutants, seed 5
 *   node tools/tamper.js --runs 60 --seed 9
 *   node tools/tamper.js --src Bench/fib.lua --json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const luau = require("../src/Toolchain/luaucli");
const { obfuscate } = require("../src/Core/obfuscate");
const { createRNG } = require("../src/Core/rng");

const ROOT = path.join(__dirname, "..");

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const FLIP_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+./";

function mutate(artifact, rng, kind) {
  const n = artifact.length;
  switch (kind) {
    case "byte": {
      const at = 1 + ((rng() * (n - 2)) | 0);
      const ch = FLIP_SAFE[(rng() * FLIP_SAFE.length) | 0];
      return { what: `byte ${at} -> '${ch}'`, code: artifact.slice(0, at) + ch + artifact.slice(at + 1) };
    }
    case "digit": {
      // Only hit ASCII digits, which is where opcodes, salts and lengths live.
      const spots = [];
      for (let i = 0; i < n; i++) if (artifact[i] >= "0" && artifact[i] <= "9") spots.push(i);
      if (!spots.length) return null;
      const at = spots[(rng() * spots.length) | 0];
      const ch = String((Number(artifact[at]) + 1 + ((rng() * 8) | 0)) % 10);
      return { what: `digit at ${at}: ${artifact[at]} -> ${ch}`, code: artifact.slice(0, at) + ch + artifact.slice(at + 1) };
    }
    case "hexpair": {
      const m = /0x[0-9A-F]{3,}/g;
      const all = [];
      let hit;
      while ((hit = m.exec(artifact))) all.push(hit);
      if (!all.length) return null;
      const pick = all[(rng() * all.length) | 0];
      const at = pick.index + 2 + ((rng() * (pick[0].length - 2)) | 0);
      const ch = "0123456789ABCDEF"[(rng() * 16) | 0];
      return { what: `hex digit at ${at}`, code: artifact.slice(0, at) + ch + artifact.slice(at + 1) };
    }
    case "truncate": {
      const cut = Math.max(8, (n * (0.02 + rng() * 0.2)) | 0);
      return { what: `truncate ${cut} bytes`, code: artifact.slice(0, n - cut) };
    }
    case "append": {
      // A trailing comment changes nothing, so make the appended text a
      // statement: an artifact that ignores injected code is fine, one that runs
      // its own payload anyway is fine too, but this way we see which.
      return { what: "append injected call", code: artifact + '\nprint("INJECTED_BY_PATCHER")\n' };
    }
    case "dropsemi": {
      // Remove one `local`/`then` keyword: a parser-level edit that still parses
      // often enough to reach the loader.
      const needle = [" local ", " then ", " do ", " end "][(rng() * 4) | 0];
      const at = artifact.indexOf(needle);
      if (at < 0) return null;
      return { what: `drop '${needle.trim()}' at ${at}`, code: artifact.slice(0, at) + " " + artifact.slice(at + needle.length) };
    }
    case "blob": {
      // Flip a character inside a long-bracket bank blob: the ciphertext the
      // payload lives in. This is the attack the integrity checks exist for.
      const re = /\[=+\[([^\]]{32,})\]=+\]/g;
      const all = [];
      let hit;
      while ((hit = re.exec(artifact))) all.push(hit);
      if (!all.length) return null;
      const pick = all[(rng() * all.length) | 0];
      const at = pick.index + pick[0].indexOf("[[") + 2 + ((rng() * (pick[1].length - 2)) | 0);
      const ch = FLIP_SAFE[(rng() * FLIP_SAFE.length) | 0];
      return { what: `blob char at ${at}`, code: artifact.slice(0, at) + ch + artifact.slice(at + 1) };
    }
    case "layer": {
      // Nudge a number inside a `{a,b,c,d,e,salt}` cipher-layer tuple, which is
      // what a patcher edits to make the peel produce different bytes.
      const re = /\{(\d{1,3}),(\d{1,3}),(\d{1,3}),([01]),(\d{1,3}),(\d{1,12})\}/g;
      const all = [];
      let hit;
      while ((hit = re.exec(artifact))) all.push(hit);
      if (!all.length) return null;
      const pick = all[(rng() * all.length) | 0];
      const at = pick.index + 1 + ((rng() * 5) | 0);
      const d = BigInt(artifact[at]) === 9n ? "1" : String(Number(artifact[at]) + 1);
      return { what: `layer param at ${at}`, code: artifact.slice(0, at) + d + artifact.slice(at + 1) };
    }
    case "swap": {
      const at = 1 + ((rng() * (n - 4)) | 0);
      const a = artifact[at];
      const b = artifact[at + 2];
      const chars = artifact.split("");
      chars[at] = b;
      chars[at + 2] = a;
      return { what: `swap ${at}/${at + 2}`, code: chars.join("") };
    }
    default:
      return null;
  }
}

function main() {
  if (!luau.available("luau")) {
    console.error("luau missing (set LUAU_BIN)");
    process.exit(2);
  }
  const runs = Number(argOf("runs", 24));
  const seed = Number(argOf("seed", 5));
  const srcArg = argOf("src", null);
  const asJson = Boolean(argOf("json", false));
  const target = String(argOf("target", "luau"));
  const source = srcArg
    ? fs.readFileSync(path.isAbsolute(srcArg) ? srcArg : path.join(ROOT, srcArg), "utf8")
    : 'local acc = 0\nfor i = 1, 200 do acc = acc + i end\nprint("TAMPER_PAYLOAD", acc)\n';
  const expect = String(luau.run(source, { timeout: 60000 }).stdout || "").trim().split("\n").pop() || "";
  const artifact = obfuscate(source, { seed, bloat: 0, target });
  const refRun = luau.runFile(luau.robloxShim() + "\n" + artifact, { timeout: 60000 });
  const refOut = String(refRun.stdout || "");
  const shim = luau.robloxShim();
  const kinds = ["blob", "forge", "layer", "forge", "byte", "noattest", "digit", "noatlas", "forge", "hexpair", "truncate", "dropsemi", "swap", "append"];
  const rng = createRNG(seed * 2654435761 + 12345);

  const rows = [];
  for (let i = 0; i < runs; i++) {
    const kind = kinds[i % kinds.length];
    // Layer 3 cannot be reached by editing the artifact text: the stack program
    // lives inside the coded blob, and a text edit there is already covered by
    // `blob`. The honest attack on this layer is a corrupted token, so the mutant
    // is built with one flipped - same seed, same everything else - which is what
    // a patcher gets after decoding and re-encoding the stream.
    // The anti-tamper block is deleted outright. Nothing textual is corrupted, so
    // the only thing standing between this mutant and a working artifact is the
    // fact that the interpreter takes its code salt from the block's verdict.
    // The API atlas is removed the same way, and must fail the same way: the
    // interpreter's salt is folded from what the atlas answered.
    if (kind === "noatlas") {
      const code = obfuscate(source, { seed, bloat: 0, target, dropAtlas: true });
      const changed = code !== artifact;
      const res2 = luau.runFile(shim + "\n" + code, { timeout: 3000 });
      const out2 = String(res2.stdout || "");
      const printed2 = out2.includes(expect);
      const same2 = out2 === refOut;
      rows.push({
        kind: "noatlas",
        what: "API atlas removed",
        scored: changed,
        ran: printed2 && !same2 && changed,
        inert: !changed || same2,
        why: !changed
          ? "no-op"
          : !printed2
            ? res2.timedOut ? "parked" : res2.status !== 0 ? "error (decode key wrong)" : "no output (quarantined)"
            : same2 ? "ran, output identical (inert edit)" : "PAYLOAD RAN, OUTPUT CHANGED",
      });
      continue;
    }
    if (kind === "noattest") {
      const code = obfuscate(source, { seed, bloat: 0, target, dropAttest: true });
      const changed = code !== artifact;
      const res2 = luau.runFile(shim + "\n" + code, { timeout: 3000 });
      const out2 = String(res2.stdout || "");
      const printed2 = out2.includes(expect);
      const same2 = out2 === refOut;
      rows.push({
        kind: "noattest",
        what: "anti-tamper block removed",
        scored: changed,
        ran: printed2 && !same2 && changed,
        inert: !changed || same2,
        why: !changed
          ? "no-op"
          : !printed2
            ? res2.timedOut ? "parked" : res2.status !== 0 ? "error (decode key wrong)" : "no output (quarantined)"
            : same2 ? "ran, output identical (inert edit)" : "PAYLOAD RAN, OUTPUT CHANGED",
      });
      continue;
    }
    if (kind === "forge") {
      const token = 3 + ((rng() * 60) | 0);
      const flavour = rng() < 0.5 ? "operand" : "op";
      const code = obfuscate(source, { seed, bloat: 0, target, forgeMutation: { token, kind: flavour } });
      const changed = code !== artifact;
      const res2 = luau.runFile(shim + "\n" + code, { timeout: 3000 });
      const out2 = String(res2.stdout || "");
      const printed2 = out2.includes(expect);
      const same2 = out2 === refOut;
      rows.push({
        kind: "forge",
        what: `token ${token}.${flavour}`,
        scored: changed,
        ran: printed2 && !same2 && changed,
        inert: !changed || same2,
        why: !changed
          ? "token outside the stream (no-op)"
          : !printed2
            ? res2.timedOut ? "parked" : res2.status !== 0 ? "error" : "no output (quarantined)"
            : same2 ? "ran, output identical (inert edit)" : "PAYLOAD RAN, OUTPUT CHANGED",
      });
      continue;
    }
    const mutant = mutate(artifact, rng, kind);
    if (!mutant) continue;
    const res = luau.runFile(shim + "\n" + mutant.code, { timeout: 3000 });
    const out = String(res.stdout || "");
    const printed = out.includes(expect);
    // Three outcomes matter: caught, inert (same output as the untouched build,
    // so the patcher gained nothing) and silently changed (the payload ran but
    // said something else - the only real failure). `append` is a control: code
    // a patcher adds *after* the artifact is outside anything we can police.
    const same = out === refOut;
    const scored = kind !== "append";
    const gap = printed && !same && scored;
    rows.push({
      kind,
      what: mutant.what,
      scored,
      ran: gap,
      inert: same,
      why: !printed
        ? res.timedOut ? "parked" : res.status !== 0 ? "error" : "no output"
        : same ? "ran, output identical (inert edit)"
        : scored ? "PAYLOAD RAN, OUTPUT CHANGED" : "ran, output changed (control)",
    });
  }

  const scoredRows = rows.filter((r) => r.scored);
  const ran = scoredRows.filter((r) => r.ran);
  if (asJson) {
    console.log(JSON.stringify({ seed, target, bytes: artifact.length, expect, total: rows.length, gaps: ran.length, rows }, null, 2));
  } else {
    console.log(`artifact ${artifact.length} B · seed ${seed} · ${rows.length} mutants · expecting "${expect}"`);
    for (const r of rows) {
      const mark = r.ran ? "\x1b[31mX\x1b[0m" : "\x1b[32m+\x1b[0m";
      console.log(`${mark} ${r.kind.padEnd(9)} ${r.what.padEnd(30)} \x1b[2m${r.why}\x1b[0m`);
    }
    const inert = scoredRows.filter((r) => r.inert).length;
    const caught = scoredRows.length - inert - ran.length;
    const pct = (caught / Math.max(1, scoredRows.length)) * 100;
    console.log(`\n${caught}/${scoredRows.length} caught (${pct.toFixed(0)}%), ${inert} inert, ${ran.length} silently changed`);
  }
  process.exit(ran.length ? 1 : 0);
}

main();
