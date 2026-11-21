"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const cache = new Map();

function envKey(name) {
  return "LUAU_" + name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function candidates(name) {
  const out = [];
  const direct = process.env[envKey(name)];
  if (direct) out.push(direct);

  const dirs = String(process.env.LUAU_BIN || "")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  for (const d of dirs) out.push(path.join(d, name));

  const local = ["luau/bin", "luau", "vendor/luau", "vendor/luau/bin", "../luau/bin"];
  for (const d of local) out.push(path.join(__dirname, "..", "..", d, name));

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const userDirs = [
    path.join(home, ".eatfuscator", "luau", "bin"),
    path.join(home, ".eatfuscator", "luau"),
  ];
  for (const d of userDirs) out.push(path.join(d, name));

  const exe = process.platform === "win32" ? `${name}.exe` : null;
  if (exe) {
    out.push(...out.slice().map((p) => p + ".exe"));
  }
  return out;
}

function which(name) {
  const res = spawnSync("sh", ["-c", `command -v ${name} 2>/dev/null`], { encoding: "utf8", timeout: 5000 });
  const first = (res.stdout || "").trim().split("\n")[0];
  return res.status === 0 && first ? first : null;
}

function find(name) {
  if (cache.has(name)) return cache.get(name);
  let found = null;
  for (const candidate of candidates(name)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found = candidate;
      break;
    } catch (_) {

    }
  }
  if (!found) found = which(name);
  if (found) ensureExecutable(found);
  cache.set(name, found);
  return found;
}

// A vendored binary arrives with whatever mode the archive that delivered it
// had: `cp` from a snapshot, `unzip` without `-X`, a git checkout on a filesystem
// that does not track modes. Every one of those turns a working toolchain into
// "no luau binary found" or, worse, a silent spawn failure that tools report as a
// timeout. Fixing the mode here is cheaper than explaining it once per user.
function ensureExecutable(file) {
  if (process.platform === "win32") return;
  try {
    const st = fs.statSync(file);
    if (st.mode & 0o111) return;
    fs.chmodSync(file, st.mode | 0o755);
  } catch (_) {
    /* read-only mount: the spawn will report the real problem */
  }
}

function available() {
  return !!find("luau-compile");
}

function withTempFile(code, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eatfuscator-luau-"));
  const file = path.join(dir, "chunk.lua");
  try {
    fs.writeFileSync(file, code, "utf8");
    return fn(file, dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {

    }
  }
}

// Full compile, not just a parse: Luau's 200-local limit is reported by the
// compiler, so `--only-parse` cannot see it and a loader that blows it would
// fail at load with no message at all.
function fullCompile(code, { timeout = 60000 } = {}) {
  const bin = find("luau-compile");
  if (!bin) return { ok: true, skipped: true, gate: "none" };
  return withTempFile(String(code), (file) => {
    const res = spawnSync(bin, ["--null", file], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
    if (res.status === 0) return { ok: true, skipped: false, gate: "luau-compile" };
    const err = String(res.stderr || "").trim();
    return { ok: false, skipped: false, gate: "luau-compile", error: err.split("\n")[0] || `luau-compile exit ${res.status}` };
  });
}

function compileCheck(code, { timeout = 60000 } = {}) {
  const bin = find("luau-compile");
  if (!bin) return { ok: true, skipped: true, gate: "none" };
  return withTempFile(String(code), (file) => {
    const res = spawnSync(bin, ["--null", "--only-parse", file], {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    if (res.status === 0) return { ok: true, skipped: false, gate: "luau-compile" };
    const err = String(res.stderr || "").trim();
    return { ok: false, skipped: false, gate: "luau-compile", error: err.split("\n")[0] || `luau-compile exit ${res.status}` };
  });
}

let shimCache = null;
let richCache = null;

/**
 * The Roblox host shim (tools/roblog.lua).
 *
 * The default target refuses to run outside a real Luau/Roblox host, so on the
 * CLI every artifact has to be given one. Passing `host: "bare"` runs the code
 * with nothing added, which is how the "does it trip off-platform" tests are
 * written.
 */
function robloxShim() {
  if (shimCache !== null) return shimCache;
  try {
    shimCache = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "tools", "roblog.lua"), "utf8");
  } catch {
    shimCache = "";
  }
  return shimCache;
}

// The wide host (tools/robloxhost.lua): enough of the engine that a third-party
// Roblox script runs to completion, used for source-vs-artifact parity rather
// than for gate testing. roblog.lua stays the thin, strict host.
function richHost() {
  if (richCache !== null) return richCache;
  try {
    richCache = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "tools", "robloxhost.lua"), "utf8");
  } catch {
    richCache = "";
  }
  return richCache;
}

function withHost(code, host) {
  if (host === "bare" || host === null) return String(code);
  return robloxShim() + "\n" + String(code);
}

function run(code, { timeout = 60000, args = [], host = "roblox" } = {}) {
  const bin = find("luau");
  if (!bin) return { skipped: true };
  return runFile(withHost(code, host), { timeout, args });
}

function runFile(code, { timeout = 60000, args = [] } = {}) {
  const bin = find("luau");
  if (!bin) return { skipped: true };
  return withTempFile(String(code), (file) => {
    const res = spawnSync(bin, [file, ...args], {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    return {
      skipped: false,
      status: res.status,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      timedOut: res.signal === "SIGKILL" || res.signal === "SIGTERM" || res.error?.code === "ETIMEDOUT",
    };
  });
}

function analyze(code, { timeout = 60000 } = {}) {
  const bin = find("luau-analyze");
  if (!bin) return { skipped: true, messages: [] };
  return withTempFile(String(code), (file) => {
    const res = spawnSync(bin, ["--formatter=plain", file], {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    const messages = String(res.stderr || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^$/.test(l));
    return { skipped: false, ok: res.status === 0, status: res.status, messages };
  });
}

function describe() {
  const compile = find("luau-compile");
  const run_ = find("luau");
  const analyze_ = find("luau-analyze");
  return { compile, run: run_, analyze: analyze_, available: !!compile };
}

module.exports = { richHost,
  robloxShim,
  runFile,
  find,
  available,
  describe,
  compileCheck,
  fullCompile,
  run,
  analyze,
};
// Luau CLI module expanded
const LUAUCLI_EXTRA = {
  // Additional CLI commands
  commands: ['obfuscate', 'deobfuscate', 'audit', 'stats', 'info', 'version', 'help', 'config'],
  // CLI options: seed only. Everything else is derived from it.
  options: ['seed'],
  // CLI defaults
  defaults: {
    seed: 1,
  },
  // CLI version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.LUAUCLI_EXTRA = LUAUCLI_EXTRA;
// End of CLI module expansion
