"use strict";

/**
 * Eatfuscator — dsc.gg/eatfuscator
 *
 * Public API:
 *   obfuscate(source, { minify, seed, verbose }) -> wrapped Lua source
 *   minify(source, mode)                         -> densified Lua only
 *   parseMinify(mode)                            -> normalised mode string
 *
 * Everything the wrapper needs lives in this module: wrapper runtime template
 * (wrapper.lua), the wrap engine (wrap.js) and the Lua minifier (minify.js).
 *
 * Output shape (single line, always):
 *   ([[dsc.gg/eatfuscator]]):gsub('.+',(function(...)<body>end)(...))
 */

const {
  wrapSource, minifySource, validate, decodeReference, referenceImage, measurePayload, opmapForSeed, BRAND, NAME_RE,
} = require("../Envelope/wrap");

const MINIFY_MODES = ["false", "Normal", "Max", "Both"];
const TARGETS = ["luau", "portable"];

/**
 * Reference dialect for the emitted artifact.
 *   luau     (default) — Luau surface syntax: compound assignment, `//`
 *   portable           — Lua 5.1 / 5.2 / 5.3 compatible spelling
 */
function parseTarget(target) {
  const raw = target === undefined || target === null ? "luau" : String(target).trim().toLowerCase();
  if (raw === "" || raw === "luau" || raw === "luaulang" || raw === "roblox") return "luau";
  if (raw === "portable" || raw === "lua51" || raw === "lua" || raw === "5.1" || raw === "5.3") return "portable";
  const err = new Error(`invalid target: ${JSON.stringify(raw)} — expected one of ${TARGETS.join(" | ")}`);
  err.code = "EBADTARGET";
  throw err;
}

/**
 * Strict mode parser. Unknown values are rejected — silently falling back
 * to Normal hides typos and produces builds the caller did not ask for.
 */
function parseMinify(mode) {
  const raw = mode === undefined || mode === null ? "Normal" : String(mode).trim();
  const key = raw.toLowerCase();

  if (key === "" ) return "Normal";
  if (key === "false" || key === "off" || key === "none" || key === "no") return "false";
  if (key === "normal" || key === "true" || key === "on" || key === "yes" || key === "std") return "Normal";
  if (key === "max" || key === "maximum") return "Max";
  if (key === "both" || key === "all") return "Both";

  const err = new Error(
    `invalid minify setting: ${JSON.stringify(raw)} — expected one of ${MINIFY_MODES.join(" | ")}`
  );
  err.code = "EBADMINIFY";
  err.allowed = MINIFY_MODES.slice();
  throw err;
}

/** Non-throwing variant for call sites that must stay alive. */
function tryParseMinify(mode) {
  try {
    return { ok: true, mode: parseMinify(mode) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function obfuscate(src, options = {}) {
  const mode = parseMinify(options.minify);
  return wrapSource(String(src == null ? "" : src), {
    minify: mode,
    seed: options.seed,
    verbose: !!options.verbose,
    bloat: options.bloat,
    flatten: options.flatten,
    blocks: options.blocks,
    target: parseTarget(options.target),
  });
}

function minify(src, mode = "Normal") {
  return minifySource(src, parseMinify(mode));
}

/**
 * Describe the upvalue layout of a built artifact.
 * Reported for tooling and tests; never required at run time.
 */
function inspect(code) {
  const text = String(code || "");
  const closures = (text.match(/return function\(/g) || []).length;
  const handlers = (text.match(/\]=function\(\)/g) || []).length;
  let layers = 0;
  let banks = 0;
  let dispatch = 0;
  try {
    const st = require("../Envelope/wrap").buildStats(text);
    layers = st.layers;
    banks = st.banks;
    dispatch = st.dispatch;
  } catch (_) {
    banks = (text.match(/\[0x[0-9A-F]+\]=\{"/g) || []).length;
  }
  return { closures, handlers, layers, banks, dispatch, bytes: Buffer.byteLength(text) };
}

module.exports = {
  obfuscate,
  minify,
  parseMinify,
  parseTarget,
  tryParseMinify,
  MINIFY_MODES,
  validate,
  decodeReference,
  referenceImage,
  measurePayload,
  opmapForSeed,
  inspect,
  BRAND,
  NAME_RE,
};
