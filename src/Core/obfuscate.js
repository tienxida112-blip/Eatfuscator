"use strict";

const {
  wrapSource, resolveSeed, wantsSimple, loaderText, validate, referenceImage, measurePayload, opmapForSeed, BRAND, NAME_RE,
} = require("../Envelope/wrap");

const TARGETS = ["luau", "portable"];

function parseTarget(target) {
  const raw = target === undefined || target === null ? "luau" : String(target).trim().toLowerCase();
  if (raw === "" || raw === "luau" || raw === "luaulang" || raw === "roblox") return "luau";
  if (raw === "portable" || raw === "lua51" || raw === "lua" || raw === "5.1" || raw === "5.3") return "portable";
  const err = new Error(`invalid target: ${JSON.stringify(raw)} — expected one of ${TARGETS.join(" | ")}`);
  err.code = "EBADTARGET";
  throw err;
}

function obfuscate(src, options = {}) {
  const text = String(src == null ? "" : src);
  const target = parseTarget(options.target);
  const settings = {
    // Resolve once: a random seed must not change between compile retries.
    seed: resolveSeed(options.seed),
    bulk: options.bulk,
    verbose: !!options.verbose,
    bloat: options.bloat,
    flatten: options.flatten,
    blocks: options.blocks,
    target,
    simple: options.simple,
    hostProbe: !!options.hostProbe,
    trap: options.trap,
    // Both of these are off by default because both are readable output: a
    // banner line and an English failure message are the two things a reader of
    // the artifact searches for first.
    diag: !!options.diag,
    // Round 7: the artifact carries its loader as a compressed blob and reassembles
    // it with loadstring at run time. Tools that need to look at the loader itself
    // (shape audits, tamper tests that patch the loader's text) ask for it whole
    // with `loadstring: false`.
    loadstring: options.loadstring === false ? false : undefined,
    // Test hook (tools/tamper.js): corrupt one token of the layer-3 stack program
    // at build time, which is exactly what a patcher does to the stored stream.
    forgeMutation: options.forgeMutation || null,
    // Test hook (tools/tamper.js): build the artifact with the whole anti-tamper
    // block left out, which is what a patcher does when it finds the checks and
    // deletes them. The interpreter's code salt is derived from that block, so
    // this mutant must not be able to decode its own program.
    dropAttest: !!options.dropAttest,
    // Test hook: rewrite one salt / swap one pair of anti-tamper checks after the
    // build-time fold, so the chain word no longer matches what the build computed.
    attestMutation: options.attestMutation || null,
    // Test hook: build without the API atlas, to prove the interpreter's salt
    // depends on it.
    dropAtlas: !!options.dropAtlas,
    guardProbe: !!options.guardProbe,
    wordProbe: options.wordProbe || null, // internal regression only
    constProbe: options.constProbe || null, // internal regression only
    imageProbe: options.imageProbe || null, // internal malformed-image regression only
    dispatchProbe: options.dispatchProbe || null, // internal regression only
    neutralizeTrap: !!options.neutralizeTrap, // internal regression hooks
    forceHostFailure: !!options.forceHostFailure,
    omitHostKey: !!options.omitHostKey,
    // undefined means "default", and the default is on; only an explicit false
    // removes the banner.
    watermark: options.watermark === false ? false : options.watermark === true ? true : undefined,
  };
  try {
    // Compile guard. Luau allows 200 locals in one function and the flattened
    // loader runs close to that line; when it crosses, Luau refuses to compile
    // the chunk, loadstring hands back nil, and the artifact traps at load with
    // no message - which is indistinguishable from anti-tamper. So the build is
    // compiled once here, and a build that does not compile is rebuilt with a
    // smaller hoist budget rather than shipped.
    if (!wantsSimple(settings) && options.compileGuard !== false) {
      const luau = require("../Toolchain/luaucli");
      const shouldFlatten = settings.flatten !== false;
      // Smaller blocks counts reduce cross-block hoisting, without dropping the
      // VM or silently turning off control-flow flattening.
      const initial = Number(settings.blocks) || 26;
      const plans = shouldFlatten ? [...new Set([initial, 20, 16, 12, 8, 6])].filter(n => n <= initial) : [initial];
      let lastError = "no viable flattened layout";
      for (const blocks of plans) {
        let out;
        try {
          // Leave additional register headroom for Luau versions whose register
          // allocation differs from the vendored compiler. If a layout cannot
          // fit, retry a smaller block count rather than emit an unsafe layout.
          out = wrapSource(text, { ...settings, blocks, hoistBudget: 165, requireFlatten: shouldFlatten });
        } catch (e) {
          if (e.code !== "ECFFLIMIT") throw e;
          lastError = e.message;
          if (options.verbose) console.error(`[obfuscate] retrying ${blocks} blocks: ${lastError}`);
          continue;
        }
        if (!luau.available()) return out;
        const check = luau.fullCompile(loaderText());
        if (check.ok || check.skipped) return out;
        lastError = check.error;
        if (options.verbose) console.error(`[obfuscate] ${blocks} blocks failed compilation: ${lastError}`);
        if (!/out of local registers|exceeded limit 200/i.test(lastError)) break;
      }
      throw new Error(`loader compile failed (seed ${settings.seed}): ${lastError}`);
    }
    return wrapSource(text, settings);
  } catch (e) {
    // Input problems are reported, never papered over: falling back would turn a
    // syntax error into a plausible-looking artifact that does nothing.
    if (e && e.code) throw e;
    // An unexpected build failure is an error. It used to degrade to the flat
    // envelope, which is obfuscated but is not the product - and it did so
    // silently, at a tenth of the size, so a regression in the interpreter showed
    // up as a small artifact that still "worked" rather than as a failure. The
    // downgrade is opt-in now (`fallback: true`), for callers that want a best
    // effort.
    if (options.fallback !== true) throw e;
    if (options.verbose) console.error(`[obfuscate] full VM build failed (${e.message}); falling back to the flat envelope`);
    return wrapSource(text, { ...settings, simple: true });
  }
}

function inspect(code) {
  const text = String(code || "");
  const closures = (text.match(/return function\(/g) || []).length;
  const handlers = (text.match(/\]=function\(\)/g) || []).length;
  let layers = 0;
  let banks = 0;
  let dispatch = 0;
  let modTests = 0;
  try {
    const st = require("../Envelope/wrap").buildStats(text);
    layers = st.layers;
    banks = st.banks;
    dispatch = st.dispatch;
    modTests = st.modTests;
  } catch (_) {
    banks = (text.match(/\[0x[0-9A-F]+\]=\{"/g) || []).length;
  }
  return { closures, handlers, layers, banks, dispatch, modTests, bytes: Buffer.byteLength(text) };
}

module.exports = {
  obfuscate,
  parseTarget,
  validate,
  referenceImage,
  measurePayload,
  opmapForSeed,
  inspect,
  BRAND,
  NAME_RE,
};
// Expanded obfuscate module
module.exports.minify = function(src, level) { return require("../Steps/Minify").minifyLua(String(src||""), level||"Normal"); };
