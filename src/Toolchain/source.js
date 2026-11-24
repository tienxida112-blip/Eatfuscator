"use strict";

const fs = require("fs");
const path = require("path");

const VALUE_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "Sample", "Test", "Vendor"]);

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev === "str" || prev === "num" || prev === "regex") return false;
  if (prev === ")" || prev === "]" || prev === "}") return false;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prev)) return VALUE_KEYWORDS.has(prev);
  return true;
}

function scanJs(src) {
  const out = [];
  let count = 0;
  let i = 0;
  const n = src.length;
  const stack = [{ type: "code", brace: 0, prev: "" }];
  const top = () => stack[stack.length - 1];
  if (src.startsWith("#!")) {
    const e = src.indexOf("\n");
    out.push(src.slice(0, e < 0 ? n : e + 1));
    i = e < 0 ? n : e + 1;
  }
  while (i < n) {
    const ctx = top();
    const c = src[i];
    if (ctx.type === "tpl") {
      if (c === "\\") {
        out.push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === "`") {
        out.push("`");
        i++;
        stack.pop();
        top().prev = "str";
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        out.push("${");
        i += 2;
        stack.push({ type: "code", brace: 0, prev: "" });
        continue;
      }
      out.push(c);
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      count += 1;
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      count += 1;
      const e = src.indexOf("*/", i + 2);
      if (e < 0) break;
      const nl = (src.slice(i, e + 2).match(/\n/g) || []).length;
      if (nl) out.push("\n".repeat(nl));
      i = e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (src[j] === "\n") break;
        j++;
      }
      out.push(src.slice(i, j));
      i = j;
      ctx.prev = "str";
      continue;
    }
    if (c === "`") {
      out.push("`");
      i++;
      stack.push({ type: "tpl" });
      continue;
    }
    if (c === "/" && regexAllowed(ctx.prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          j++;
          closed = true;
          break;
        } else if (d === "\n") break;
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out.push(src.slice(i, j));
        i = j;
        ctx.prev = "regex";
        continue;
      }
    }
    if (c === "{") {
      ctx.brace++;
      out.push(c);
      i++;
      ctx.prev = "{";
      continue;
    }
    if (c === "}") {
      if (stack.length > 1 && ctx.brace === 0) {
        stack.pop();
        out.push("}");
        i++;
        continue;
      }
      ctx.brace = Math.max(0, ctx.brace - 1);
      out.push(c);
      i++;
      ctx.prev = "}";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      out.push(w);
      ctx.prev = w;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObBeE._]/.test(src[j])) j++;
      out.push(src.slice(i, j));
      ctx.prev = "num";
      i = j;
      continue;
    }
    if (!/\s/.test(c)) ctx.prev = c;
    out.push(c);
    i++;
  }
  return { code: out.join(""), count };
}

function scanLua(src) {
  const out = [];
  let count = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") {
      count += 1;
      let j = i + 2;
      if (src[j] === "[") {
        let k = j + 1;
        let eq = 0;
        while (src[k] === "=") {
          eq++;
          k++;
        }
        if (src[k] === "[") {
          const close = "]" + "=".repeat(eq) + "]";
          const e = src.indexOf(close, k + 1);
          const end = e < 0 ? n : e + close.length;
          const nl = (src.slice(i, end).match(/\n/g) || []).length;
          if (nl) out.push("\n".repeat(nl));
          i = end;
          continue;
        }
      }
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (src[j] === "\n") break;
        j++;
      }
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "[" && (src[i + 1] === "[" || src[i + 1] === "=")) {
      let k = i + 1;
      let eq = 0;
      while (src[k] === "=") {
        eq++;
        k++;
      }
      if (src[k] === "[") {
        const close = "]" + "=".repeat(eq) + "]";
        const e = src.indexOf(close, k + 1);
        const end = e < 0 ? n : e + close.length;
        out.push(src.slice(i, end));
        i = end;
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return { code: out.join(""), count };
}

function scan(code, kind) {
  return String(kind).toLowerCase() === "lua" ? scanLua(String(code)) : scanJs(String(code));
}

function stripComments(code, kind) {
  const r = scan(code, kind);
  return r.code;
}

function countComments(code, kind) {
  return scan(code, kind).count;
}

function moduleFiles(root) {
  const files = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(".js") || name.endsWith(".lua")) files.push(full);
    }
  })(root);
  return files.sort();
}

module.exports = { stripComments, countComments, scan, moduleFiles };
// Toolchain source module expanded
const SOURCE_EXTRA = {
  // Additional skip dirs
  skip_dirs: new Set(['node_modules', '.git', 'Sample', 'Test', 'Vendor', 'extra', 'extra2', 'extra3']),
  // Additional protected patterns
  protected_patterns: [/\.git$/, /\.svn$/, /\.hg$/, /\.DS_Store$/, /^Thumbs\.db$/],
  // Additional source patterns
  source_patterns: [/\.lua$/, /\.luau$/, /\.js$/, /\.ts$/, /\.tsx$/],
  // Additional protected files
  protected_files: ['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md'],
  // Source version
  version: '2.0.0',
  built: new Date().toISOString(),
};
module.exports.SOURCE_EXTRA = SOURCE_EXTRA;
// End of source module expansion
