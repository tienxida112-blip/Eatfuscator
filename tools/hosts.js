#!/usr/bin/env node
/*
 * tools/hosts.js - run one artifact against the host-profile matrix.
 *
 * The point of an obfuscated artifact is that it only runs where it is supposed
 * to run. This tool proves both halves of that claim in one pass: every profile
 * in spec/hosts.json that imitates Roblox (or quietly drops a library) must
 * leave the payload unprinted, and the two genuine hosts must print it.
 *
 *   node tools/hosts.js                       # default payload, seed 5
 *   node tools/hosts.js --seed 91 --src Test/smoke_test.lua
 *   node tools/hosts.js --json                # machine readable
 *   node tools/hosts.js --profile bare-luau   # one profile only
 */
"use strict";

const fs = require("fs");
const path = require("path");
const luau = require("../src/Toolchain/luaucli");
const { obfuscate } = require("../src/Core/obfuscate");

const ROOT = path.join(__dirname, "..");
const SPEC = path.join(ROOT, "spec", "hosts.json");

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const DEFAULTS = {
  seed: 5,
  timeout: 9000,
  stopTimeout: 3500,
  target: "luau",
  payload: 'print("EATFUSCATOR", 6 * 7)\n',
};

function profileCode(profile, artifact, shim) {
  const parts = [];
  if (profile.shim) parts.push(shim);
  // A profile may carry its own whole host as a fixture file (spec/fixtures):
  // a replayed environment is a host in its own right, not a prelude.
  if (profile.fixture) {
    const file = path.join(ROOT, profile.fixture);
    if (fs.existsSync(file)) parts.push(fs.readFileSync(file, "utf8"));
  }
  if (profile.prelude) parts.push(profile.prelude);
  parts.push(artifact);
  return parts.join("\n") + "\n";
}

function classify(res, expectedLine) {
  if (!res || res.skipped) return { ran: false, why: "luau missing" };
  const out = String(res.stdout || "");
  const ran = out.includes(expectedLine);
  if (ran) return { ran: true, why: "payload printed" };
  if (res.timedOut) return { ran: false, why: "parked" };
  const err = String(res.stderr || "").trim().split("\n")[0];
  if (res.status === 0) return { ran: false, why: "no output" };
  return { ran: false, why: err ? `exit ${res.status}: ${err.slice(0, 72)}` : `exit ${res.status}` };
}

function main() {
  if (!luau.available("luau")) {
    console.error("luau binary not found - set LUAU_BIN or put luau in vendor/luau/bin");
    process.exit(2);
  }
  const seed = Number(argOf("seed", DEFAULTS.seed));
  const target = String(argOf("target", DEFAULTS.target));
  const srcArg = argOf("src", null);
  const source = srcArg ? fs.readFileSync(String(srcArg), "utf8") : DEFAULTS.payload;
  const only = argOf("profile", null);
  const asJson = Boolean(argOf("json", false));
  const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
  const shim = luau.robloxShim();

  // The expected output line is whatever the plain payload prints when it runs.
  const ref = luau.run(source, { timeout: 60000 });
  const expectedLine = String(ref.stdout || "").trim().split("\n").pop() || "";

  const artifact = obfuscate(source, { seed, bloat: 0, target });
  const rows = [];
  for (const profile of spec.profiles) {
    if (only && profile.id !== only) continue;
    const timeout = profile.expect === "run" ? DEFAULTS.timeout : DEFAULTS.stopTimeout;
    const res = luau.runFile(profileCode(profile, artifact, shim), { timeout });
    const verdict = classify(res, expectedLine);
    const ok = profile.expect === "run" ? verdict.ran : !verdict.ran;
    rows.push({
      id: profile.id,
      label: profile.label,
      expect: profile.expect,
      ran: verdict.ran,
      why: verdict.why,
      ok,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ seed, target, bytes: artifact.length, expectedLine, rows }, null, 2));
  } else {
    console.log(`artifact ${artifact.length} B · seed ${seed} · target ${target} · expecting "${expectedLine}"`);
    for (const r of rows) {
      const mark = r.ok ? "\x1b[32m+\x1b[0m" : "\x1b[31mx\x1b[0m";
      const want = r.expect === "run" ? "runs " : "stops";
      console.log(`${mark} ${r.id.padEnd(24)} ${want} \x1b[2m· ${r.why}\x1b[0m  ${r.ok ? "" : "<-- " + r.label}`);
    }
    const bad = rows.filter((r) => !r.ok);
    console.log(`\n${rows.length - bad.length} of ${rows.length} profiles behaved as specified`);
  }
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

main();
