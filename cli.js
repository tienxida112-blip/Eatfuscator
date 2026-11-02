#!/usr/bin/env node
"use strict";

/**
 * Eatfuscator CLI — invite only — dsc.gg/eatfuscator
 */

const fs = require("fs");
const path = require("path");
const { obfuscate, minify: minifyOnly, inspect } = require("./src/Core/obfuscate");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function banner() {
  console.error(`${CYAN}${BOLD}
  ███████╗ █████╗ ████████╗███████╗██╗   ██╗███████╗
  ██╔════╝██╔══██╗╚══██╔══╝██╔════╝██║   ██║██╔════╝
  █████╗  ███████║   ██║   █████╗  ██║   ██║███████╗
  ██╔══╝  ██╔══██║   ██║   ██╔══╝  ██║   ██║╚════██║
  ███████╗██║  ██║   ██║   ██║     ╚██████╔╝███████║
  ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚══════╝
${DIM}  invite only  ·  ${"dsc.gg/eatfuscator"}${RESET}
`);
}

function usage() {
  banner();
  console.error(`${BOLD}Usage:${RESET}`);
  console.error(`  ${CYAN}node cli.js${RESET} <input.lua> [output.lua] [options]`);
  console.error(`  ${CYAN}node cli.js${RESET} -c "print(1)" [output.lua] [options]`);
  console.error(`  ${CYAN}node cli.js minify${RESET} <input.lua> [output.lua]   ${DIM}(densify only)${RESET}`);
  console.error(`  ${CYAN}node cli.js check${RESET} <file.lua> [...]           ${DIM}(syntax check only)${RESET}`);
  console.error();
  console.error(`${BOLD}Options:${RESET}`);
  console.error(`  ${YELLOW}--setting minify:<level>${RESET}   false | Normal | Max | Both   (default: Normal)`);
  console.error(`  ${YELLOW}--setting seed:<number>${RESET}    deterministic seed            (default: random)`);
  console.error(`  ${YELLOW}--setting verbose:true${RESET}     print pipeline statistics`);
  console.error(`  ${YELLOW}--setting bloat:<size>${RESET}     artifact size target, e.g. 512k (default), 1m, off`);
  console.error(`  ${YELLOW}--setting target:<dialect>${RESET} luau | portable            (default: luau)`);
  console.error(`  ${YELLOW}--setting flatten:off${RESET}      keep the loader body straight-line (default: on)`);
  console.error(`  ${YELLOW}--setting blocks:<n>${RESET}       dispatch blocks in the flattened loader (default: 26)`);
  console.error(`  ${YELLOW}-h, --help${RESET}                 show this help`);
  console.error();
  console.error(`${DIM}Output is always a single line:${RESET}`);
  console.error(`  ([[dsc.gg/eatfuscator]]):gsub('.+',(function(...)...end)(...))`);
  console.error();
  console.error(`${DIM}Examples:${RESET}`);
  console.error(`  node cli.js script.lua out.lua --setting minify:Normal --setting seed:42`);
  console.error(`  node cli.js -c 'print("hi")' --setting minify:Max`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") usage();

/* ---- syntax-check mode ---- */
if (args[0] === "check" || args[0] === "--check") {
  const { checkSyntax } = require("./src/Steps/Minify");
  const files = args.slice(1).filter((a) => !a.startsWith("-"));
  if (!files.length) {
    console.error("Usage: node cli.js check <file.lua> [...]");
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, "utf8");
    } catch (e) {
      console.error(`${RED}x${RESET} ${f} ${DIM}unreadable${RESET}`);
      bad++;
      continue;
    }
    // Luau is the reference; a chunk that only parses as Lua 5.1 is reported
    // separately instead of being called valid
    const luau = checkSyntax(src, "luau");
    const lua51 = checkSyntax(src, "5.1");
    if (luau.ok) {
      const note = lua51.ok ? "luau + 5.1" : "luau only";
      console.log(`${GREEN}+${RESET} ${f} ${DIM}${Buffer.byteLength(src)} bytes, ${note}${RESET}`);
    } else {
      bad++;
      console.log(`${RED}x${RESET} ${f} ${DIM}${luau.error}${RESET}`);
    }
  }
  process.exit(bad ? 1 : 0);
}

/* ---- self-check mode ---- */
if (args[0] === "suite" || args[0] === "--suite") {
  const { runSuite, parseArgs } = require("./src/Toolchain/suite");
  process.exit(runSuite(parseArgs(args.slice(1))));
}

/* ---- densify-only mode ---- */
if (args[0] === "minify" || args[0] === "--minify-only") {
  args.shift();
  let inPath = null;
  let outPath = null;
  let mode = "Normal";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--setting" && args[i + 1]) {
      const [k, v] = args[++i].split(/[:=]/);
      if (/^(minify|mode)$/i.test(k)) mode = v;
      continue;
    }
    if (!inPath) { inPath = a; continue; }
    if (!outPath) { outPath = a; continue; }
  }

  if (!inPath) {
    console.error("Usage: node cli.js minify <input.lua> [output.lua]");
    process.exit(1);
  }

  const src = fs.readFileSync(inPath, "utf8");
  const out = minifyOnly(src, mode);
  const dest = outPath || inPath.replace(/\.lua$/i, "") + ".min.lua";
  fs.writeFileSync(dest, out, "utf8");

  const before = Buffer.byteLength(src, "utf8");
  const after = Buffer.byteLength(out, "utf8");
  console.error(`Minified (no wrapping) -> ${dest}`);
  console.error(`${DIM}${before} -> ${after} bytes (${((after / before) * 100).toFixed(1)}%)${RESET}`);
  process.exit(0);
}

let minifyMode = "Normal";
let seed = "random";
let verbose = false;
let bloat = "512k";
let flatten = true;
let blocks = 26;
let target = "luau";
let inPath = null;
let outPath = null;
let inline = null;

function parseBloat(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "off" || s === "none" || s === "0") return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Math.round(n * (m[2] === "m" ? 1048576 : m[2] === "k" ? 1024 : 1));
}

function apply(kv) {
  const [k, v] = String(kv).split(/[:=]/);
  if (!k) return;
  const key = k.toLowerCase();
  if (key === "minify" || key === "mode") minifyMode = v;
  else if (key === "seed") seed = v;
  else if (key === "verbose") verbose = /^(1|true|yes)$/i.test(v);
  else if (key === "bloat" || key === "size") bloat = v;
  else if (key === "flatten" || key === "flat") flatten = !/^(0|false|off|none|no)$/i.test(v);
  else if (key === "blocks") blocks = parseInt(v, 10) || 26;
  else if (key === "target" || key === "dialect") target = v;
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-c" && args[i + 1]) { inline = args[++i]; continue; }
  if (a === "--setting" && args[i + 1]) { apply(args[++i]); continue; }
  if (a.startsWith("--setting=")) { apply(a.slice(10)); continue; }
  if (!inPath && inline == null) { inPath = a; continue; }
  if (!outPath) { outPath = a; continue; }
}

banner();

const src = inline != null ? inline : fs.readFileSync(inPath, "utf8");
if (!outPath) {
  outPath = inline != null ? "out.lua" : inPath.replace(/\.lua$/i, "") + ".obfuscated.lua";
}

const srcBytes = Buffer.byteLength(src, "utf8");
console.error(`${DIM}Input :${RESET} ${inline != null ? "(inline)" : inPath}  (${srcBytes} bytes)`);
console.error(`${DIM}Minify:${RESET} ${minifyMode}   ${DIM}Seed:${RESET} ${seed}   ${DIM}Target:${RESET} ${target}`);
console.error(`${YELLOW}> obfuscating...${RESET}`);

const t0 = Date.now();
let out;
try {
  out = obfuscate(src, { minify: minifyMode, seed, verbose, bloat: parseBloat(bloat), flatten, blocks, target });
} catch (e) {
  console.error(`${RED}x ${e.message}${RESET}`);
  process.exit(1);
}
const ms = Date.now() - t0;

fs.writeFileSync(outPath, out, "utf8");
const outBytes = Buffer.byteLength(out, "utf8");

const info = inspect(out);

console.error(`${GREEN}+ done${RESET} in ${ms}ms`);
console.error(`${DIM}Output:${RESET} ${outPath}`);
console.error(`${DIM}Size  :${RESET} ${srcBytes} -> ${outBytes} bytes`);
console.error(`${DIM}Shape :${RESET} single line, ${out.length} chars`);
console.error(`${DIM}Upval :${RESET} ${info.closures} nested closures, ${info.handlers} VM handlers`);
console.error(`${DIM}Flow  :${RESET} ${info.dispatch ? info.dispatch + " dispatch blocks" : "straight-line loader"}`);
console.error(`${DIM}Banks :${RESET} ${info.banks} entries, ${info.layers} cipher layers`);
{
  const ob = require("./src/Core/obfuscate");
  const minified = Buffer.byteLength(ob.minify(src, minifyMode));
  const measured = ob.measurePayload(src, { minify: minifyMode, seed });
  const image = measured.len;
  const protos = measured.protos;
  console.error(`${DIM}Payload:${RESET} ${srcBytes} source bytes -> ${minified} minified -> ${image} image bytes, ${protos} protos`);
}
