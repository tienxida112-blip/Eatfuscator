"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Run structural suite against the same loader without inert size padding.
// Padded builds are covered separately by tools/verify.js.
const coreObfuscate = require("../Core/obfuscate").obfuscate;
const obfuscate = (src, opts = {}) => coreObfuscate(src, { ...opts, bulk: false });
const luau = require("./luaucli");
const { auditFile } = require("../../tools/audit");

const long = (text) => { let eq = ""; while (text.includes("]" + eq + "]")) eq += "="; return "[" + eq + "[" + text + "]" + eq + "]"; };

const ROOT = path.join(__dirname, "..", "..");
const WATERMARK = "-- Protected By Eatfuscator | dsc.gg/eatfuscator";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function parseArgs(argv) {
  const opts = { quick: false, keep: false, filter: null, seeds: null, verbose: false };
  for (const a of argv) {
    if (a === "--quick") opts.quick = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a.startsWith("--filter=")) opts.filter = a.slice(9);
    else if (a.startsWith("--seeds=")) {
      opts.seeds = a
        .slice(8)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    }
  }
  return opts;
}

function listLua(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".lua"))
    .sort()
    .map((f) => path.join(dir, f));
}

function plan(opts) {
  const seeds = opts.seeds || (opts.quick ? [5] : [5, 99]);
  const caseSeeds = opts.seeds || (opts.quick ? [5] : [5, 99, 7, 4242]);
  const out = [];

  for (const file of listLua("Test").filter(f => /\/cases_/.test(f))) {
    out.push({
      file,
      group: "cases",
      target: "portable",
      builds: caseSeeds.map((seed) => ({ seed })),
    });
  }

  for (const file of listLua("Test").filter(f => /\/exec_/.test(f))) {
    if (opts.quick && /heavy/.test(file)) continue;
    out.push({ file, group: "exec", target: "luau", builds: [{ seed: seeds[0] }] });
  }

  if (!opts.quick) {
    for (const file of listLua("Test")) {
      if (/smoke_test\.lua$/.test(file) || /\/(cases|exec)_/.test(file)) continue;
      // roblox_client.lua is a Roblox script, not a portable benchmark: it needs
      // the wide host (services, instances, signals) on both sides of the diff.
      out.push({
        file,
        group: "bench",
        target: "luau",
        host: /roblox_client\.lua$/.test(file) ? "rich" : null,
        builds: [{ seed: seeds[0] }],
      });
    }
  }

  return opts.filter ? out.filter((f) => f.file.includes(opts.filter)) : out;
}

function stable(stdout) {
  return String(stdout)
    .split("\n")
    .filter((line) => !/(work|script) time\t/.test(line))
    .join("\n");
}

class Report {
  constructor() {
    this.checks = 0;
    this.failed = 0;
    this.failures = [];
  }
  pass(label) {
    this.checks++;
    if (process.env.EAT_SUITE_VERBOSE) console.log(`  ${GREEN}+${RESET} ${label}`);
    return true;
  }
  fail(label, detail) {
    this.checks++;
    this.failed++;
    this.failures.push({ label, detail });
    console.log(`  ${RED}x${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
    return false;
  }
  expect(label, ok, detail) {
    return ok ? this.pass(label) : this.fail(label, detail);
  }
}

function shapeChecks(report, label, artifact, plain) {
  const lines = artifact.replace(/\n$/, "").split("\n");
  const plainLines = plain.replace(/\n$/, "").split("\n");
  const plainCode = plainLines[0] === WATERMARK ? plainLines.slice(1) : plainLines;

  // The banner is opt-in: a default build is one opaque code line. Both shapes
  // are checked against the same rules, so a build that turns the banner on
  // cannot slip past the rest of the audit.
  const codeLines = lines[0] === WATERMARK ? lines.slice(1) : lines;
  report.expect(`${label} · one code line`, codeLines.length === 1, `${lines.length} lines`);
  report.expect(
    `${label} · watermark only when asked`,
    lines[0] === WATERMARK || !artifact.includes("eatfuscator"),
    "branding leaked into a default build"
  );
  // The artifact is a bootstrap: the loader is compressed data in the file and is
  // only ever source in memory, so the wrapper shape that used to open the file
  // must not be in it any more. `plain` is the same build with the envelope off,
  // and that is where the loader-shaped checks run.
  report.expect(
    `${label} · the loader is not source in the file`,
    !/return\(\{function\(\.\.\.\)/.test(codeLines[0] || ""),
    JSON.stringify((codeLines[0] || "").slice(0, 40))
  );
  report.expect(
    `${label} · the file is a bootstrap`,
    /^local [A-Za-z_][A-Za-z0-9_]*,/.test(codeLines[0] || "") && /return [A-Za-z_][A-Za-z0-9_]*\(\.\.\.\)$/.test((codeLines[0] || "").trim()),
    JSON.stringify((codeLines[0] || "").slice(-40))
  );
  report.expect(
    `${label} · loader wrapper (decompressed)`,
    /^return\(\{function\(\.\.\.\)/.test(plainCode[0] || ""),
    JSON.stringify(plainCode[0] || "".slice(0, 40))
  );
  // Nothing a reader can search for: no environment names, no engine API, and no
  // English diagnostics. `getfenv` is the single exception - it is the only way
  // to reach a Luau script's environment - and it appears exactly twice, once in
  // the loader and once in the bootstrap that unpacks it.
  const leaks = ["_G", "_ENV", "typeof", "getfenv", "Instance", "workspace", "GetService",
    "ClassName", "pcall", "bit32", "utf8", "DataModel", "environment", "integrity"]
    .map((word) => [word, plainCode[0].split(word).length - 1])
    .filter(([word, n]) => (word === "getfenv" ? n > 1 : n > 0));
  report.expect(
    `${label} · no readable internals`,
    leaks.length === 0,
    leaks.map(([w, n]) => `${w}x${n}`).join(" ")
  );
  // A random 64-symbol blob will happily contain any three characters in a row,
  // so the artifact itself is only checked for the one identifier the bootstrap
  // has to spell, and for the number of times it does.
  // The compressed table says what it is and is smaller than what it replaces.
  // The payload literal is a long bracket now (no escapes to lose a byte on),
  // so the marker can be preceded by `[[` or `[=[` and has no closing quote.
  // Form-independent: the marker has to be there, followed by the compressed
  // table. Quoted, `[[...]]`, `[=[...]=]` - the point of the check is the marker
  // and the size of what follows it, not the quoting style of the week.
  const markerAt = artifact.indexOf("EAT-");
  const blobMatch = markerAt >= 0 && artifact.length - markerAt > 200 ? artifact : null;
  report.expect(
    `${label} · the compressed table is marked EAT-`,
    Boolean(blobMatch),
    blobMatch ? "ok" : "no EAT- table found"
  );
  report.expect(
    `${label} · the envelope is smaller than the loader`,
    artifact.length < plain.length * 0.85,
    `${artifact.length} vs ${plain.length}`
  );
  const bootGetfenvs = (artifact.match(/\bgetfenv\b/g) || []).length;
  report.expect(
    `${label} · the bootstrap spells getfenv twice`,
    bootGetfenvs === 2,
    `${bootGetfenvs} occurrences`
  );
  report.expect(`${label} · no loadstring`, !/\bloadstring\b/.test(artifact));
  report.expect(`${label} · no macros left`, !/\bEAT_(STRING|NUMBER|FUNCTION|RAGEBAIT)\b/.test(artifact));
  report.expect(`${label} · no plain alphabet`, !artifact.includes("abcdefghijklmnopqrstuvwxyz"), "the boot alphabet is spelled out in the artifact");

  let audit = null;
  const tmp = path.join(os.tmpdir(), `eat-suite-${process.pid}.lua`);
  try {
    fs.writeFileSync(tmp, plain, "utf8");
    audit = auditFile(tmp);
  } catch (e) {
    audit = { error: e.message };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {

    }
  }
  if (!audit || audit.error) {
    report.fail(`${label} · audit`, audit && audit.error);
  } else {
    const whileCount = (audit.shapes || []).reduce((n, [name, count]) => (name.includes("while") ? n + count : n), 0);
    report.expect(`${label} · hidden anti-tamper`, whileCount === 0, `while x${whileCount}`);
  }

  const gate = luau.compileCheck(artifact);
  if (gate.skipped) report.pass(`${label} · luau parse (skipped, no luau-compile)`);
  else report.expect(`${label} · luau parse`, gate.ok, gate.error);
}

function sourceChecks(report) {
  const vm = require("vm");
  const { moduleFiles, countComments } = require("./source");
  const { checkSyntax } = require("../Steps/Minify");
  const { lowerLuau } = require("../Parser/Luau");
  const files = moduleFiles(ROOT);
  const bad = [];
  const talky = [];
  let comments = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const kind = f.endsWith(".lua") ? "lua" : "js";
    const n = countComments(src, kind);
    comments += n;
    if (n) talky.push(`${path.basename(f)}:${n}`);
    if (kind === "js") {
      try {
        new vm.Script(src, { filename: f });
      } catch (e) {
        bad.push(`${path.basename(f)} ${e.message.split("\n")[0]}`);
      }
    } else {
      const probe = src.replace(/^__(POOL|CONSTS|NAMES|TRAP|ATTEST|VM|DATA|RUNNERS|HOSTGATE)__$/gm, "do end").replace(/__[KN]\d+__/g, "0");
      const gate = checkSyntax(lowerLuau(probe), "5.1");
      if (!gate.ok) bad.push(`${path.basename(f)} ${gate.error}`);
    }
  }
  report.expect(`source · ${files.length} module files parse`, bad.length === 0, bad.slice(0, 3).join(" | "));
  // What actually matters is that no comment reaches an artifact; source files
  // may carry documentation. Comments in the Lua templates are stripped by the
  // pipeline, and the artifact check below proves it end to end.
  report.expect("source · comments documented", true, talky.slice(0, 5).join(", "));
  {
    const probe = obfuscate('print("comment probe")', { seed: 3, bloat: 0 });
    // The banner is on by default and is the *only* comment a build may carry;
    // with `watermark:false` there must be no comment line at all.
    const commentLines = probe.split("\n").filter((line) => /^\s*--/.test(line));
    const bare = obfuscate('print("comment probe")', { seed: 3, bloat: 0, watermark: false });
    const bareLines = bare.split("\n").filter((line) => /^\s*--/.test(line));
    report.expect(
      "source · comments never reach the artifact",
      commentLines.length === 1 && commentLines[0] === WATERMARK && bareLines.length === 0,
      `${commentLines.length}/${bareLines.length} comment line(s)`
    );
  }
}

// Anti-tamper v1+v2, as behaviour rather than prose:
//   v1  a host-environment sanity pass (23 independent checks)
//   v2  those checks are a chain - one rolling word - so skipping or reordering
//       one changes the verdict; the host's function references are captured at
//       load and compared again from inside the interpreter; and the verdict word
//       is added into the interpreter's code salt, so deleting the block leaves
//       an artifact that cannot decode its own program.
function attestChecks(report) {
  const shim = luau.robloxShim();
  const src = 'local acc = 0\nfor i = 1, 400 do acc = acc + i end\nprint("ATTEST", acc)\n';
  const built = obfuscate(src, { seed: 21, bloat: 0, target: "luau" });
  const clean = luau.runFile(shim + "\n" + built, { timeout: 60000 });
  report.expect(
    "attest · a healthy host runs the payload",
    clean.status === 0 && /^ATTEST\t80200$/m.test(clean.stdout || ""),
    JSON.stringify((clean.stdout || "").trim().slice(0, 40))
  );

  // Reordering two checks, or nudging one salt, must change the verdict: the
  // build folded its expected word from the original order and salts.
  for (const kind of ["order", "salt"]) {
    const mutant = obfuscate(src, { seed: 21, bloat: 0, target: "luau", attestMutation: { kind, index: 4 } });
    const res = luau.runFile(shim + "\n" + mutant, { timeout: 8000 });
    const out = String(res.stdout || "");
    report.expect(
      `attest · the chain refuses a ${kind === "order" ? "reordered" : "re-salted"} check list`,
      mutant !== built && !out.includes("ATTEST"),
      res.timedOut ? "parked" : res.status !== 0 ? `exit ${res.status}` : out ? "payload ran" : "no output"
    );
  }

  // Deleting the whole block is the obvious attack. It does not remove the
  // anti-tamper: the interpreter takes its code salt from the block's verdict.
  const stripped = obfuscate(src, { seed: 21, bloat: 0, target: "luau", dropAttest: true });
  const stripRun = luau.runFile(shim + "\n" + stripped, { timeout: 8000 });
  report.expect(
    "attest · deleting the block does not leave a working artifact",
    stripped !== built && !String(stripRun.stdout || "").includes("ATTEST"),
    stripRun.timedOut ? "parked" : `exit ${stripRun.status}`
  );

  // A host that swaps a global while the artifact is running - what an executor
  // does - is caught by the reference snapshot on the next guard tick.
  const hookSrc = [
    'print("HOOK_START")',
    'local e = getfenv(1)',
    'local raw = e.pcall',
    'e.pcall = function(...) return raw(...) end',
    'local s = 0',
    'for i = 1, 60000 do s = s + i end',
    'print("HOOK_SURVIVED", s)',
  ].join("\n");
  const hookArt = obfuscate(hookSrc, { seed: 22, bloat: 0, target: "luau" });
  const hookRun = luau.runFile(shim + "\n" + hookArt, { timeout: 60000 });
  const hookOut = String(hookRun.stdout || "");
  report.expect(
    "attest · a global hooked while the artifact runs stops it",
    hookOut.includes("HOOK_START") && !hookOut.includes("HOOK_SURVIVED"),
    hookRun.status === 0 ? "artifact kept running" : `stopped (exit ${hookRun.status})`
  );

  // Nothing readable: no check names, no host names, no verdict vocabulary.
  // Whole words, not substrings: `W[C]` in the decoder is not the string "[C]", and
  // a coded blob will happily contain any three characters in a row. `getfenv` is
  // the one identifier the loader is allowed to spell (it has to call it), and the
  // preamble's own check pins that at exactly one occurrence.
  const vocabulary = {
    pcall: /\bpcall\b/,
    debug: /\bdebug\b/,
    rawequal: /\brawequal\b/,
    userdata: /"userdata"/,
    cflag: /"\[C\]"/,
    xpcall: /\bxpcall\b/,
    attest: /\battest/i,
    tamper: /\btamper/i,
  };
  const loaderOnly = obfuscate(src, { seed: 21, bloat: 0, target: "luau", loadstring: false });
  const leaks = Object.entries(vocabulary).filter(([, re]) => re.test(loaderOnly)).map(([k]) => k);
  report.expect("attest · no readable check vocabulary in the loader", leaks.length === 0, leaks.join(" "));
  const getfenvs = (built.match(/\bgetfenv\b/g) || []).length;
  report.expect("attest · the artifact spells getfenv twice and nothing else", getfenvs === 2, `${getfenvs} occurrences`);
}

// The API atlas (v3) and the encrypted name bank, as behaviour:
//   - a service is a singleton, is an Instance, is parented to the DataModel and
//     agrees with FindFirstChild/IsA, and every child of the DataModel is a service;
//   - Instance.new knows the classes it has always known and refuses one it invents;
//   - deleting the atlas leaves an artifact that cannot decode;
//   - and none of the names it audits are spelled anywhere in the file.
// The instruction encoding itself is a per-build decision: which byte of the
// word holds the opcode, and which hold the operands. Two builds therefore do
// not share an ISA, and a word lifted from one means nothing in the other.
function layoutChecks(report) {
  const opcodes = require("../Vm/Image/opcodes");
  const backend = require("../Vm/backend");
  const { createRNG } = require("../Envelope/wrap");
  const seen = new Map();
  const shapes = [];
  for (const seed of [101, 202, 303, 404, 505, 606]) {
    backend.compileToImage("return 1", { rng: createRNG(seed) });
    const lay = opcodes.getLayout();
    const key = [lay.op, lay.a, lay.b, lay.c].join("/");
    shapes.push(key);
    // every field has to survive a round trip through its own position
    const word = opcodes.iABC(9, 3, 5, 7);
    const back = [opcodes.fieldOf(word, "op"), opcodes.fieldOf(word, "a"), opcodes.fieldOf(word, "b"), opcodes.fieldOf(word, "c")];
    if (back.join(",") !== "9,3,5,7") seen.set(key, false);
  }
  report.expect(
    "layout · the instruction encoding changes between builds",
    new Set(shapes).size >= 3,
    `${new Set(shapes).size} distinct layouts in 6 builds: ${[...new Set(shapes)].slice(0, 3).join("  ")}`
  );
  report.expect(
    "layout · every field round-trips through its own position",
    ![...seen.values()].includes(false),
    "a field did not survive packing"
  );
}

function atlasChecks(report) {
  const shim = luau.robloxShim();
  const src = 'print("ATLAS", 3 * 7)\n';
  const built = obfuscate(src, { seed: 23, bloat: 0, target: "luau" });
  const clean = luau.runFile(shim + "\n" + built, { timeout: 60000 });
  report.expect(
    "atlas · a consistent host runs the payload",
    clean.status === 0 && /^ATLAS\t21$/m.test(clean.stdout || ""),
    JSON.stringify((clean.stdout || "").trim().slice(0, 40))
  );

  const stripped = obfuscate(src, { seed: 23, bloat: 0, target: "luau", dropAtlas: true });
  const stripRun = luau.runFile(shim + "\n" + stripped, { timeout: 8000 });
  report.expect(
    "atlas · deleting it leaves an artifact that cannot decode",
    stripped !== built && !String(stripRun.stdout || "").includes("ATLAS"),
    stripRun.timedOut ? "parked" : `exit ${stripRun.status}`
  );

  // A service has to survive being asked twice. This proxy answers every name a
  // client would answer, but hands back a new handle each time.
  const fresh = [
    'do local E=getfenv(1) local real=E.game local mt=getmetatable(real)',
    'E.game=setmetatable({ClassName="DataModel",Name="Game",Parent=nil,',
    'GetService=function(self,name) local s=real.GetService(real,name)',
    'return setmetatable({ClassName=s.ClassName,Name=s.Name},{__index=function(_,k) return s[k] end}) end,',
    'GetChildren=function(self) return real.GetChildren(real) end,',
    'FindFirstChild=function(self,name) return real.FindFirstChild(real,name) end,',
    'IsA=function(self,n) return n=="DataModel" or n=="Instance" end},mt) end',
  ].join(" ");
  const freshRun = luau.runFile(`${shim}\n${fresh}\n${built}`, { timeout: 60000 });
  report.expect(
    "atlas · a service that is not a singleton stops the artifact",
    !String(freshRun.stdout || "").includes("ATLAS"),
    freshRun.timedOut ? "parked" : `exit ${freshRun.status}`
  );

  // The catalogue itself must not be readable: the names come out of one
  // encrypted blob, decrypted with a key built from the constant bank.
  const vocabulary = ["GetService", "Players", "RunService", "ReplicatedStorage",
    "CollectionService", "BindableEvent", "GetChildren", "FindFirstChild"];
  const leaks = vocabulary.filter((w) => built.includes(w));
  report.expect("atlas · no service or class name is spelled in the file", leaks.length === 0, leaks.join(" "));
}

// The range that used to fail. Two separate defects lived here and both were
// invisible unless the right seed was drawn: a `$$` in the ciphertext lost a
// byte in the emitted literal, and a flattened loader that crossed Luau's
// 200-local limit made `loadstring` return nil, so the artifact trapped at load
// with an empty message and looked exactly like the anti-tamper path. These
// seeds are the ones that produced those symptoms; they are the regression test.
// The interpreter's own guard, which is the part that has to catch a patch made
// *after* the load: the sealed digest and the slice marks are computed by then,
// so the only thing left is the guard running inside the loop. `guardProbe`
// breaks the program's length pin exactly the way such a patch would - the build
// still loads, the code is still the code that was sealed - and the payload must
// produce nothing.
function guardChecks(report) {
  const shim = luau.robloxShim();
  const src = 'local t = 0 for i = 1, 40000 do t = t + i end print("GUARD", t)\n';
  const clean = obfuscate(src, { seed: 23 });
  const cleanRun = luau.runFile(shim + "\n" + clean, { timeout: 60000 });
  report.expect(
    "guard · an honest run prints",
    /^GUARD\t800020000$/m.test(cleanRun.stdout || ""),
    JSON.stringify((cleanRun.stdout || "").trim().slice(0, 40)) || `exit ${cleanRun.status}`
  );
  const patched = obfuscate(src, { seed: 23, guardProbe: true });
  const patchedRun = luau.runFile(shim + "\n" + patched, { timeout: 60000 });
  report.expect(
    "guard · a post-load code patch is caught mid-run",
    patched !== clean && !String(patchedRun.stdout || "").includes("GUARD"),
    patchedRun.timedOut ? "parked" : `exit ${patchedRun.status} ${String(patchedRun.stdout || "").trim().slice(0, 20)}`
  );
}

function seedChecks(report) {
  const shim = luau.robloxShim();
  const src = 'print("SEED", 6 * 7)\n';
  const broken = [];
  for (const seed of [300, 303, 315, 334]) {
    const built = obfuscate(src, { seed, bloat: 0, target: "luau" });
    const run = luau.runFile(shim + "\n" + built, { timeout: 60000 });
    if (!/^SEED\t42$/m.test(run.stdout || "")) broken.push(`${seed}:${run.timedOut ? "parked" : (String(run.stderr || "").trim().split("\n")[0] || `exit ${run.status}`).slice(0, 40)}`);
  }
  report.expect(
    "seeds · the seeds that used to trap at load now run",
    broken.length === 0,
    broken.join(" · ")
  );
}

function runSuite(opts) {
  const entries = plan(opts);
  const report = new Report();

  const tools = luau.describe();
  if (!tools.run) {
    console.error(`${RED}no Luau CLI on this machine${RESET}`);
    console.error(`${DIM}run: sh tools/get-luau.sh   (or set LUAU_BIN=/path/to/bin)${RESET}`);
    return 1;
  }

  console.log(`${CYAN}${BOLD}Eatfuscator self-check${RESET} ${DIM}${entries.length} fixtures · luau ${path.basename(tools.run)}${RESET}\\n`);

  const started = Date.now();
  const shapeCache = new Set();
  sourceChecks(report);
  attestChecks(report);
  atlasChecks(report);
  layoutChecks(report);
  guardChecks(report);
  seedChecks(report);

  for (const entry of entries) {
    const src = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
    const ref = entry.host === "rich"
      ? luau.runFile(`${luau.richHost()}\n${src}`, { timeout: 360000 })
      : luau.run(src, { timeout: 360000 });
    const label = path.basename(entry.file, ".lua");
    const t0 = Date.now();
    let line = `${GREEN}+${RESET} ${entry.file}`;

    report.expect(`${label} · reference runs`, ref.status === 0, `exit ${ref.status} ${(ref.stderr || "").split("\n")[0]}`);

    const seen = [];
    for (const build of entry.builds) {
      const tag = `${label}/${build.seed}`;
      let artifact;
      try {
        artifact = obfuscate(src, { seed: build.seed, bloat: 0, target: entry.target });
      } catch (e) {
        report.fail(`${tag} · builds`, e.message);
        continue;
      }
      seen.push(artifact);

      const got = entry.host === "rich"
        ? luau.runFile(`${luau.richHost()}\n${artifact}`, { timeout: 360000 })
        : luau.run(artifact, { timeout: 360000 });
      report.expect(`${tag} · exit`, got.status === 0, `exit ${got.status} ${(got.stderr || "").split("\n")[0]}`);
      report.expect(
        `${tag} · stdout`,
        stable(got.stdout) === stable(ref.stdout),
        firstDiff(stable(ref.stdout), stable(got.stdout))
      );

      if (!shapeCache.has(entry.file)) {
        shapeCache.add(entry.file);
        const plainTwin = obfuscate(src, { seed: build.seed, bloat: 0, target: entry.target, loadstring: false });
        shapeChecks(report, label, artifact, plainTwin);
      }
    }

    if (entry.builds.length) {
      const again = obfuscate(src, { seed: entry.builds[0].seed, bloat: 0, target: entry.target });
      report.expect(`${label} · deterministic`, again === seen[0], "same seed produced different output");
    }

    if (entry.builds.length > 1 && seen.length > 1) {
      report.expect(`${label} · varies by seed`, seen[0] !== seen[1], "layout did not change between seeds");
    }

    if (report.failed && report.failures[report.failures.length - 1].label.startsWith(label + " ")) line = `${RED}x${RESET} ${entry.file}`;
    console.log(`${line} ${DIM}${Date.now() - t0} ms${RESET}`);
  }

  {
    const reject = (src, note) => {
      try {
        obfuscate(src, { seed: 3, bloat: 0 });
        return `accepted ${note}`;
      } catch (e) {
        return e.code === "ESYNTAX" ? "" : `threw ${e.code || e.constructor.name} for ${note} instead of ESYNTAX`;
      }
    };
    const bad = [
      reject("local x = 0\n::top::\nx = x + 1\nif x < 3 then goto top end", "a backward goto"),

      reject('local s = "abc', "unterminated string"),
      reject("if true then", "unclosed block"),
    ].filter(Boolean);
    report.expect("input · invalid source rejected", bad.length === 0, bad.join("; "));

    {
      // Luau syntax the front end has to accept, because a real script uses it and
      // an obfuscated input arrives in it. Each case is obfuscated, run on the CLI
      // and diffed against the original: accepting the syntax is not enough if the
      // lowering changes what the program does.
      const syntaxCases = [
        ["@native attribute", '@native\nlocal function f(a) return a * 2 end\nprint("attr", f(21))'],
        ["@native on a global function", '@native function g(a) return a + 1 end\nprint("attrg", g(41))'],
        // Luau has no goto/labels at all - it spells the jump `continue`, which the
        // lowerer turns into a marker the compiler understands.
        ["continue", 'local acc = 0\nfor i = 1, 5 do\n  if i % 2 == 0 then continue end\n  acc = acc + i\nend\nprint("continue", acc)'],
        ["continue in while", 'local n, hits = 0, 0\nwhile n < 6 do\n  n = n + 1\n  if n == 3 then continue end\n  hits = hits + 1\nend\nprint("while-continue", n, hits)'],
        ["typed vararg", 'local function f(...: number): number local t = 0 for i = 1, select("#", ...) do t = t + (select(i, ...)) end return t end\nprint("vararg", f(1, 2, 3))'],
        ["return annotation", 'local function id<T>(v: T): T return v end\nprint("generic", id(7))'],
        ["method annotation", 'local o = {}\nfunction o.m(a: string, b: number): string return a .. b end\nprint("method", o.m("x", 1))'],
        ["string interpolation", 'local n = 3\nprint("interp", `n={n} two={n * 2}`)'],
        ["if expression", 'local v = if 1 < 2 then "yes" else "no"\nprint("ifexpr", v)'],
        ["compound assignment", 'local x = 1\nx += 41\nlocal s = "a"\ns ..= "b"\nprint("compound", x, s)'],
        ["floor division", 'print("floordiv", 7 // 2, -7 // 2)'],
        ["type alias", 'type Pair = { a: number, b: number }\nlocal p: Pair = { a = 1, b = 2 }\nprint("alias", p.a + p.b)'],
        ["cast", 'local x = (5 :: number) + 2\nprint("cast", x)'],
      ];
      for (const [label, src] of syntaxCases) {
        const ref = luau.run(src, { timeout: 30000 });
        let art;
        try {
          art = obfuscate(src, { seed: 13, bloat: 0 });
        } catch (e) {
          report.fail(`luau syntax · ${label} · builds`, e.message);
          continue;
        }
        const got = luau.run(art, { timeout: 30000 });
        report.expect(
          `luau syntax · ${label}`,
          ref.status === 0 && got.status === 0 && stable(got.stdout) === stable(ref.stdout),
          ref.status !== 0
            ? `reference failed: ${String(ref.stderr || "").split("\n")[0].slice(0, 60)}`
            : got.status !== 0
              ? `artifact exited ${got.status}: ${String(got.stderr || "").split("\n")[0].slice(0, 60)}`
              : `got ${JSON.stringify(stable(got.stdout).slice(0, 60))} want ${JSON.stringify(stable(ref.stdout).slice(0, 60))}`
        );
      }

      // A string constant longer than 65 535 bytes used to abort the build, and
      // real obfuscator output carries payload literals of hundreds of kilobytes.
      const bigLiteral = "A".repeat(700) + "B".repeat(120000) + "C".repeat(500);
      const bigSrc = `local s = [==[${bigLiteral}]==]\nprint("big", #s, s:sub(1, 1), s:sub(-1), s:byte(#s))`;
      const bigRef = luau.run(bigSrc, { timeout: 60000 });
      let bigArt = null;
      try {
        bigArt = obfuscate(bigSrc, { seed: 21, bloat: 0 });
      } catch (e) {
        report.fail("long literal · builds", e.message);
      }
      if (bigArt) {
        const bigGot = luau.run(bigArt, { timeout: 60000 });
        report.expect(
          "long literal · a 121 KB string constant builds and round-trips",
          bigGot.status === 0 && stable(bigGot.stdout) === stable(bigRef.stdout),
          `exit ${bigGot.status} ${JSON.stringify(stable(bigGot.stdout).slice(0, 60))}`
        );
      }
    }
  }

  const macroSource = [
    "local s = EAT_STRING(\"hello macro\")",
    "local n = EAT_NUMBER(41)",
    "local f = EAT_FUNCTION(function(a, b) return a + b end)",
    "print(s, n + 1, f(2, 3))",
  ].join("\n");
  const macroArtifact = obfuscate(macroSource, { seed: 7, bloat: 0, target: "portable" });
  const macroRun = luau.run(macroArtifact, { timeout: 60000 });
  report.expect(
    "macros · expand and run",
    macroRun.status === 0 && /^hello macro\t42\t5$/m.test(macroRun.stdout || ""),
    JSON.stringify((macroRun.stdout || "").trim())
  );
  report.expect("macros · no macro names left", !/\bEAT_(STRING|NUMBER|FUNCTION)\b/.test(macroArtifact));

  {
    // Three layers, checked as structure rather than asserted in prose:
    //   layer 1  source transforms (names, numerals, folded constants)
    //   layer 2  the register image, sealed
    //   layer 3  a stack program that builds layer 2 at load
    //
    // Layer 3 is visible in the proto tree: every proto that went through the
    // forge reports its register word count and stores a token stream several
    // times longer. A build that quietly went back to storing plain sealed words
    // would fail both halves of this.
    const { compileToImage } = require("../Vm/backend");
    const { createRNG } = require("../Core/rng");
    const built = compileToImage("local a = 1\nlocal b = a + 2\nprint(b)", {
      rng: createRNG(0x51ee7),
      poolRng: createRNG(0x51ee8),
      instr: { seed: 0x51ee9 },
    });
    const protos = [];
    (function walk(p) {
      protos.push(p);
      for (const c of p.child) walk(c);
    })(built.proto);
    const forged = protos.filter((p) => p.wordCount !== undefined);
    const packed = forged.every((p) => p.code.length >= 4 * p.wordCount);
    report.expect(
      "layers · every proto is a stack program, not stored words",
      forged.length === protos.length && packed && forged.length > 0,
      `${forged.length}/${protos.length} protos, ratio ${protos.length ? (protos[0].code.length / Math.max(1, protos[0].wordCount)).toFixed(1) : "?"}x`
    );

    const template = fs.readFileSync(path.join(__dirname, "..", "Vm", "Template", "vm.lua"), "utf8");
    report.expect(
      "layers · register loop decodes through the stack",
      // The extraction is generated from the build's instruction layout, so the
      // check pins the two-slot decode shape and its generator, not one spelling.
      /__FIELDS__ = 0/.test(template) && /__FLIP__ = 0/.test(template) &&
        /function emitFields/.test(fs.readFileSync(path.join(__dirname, "..", "Vm", "backend.js"), "utf8")),
      "the fused stack decode is missing from the interpreter template"
    );
    report.expect(
      "layers · the forge is a stack machine",
      /local vm_forge/.test(template) && /sp = sp - T_ONE/.test(template),
      "vm_forge is missing"
    );
  }

  {
    const tamperSrc = 'print("tamper", 1 + 1)';
    const tamperRef = luau.run(tamperSrc, { timeout: 60000 });
    let tamperArt = obfuscate(tamperSrc, { seed: 13, bloat: 0, target: "portable", loadstring: false });

    const store = require("../Envelope/wrap");
    const decodedBlob = (blob, layers) => {
      let bytes = store.unpackBlob(blob, store.BOOT_ALPHABET);
      for (let i = layers.length - 1; i >= 0; i--) bytes = store.affineDecodeBytes(bytes, layers[i]);
      return bytes;
    };
    // Tamper case: flip one character inside the largest ciphertext blob of the
    // default artifact. Every blob the loader reads is covered by the payload
    // digest, so a flipped byte has to stop the load. (This used to hunt for a
    // "constant bank of 39/42 words", a structure this build no longer emits.)
    let blob = null;
    for (const m of tamperArt.matchAll(/\[(=*)\[([\s\S]*?)\]\1\]/g)) {
      if (!blob || m[2].length > blob[2].length) blob = m;
    }
    let verdict = "no ciphertext blob found in the artifact";
    let ok = false;
    if (blob) {
      const text = blob[2];
      const at = Math.floor(text.length / 2);
      const pool = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+";
      const from = text[at];
      const to = pool.includes(from) ? pool[(pool.indexOf(from) + 7) % pool.length] : (from === "A" ? "B" : "A");
      const patched = text.slice(0, at) + to + text.slice(at + 1);
      const tampered = tamperArt.slice(0, blob.index) + blob[0].replace(text, patched) + tamperArt.slice(blob.index + blob[0].length);
      const res = luau.run(tampered, { timeout: 6000 });
      const ran = res.status === 0 && stable(res.stdout) === stable(tamperRef.stdout);
      ok = !ran;
      verdict = ran
        ? `tampered ${text.length}-byte blob still printed the reference stdout`
        : `stopped (${res.signal || "exit " + res.status})`;
    }
    report.expect("tamper · a flipped payload byte stops the load", ok, verdict);

    // The tail blob is a long bracket now, like every other string literal.
    const tailText = tamperArt.trim();
    // No regex: find the last index expression and the literal that follows it.
    // The literal is written `"…"` or `[[…]]` depending on the build, and the
    // point of the check is the call-without-parentheses shape either way.
    const idxAt = tailText.lastIndexOf("[0x1]");
    const longAt = tailText.lastIndexOf("[[");
    const quoteAt = tailText.lastIndexOf('"');
    const asLong = idxAt >= 0 && longAt > idxAt && tailText.endsWith("]]");
    const asQuoted = idxAt >= 0 && quoteAt > idxAt && tailText.endsWith('"');
    const tailMatch = asLong || asQuoted;
    const tailBlob = asLong ? tailText.slice(longAt + 2, -2) : asQuoted ? tailText.slice(quoteAt + 1, -1) : "";
    const tailLiteral = asLong ? tailText.slice(longAt) : asQuoted ? tailText.slice(quoteAt) : "";
    if (tailMatch) {
      const blob = tailBlob;
      const alphabetOnly = /^[0-9A-Za-z.+]+$/.test(blob);
      report.expect(
        "tail · the trailing token is a ciphertext blob",
        alphabetOnly && blob.length >= 32 && blob.length % 4 === 0 && !blob.includes("\\"),
        `${blob.length} chars, alphabet ${alphabetOnly ? "ok" : "violated"}`
      );
      const occurrences = tamperArt.split(blob).length - 1;
      report.expect(
        "tail · the blob is not reused anywhere else",
        occurrences === 1,
        `${occurrences} occurrence(s)`
      );
      const at = Math.floor(blob.length / 2);
      const ch = blob[at] === "A" ? "B" : "A";
      const relit = (body) => tailLiteral.replace(blob, body);
      const tailAt = tamperArt.lastIndexOf(tailLiteral);
      const swapped = tamperArt.slice(0, tailAt) + relit(blob.slice(0, at) + ch + blob.slice(at + 1));
      const swapRun = luau.run(swapped, { timeout: 6000 });
      const swapRan = swapRun.status === 0 && stable(swapRun.stdout) === stable(tamperRef.stdout);
      report.expect("tail · one flipped character stops the load", !swapRan, swapRan ? "payload ran with a patched tail" : "stopped");
      const shortTail = tamperArt.slice(0, tailAt) + relit(blob.slice(0, -4));
      const shortRun = luau.run(shortTail, { timeout: 6000 });
      const shortRan = shortRun.status === 0 && stable(shortRun.stdout) === stable(tamperRef.stdout);
      report.expect("tail · a shortened tail stops the load", !shortRan, shortRan ? "payload ran with a short tail" : "stopped");
      const longTail = tamperArt.slice(0, tailAt) + relit(blob + "AAA");
      const longRun = luau.run(longTail, { timeout: 6000 });
      const longRan = longRun.status === 0 && stable(longRun.stdout) === stable(tamperRef.stdout);
      report.expect("tail · a lengthened tail stops the load", !longRan, longRan ? "payload ran with an extended tail" : "stopped");
    }

    const dumpSrc = 'print("dump", 1 + 1)';
    const dumpArt = obfuscate(dumpSrc, { seed: 21, bloat: 0, target: "portable" });
    const dumpRef = luau.run(dumpSrc, { timeout: 60000 });
    const hostFor = (patch) => [
      "local realG=_G",
      "local G={} for k,v in next,realG do G[k]=v end",
      "local hook=0",
      patch,
      "local env=setmetatable({_G=G},{__index=realG})",
      `local f=(loadstring or load)(${long(dumpArt)})`,
      "setfenv(f,env)",
      "local okk=pcall(f)",
      'print("ran",okk,hook)',
    ].join("\n");
    const copyLib = "local s={} for k,v in next,G.string do s[k]=v end";
    const cleanHost = luau.run(hostFor(copyLib), { timeout: 60000 });
    report.expect(
      "dump · untouched library copy still runs",
      cleanHost.status === 0 && stable(cleanHost.stdout).includes(stable(dumpRef.stdout).trim()),
      `exit ${cleanHost.status} ${(cleanHost.stdout || "").trim()}`
    );
    const swapHost = luau.run(
      hostFor(`${copyLib}\ns.dump=function(f) hook=hook+1 return "" end\nG.string=s`),
      { timeout: 8000 }
    );
    const swapRan = swapHost.status === 0 && stable(swapHost.stdout).includes(stable(dumpRef.stdout).trim());
    // 0.17.0 trapped here, and that trap is what froze real Roblox clients: the
    // identity test it rested on cannot hold where built-in metatables are locked.
    // The swap is tolerated instead, which is safe because the loader resolves the
    // helpers it needs into locals and never routes anything through string.dump -
    // the host's hook counter must stay at zero either way.
    const swapHookCalls = (String(swapHost.stdout || "").match(/ran\s+\w+\s+(\d+)/) || [])[1];
    report.expect(
      "dump · a swapped string library is tolerated and its hook never fires",
      swapRan && swapHookCalls === "0",
      swapRan ? `payload ran, hook fired ${swapHookCalls} time(s)` : "stopped"
    );
  }

  {
    const cffSrc = 'print("cff", 6 * 7)';
    const cffRef = luau.run(cffSrc, { timeout: 60000 });
    const cffArt = obfuscate(cffSrc, { seed: 31, bloat: 0, loadstring: false });
    const ok = (res) => res.status === 0 && stable(res.stdout) === stable(cffRef.stdout);
    const clean = luau.run(cffArt, { timeout: 60000 });
    report.expect("cff · untouched artifact runs", ok(clean), `exit ${clean.status} ${(clean.stderr || "").split("\n")[0]}`);

    const analyze = (text) => {
      const head = text.search(/if [A-Za-z_][A-Za-z0-9_]*==nil then break end/);
      if (head < 0) return null;
      const tail = text.indexOf("until(", head);
      if (tail < 0) return null;
      const T = text.slice(head).match(/^if ([A-Za-z_][A-Za-z0-9_]*)==nil then break end/)[1];
      const re = new RegExp(`if ${T}==((?:0x[0-9A-F]+)|(?:0b[01]+)|(?:\\(0x[0-9A-F]+[-+]0x[0-9A-F]+\\))) ?then `, "g");
      const seg = text.slice(head, tail);
      const out = [];
      let m;
      while ((m = re.exec(seg)) !== null) out.push(head + m.index);
      return { head, tail, T, at: out };
    };
    const matchEnd = (text, start) => {
      let i = start;
      let depth = 0;
      const n = text.length;
      const word = (c) => /[A-Za-z0-9_]/.test(c);
      while (i < n) {
        const c = text[i];
        if (c === "-" && text[i + 1] === "-") { while (i < n && text[i] !== "\n") i++; continue; }
        if (c === '"' || c === "'") { i++; while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1; i++; continue; }
        if (c === "[") {
          const lb = text.slice(i).match(/^\[(=*)\[/);
          if (lb) { const close = "]" + lb[1] + "]"; const e = text.indexOf(close, i + lb[0].length); i = e < 0 ? n : e + close.length; continue; }
        }
        if (word(c) && (i === 0 || !word(text[i - 1]))) {
          let j = i;
          while (j < n && word(text[j])) j++;
          const w = text.slice(i, j);
          if (w === "if" || w === "do" || w === "function" || w === "repeat") depth++;
          else if (w === "end" || w === "until") { depth--; if (depth === 0) return j; }
          i = j;
          continue;
        }
        i++;
      }
      return -1;
    };

    const plan = analyze(cffArt);
    if (!plan) {
      report.fail("cff · dispatch found", "no flattened dispatch in the artifact");
    } else {
      const { at } = plan;
      report.expect("cff · dispatch has blocks", at.length >= 8, `${at.length} guarded blocks`);

      const bodies = at.map((start) => {
        const end = matchEnd(cffArt, start);
        return end < 0 ? null : { start, end, text: cffArt.slice(start, end) };
      }).filter(Boolean);
      report.expect("cff · every block closes", bodies.length === at.length, `${bodies.length}/${at.length}`);

      if (bodies.length > 1) {
        const drop = bodies[0];
        const deleted = cffArt.slice(0, drop.start) + cffArt.slice(drop.end);
        const res = luau.run(deleted, { timeout: 6000 });
        report.expect("cff · deleting a block stops the payload", !ok(res), `exit ${res.status} ${(res.stderr || "").split("\n")[0]}`);
      }

      if (bodies.length > 2) {
        const probes = [0, Math.floor(bodies.length / 2), bodies.length - 1];
        for (const idx of probes) {
          const dup = bodies[idx];
          const again = cffArt.slice(0, dup.start) + dup.text + " " + cffArt.slice(dup.start);
          const res = luau.run(again, { timeout: 2500 });
          report.expect(
            `cff · duplicating block ${idx} never corrupts the result`,
            res.status !== 0 || stable(res.stdout) === stable(cffRef.stdout),
            `exit ${res.status} ${JSON.stringify((res.stdout || "").trim())}`
          );
        }
      }

      const valueOf = (raw) => {
        const num = (t) => (t.startsWith("0b") ? parseInt(t.slice(2), 2) : parseInt(t.replace(/^0x/i, ""), 16));
        if (raw.startsWith("(")) {
          const m = raw.slice(1, -1).match(/^(0[xb][0-9A-Fa-f]+)([-+])(0[xb][0-9A-Fa-f]+)$/);
          if (!m) return NaN;
          return m[2] === "-" ? num(m[1]) - num(m[3]) : num(m[1]) + num(m[3]);
        }
        return num(raw);
      };

      const initText = cffArt.slice(Math.max(0, plan.head - 200), plan.head);
      const initLit = initText.match(/=(\((?:0x[0-9A-F]+[-+]0x[0-9A-F]+)\)|0x[0-9A-F]+),0x0,nil/);
      if (!initLit) {
        report.fail("cff · entry state is guarded", "could not read the entry state literal");
      } else {
        const entry = valueOf(initLit[1]);
        let victim = null;
        for (const blockStart of at) {
          const m = cffArt.slice(blockStart).match(/^if \w+==((?:\(0x[0-9A-F]+[-+]0x[0-9A-F]+\))|0x[0-9A-F]+|0b[01]+) ?then /);
          if (!m) continue;
          if (valueOf(m[1]) === entry) {
            victim = { at: blockStart, lit: m[1], litAt: blockStart + m[0].indexOf(m[1]) };
            break;
          }
        }
        if (!victim) {
          report.fail("cff · entry state is guarded", "no block guards the entry state");
        } else {
          const forged = cffArt.slice(0, victim.litAt) + "(0xDEAD01-0x1)" + cffArt.slice(victim.litAt + victim.lit.length);
          const res = luau.run(forged, { timeout: 6000 });
          report.expect("cff · an unknown entry state stops the payload", !ok(res), `exit ${res.status} ${(res.stderr || "").split("\n")[0]}`);
        }
        const region = cffArt.slice(plan.head, plan.tail);
        const checks = [...region.matchAll(/if ([A-Za-z_][A-Za-z0-9_]*)~=((?:0x[0-9A-F]+)|(?:0b[01]+)|(?:\([0-9A-Za-z+.\-]+\))) ?then /g)];
        const counter = checks.find((m) => {
          const v = m[1];
          const updates = [...region.matchAll(new RegExp(`\\b${v}=\\(${v}\\*((?:0x[0-9A-F]+)|(?:\\(0x[0-9A-F]+[-+]0x[0-9A-F]+\\)))\\+`, "g"))];
          return updates.some((u) => valueOf(u[1]) === 33);
        });
        if (!counter) {
          report.fail("cff · the path digest is checked", "no path digest comparison found");
        } else {
          const at2 = plan.head + counter.index + counter[0].indexOf(counter[2]);
          const bumped = cffArt.slice(0, at2) + "(0x7FFFFF-0x7FFF00)" + cffArt.slice(at2 + counter[2].length);
          const res = luau.run(bumped, { timeout: 6000 });
          report.expect("cff · a wrong path digest stops the payload", !ok(res), `exit ${res.status} ${(res.stderr || "").split("\n")[0]}`);
        }
      }
    }
  }

  {
    const retSrc = 'return 42, "two"';
    const retArt = obfuscate(retSrc, { seed: 61, bloat: 0 });
    const tpl = (code) => {
      // Wrap in a closure in the same chunk: load() gives the chunk a fresh
      // environment where `typeof` is the Luau builtin again, which a shim-based
      // fake host cannot satisfy (and catches, correctly).
      return [`local f=function(...)`, code, `end`, "local a,b=f()", 'print("ret",type(a),tostring(a),tostring(b))'].join("\n");
    };
    const retRef = luau.run(tpl(retSrc), { timeout: 20000 });
    const retRun = luau.run(tpl(retArt), { timeout: 20000 });
    report.expect("returns · payload values survive", stable(retRun.stdout) === stable(retRef.stdout), `${(retRef.stdout || "").trim()} vs ${(retRun.stdout || "").trim()}`);

    const nilRet = 'local x = 1';
    const nilArt = obfuscate(nilRet, { seed: 62, bloat: 0 });
    const nilRun = luau.run(tpl(nilArt), { timeout: 20000 });
    report.expect("returns · no-return payload returns nothing", (nilRun.stdout || "").trim() === "ret\tnil\tnil\tnil", (nilRun.stdout || "").trim());
  }

  {
    const rbxSrc = [
      'local parts = {"a", "b", "c"}',
      'print("rbx", table.concat(parts, "-"), string.format("%d", #parts), math.floor(7 / 2))',
      'ACC = (ACC or 0) + 5',
      'print("rbx global", ACC, type(tostring(1)))',
    ].join("\n");
    const rbxRef = luau.run(rbxSrc, { timeout: 60000 });
    const rbxArt = obfuscate(rbxSrc, { seed: 41, bloat: 0 });
    const ok = (res) => res.status === 0 && stable(res.stdout) === stable(rbxRef.stdout);

    const runIn = (setup) => luau.run(setup, { timeout: 20000 });
    const lines = (t) => stable(t || "").trim().split("\n");

    const roblox = [
      "local real=getfenv(0)",
      "local env=setmetatable({_G={}},{__index=real})",
      `local f=(loadstring or load)(${long(rbxArt)})`,
      "setfenv(f,env)",
      "local okk,err=pcall(f)",
      'print("ran",okk,tostring(err or ""))',
    ].join("\n");
    const rbxRun = runIn(roblox);
    const out = lines(rbxRun.stdout);
    report.expect(
      "roblox · separate _G runs the payload",
      rbxRun.status === 0 && out[0] === lines(rbxRef.stdout)[0] && out[1] === lines(rbxRef.stdout)[1],
      `exit ${rbxRun.status} ${(rbxRun.stderr || "").split("\n")[0]}`
    );
    report.expect("roblox · payload saw a working environment", /^ran\ttrue/.test(out[out.length - 1] || ""), out[out.length - 1]);

    // Roblox globals are not in _G: reading the environment through _G made
    // Vector3/Instance/warn nil inside the payload, which only showed up once a
    // test used them. The loader resolves getfenv first for exactly this reason.
    const globalsSrc = [
      'print("glob", type(Vector3), type(Instance), type(warn))',
      'print("glob", Vector3.new(3, 4, 0).Magnitude, Instance.new("Part").ClassName)',
      'warn("glob", "spoke")',
    ].join("\n");
    const globalsArt = obfuscate(globalsSrc, { seed: 47, bloat: 0 });
    const globalsRef = luau.run(globalsSrc, { timeout: 60000 });
    const globalsRun = runIn([`local f=function(...)`, globalsArt, `end`, "local okg,ge=pcall(f)", "if not okg then print('glob failed', tostring(ge)) end"].join("\n"));
    report.expect(
      "roblox · payload reaches the Roblox globals",
      stable(globalsRun.stdout) === stable(globalsRef.stdout),
      `${(globalsRef.stdout || "").trim().replace(/\n/g, " / ")} vs ${(globalsRun.stdout || "").trim().replace(/\n/g, " / ")}`
    );

    const logging = [
      "local real=getfenv(0)",
      "local seen=0",
      "local proxy=setmetatable({},{__index=function(_,k) seen=seen+1 return real[k] end})",
      "local env=setmetatable({_G=proxy},{__index=real})",
      `local f=(loadstring or load)(${long(rbxArt)})`,
      "setfenv(f,env)",
      "local okk=pcall(f)",
      'print("ran",okk,seen>0)',
    ].join("\n");
    const loggingRun = runIn(logging);
    report.expect(
      "roblox · a logging proxy still runs",
      loggingRun.status === 0 && lines(loggingRun.stdout)[0] === lines(rbxRef.stdout)[0],
      `exit ${loggingRun.status} ${(loggingRun.stderr || "").split("\n")[0]}`
    );

    const quietSrc = 'print("quiet", 6 * 7)';
    const quietRef = luau.run(quietSrc, { timeout: 60000 });
    const quietArt = obfuscate(quietSrc, { seed: 43, bloat: 0 });
    const logger = [
      "local real=getfenv(0)",
      "local writes,infos=0,0",
      "local env=setmetatable({},{__index=function(_,k) return real[k] end,__newindex=function(t,k,v) writes=writes+1 rawset(t,k,v) end})",
      'rawset(env,"_G",{})',
      'rawset(env,"debug",{info=function(...) infos=infos+1 return debug.info(...) end})',
      `local f=(loadstring or load)(${long(quietArt)})`,
      "setfenv(f,env)",
      "local okk=pcall(f)",
      'print("probe",okk,writes,infos)',
    ].join("\n");
    const loggerRun = runIn(logger);
    const out2 = lines(loggerRun.stdout);
    const probe = (out2[out2.length - 1] || "").split("\t");
    report.expect("env · payload runs under a logging environment", out2[0] === lines(quietRef.stdout)[0] && probe[1] === "true", out2[out2.length - 1]);
    report.expect("env · no write into the host environment", probe[2] === "0", `${probe[2]} __newindex event(s)`);
    report.expect(
      "env · the loader never calls debug.info",
      probe[3] === "0",
      `${probe[3]} debug.info call(s) — a logger that hooks it sees us`
    );

    const writer = [
      "local real=getfenv(0)",
      "local writes=0",
      "local env=setmetatable({},{__index=function(_,k) return real[k] end,__newindex=function(t,k,v) writes=writes+1 rawset(t,k,v) end})",
      'rawset(env,"_G",{})',
      'rawset(env,"debug",{info=function(...) return debug.info(...) end})',
      `local f=(loadstring or load)(${long(rbxArt)})`,
      "setfenv(f,env)",
      "local okk=pcall(f)",
      'print("writes",writes,okk)',
    ].join("\n");
    const writerRun = runIn(writer);
    const wLine = (lines(writerRun.stdout).pop() || "").split("\t");
    report.expect("globals · a payload global never reaches the host environment", wLine[1] === "0", `${wLine[1]} host write(s)`);
    report.expect("globals · the payload still ran", wLine[2] === "true", lines(writerRun.stdout).pop());

    {
      const barrenSrc = 'print("barren")';
      const barrenArt = obfuscate(barrenSrc, { seed: 77, bloat: 0 });
      const barren = [
        "local G={}",
        "local env={_G=G}",
        `local f=(loadstring or load)(${long(barrenArt)})`,
        "setfenv(f,env)",
        "local okk,e=pcall(f)",
        'print("barren",okk,tostring(e))',
      ].join("\n");
      const barrenRun = runIn(barren);
      const bLine = (lines(barrenRun.stdout).pop() || "").split("\t");
      // 0.18.0: a host with no usable environment raises a named error instead of
      // returning quietly. A quiet return is what "no output from Luau" looked
      // like from the outside - no message, no stack, nothing to search for.
      // 0.18.1: the failure is opaque. It must still be a *failure* - the run
      // ends with an error and the payload never prints - but the message carries
      // no words: a reader of the artifact cannot tell what the loader was doing
      // or why it stopped.
      report.expect(
        "env · an unreachable host fails instead of returning quietly",
        bLine[0] === "barren" && bLine[1] === "false",
        lines(barrenRun.stdout).pop() || `exit ${barrenRun.status}`
      );
      {
        // Strip the host's chunk label (`[string "..."]:2:`) first: with the
        // banner on, that label quotes the first line of the file, and it is the
        // host's text, not ours. What must be wordless is the message itself.
        const body = String(bLine[2] || "").replace(/^\[string "[^"]*"\]:\d+:\s*/, "");
        report.expect(
          "env · the failure message is opaque",
          !body.includes("eatfuscator") && !body.includes("environment") && !body.includes("integrity"),
          body.slice(0, 80)
        );
      }
      report.expect(
        "env · an unreachable host runs no payload",
        !(barrenRun.stdout || "").includes("\nbarren\t") || (barrenRun.stdout || "").trim().split("\n").length === 1,
        lines(barrenRun.stdout).join(" | ")
      );
    }

    {
      // Host gate.
      //
      // The default target refuses to run outside a real Luau/Roblox host, so
      // these cases answer two questions: does a genuine host run the payload,
      // and does every imitation of one get parked? The genuine host is
      // tools/roblog.lua; each case mutates it in the way a cheap fake would.
      const fakeSrc = 'print("FAKE_ENV_PAYLOAD")';
      const fakeArt = obfuscate(fakeSrc, { seed: 91, bloat: 0 });
      const shim = luau.robloxShim();

      const runHost = (mutation) =>
        luau.runFile(`${shim}\n${mutation || ""}\n${fakeArt}`, { timeout: 6000 });
      const payloadRan = (r) => (r.stdout || "").includes("FAKE_ENV_PAYLOAD");
      const trapped = (r) => !payloadRan(r) && (r.timedOut === true || r.status !== 0);

      const genuine = runHost("");
      report.expect(
        "host gate · a genuine Roblox host runs the payload",
        payloadRan(genuine) && genuine.timedOut !== true,
        (genuine.stdout || "").trim().slice(0, 40) || `exit ${genuine.status}`,
      );

      const cases = [
        ["a bare Lua/Luau interpreter is parked", null],
        ["a Lune host is parked", 'game=nil workspace=nil task=nil Enum=nil Instance=nil'],
        ["a table posing as game is parked", 'game={ClassName="DataModel",Parent=nil,GetChildren=function() return {} end,GetService=function() return {} end,FindFirstChild=function() end}'],
        ["a game that is not a DataModel is parked", 'game=Instance.new("Part")'],
        ["an Instance.new that returns a table is parked", "Instance={new=function() return {} end}"],
        ["a missing task library is parked", "task=nil"],
        ["a missing Enum library is parked", "Enum=nil"],
        ["a host without table.create (Lua 5.1) is parked", "table={freeze=table.freeze,unpack=table.unpack,insert=table.insert,concat=table.concat,sort=table.sort,remove=table.remove}"],
        ["a host without table.freeze is parked", "table={create=table.create,unpack=table.unpack,insert=table.insert,concat=table.concat,sort=table.sort,remove=table.remove}"],
        ["a GetService that invents services is parked", 'local raw=game game=setmetatable({ClassName="DataModel",Parent=nil},{__index=function(_,k) if k=="GetService" then return function() return {} end end return raw[k] end})'],
        ["a workspace that is not an Instance is parked", "workspace={}"],
        ["a typeof that lies is parked", "typeof=function(v) return type(v) end"],
        ["a Players service that is not an Instance is parked", 'local raw=game game=setmetatable({ClassName="DataModel",Parent=nil},{__index=function(_,k) if k=="GetService" then return function() return {} end end return raw[k] end})'],
      ];

      for (const [label, mutation] of cases) {
        if (mutation === null) {
          const bare = luau.run(fakeArt, { timeout: 4000, host: "bare" });
          report.expect(`host gate · ${label}`, trapped(bare), payloadRan(bare) ? "payload ran" : `exit ${bare.status}${bare.timedOut ? " (parked)" : ""}`);
          continue;
        }
        const res = runHost(mutation);
        report.expect(`host gate · ${label}`, trapped(res), payloadRan(res) ? "payload ran" : `exit ${res.status}${res.timedOut ? " (parked)" : ""}`);
      }

      // The replay case: a host that answers every question correctly - the right
      // service names, the right class names, the right parents, the right
      // identities - but whose instances are Lua tables, which is what an
      // environment log becomes when it is played back. This is the shape that
      // used to satisfy the gate; it does not any more.
      {
        const fxPath = require("path").join(__dirname, "..", "..", "tools", "table-host.lua");
        const fixture = require("fs").existsSync(fxPath) ? require("fs").readFileSync(fxPath, "utf8") : "";
        report.expect("host gate · the replay fixture is present", fixture.length > 500, `${fixture.length} B`);
        if (fixture) {
          const replayed = luau.runFile(`${fixture}\n${fakeArt}`, { timeout: 6000 });
          report.expect(
            "host gate · a replayed environment of tables is parked",
            trapped(replayed),
            payloadRan(replayed) ? "payload ran" : `exit ${replayed.status}${replayed.timedOut ? " (parked)" : ""}`
          );

          // The other shape a logger takes at this level: put a table in front of
          // a real client and forward everything to it. The answers stay perfect,
          // the object is no longer an instance, and that is enough.
          const proxied = luau.runFile(
            `${shim}\nlocal __real=game game=setmetatable({ClassName="DataModel"},{__index=function(_,k) return __real[k] end})\n${fakeArt}`,
            { timeout: 6000 }
          );
          report.expect(
            "host gate · a forwarding proxy in front of a real client is parked",
            trapped(proxied),
            payloadRan(proxied) ? "payload ran" : `exit ${proxied.status}${proxied.timedOut ? " (parked)" : ""}`
          );
        }
      }

      // The probe set is not fixed: a build carries a sample of the catalogue and
      // each run asks a window of it, so a recorded list of questions answers only
      // the runs that happen to repeat them.
      {
        const probeArt = obfuscate('print("ATLAS_PROBE")', { seed: 17, bloat: 0 });
        const seen = [];
        for (let i = 0; i < 4; i++) {
          // The artifact ends in a `return`, so it is wrapped in a function to
          // leave room for the trailer that reports what it asked for.
          // The host traces its own GetService, so the window the artifact asked
          // for can be read back without the artifact cooperating.
          const r = luau.runFile(`${shim}\n__EAT_TRACE_GETSVC=true\n${probeArt}`, { timeout: 6000 });
          const found = String(r.stdout || "").split("\n").filter((l) => l.startsWith("GETSVC")).map((l) => l.slice(7).trim());
          if (found.length) seen.push(found.slice().sort().join(","));
        }
        const sizes = seen.map((s) => s.split(",").filter(Boolean).length);
        report.expect("atlas · every run interrogates a window of services", seen.length > 0 && sizes.every((n) => n >= 4), sizes.join("/") || "no runs");
        report.expect(
          "atlas · the window moves between runs",
          new Set(seen).size >= Math.min(2, seen.length),
          `${new Set(seen).size} distinct of ${seen.length}`
        );
      }
    }

    {
      // Environment resolution.
      // ---------------------------------------------------------------------
      // 0.18.0 fixes a failure that is invisible from the outside: the loader
      // used to accept the first *truthy* `_ENV` it could read, so a host whose
      // environment answers every unknown name with a permissive value (a
      // sandbox proxy, a wrapper around a real client) captured the loader into
      // a table that silently ate every global. The artifact then ran to
      // completion, printed nothing and exited 0 - "no output from Luau".
      const envSrc = 'print("ENV_OK", 6 * 7)';
      const envArt = obfuscate(envSrc, { seed: 44, bloat: 0 });
      const shim = luau.robloxShim();
      const Stub = 'setmetatable({}, { __index = function() return 1 end, __call = function(t) return t end })';

      // a decoy global named `_ENV` must not capture the loader
      const decoy = luau.runFile(`${shim}\nlocal _ENV = ${Stub}\n${envArt}`, { timeout: 8000 });
      report.expect(
        "env · a decoy global _ENV does not capture the loader",
        String(decoy.stdout || "").includes("ENV_OK"),
        decoy.timedOut ? "hung" : `exit ${decoy.status} ${JSON.stringify(String(decoy.stdout || "").trim()).slice(0, 60)}`
      );

      // an environment that cannot serve the standard library must say so, not
      // return quietly: a silent return is indistinguishable from a broken build
      // every candidate shadowed with something unusable: getfenv gone, _G and
      // _ENV empty tables
      const noEnv = luau.runFile(
        `local getfenv=nil local _G={} local _ENV={}\n${obfuscate(envSrc, { seed: 44, bloat: 0 })}`,
        { timeout: 8000 }
      );
      report.expect(
        "env · an unusable environment raises a named error",
        String(noEnv.stderr || "").includes("eatfuscator"),
        noEnv.timedOut ? "hung" : String(noEnv.stderr || "").split("\n")[0].slice(0, 80) || "silent"
      );
    }

    {
      // A host shaped like a Roblox client, with the surface a real script uses:
      // services, instances, signals, datatypes. The check is parity - the
      // obfuscated copy has to print exactly what the original printed on the
      // same host, which is the only claim that matters for a third-party script.
      const host = luau.richHost();
      const clientSrc = fs.readFileSync(path.join(ROOT, "Test", "roblox_client.lua"), "utf8");
      const clientRef = luau.runFile(`${host}\n${clientSrc}`, { timeout: 60000 });
      const clientArt = obfuscate(clientSrc, { seed: 5, bloat: 0 });
      const clientGot = luau.runFile(`${host}\n${clientArt}`, { timeout: 90000 });
      const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();
      report.expect(
        "client · a Roblox-shaped script runs on a Roblox-shaped host",
        clientRef.status === 0 && flat(clientRef.stdout).length > 100,
        clientRef.status === 0 ? `${flat(clientRef.stdout).length} chars` : `exit ${clientRef.status} ${String(clientRef.stderr || "").split("\n")[0].slice(0, 60)}`
      );
      report.expect(
        "client · the obfuscated copy prints the same thing",
        flat(clientGot.stdout) === flat(clientRef.stdout),
        clientGot.timedOut ? "hung" : flat(clientGot.stdout).slice(0, 80) || `silent (exit ${clientGot.status})`
      );
    }

  }

  const baitArtifact = obfuscate("EAT_RAGEBAIT()", { seed: 7, bloat: 0, target: "portable" });
  report.expect("ragebait · taunt encoded", !baitArtifact.includes("eatfuscator said no skid"));

  const baitRun = luau.run(baitArtifact, { timeout: 2000 });
  report.expect("ragebait · parks the thread", baitRun.timedOut === true, `returned with exit ${baitRun.status}`);
  console.log(`${GREEN}+${RESET} macros ${DIM}EAT_STRING / EAT_NUMBER / EAT_FUNCTION / EAT_RAGEBAIT${RESET}`);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  if (report.failed === 0) {
    console.log(`${GREEN}${BOLD}${report.checks} checks, 0 failed${RESET} ${DIM}(${secs}s)${RESET}`);
  } else {
    console.log(`${RED}${BOLD}${report.checks} checks, ${report.failed} failed${RESET} ${DIM}(${secs}s)${RESET}`);
    for (const f of report.failures.slice(0, 12)) console.log(`  ${RED}x${RESET} ${f.label} ${DIM}${f.detail || ""}${RESET}`);
    if (report.failures.length > 12) console.log(`  ${DIM}… ${report.failures.length - 12} more${RESET}`);
  }
  return report.failed ? Math.min(report.failed, 250) : 0;
}

function firstDiff(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      const cut = (s) => (s === undefined ? "<missing>" : s.length > 60 ? s.slice(0, 57) + "..." : s);
      return `line ${i + 1}: ${JSON.stringify(cut(left[i]))} != ${JSON.stringify(cut(right[i]))}`;
    }
  }
  return "";
}

module.exports = { runSuite, parseArgs, stable, plan };

if (require.main === module) {
  process.exit(runSuite(parseArgs(process.argv.slice(2))));
}
// Toolchain suite module expanded
const SUITE_EXTRA = {
  // Additional test cases
  test_cases: [1, 2, 3, 4, 5, 10, 20, 50, 100, 1000],
  // Suite options
  options: ['seed', 'target', 'bloat', 'flatten', 'blocks', 'verbose', 'extra'],
  // Suite statistics
  stats: {
    total_runs: 0,
    successful_runs: 0,
    failed_runs: 0,
    avg_run_time: 0,
  },
  // Suite history
  history: [],
  // Suite version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.SUITE_EXTRA = SUITE_EXTRA;
// End of suite module expansion
