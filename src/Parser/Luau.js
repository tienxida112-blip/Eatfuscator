"use strict";

/**
 * Luau -> Lua 5.1 surface lowering — dsc.gg/eatfuscator
 *
 * The bytecode compiler parses Lua 5.1 grammar, but the scripts people
 * actually ship are written in Luau. This module rewrites the Luau-only
 * surface syntax into plain 5.1 before compilation:
 *
 *   type annotations     function f(a: number): (number, number)
 *   compound assignment  x += 1, t.k ..= "s"
 *   continue             -> marker call the compiler turns into a jump
 *   if expressions       x = if c then a else b
 *
 *   floor division       a // b           -> a helper call, exact for every sign
 *
 * `//` is lowered through a helper (`__EATF_FLOORDIV__(a,b)`) instead of being
 * inlined as `(a-(a%b))/b`, so each operand is still evaluated exactly once.
 * Every rewrite skips string literals, long brackets and comments.
 */

const MARK_CONTINUE = "__EATF_CONTINUE__";
const MARK_FLOORDIV = "__EATF_FLOORDIV__";
// Luau's `//` is floor division. `(a-(a%b))/b` only agrees for integers and it
// leaks a float in Lua 5.1 (`14.0` where Luau prints `14`); math.floor gives the
// same value for every numeric input and prints identically.
const FLOORDIV_HELPER = `local ${MARK_FLOORDIV}=function(a,b)return math.floor(a/b)end `;

function isIdentStart(c) {
  return c !== undefined && /[A-Za-z_]/.test(c);
}

function isIdent(c) {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

function skipQuoted(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === q) return i + 1;
    if (src[i] === "\n") return i;
    i++;
  }
  return i;
}

function longBracketAt(src, i) {
  const m = /^\[(=*)\[/.exec(src.slice(i, i + 32));
  return m || null;
}

function skipLong(src, i, m) {
  const close = "]" + m[1] + "]";
  const end = src.indexOf(close, i + m[0].length);
  return end < 0 ? src.length : end + close.length;
}

function skipComment(src, i) {
  const lb = longBracketAt(src, i + 2);
  if (lb) return skipLong(src, i + 2, lb);
  while (i < src.length && src[i] !== "\n") i++;
  return i;
}

const TYPE_END = new Set([",", ")", "=", ";", "}", "\n", "\r", "->"]);
const TYPE_END_WORDS = ["end", "do", "local", "return", "if", "for", "while", "repeat", "else", "elseif", "until"];

/** consume one type expression; returns the index after it, or -1 */
function scanType(src, i) {
  let j = i;
  const n = src.length;
  const skipWs = () => {
    while (j < n && /\s/.test(src[j])) j++;
  };

  let segments = 0;
  while (j < n) {
    skipWs();
    const c = src[j];
    if (c === "{") {
      let depth = 0;
      while (j < n) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") {
          depth--;
          j++;
          if (!depth) break;
          continue;
        }
        j++;
      }
    } else if (c === "(") {
      let depth = 0;
      while (j < n) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") {
          depth--;
          j++;
          if (!depth) break;
          continue;
        } else if (src[j] === '"' || src[j] === "'") {
          j = skipQuoted(src, j);
          continue;
        }
        j++;
      }
    } else if (c === '"' || c === "'") {
      j = skipQuoted(src, j);
    } else if (isIdentStart(c)) {
      while (j < n && (isIdent(src[j]) || src[j] === ".")) j++;
      skipWs();
      if (src[j] === "<") {
        let depth = 0;
        while (j < n) {
          if (src[j] === "<") depth++;
          else if (src[j] === ">") {
            depth--;
            j++;
            if (!depth) break;
            continue;
          }
          j++;
        }
      }
      if (src.slice(j, j + 2) === "->") {
        j += 2;
        continue;
      }
    } else if (c === "?") {
      j++;
    } else {
      return -1;
    }

    segments++;
    skipWs();
    // unions / intersections
    if (src[j] === "|" || src[j] === "&") {
      j++;
      continue;
    }
    if (src.slice(j, j + 2) === "->") {
      j += 2;
      continue;
    }
    break;
  }

  if (!segments) return -1;
  return j;
}

function stripAnnotationAt(src, colon) {
  const after = scanType(src, colon + 1);
  if (after < 0) return null;
  let k = after;
  while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
  if (src[k] === undefined) return after;
  if (TYPE_END.has(src[k])) return after;
  if (src.slice(k, k + 2) === "->") return after;
  if (isIdentStart(src[k])) {
    let e = k;
    while (e < src.length && isIdent(src[e])) e++;
    if (TYPE_END_WORDS.includes(src.slice(k, e))) return after;
  }
  return null;
}

/** `a.b[c]` style lvalue that ends right before `at` */
function lvalueStart(src, at) {
  let j = at - 1;
  const skipBack = () => {
    while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  };
  skipBack();
  for (;;) {
    if (src[j] === "]" || src[j] === ")") {
      const open = src[j] === "]" ? "[" : "(";
      let depth = 0;
      while (j >= 0) {
        if (src[j] === (open === "[" ? "]" : ")")) depth++;
        else if (src[j] === open) {
          depth--;
          if (!depth) break;
        }
        j--;
      }
      if (j < 0) return -1;
      // step over the opening bracket so the base of `t[1]` / `f(x)` is seen
      j--;
      skipBack();
      if (j >= 0 && src[j] === ".") {
        j--;
        skipBack();
        continue;
      }
      if (j >= 0 && isIdent(src[j])) {
        continue;
      }
      return -1;
    }
    if (isIdent(src[j])) {
      while (j >= 0 && isIdent(src[j])) j--;
      skipBack();
      if (src[j] === ".") {
        j--;
        skipBack();
        continue;
      }
      return j + 1;
    }
    return -1;
  }
}

const STMT_END_WORDS = ["end", "else", "elseif", "until"];
const DEPTH_OPEN = { "(": 1, "[": 1, "{": 1 };
const DEPTH_CLOSE = { ")": 1, "]": 1, "}": 1 };

function statementEnd(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === "-" && src[j + 1] === "-") {
      j = skipComment(src, j);
      continue;
    }
    if (c === "[") {
      const lb = longBracketAt(src, j);
      if (lb) {
        j = skipLong(src, j, lb);
        continue;
      }
    }
    if (DEPTH_OPEN[c]) depth++;
    else if (DEPTH_CLOSE[c]) {
      if (depth === 0) return j;
      depth--;
    } else if (depth === 0) {
      if (c === ";" || c === "\n") return j;
      if (isIdentStart(c)) {
        let k = j;
        while (k < src.length && isIdent(src[k])) k++;
        const word = src.slice(j, k);
        if (STMT_END_WORDS.includes(word)) return j;
        j = k;
        continue;
      }
    }
    j++;
  }
  return j;
}

function prevSignificant(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j;
}

function prevWord(src, j) {
  if (j < 0 || !isIdent(src[j])) return "";
  let k = j;
  while (k >= 0 && isIdent(src[k])) k--;
  return src.slice(k + 1, j + 1);
}

const EXPR_PREV_CHARS = new Set(["=", "(", ",", "{", "[", "+", "-", "*", "/", "%", "^", "<", ">", "~", "&", "|", "!", "?"]);
const EXPR_PREV_WORDS = new Set(["return", "and", "or", "not", "in"]);

function expressionPosition(src, i) {
  const j = prevSignificant(src, i);
  if (j < 0) return false;
  const c = src[j];
  if (EXPR_PREV_CHARS.has(c)) return true;
  const w = prevWord(src, j);
  return EXPR_PREV_WORDS.has(w);
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function matchKeyword(src, i, word) {
  const j = skipWs(src, i);
  if (src.slice(j, j + word.length) !== word) return -1;
  const after = src[j + word.length];
  if (isIdent(after)) return -1;
  return j + word.length;
}

/**
 * `if c then a elseif d then b else e` in *expression* position.
 *
 * Luau if-expressions have no `end`: each branch is a full expression, so the
 * branches are delimited with `expressionEnd` (the same scanner the compound
 * assignment lowering uses) instead of statement boundaries. That is what makes
 * a nested chain (`if a then if b then 1 else 2 else 3`) come out right: the
 * inner expression is lowered recursively and reports its own end.
 *
 * Result is a closure call, which is exactly equivalent (the branches are
 * evaluated lazily and only one of them runs).
 */
function lowerIfExpression(src, i) {
  // 1. condition, up to `then` at bracket depth zero
  let scan = i + 2;
  let depth0 = 0;
  let thenEnd = -1;
  while (scan < src.length) {
    const c = src[scan];
    if (c === '"' || c === "'") {
      scan = skipQuoted(src, scan);
      continue;
    }
    if (atComment(src, scan)) {
      scan = skipComment(src, scan);
      continue;
    }
    if (DEPTH_OPEN[c]) depth0++;
    else if (DEPTH_CLOSE[c]) depth0--;
    else if (depth0 === 0 && isIdentStart(c)) {
      let k = scan;
      while (k < src.length && isIdent(src[k])) k++;
      if (src.slice(scan, k) === "then") {
        thenEnd = k;
        break;
      }
      scan = k;
      continue;
    }
    scan++;
  }
  if (thenEnd < 0) return null;

  const cond = src.slice(i + 2, thenEnd - 4).trim();
  if (!cond) return null;

  const branchEnd = (at) => {
    const k = skipWs(src, at);
    if (src.startsWith("if ", k) || src.startsWith("if(", k)) {
      const nested = lowerIfExpression(src, k);
      if (nested) return nested.end;
    }
    return expressionEnd(src, at);
  };

  // 2. then-branch
  const aEnd = branchEnd(thenEnd);
  if (aEnd < 0) return null;
  const branchA = src.slice(thenEnd, aEnd).trim();
  if (!branchA) return null;

  // 3. `else` / `elseif` continuation
  const k = skipWs(src, aEnd);
  let branchB;
  let endAt;
  if (src.startsWith("elseif", k)) {
    const restStart = k + 6;
    const rest = "if" + src.slice(restStart);
    const nested = lowerIfExpression(rest, 0);
    if (!nested) return null;
    branchB = nested.text;
    // rest = "if" + src.slice(restStart): rest index k is src index restStart-2+k
    endAt = restStart - 2 + nested.end;
  } else if (src.startsWith("else", k)) {
    const bEnd = branchEnd(k + 4);
    if (bEnd < 0) return null;
    branchB = src.slice(k + 4, bEnd).trim();
    endAt = bEnd;
  } else {
    return null;
  }
  if (!branchB) return null;

  const lowerBranch = (text) => {
    const k = skipWs(text, 0);
    if (text.startsWith("if ", k) || text.startsWith("if(", k)) {
      const nested = lowerIfExpression(text, k);
      if (nested) return text.slice(0, k) + nested.text + text.slice(nested.end);
    }
    return lowerLuau(text);
  };

  return {
    text: `(function() if ${lowerLuau(cond)} then return (${lowerBranch(branchA)}) else return (${lowerBranch(branchB)}) end end)()`,
    end: endAt,
  };
}

const COMPOUND = ["..", "+", "-", "*", "/", "%", "^"];

/** end of a `type Name<T> = <type expression>` alias that starts after the keyword */
function typeAliasEnd(src, afterKeyword) {
  let k = skipWs(src, afterKeyword);
  if (!isIdentStart(src[k])) return -1;
  while (isIdent(src[k])) k++;
  let p = skipWs(src, k);
  if (src[p] === "<") {
    const gt = matchForward(src, p, "<", ">");
    if (gt < 0) return -1;
    p = skipWs(src, gt);
  }
  if (src[p] !== "=" || src[p + 1] === "=") return -1;

  // the type expression runs until a newline or `;` at bracket depth 0, unless
  // the line clearly continues (`|`, `&`, `,`, `->`)
  let depth = 0;
  let j = p + 1;
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === "-" && src[j + 1] === "-") {
      j = skipComment(src, j);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++;
      j++;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      if (depth > 0) depth--;
      j++;
      continue;
    }
    if (depth === 0 && (c === ";" || c === "\n" || c === "\r")) {
      let t = j + 1;
      while (t < n && /\s/.test(src[t])) t++;
      const continues = src[t] === "|" || src[t] === "&" || src[t] === "," ||
        src.slice(Math.max(0, j - 2), j).trim().endsWith("->");
      if (c === ";" || !continues) return j;
      j = t;
      continue;
    }
    j++;
  }
  return n;
}

const NUM_TAIL = /(?:0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/;
const NUM_HEAD = /^(?:0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;

/** index just past the bracket group that opens at `i` */
function matchForward(src, i, open, close) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === "-" && src[j + 1] === "-") {
      j = skipComment(src, j);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/** remove `lhs` (and the whitespace before it) from the tail of `out` */
function cutLvalueFromOut(out, lhs) {
  let k = out.length;
  while (k > 0 && /\s/.test(out[k - 1])) k--;
  if (lhs && out.slice(k - lhs.length, k) === lhs) return out.slice(0, k - lhs.length);
  const start = lvalueStart(out, k);
  return start >= 0 ? out.slice(0, start) : out;
}

/** index of the first character of the atom (identifier chain / group / number) that ends at `end` */
function atomStartBack(src, end) {
  const isClose = (c) => c === "]" || c === ")" || c === "}";
  let j = end - 1;
  const back = () => {
    while (j >= 0 && /\s/.test(src[j])) j--;
  };
  back();
  if (j < 0) return -1;

  if (/[0-9]/.test(src[j])) {
    const num = NUM_TAIL.exec(src.slice(0, j + 1));
    if (num) {
      const numStart = j + 1 - num[0].length;
      if (!isIdent(src[numStart - 1])) return numStart;
    }
  }

  for (;;) {
    back();
    if (j < 0) return -1;
    if (isClose(src[j])) {
      const close = src[j];
      const open = close === "]" ? "[" : close === ")" ? "(" : "{";
      let depth = 0;
      while (j >= 0) {
        if (src[j] === close) depth++;
        else if (src[j] === open) {
          depth--;
          if (!depth) break;
        }
        j--;
      }
      if (j < 0) return -1;
      const openIdx = j;
      let k = openIdx - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      // `t[k][j]`, `f(x).y`, `a:b()` all keep extending leftwards
      if (k >= 0 && (isIdent(src[k]) || isClose(src[k]) || src[k] === "." || src[k] === ":")) {
        j = k;
        continue;
      }
      return openIdx; // a bare parenthesised group is an operand on its own
    }
    if (isIdent(src[j])) {
      while (j >= 0 && isIdent(src[j])) j--;
      let k = j;
      while (k >= 0 && /\s/.test(src[k])) k--;
      if (k >= 0 && (src[k] === "." || src[k] === ":")) {
        j = k - 1;
        continue;
      }
      return j + 1;
    }
    return -1;
  }
}

/** start of the expression that ends at `end` — one operand of a binary operator */
function leftOperandStart(src, end) {
  let start = atomStartBack(src, end);
  if (start < 0) return -1;
  for (;;) {
    const p = prevSignificant(src, start);
    if (p < 0) return start;
    const ch = src[p];
    // `^` binds tighter than `//`; `* / %` share its precedence and associate
    // left, so `a * b // c` is `(a * b) // c`
    if (ch === "^" || ch === "*" || ch === "%" || ch === "/") {
      const inner = leftOperandStart(src, p);
      if (inner >= 0) {
        start = inner;
        continue;
      }
    }
    if (ch === "-" || ch === "#") {
      if (expressionPosition(src, p)) {
        start = p;
        continue;
      }
    }
    const w = prevWord(src, p);
    if (w === "not" && expressionPosition(src, p - w.length + 1)) {
      start = p - w.length + 1;
      continue;
    }
    return start;
  }
}

/** end of the expression that starts at `i` — right operand of `//` */
function rightOperandEnd(src, i) {
  let j = i;
  const fwd = () => {
    while (j < src.length && /\s/.test(src[j])) j++;
  };
  fwd();
  for (;;) {
    if (atComment(src, j)) break;
    if (src[j] === "-" || src[j] === "#") {
      j++;
      fwd();
      continue;
    }
    if (src.slice(j, j + 3) === "not" && !isIdent(src[j + 3])) {
      j += 3;
      fwd();
      continue;
    }
    break;
  }
  if (src[j] === "(") j = matchForward(src, j, "(", ")");
  else if (src[j] === "{") j = matchForward(src, j, "{", "}");
  else if (src[j] === '"' || src[j] === "'") j = skipQuoted(src, j);
  else if (isIdentStart(src[j])) {
    while (j < src.length && isIdent(src[j])) j++;
  } else {
    const m = NUM_HEAD.exec(src.slice(j));
    if (!m) return -1;
    j += m[0].length;
  }
  if (j < 0) return -1;
  // postfix chain: .name [expr] (args) {tbl} :name(args)
  for (;;) {
    const k = j;
    const c = src[k];
    if (c === "." && src[k + 1] !== ".") {
      j = k + 1;
      while (j < src.length && isIdent(src[j])) j++;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") {
      const close = c === "[" ? "]" : c === "(" ? ")" : "}";
      const e = matchForward(src, k, c, close);
      if (e < 0) return -1;
      j = e;
      continue;
    }
    if (c === ":" && src[k + 1] !== ":") {
      j = k + 1;
      while (j < src.length && isIdent(src[j])) j++;
      const p = skipWs(src, j);
      if (src[p] === "(") {
        const e = matchForward(src, p, "(", ")");
        if (e < 0) return -1;
        j = e;
      }
      continue;
    }
    break;
  }
  // `^` binds tighter than `*` and `/`
  const q = skipWs(src, j);
  if (src[q] === "^") {
    const e = rightOperandEnd(src, q + 1);
    if (e > 0) j = e;
  }
  return j;
}

const BINOPS = ["..", "==", "~=", "<=", ">=", "//", "+", "-", "*", "/", "%", "^", "<", ">"];

/** `--` starts a comment; inside an expression it ends the operand */
function atComment(src, i) {
  return src[i] === "-" && src[i + 1] === "-";
}

/**
 * End of a full expression starting at `i` (binary operators included, Lua
 * precedence ignored because `( ... )` around the whole RHS keeps the meaning).
 *
 * The point of this over `statementEnd` is minified input: with no newlines to
 * lean on, `a += 1 b = 2` must stop at `1`, not run to EOF.
 */
function expressionEnd(src, i) {
  let j = rightOperandEnd(src, i);
  if (j < 0) return -1;
  for (;;) {
    const k = skipWs(src, j);
    if (atComment(src, k)) break;
    let op = null;
    for (const cand of BINOPS) {
      if (src.startsWith(cand, k)) { op = cand; break; }
    }
    if (!op) {
      if (/^and\b/.test(src.slice(k, k + 4))) op = "and";
      else if (/^or\b/.test(src.slice(k, k + 3))) op = "or";
    }
    if (!op) break;
    const r = rightOperandEnd(src, k + op.length);
    if (r < 0) break;
    j = r;
  }
  return j;
}

/**
 * Generic parameter list: `id<T>`, `map<K, V>`, `f<T...>`.
 *
 * Only recognised when the `<` is glued to the identifier and the `>` is
 * followed by `(`, which is the only place Luau allows a generic function
 * declaration. `a < b` never matches because of the spaces / the missing `(`.
 */
function genericEnd(src, at) {
  if (src[at] !== "<") return -1;
  let k = at + 1;
  let depth = 1;
  while (k < src.length) {
    const c = src[k];
    if (c === "<") depth++;
    else if (c === ">") {
      depth--;
      if (depth === 0) break;
    } else if (!/[\w\s,.:\[\]?]/.test(c)) return -1;
    k++;
  }
  if (depth !== 0) return -1;
  const after = skipWs(src, k + 1);
  return src[after] === "(" ? k + 1 : -1;
}

/** quote a JS string as a Lua 5.1/Luau literal */
function luaQuote(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 32 || code === 127) out += "\\" + String(code).padStart(3, "0");
    else out += ch;
  }
  return out + '"';
}

/** index of the `}` closing the interpolation segment opened at `at` */
function interpExprEnd(src, at) {
  let k = at + 1;
  let depth = 1;
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "`") {
      const nested = interpEnd(src, k);
      if (nested < 0) return -1;
      k = nested;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return k;
    }
    k++;
  }
  return -1;
}

/** index just past the backtick that closes the literal opening at `at` */
function interpEnd(src, at) {
  let k = at + 1;
  while (k < src.length) {
    const c = src[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "`") return k + 1;
    if (c === "{") {
      const close = interpExprEnd(src, k);
      if (close < 0) return -1;
      k = close + 1;
      continue;
    }
    k++;
  }
  return -1;
}

/**
 * `` `a{x}b` `` -> `("a" .. tostring(x) .. "b")`
 *
 * Luau interpolation is `tostring` of each value in order, so the concatenation
 * is exact -- including nested interpolated strings, which are lowered first.
 */
function lowerInterp(src, at) {
  const end = interpEnd(src, at);
  if (end < 0) return null;

  const segments = [];
  let buf = "";
  let k = at + 1;
  const flush = () => {
    if (buf.length) segments.push({ text: buf });
    buf = "";
  };
  while (k < end - 1) {
    const c = src[k];
    if (c === "\\") {
      const next = src[k + 1];
      const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "`": "`", "{": "{", "}": "}" };
      buf += map[next] !== undefined ? map[next] : next;
      k += 2;
      continue;
    }
    if (c === "{") {
      flush();
      const close = interpExprEnd(src, k);
      if (close < 0) return null;
      segments.push({ expr: src.slice(k + 1, close) });
      k = close + 1;
      continue;
    }
    buf += c;
    k++;
  }
  flush();

  if (!segments.length) return { text: '""', end };
  const parts = segments.map((seg) =>
    seg.text !== undefined ? luaQuote(seg.text) : `tostring(${lowerLuau(seg.expr)})`,
  );
  return { text: `(${parts.join(" .. ")})`, end };
}

/** `\u{1F600}` / `\u0041` -> Lua's `\ddd` byte escapes */
function fixUnicodeEscapes(lit) {
  const toBytes = (cp) => {
    const buf = Buffer.from(String.fromCodePoint(cp), "utf8");
    return [...buf].map((b) => "\\" + String(b).padStart(3, "0")).join("");
  };
  // A single backslash escape, so `\\x41` stays two characters and only the
  // real `\x41` is rewritten. The 5.1 front-end has no `\x`, so every hex
  // escape becomes the decimal byte escape both languages understand
  return lit
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => toBytes(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => toBytes(parseInt(hex, 16)))
    .replace(/(^|[^\\])((?:\\\\)*)\\x([0-9a-fA-F]{2})/g, (m, head, pairs, hex) =>
      head + pairs + "\\" + String(parseInt(hex, 16)).padStart(3, "0"));
}

/**
 * Luau numeric literals Lua 5.1 cannot read:
 *   binary      0b1010        -> 10
 *   separators  1_000_000     -> 1000000
 */
function scanNumber(src, i) {
  let j = i;
  if (src[j] === "0" && /[bB]/.test(src[j + 1] || "")) {
    j += 2;
    while (/[01_]/.test(src[j] || "")) j++;
    return { end: j, text: String(parseInt(src.slice(i + 2, j).replace(/_/g, "") || "0", 2)) };
  }
  if (src[j] === "0" && /[xX]/.test(src[j + 1] || "")) {
    j += 2;
    while (/[0-9a-fA-F_]/.test(src[j] || "")) j++;
    if (src[j] === "." && /[0-9a-fA-F]/.test(src[j + 1] || "")) {
      j++;
      while (/[0-9a-fA-F_]/.test(src[j] || "")) j++;
    }
    if (/[pP]/.test(src[j] || "")) {
      j++;
      if (/[+-]/.test(src[j] || "")) j++;
      while (/[0-9_]/.test(src[j] || "")) j++;
    }
    return { end: j, text: src.slice(i, j).replace(/_/g, "") };
  }
  while (/[0-9_]/.test(src[j] || "")) j++;
  if (src[j] === "." && /[0-9]/.test(src[j + 1] || "")) {
    j++;
    while (/[0-9_]/.test(src[j] || "")) j++;
  }
  if (/[eE]/.test(src[j] || "")) {
    j++;
    if (/[+-]/.test(src[j] || "")) j++;
    while (/[0-9_]/.test(src[j] || "")) j++;
  }
  return { end: j, text: src.slice(i, j).replace(/_/g, "") };
}

function lowerLuau(src) {
  const text = String(src);
  let usedFloorDiv = false;
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === "-" && text[i + 1] === "-") {
      const j = skipComment(text, i);
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = skipQuoted(text, i);
      out += fixUnicodeEscapes(text.slice(i, j));
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      // `0b1010` / `1_000_000` are Luau spellings of an ordinary number
      const prev = out.length ? out[out.length - 1] : "";
      if (!/[A-Za-z0-9_.]/.test(prev)) {
        const num = scanNumber(text, i);
        if (num.end > i) {
          out += num.text;
          i = num.end;
          continue;
        }
      }
    }
    if (text.slice(i, i + 2) === "::") {
      // `x :: T` is a type assertion: it has no runtime meaning, so the cast
      // and its type are dropped and the operand is left in place
      const end = scanType(text, i + 2);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (c === "`") {
      const interp = lowerInterp(text, i);
      if (!interp) throw new Error("unterminated interpolated string");
      out += interp.text;
      i = interp.end;
      continue;
    }
    if (c === "[") {
      const lb = longBracketAt(text, i);
      if (lb) {
        const j = skipLong(text, i, lb);
        out += text.slice(i, j);
        i = j;
        continue;
      }
    }
    if (c === "/" && text[i + 1] === "/") {
      if (text[i + 2] === "=") {
        // a //= b  ->  a = __EATF_FLOORDIV__(a, (b))
        const start = lvalueStart(text, i);
        const before = prevSignificant(text, i);
        if (start >= 0 && before >= 0) {
          const lhs = text.slice(start, before + 1);
          const rhsEnd = expressionEnd(text, i + 3);
          const rhs = text.slice(i + 3, rhsEnd).trim();
          if (lhs && rhs) {
            out = cutLvalueFromOut(out, lhs);
            out += `${lhs} = ${MARK_FLOORDIV}(${lhs}, (${rhs}))`;
            i = rhsEnd;
            usedFloorDiv = true;
            continue;
          }
        }
        throw new Error("unsupported Luau operator '//=' in this position");
      }
      const start = leftOperandStart(out, out.length);
      const end = rightOperandEnd(text, i + 2);
      if (start >= 0 && end > 0) {
        const lhs = out.slice(start);
        const rhs = text.slice(i + 2, end).trim();
        out = out.slice(0, start) + `${MARK_FLOORDIV}((${lhs}), (${rhs}))`;
        i = end;
        usedFloorDiv = true;
        continue;
      }
      throw new Error("unsupported Luau operator '//' (floor division) in this expression");
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdent(text[j])) j++;
      const word = text.slice(i, j);

      // `local function id<T>(...)`: the generic list is Luau-only syntax
      if (text[j] === "<") {
        const g = genericEnd(text, j);
        if (g > 0) {
          out += word;
          i = g;
          continue;
        }
      }

      if (word === "continue") {
        const after = skipWs(text, j);
        const nextCh = text[after];
        const terminators = nextCh === undefined || nextCh === "\n" || nextCh === ";" || nextCh === "\r" ||
          STMT_END_WORDS.some((w) => text.slice(after, after + w.length) === w);
        const memberAccess = text[i - 1] === "." || text[i - 1] === ":";
        if (terminators && !memberAccess) {
          out += `${MARK_CONTINUE}()`;
          i = j;
          continue;
        }
      }

      // type aliases: `type X = ...`, `type X<T> = ...`, `export type X = ...`
      if (word === "export") {
        const afterExport = skipWs(text, j);
        if (text.slice(afterExport, afterExport + 4) === "type" && !isIdent(text[afterExport + 4])) {
          i = afterExport;
          continue;
        }
      }
      if (word === "type") {
        // `o.type` / `o:type()` are member accesses; a comment ending in "."
        // on the previous line is not
        const member = text[i - 1] === "." || text[i - 1] === ":";
        const aliasEnd = member ? -1 : typeAliasEnd(text, j);
        if (aliasEnd > 0) {
          i = aliasEnd;
          continue;
        }
      }

      if (word === "if" && expressionPosition(text, i)) {
        const lowered = lowerIfExpression(text, i);
        if (lowered) {
          out += lowered.text;
          i = lowered.end;
          continue;
        }
      }

      // type annotation: `name: type`
      if (text[j] === ":" && text[j + 1] !== ":") {
        const stripped = stripAnnotationAt(text, j);
        if (stripped > 0) {
          out += word;
          i = stripped;
          continue;
        }
      }

      out += word;
      i = j;
      continue;
    }

    // compound assignment: lvalue op= rhs
    let compoundOp = null;
    if (text.slice(i, i + 2) === "..") compoundOp = "..";
    else if (COMPOUND.includes(c)) compoundOp = c;
    const opLen = compoundOp ? compoundOp.length : 0;
    if (compoundOp && text[i + opLen] === "=" && text[i + opLen + 1] !== "=") {
      const before = prevSignificant(text, i);
      const looksLikeLvalue = before >= 0 && (isIdent(text[before]) || text[before] === "]" || text[before] === ")");
      const notCompare = before >= 0 && !"=<>~".includes(text[before]);
      if (looksLikeLvalue && notCompare) {
        const start = lvalueStart(text, i);
        if (start >= 0) {
          const lhs = text.slice(start, prevSignificant(text, i) + 1);
          const rhsStart = i + opLen + 1;
          const rhsEnd = expressionEnd(text, rhsStart);
          const rhs = text.slice(rhsStart, rhsEnd).trim();
          if (lhs && rhs) {
            out = cutLvalueFromOut(out, lhs);
            out += `${lhs} = ${lhs} ${text.slice(i, i + opLen)} (${rhs})`;
            i = rhsEnd;
            continue;
          }
        }
      }
    }

    if (c === ")") {
      const after = skipWs(text, i + 1);
      if (text[after] === ":" && text[after + 1] !== ":") {
        const stripped = stripAnnotationAt(text, after);
        if (stripped > 0) {
          out += ")";
          i = stripped;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  return usedFloorDiv ? FLOORDIV_HELPER + out : out;
}

/**
 * Parse-only Luau normalisation: map Luau's *operators* onto their Lua 5.1
 * spelling without touching the operands. Used by the syntax gate, which has to
 * cope with one-line artifacts where statement-boundary scanning is not safe.
 *
 *   a += b a ..= b a // b      ->  a = b a = b a / b
 *   a ~= b                     ->  a ~= b   (unchanged)
 *   a != b                     ->  a ~= b
 */
function normalizeLuauOperators(src) {
  const text = String(src);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      const j = skipComment(text, i);
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = skipQuoted(text, i);
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "[") {
      const lb = longBracketAt(text, i);
      if (lb) {
        const j = skipLong(text, i, lb);
        out += text.slice(i, j);
        i = j;
        continue;
      }
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (three === "..=" || three === "//=") {
      out += "=";
      i += 3;
      continue;
    }
    if ((two === "+=" || two === "-=" || two === "*=" || two === "/=" || two === "%=" || two === "^=") && text[i + 2] !== "=") {
      out += "=";
      i += 2;
      continue;
    }
    if (two === "//") {
      out += "/";
      i += 2;
      continue;
    }
    if (two === "!=") {
      out += "~=";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

module.exports = { lowerLuau, normalizeLuauOperators, MARK_CONTINUE, MARK_FLOORDIV };
