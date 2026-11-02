"use strict";

/**
 * Official Luau toolchain bridge.
 *
 * The Luau CLI (`luau`, `luau-compile`, `luau-analyze`) is the reference for
 * both syntax and behaviour. It is never required to build an artifact, but
 * when it is on the machine every build is gated by the real Luau front-end
 * instead of a hand-written grammar.
 *
 * Discovery order for a tool called `<name>`:
 *   1. LUAU_COMPILE / LUAU_ANALYZE / LUAU (absolute path)
 *   2. every directory in LUAU_BIN
 *   3. `luau/bin`, `vendor/luau`, `vendor/luau/bin` inside the package
 *   4. $PATH
 *
 * Everything here degrades to `{ skipped: true }` rather than throwing, so the
 * package still works on machines without a Luau build.
 */

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

  // project-local installs first, then the per-user one that
  // `tools/get-luau.sh` populates
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
      /* not here */
    }
  }
  if (!found) found = which(name);
  cache.set(name, found);
  return found;
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
      /* best effort */
    }
  }
}

/** parse-only syntax gate: `luau-compile --null --only-parse` */
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

/** run a chunk and capture stdout — used by the tests and by `cli.js check` */
function run(code, { timeout = 60000, args = [] } = {}) {
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

/** lint the source with luau-analyze; informational, never fatal */
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

module.exports = { find, available, describe, compileCheck, run, analyze };
