#!/usr/bin/env node
"use strict";

/**
 * Regenerate Sample/*.lua from Test/exec/heavy.lua.
 *
 *   node tools/build_samples.js            # default target (luau)
 *   node tools/build_samples.js --portable # plain Lua 5.1 spelling
 *
 * Every sample is verified before it is written: it must pass the Luau syntax
 * gate and produce the reference program's stdout when the Luau CLI is
 * available.
 */

const fs = require("fs");
const path = require("path");
const { obfuscate } = require("../src/Core/obfuscate");
const luau = require("../src/Toolchain/luaucli");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "Test", "exec", "heavy.lua");
const OUT = path.join(ROOT, "Sample");
const SEED = 2024;

const target = process.argv.includes("--portable") ? "portable" : "luau";
const modes = [
  ["Normal", "Normal"],
  ["NoMinify", "false"],
  ["Max", "Max"],
  ["Both", "Both"],
];

const source = fs.readFileSync(SRC, "utf8");
const available = luau.available();
const reference = available ? luau.run(source) : null;
if (reference && reference.status !== 0) {
  console.error(`reference run failed: ${String(reference.stderr).split("\n")[0]}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
let bad = 0;
for (const [name, minify] of modes) {
  const code = obfuscate(source, { minify, seed: SEED, bloat: 512 * 1024, target });
  if (available) {
    const run = luau.run(code);
    if (run.status !== 0 || run.stdout !== reference.stdout) {
      bad++;
      console.error(`x ${name}: ${String(run.stderr || "stdout differs").split("\n")[0]}`);
      continue;
    }
  }
  fs.writeFileSync(path.join(OUT, `${name}.lua`), code);
  console.log(`+ ${name}.lua  ${Buffer.byteLength(code, "utf8")} bytes  (${minify}, target=${target})`);
}
process.exit(bad ? 1 : 0);
