#!/usr/bin/env node
/**
 * Eatfuscator CLI v2.0
 * Beautiful, strong Lua/Luau obfuscator
 */
const fs = require("fs");
const path = require("path");
const { obfuscate, minify: minifyOnly } = require("./src/Core/obfuscate");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function banner() {
  console.error(`${CYAN}${BOLD}
╔═══════════════════════════════════════════════════════════════╗
║     ███████╗ █████╗ ████████╗███████╗██╗   ██╗███████╗      ║
║     ██╔════╝██╔══██╗╚══██╔══╝██╔════╝██║   ██║██╔════╝      ║
║     █████╗  ███████║   ██║   █████╗  ██║   ██║███████╗      ║
║     ██╔══╝  ██╔══██║   ██║   ██╔══╝  ██║   ██║╚════██║      ║
║     ███████╗██║  ██║   ██║   ██║     ╚██████╔╝███████║      ║
║     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚══════╝      ║
║                                                               ║
║  Eatfuscator CLI                                  ║
╚═══════════════════════════════════════════════════════════════╝
${RESET}`);
}

function usage() {
  banner();
  console.error(`${BOLD}Usage:${RESET}`);
  console.error(`  ${CYAN}node cli.js${RESET} <input.lua> [output.lua] [options]`);
  console.error(`  ${CYAN}node cli.js${RESET} -c "print(1)" [output.lua] [options]`);
  console.error(`  ${CYAN}node cli.js minify${RESET} <input.lua> [output.lua]   ${DIM}(densify only)${RESET}`);
  console.error();
  console.error(`${BOLD}Options:${RESET}`);
  console.error(`  ${YELLOW}--setting seed:<number>${RESET}    deterministic seed - the only build setting`);
  console.error(`  ${YELLOW}-h, --help${RESET}                 show this help`);
  console.error();
  console.error(`${DIM}Examples:${RESET}`);
  console.error(`  node cli.js script.lua out.lua --setting seed:42`);
  console.error(`  node cli.js -c 'print("hi")' --setting seed:42`);
  console.error();
  console.error(`${DIM}Seed is the only knob: every other build choice (packing, padding, name`);
  console.error(`lengths, trap shape, target) is derived from it. Omit it and a random one`);
  console.error(`is drawn and printed, so a build can be reproduced later.${RESET}`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") usage();

// pure minify mode: node cli.js minify <input.lua> [output.lua]
if (args[0] === "minify" || args[0] === "--minify-only") {
  args.shift();
  let minIn = null, minOut = null, minMode = "Normal";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--setting" && args[i + 1]) {
      const [k, v] = args[++i].split(/[:=]/);
      if (/^minify|mode$/i.test(k)) minMode = v;
      continue;
    }
    if (!minIn) { minIn = a; continue; }
    if (!minOut) { minOut = a; continue; }
  }
  if (!minIn) { console.error("Usage: node cli.js minify <input.lua> [output.lua]"); process.exit(1); }
  const src = fs.readFileSync(minIn, "utf8");
  const out = minifyOnly(src, minMode);
  const dest = minOut || minIn.replace(/\.lua$/i, "") + ".min.lua";
  fs.writeFileSync(dest, out);
  console.error(`Minified (no obfuscation) → ${dest} (${Buffer.byteLength(out)} bytes)`);
  process.exit(0);
}


let minify = "Normal", seed = "random", verbose = false, hostProbe = false, trap = null;
let bloat, diag = false, watermark;  // undefined = tool default (banner on)
let inPath = null, outPath = null, inline = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-c" && args[i + 1]) { inline = args[++i]; continue; }
  if (a === "--setting" && args[i + 1]) { apply(args[++i]); continue; }
  if (a.startsWith("--setting=")) { apply(a.slice(10)); continue; }
  if (!inPath && !inline) { inPath = a; continue; }
  if (!outPath) { outPath = a; continue; }
}

function apply(kv) {
  const [k, v] = kv.split(/[:=]/);
  if (!k) return;
  const key = k.toLowerCase();
  if (key === "seed") { seed = v; return; }
  // Seed-only, on purpose. Every other knob used to be a --setting, and every
  // one of them was a way to ship a build that is weaker than the default: no
  // padding, no flattening, no trap, source form. The build no longer has a
  // weaker setting to select, so the flag is gone rather than ignored.
  console.error(`unknown setting: ${k}`);
  console.error(`seed is the only build setting: --setting seed:<number>`);
  process.exit(2);
}

(async () => {
  banner();
  const src = inline != null ? inline : fs.readFileSync(inPath, "utf8");
  if (!outPath) {
    outPath = inline != null
      ? "out.lua"
      : inPath.replace(/\.lua$/i, "") + ".obfuscated.lua";
  }

  const srcBytes = Buffer.byteLength(src, "utf8");
  console.error(`${DIM}Input :${RESET} ${inline != null ? "(inline)" : inPath}  ${DIM}(${srcBytes} bytes)${RESET}`);
  console.error(`${DIM}Minify:${RESET} ${minify}   ${DIM}Seed:${RESET} ${seed}`);
  console.error();
  console.error(`${YELLOW}▸ Obfuscating...${RESET}`);

  const t0 = Date.now();
  const out = await obfuscate(src, { minify, seed, verbose, hostProbe, trap, bloat, diag, watermark });
  const ms = Date.now() - t0;

  fs.writeFileSync(outPath, out, "utf8");
  const outBytes = Buffer.byteLength(out, "utf8");
  const ratio = (outBytes / Math.max(1, srcBytes)).toFixed(1);

  console.error(`${GREEN}✔ Done${RESET} in ${ms}ms`);
  console.error(`${DIM}Output:${RESET} ${outPath}`);
  console.error(`${DIM}Size  :${RESET} ${outBytes} bytes  (${ratio}×)`);
  console.error();
})().catch((e) => {
  console.error(`${RED}✖ Error:${RESET}`, e?.stack || e);
  process.exit(1);
});
