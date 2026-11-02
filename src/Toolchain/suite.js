"use strict";

/**
 * Built-in self-check — dsc.gg/eatfuscator
 *
 * The suite itself contains no test code: every case is a Lua file under
 * `Test/`. This module only drives them through the real toolchain —
 * reference run with the Luau CLI, obfuscate, run the artifact, compare — and
 * adds the shape checks that a Lua chunk cannot perform on itself (watermark,
 * wrapper, hidden anti-tamper, determinism, variability).
 *
 *   node cli.js suite                 full run
 *   node cli.js suite --quick         one seed, one mode, no big fixtures
 *   node cli.js suite --filter=json   only fixtures whose path matches
 *   node cli.js suite --seeds=5,99    pick the seeds
 *
 * Exit code is the number of failed checks (0 = green).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { obfuscate } = require("../Core/obfuscate");
const luau = require("./luaucli");
const { auditFile } = require("../../tools/audit");

const ROOT = path.join(__dirname, "..", "..");
const WATERMARK = "-- Protected By Eatfuscator | dsc.gg/eatfuscator";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function listLua(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".lua"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** every fixture, with the matrix it is worth running */
function plan(opts) {
  const seeds = opts.seeds || (opts.quick ? [5] : [5, 99]);
  const out = [];

  // small, fast language cases: the widest matrix
  for (const file of listLua("Test/cases")) {
    out.push({
      file,
      group: "cases",
      target: "portable",
      builds: opts.quick
        ? [{ seed: seeds[0], mode: "Normal" }]
        : seeds.flatMap((seed) => [
            { seed, mode: "Normal" },
            { seed, mode: "false" },
          ]),
    });
  }

  // program fixtures: one build each, Luau target
  for (const file of listLua("Test/exec")) {
    if (opts.quick && /heavy/.test(file)) continue;
    out.push({ file, group: "exec", target: "luau", builds: [{ seed: seeds[0], mode: "Normal" }] });
  }

  // whole-program benchmarks: skipped in --quick runs
  if (!opts.quick) {
    for (const file of listLua("Test")) {
      if (/smoke_test\.lua$/.test(file)) continue; // reference program has no main
      out.push({ file, group: "bench", target: "luau", builds: [{ seed: seeds[0], mode: "Normal" }] });
    }
  }

  return opts.filter ? out.filter((f) => f.file.includes(opts.filter)) : out;
}

/* ------------------------------------------------------------------ */
/* output normalisation                                                */
/* ------------------------------------------------------------------ */

/**
 * Benchmarks print their own timings; those are the only lines a run cannot
 * reproduce, so both sides are stripped the same way before comparing.
 */
function stable(stdout) {
  return String(stdout)
    .split("\n")
    .filter((line) => !/(work|script) time\t/.test(line))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* checks                                                              */
/* ------------------------------------------------------------------ */

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

/** shape of an artifact: everything a filter could notice at a glance */
function shapeChecks(report, label, artifact) {
  const lines = artifact.replace(/\n$/, "").split("\n");

  report.expect(`${label} · two lines`, lines.length === 2, `${lines.length} lines`);
  report.expect(`${label} · watermark`, lines[0] === WATERMARK, JSON.stringify(lines[0] || "").slice(0, 60));
  report.expect(
    `${label} · wrapper`,
    /^return\(\{function\(\.\.\.\)/.test(lines[1] || ""),
    JSON.stringify((lines[1] || "").slice(0, 40))
  );
  report.expect(`${label} · no loadstring`, !/\bloadstring\b/.test(artifact));
  report.expect(`${label} · no macros left`, !/\bEAT_(STRING|NUMBER|FUNCTION|RAGEBAIT)\b/.test(artifact));

  // the anti-tamper walk must not read as a loop
  let audit = null;
  const tmp = path.join(os.tmpdir(), `eat-suite-${process.pid}.lua`);
  try {
    fs.writeFileSync(tmp, artifact, "utf8");
    audit = auditFile(tmp);
  } catch (e) {
    audit = { error: e.message };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* gone already */
    }
  }
  if (!audit || audit.error) {
    report.fail(`${label} · audit`, audit && audit.error);
  } else {
    const whileCount = (audit.shapes || []).reduce((n, [name, count]) => (name.includes("while") ? n + count : n), 0);
    report.expect(`${label} · hidden anti-tamper`, whileCount === 0, `while x${whileCount}`);
  }

  // the artifact must still be a chunk the real Luau front-end accepts
  const gate = luau.compileCheck(artifact);
  if (gate.skipped) report.pass(`${label} · luau parse (skipped, no luau-compile)`);
  else report.expect(`${label} · luau parse`, gate.ok, gate.error);
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

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

  for (const entry of entries) {
    const src = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
    const ref = luau.run(src, { timeout: 180000 });
    const label = path.basename(entry.file, ".lua");
    const t0 = Date.now();
    let line = `${GREEN}+${RESET} ${entry.file}`;

    // 1. the reference program itself runs
    report.expect(`${label} · reference runs`, ref.status === 0, `exit ${ref.status} ${(ref.stderr || "").split("\n")[0]}`);

    const seen = [];
    for (const build of entry.builds) {
      const tag = `${label}/${build.seed}/${build.mode}`;
      let artifact;
      try {
        artifact = obfuscate(src, { minify: build.mode, seed: build.seed, bloat: 0, target: entry.target });
      } catch (e) {
        report.fail(`${tag} · builds`, e.message);
        continue;
      }
      seen.push(artifact);

      const got = luau.run(artifact, { timeout: 180000 });
      report.expect(`${tag} · exit`, got.status === 0, `exit ${got.status} ${(got.stderr || "").split("\n")[0]}`);
      report.expect(
        `${tag} · stdout`,
        stable(got.stdout) === stable(ref.stdout),
        firstDiff(stable(ref.stdout), stable(got.stdout))
      );

      // shape checks once per file, on the first build
      if (!shapeCache.has(entry.file)) {
        shapeCache.add(entry.file);
        shapeChecks(report, label, artifact);
      }
    }

    // 2. same seed, same bytes
    if (entry.builds.length) {
      const again = obfuscate(src, { minify: entry.builds[0].mode, seed: entry.builds[0].seed, bloat: 0, target: entry.target });
      report.expect(`${label} · deterministic`, again === seen[0], "same seed produced different output");
    }

    // 3. two seeds must not produce the same artifact
    if (entry.builds.length > 1 && seen.length > 1) {
      report.expect(`${label} · varies by seed`, seen[0] !== seen[1], "layout did not change between seeds");
    }

    if (report.failed && report.failures[report.failures.length - 1].label.startsWith(label + " ")) line = `${RED}x${RESET} ${entry.file}`;
    console.log(`${line} ${DIM}${Date.now() - t0} ms${RESET}`);
  }

  /* ---------------------------------------------------------------- */
  /* macro fixture: the four macros must expand and keep behaviour     */
  /* ---------------------------------------------------------------- */
  const macroSource = [
    "local s = EAT_STRING(\"hello macro\")",
    "local n = EAT_NUMBER(41)",
    "local f = EAT_FUNCTION(function(a, b) return a + b end)",
    "print(s, n + 1, f(2, 3))",
  ].join("\n");
  const macroArtifact = obfuscate(macroSource, { minify: "Normal", seed: 7, bloat: 0, target: "portable" });
  const macroRun = luau.run(macroArtifact, { timeout: 60000 });
  report.expect(
    "macros · expand and run",
    macroRun.status === 0 && /^hello macro\t42\t5$/m.test(macroRun.stdout || ""),
    JSON.stringify((macroRun.stdout || "").trim())
  );
  report.expect("macros · no macro names left", !/\bEAT_(STRING|NUMBER|FUNCTION)\b/.test(macroArtifact));

  // ragebait prints the taunt and then parks the thread for good: the text is
  // carried encoded like any other string, so a filter never reads it
  const baitArtifact = obfuscate("EAT_RAGEBAIT()", { minify: "Normal", seed: 7, bloat: 0, target: "portable" });
  report.expect("ragebait · taunt encoded", !baitArtifact.includes("eatfuscator said no skid"));
  // `EAT_RAGEBAIT` never returns, so the check is that the thread is still
  // parked when the timer fires; stdout is block buffered under a pipe and is
  // not a reliable witness here
  const baitRun = luau.run(baitArtifact, { timeout: 2000 });
  report.expect("ragebait · parks the thread", baitRun.timedOut === true, `returned with exit ${baitRun.status}`);
  console.log(`${GREEN}+${RESET} macros ${DIM}EAT_STRING / EAT_NUMBER / EAT_FUNCTION / EAT_RAGEBAIT${RESET}`);

  /* ---------------------------------------------------------------- */
  /* summary                                                           */
  /* ---------------------------------------------------------------- */
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

/** first differing line, for the failure note */
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
