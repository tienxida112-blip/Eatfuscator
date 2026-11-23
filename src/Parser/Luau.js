"use strict";

const MARK_CONTINUE = "__EATF_CONTINUE__";
const MARK_FLOORDIV = "__EATF_FLOORDIV__";

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
      const esc = src[i + 1];
      i += 2;
      if (esc === "z") while (i < src.length && /[ \t\r\n\v\f]/.test(src[i])) i++;
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

// Luau attributes: `@native` / `@checked` decorate a function declaration
// (`@native local function f() ... end`). They are codegen hints with no runtime
// meaning of their own, so the lowerer drops them: `@` cannot appear anywhere
// else in Lua, which makes the token unambiguous.
function scanAttribute(src, at) {
  if (src[at] !== "@") return -1;
  let j = at + 1;
  if (!isIdentStart(src[j])) return -1;
  while (j < src.length && isIdent(src[j])) j++;
  return j;
}

// `::name::` is a label, and `expr :: type` is a cast. Both start with `::`, so
// the label shape is tested first: `::` ident `::` with nothing else between.
function scanLabel(src, at) {
  if (src.slice(at, at + 2) !== "::") return -1;
  let j = at + 2;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (!isIdentStart(src[j])) return -1;
  while (j < src.length && isIdent(src[j])) j++;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src.slice(j, j + 2) !== "::") return -1;
  return j + 2;
}

// `...: number` / `...: ...number` - a typed vararg. The annotation runs to the
// `)` that closes the parameter list, so it is scanned with depth counting rather
// than by the general type scanner (which does not accept a leading `...`).
function scanVarargAnnotation(src, colon) {
  let j = colon + 1;
  let depth = 0;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src.slice(j, j + 3) === "...") j += 3;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") { j = skipQuoted(src, j); continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === ")") { if (depth === 0) return j; depth--; }
    else if (c === "," && depth === 0) return -1;
    j++;
  }
  return -1;
}

// A function's return annotation (`function f(): number`) sits after the `)`
// that closes the parameter list, where the identifier-driven annotation stripper
// cannot see it. `):name(` is also a legal method call (`f(x):g()`), so the shape
// has to come from the declaration: find the parameter list, then the `:`.
function paramListEnd(src, afterKeyword) {
  let j = afterKeyword;
  const n = src.length;
  while (j < n && /\s/.test(src[j])) j++;
  // optional generic list: `function f<T, U>(`
  if (src[j] === "<") {
    let depth = 0;
    while (j < n) {
      if (src[j] === "<") depth++;
      else if (src[j] === ">") { depth--; j++; if (!depth) break; continue; }
      j++;
    }
    while (j < n && /\s/.test(src[j])) j++;
  }
  // name, dotted name, or method name
  while (j < n && (isIdent(src[j]) || src[j] === "." || src[j] === ":" || /\s/.test(src[j]))) j++;
  if (src[j] !== "(") return -1;
  let depth = 0;
  while (j < n) {
    const c = src[j];
    if (c === '"' || c === "'") { j = skipQuoted(src, j); continue; }
    if (c === "\u0060") { j++; while (j < n && src[j] !== "\u0060") j += src[j] === "\\" ? 2 : 1; j++; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; j++; if (!depth) return j - 1; continue; }
    j++;
  }
  return -1;
}

function returnTypeEnd(src, colon) {
  let j = colon + 1;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src.slice(j, j + 3) === "...") {
    // a packed variadic return type: `...number`, `...(number, string)`
    j += 3;
    const packed = scanType(src, j);
    if (packed > 0) j = packed;
    else if (src[j] === "(") { let d = 0; while (j < src.length) { if (src[j] === "(") d++; else if (src[j] === ")") { d--; j++; if (!d) break; continue; } j++; } }
  } else {
    const after = scanType(src, j);
    if (after < 0) return -1;
    j = after;
  }
  const k = skipWs(src, j);
  if (k >= src.length) return j;
  if (TYPE_END.has(src[k])) return j;
  if (isIdentStart(src[k])) {
    let e = k;
    while (e < src.length && isIdent(src[e])) e++;
    if (TYPE_END_WORDS.includes(src.slice(k, e))) return j;
  }
  return -1;
}

// `function f(a: number): string` - the return annotation follows the `)` and is
// therefore invisible to the identifier-driven stripper, while `):name(` is also a
// legal method call. It is removed in a pre-pass instead of inline, so the
// parameter list still goes through the normal annotation handling.
function stripReturnAnnotations(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") { const j = skipComment(src, i); out += src.slice(i, j); i = j; continue; }
    if (c === '"' || c === "'") { const j = skipQuoted(src, i); out += src.slice(i, j); i = j; continue; }
    if (c === "[") {
      const lb = longBracketAt(src, i);
      if (lb) { const j = skipLong(src, i, lb); out += src.slice(i, j); i = j; continue; }
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      out += word;
      if (word === "function") {
        const close = paramListEnd(src, j);
        if (close > 0) {
          const colonAt = skipWs(src, close + 1);
          if (src[colonAt] === ":" && src[colonAt + 1] !== ":") {
            const retEnd = returnTypeEnd(src, colonAt);
            if (retEnd > 0) {
              out += src.slice(j, colonAt);
              i = retEnd;
              continue;
            }
          }
        }
      }
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
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

function lowerIfExpression(src, i) {

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

  const aEnd = branchEnd(thenEnd);
  if (aEnd < 0) return null;
  const branchA = src.slice(thenEnd, aEnd).trim();
  if (!branchA) return null;

  const k = skipWs(src, aEnd);
  let branchB;
  let endAt;
  if (src.startsWith("elseif", k)) {
    const restStart = k + 6;
    const rest = "if" + src.slice(restStart);
    const nested = lowerIfExpression(rest, 0);
    if (!nested) return null;
    branchB = nested.text;

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

function cutLvalueFromOut(out, lhs) {
  let k = out.length;
  while (k > 0 && /\s/.test(out[k - 1])) k--;
  if (lhs && out.slice(k - lhs.length, k) === lhs) return out.slice(0, k - lhs.length);
  const start = lvalueStart(out, k);
  return start >= 0 ? out.slice(0, start) : out;
}

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

      if (k >= 0 && (isIdent(src[k]) || isClose(src[k]) || src[k] === "." || src[k] === ":")) {
        j = k;
        continue;
      }
      return openIdx;
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

function leftOperandStart(src, end) {
  let start = atomStartBack(src, end);
  if (start < 0) return -1;
  for (;;) {
    const p = prevSignificant(src, start);
    if (p < 0) return start;
    const ch = src[p];

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

  const q = skipWs(src, j);
  if (src[q] === "^") {
    const e = rightOperandEnd(src, q + 1);
    if (e > 0) j = e;
  }
  return j;
}

const BINOPS = ["..", "==", "~=", "<=", ">=", "//", "+", "-", "*", "/", "%", "^", "<", ">"];

function atComment(src, i) {
  return src[i] === "-" && src[i + 1] === "-";
}

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

function fixUnicodeEscapes(lit) {
  const toBytes = (cp) => {
    const buf = Buffer.from(String.fromCodePoint(cp), "utf8");
    return [...buf].map((b) => "\\" + String(b).padStart(3, "0")).join("");
  };

  return lit
    .replace(/\\z[ \t\r\n\v\f]*/g, "")
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => toBytes(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => toBytes(parseInt(hex, 16)))
    .replace(/(^|[^\\])((?:\\\\)*)\\x([0-9a-fA-F]{2})/g, (m, head, pairs, hex) =>
      head + pairs + "\\" + String(parseInt(hex, 16)).padStart(3, "0"));
}

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


function lowerBinaryNumbers(src) {
  const text = String(src);
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
    if (c === "0" && (text[i + 1] === "b" || text[i + 1] === "B") && /[01]/.test(text[i + 2] || "")) {
      let j = i + 2;
      while (j < n && /[01_]/.test(text[j])) j++;
      out += String(parseInt(text.slice(i + 2, j).replace(/_/g, ""), 2));
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lowerLuau(src) {
  const text = stripReturnAnnotations(lowerBinaryNumbers(String(src)));
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
    if (c === "@") {
      const attrEnd = scanAttribute(text, i);
      if (attrEnd < 0) throw new Error("stray '@' in source");
      // The attribute is a hint, not a statement: drop it, keep the declaration.
      out += " ";
      i = attrEnd;
      continue;
    }
    if (c === "." && text.slice(i, i + 3) === "...") {
      const colonAt = skipWs(text, i + 3);
      if (text[colonAt] === ":" && text[colonAt + 1] !== ":") {
        const close = scanVarargAnnotation(text, colonAt);
        if (close > 0) {
          out += "...";
          i = close;
          continue;
        }
      }
      out += "...";
      i += 3;
      continue;
    }
    if (c === ":" && text[i + 1] === ":") {
      const labelEnd = scanLabel(text, i);
      if (labelEnd > 0) {
        // A label is only reachable through `goto`, and the only `goto` this
        // lowerer accepts is `goto continue` (see below), so the label goes too.
        i = labelEnd;
        continue;
      }
    }
    if (c >= "0" && c <= "9") {

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

      if (text[j] === "<") {
        const g = genericEnd(text, j);
        if (g > 0) {
          out += word;
          i = g;
          continue;
        }
      }

      if (word === "goto") {
        const afterGoto = skipWs(text, j);
        let e = afterGoto;
        while (e < n && isIdent(text[e])) e++;
        const label = text.slice(afterGoto, e);
        if (label === "continue") {
          // `goto continue` with a `::continue::` label at the end of the loop
          // body is the standard Luau spelling of `continue`.
          out += `${MARK_CONTINUE}()`;
          i = e;
          continue;
        }
        throw new Error(
          `goto ${label || "?"} is not supported: neither Luau nor Lua 5.1 has goto ` +
          `(Luau spells it 'continue', which this build does support); rewrite the jump ` +
          `as a loop, a function, or 'continue'`
        );
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

      if (word === "export") {
        const afterExport = skipWs(text, j);
        if (text.slice(afterExport, afterExport + 4) === "type" && !isIdent(text[afterExport + 4])) {
          i = afterExport;
          continue;
        }
      }
      if (word === "type") {

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

function normalizeLuauOperators(src) {
  const text = lowerBinaryNumbers(String(src));
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

module.exports = { lowerLuau, normalizeLuauOperators, lowerBinaryNumbers, MARK_CONTINUE, MARK_FLOORDIV };
