"use strict";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
const LEAD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_";

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
  "goto", "continue", "type", "export",
]);

const GLOBALS = new Set([
  "_G", "_ENV", "_VERSION", "self", "shared", "plugin", "script", "game", "workspace",
  "table", "string", "math", "coroutine", "os", "io", "debug", "bit32", "utf8", "buffer",
  "vector", "task", "typeof", "tick", "time", "wait", "spawn", "delay", "warn", "print",
  "require", "load", "loadstring", "dofile", "loadfile", "select", "next", "pairs", "ipairs",
  "pcall", "xpcall", "error", "assert", "rawget", "rawset", "rawequal", "rawlen",
  "getmetatable", "setmetatable", "getfenv", "setfenv", "unpack", "pack", "tonumber",
  "tostring", "newproxy", "collectgarbage", "getgenv", "getrenv", "getreg", "setreadonly",
  "hookfunction", "hookmetamethod", "getnamecallmethod", "checkcaller", "islclosed",
  "identifyexecutor", "request", "syn", "http", "Instance", "Vector2", "Vector3", "CFrame",
  "Color3", "UDim", "UDim2", "BrickColor", "Enum", "Ray", "Region3", "TweenInfo",
  "NumberRange", "NumberSequence", "ColorSequence", "PhysicalProperties", "Random",
  "DateTime", "Faces", "Axes", "Rect", "PathWaypoint", "OverlapParams",
  "RaycastParams", "CatalogSearchParams", "FloatCurveKey", "RotationCurveKey",
  "settings", "UserSettings", "tostring", "concat", "insert", "remove", "sort", "format",
  "gsub", "gmatch", "find", "match", "rep", "sub", "byte", "char", "len", "lower", "upper",
  "reverse", "split", "floor", "ceil", "abs", "max", "min", "huge", "pi", "random",
  "randomseed", "fmod", "modf", "sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "exp",
  "log", "log10", "round", "clamp", "sign", "noise", "map", "lerp", "delta", "wrap",
  "typeof", "identity", "create", "fromMatrix", "fromRotation", "fromEulerAnglesXYZ",
  "Angles", "rad", "deg", "clear", "clone", "destroy", "Destroy", "FindFirstChild",
  "WaitForChild", "GetChildren", "GetDescendants", "GetService", "HttpEnabled",
  "HttpService", "JSONDecode", "JSONEncode", "GetAsync", "PostAsync", "HttpGet",
  "Players", "LocalPlayer", "Character", "Humanoid", "HumanoidRootPart", "FireServer",
  "InvokeServer", "Connect", "Wait", "Disconnect", "connect", "wait", "disconnect",
]);

// Names written as literal text in emitted code. The factory cannot see that
// text, so a minted identifier that lands on one of them silently shadows it -
// on one seed in ten the char function was minted as `oi`, the same name the
// unpack loop used for its counter, and the artifact died calling a number.
// Reserving them costs a handful of one-letter names out of thousands.
// Every identifier the runtime template spells out. Collected from the file
// itself rather than listed by hand, because the list is the kind of thing that
// goes stale: two of these (`oi` and `w_`) were found by an artifact that called
// a number, and there is no reason to wait for the next one.
const LITERAL_LOCALS = (() => {
  const out = new Set(["A", "P", "O", "C", "i", "v", "a", "b", "r", "w", "k", "e"]);
  try {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "Template", "runtime.lua"), "utf8");
    for (const m of src.matchAll(/[A-Za-z_][A-Za-z0-9_]{0,10}/g)) {
      if (!m[0].startsWith("__")) out.add(m[0]);
    }
  } catch (e) {
    // no template on disk: the hand-written list still applies
  }
  return [...out];
})();
const BLOCKED = new Set(["_", "__", "cc", "do", "in", "of", ...LITERAL_LOCALS]);

function reserved(name) {
  return (
    KEYWORDS.has(name) ||
    GLOBALS.has(name) ||
    BLOCKED.has(name) ||
    name.startsWith("__") ||
    name.startsWith("_")
  );
}

const SHORT_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const SMALL_LEVEL = 2;
const LENGTHS = [
  [6, 0.14],
  [7, 0.22],
  [8, 0.24],
  [9, 0.18],
  [10, 0.13],
  [11, 0.09],
];

const NAME_SRC = "[A-Za-z_][A-Za-z0-9_]{0,10}";
const FAMILY_SRC = "[A-Za-z_][A-Za-z0-9_]{0,2}";
const FAMILY_RE = new RegExp("^" + FAMILY_SRC + "$");
const HOST_ALLOWED = new Set(["_ENV", "_G", "getfenv", "unpack"]);
const NAME_RE = new RegExp("^" + NAME_SRC + "$");
const LEGACY_SRC = "[A-Za-z_][A-Za-z0-9_]{5,10}";

function shuffleIn(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function enumerateLevel(len, seedRng) {
  const out = [];
  const build = (prefix, left) => {
    if (left === 0) {
      if (!reserved(prefix)) out.push(prefix);
      return;
    }
    const alphabet = prefix.length === 0 ? LEAD : ALPHABET;
    for (let i = 0; i < alphabet.length; i++) build(prefix + alphabet[i], left - 1);
  };
  build("", len);
  return shuffleIn(seedRng, out);
}

function makeShortFactory(rng, reservedExtras) {
  const used = new Set(reservedExtras || []);
  const pools = new Map();
  let level = 0;

  const poolFor = (len) => {
    let pool = pools.get(len);
    if (!pool) {
      pool = enumerateLevel(len, rng);
      pools.set(len, pool);
    }
    return pool;
  };

  const freshFrom = (len) => {
    const pool = poolFor(len);
    while (pool.length) {
      const candidate = pool.pop();
      if (!used.has(candidate)) return candidate;
    }
    return null;
  };

  const randomAt = (len) => {
    for (let attempt = 0; attempt < 4096; attempt++) {
      let n = LEAD[(rng() * LEAD.length) | 0];
      for (let k = 1; k < len; k++) n += ALPHABET[(rng() * ALPHABET.length) | 0];
      if (reserved(n) || used.has(n)) continue;
      return n;
    }
    return null;
  };

  return function name() {
    while (level < SHORT_LEVELS.length) {
      const len = SHORT_LEVELS[level];
      const n = len <= SMALL_LEVEL ? freshFrom(len) : randomAt(len);
      if (n) {
        used.add(n);
        return n;
      }
      level++;
    }
    for (let attempt = 0; attempt < 65536; attempt++) {
      const r = rng();
      let len = LENGTHS[LENGTHS.length - 1][0];
      let acc = 0;
      for (const [l, p] of LENGTHS) {
        acc += p;
        if (r < acc) {
          len = l;
          break;
        }
      }
      let n = LEAD[(rng() * LEAD.length) | 0];
      for (let k = 1; k < len; k++) n += ALPHABET[(rng() * ALPHABET.length) | 0];
      if (reserved(n) || used.has(n)) continue;
      used.add(n);
      return n;
    }
    throw new Error("identifier space exhausted");
  };
}

function makeNameFactory(rng, options = {}) {
  // Names that already exist as literal text in the emitter's templates. A
  // minted identifier that lands on one of them shadows it, and the failure
  // shows up as a call on a boolean or a number somewhere unrelated.
  const reservedExtras = new Set(options.reserve ? options.reserve : LITERAL_LOCALS);
  if (options.style === "long") {
    const used = new Set(reservedExtras || []);
    return function name() {
      for (let attempt = 0; attempt < 65536; attempt++) {
        const r = rng();
        let len = LENGTHS[LENGTHS.length - 1][0];
        let acc = 0;
        for (const [l, p] of LENGTHS) {
          acc += p;
          if (r < acc) {
            len = l;
            break;
          }
        }
        let n = LEAD[(rng() * LEAD.length) | 0];
        for (let k = 1; k < len; k++) n += ALPHABET[(rng() * ALPHABET.length) | 0];
        if (reserved(n) || used.has(n)) continue;
        used.add(n);
        return n;
      }
      throw new Error("identifier space exhausted");
    };
  }
  return makeShortFactory(rng, reservedExtras);
}

function isFamily(name) {
  return NAME_RE.test(name);
}

module.exports = {
  ALPHABET,
  LEAD,
  NAME_SRC,
  NAME_RE,
  FAMILY_SRC,
  FAMILY_RE,
  HOST_ALLOWED,
  LEGACY_SRC,
  KEYWORDS,
  GLOBALS,
  reserved,
  makeNameFactory,
  isFamily,
};
// Idents module expanded
const IDENTS_EXTRA = {
  // Additional name sources
  name_sources: ['english', 'latin', 'greek', 'cyrillic', 'japanese', 'korean', 'chinese', 'random'],
  // Additional identifier sets
  identifier_sets: {
    small: ['a', 'b', 'c', 'd', 'e', 'd', 'f', 'g', 'h', 'i'],
    medium: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'],
    large: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'],
  },
  // Identifier statistics
  stats: {
    total_generated: 0,
    unique_generated: 0,
    reused_count: 0,
  },
  // Identifier version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.IDENTS_EXTRA = IDENTS_EXTRA;
// End of idents module expansion
