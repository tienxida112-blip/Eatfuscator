"use strict";

/**
 * Source audit used by `npm test` (src/Toolchain/suite.js).
 *
 * The suite imports this to prove that the emitted loader hides its control
 * flow: it counts statement shapes in the artifact and asserts that no `while`
 * loop survived the shaping pass. A real parser is used rather than a regex so
 * that loop keywords inside strings and long-bracket blobs are not miscounted.
 */

const fs = require("fs");
const path = require("path");

const luaparse = require("../src/Vendor/luaparse");
const { shapeCensus } = require("../src/Steps/Shape/loops");

const SHAPE_OF = {
  WhileStatement: "while",
  RepeatStatement: "repeat",
  ForNumericStatement: "forNumeric",
  ForGenericStatement: "forGeneric",
  IfStatement: "if",
  DoStatement: "do",
  ReturnStatement: "return",
  FunctionDeclaration: "function",
  CallExpression: "call",
  TableConstructorExpression: "table",
  AssignmentStatement: "assign",
  LocalStatement: "local",
};

function walk(node, hit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, hit);
    return;
  }
  if (typeof node.type === "string") hit(node);
  for (const key in node) {
    if (key === "range" || key === "loc" || key === "type") continue;
    walk(node[key], hit);
  }
}

/**
 * @param {string} file  path to a Lua/Luau artifact
 * @returns {{file:string, bytes:number, shapes:Array<[string,number]>, nodes:number, error?:string}}
 */
function auditFile(file) {
  const target = path.resolve(String(file));
  const source = fs.readFileSync(target, "latin1");
  const counts = new Map();
  let nodes = 0;

  try {
    const ast = luaparse.parse(source, { luaVersion: "5.1", comments: false, locations: false, ranges: false });
    walk(ast, (node) => {
      nodes++;
      const shape = SHAPE_OF[node.type];
      if (shape) counts.set(shape, (counts.get(shape) || 0) + 1);
    });
  } catch (e) {
    return { file: target, bytes: Buffer.byteLength(source, "latin1"), shapes: [], nodes, error: e.message };
  }

  const shapes = [...counts].sort((a, b) => b[1] - a[1]);
  return { file: target, bytes: Buffer.byteLength(source, "latin1"), shapes, nodes, census: shapeCensus(source) };
}

function auditSource(source) {
  const text = String(source == null ? "" : source);
  return auditFile(writeTemp(text));
}

let seq = 0;
function writeTemp(text) {
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `eat-audit-${process.pid}-${seq++}.lua`);
  fs.writeFileSync(tmp, text, "latin1");
  return tmp;
}

module.exports = { auditFile, auditSource, SHAPE_OF };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node tools/audit.js <artifact.lua> [...]");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const r = auditFile(f);
    const whileCount = r.shapes.reduce((n, [name, c]) => (name === "while" ? n + c : n), 0);
    const status = r.error ? "ERROR" : whileCount ? "LEAKY" : "ok";
    if (r.error || whileCount) bad++;
    console.log(`${status.padEnd(6)} ${r.file} ${r.error || ""}${r.error ? "" : ` bytes=${r.bytes} shapes=${r.shapes.slice(0, 6).map(([k, v]) => `${k}:${v}`).join(" ")}`}`);
  }
  process.exit(bad ? 1 : 0);
}
