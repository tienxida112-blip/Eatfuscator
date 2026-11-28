"use strict";

const luaparse = require("../../Vendor/luaparse");
const { BASE } = require("../Image/opcodes");

const C = require("./context");
require("./capture");
require("./emit");
require("./scope");
require("./expr");
require("./closure");
require("./stat");

function compile(text, options = {}) {
  const ops = options.ops || BASE;
  const ast = luaparse.parse(text, {
    luaVersion: "5.1",
    comments: false,
    locations: false,
    ranges: false,
    encodingMode: "pseudo-latin1",
  });

  const readonly = C.findReadonly(ast);
  const captured = C.findCaptured(ast);
  const boxed = new Set([...captured].filter((name) => !readonly.has(name)));
  const fs = C.newFunc(null, ops, boxed, options.dedupe !== false, readonly);
  fs.proto.isVararg = true;
  C.enterBlock(fs);
  C.compileBlock(ast.body, fs);
  C.leaveBlock(fs);
  C.emitABC(fs, "RETURN", 1, 1, 0);
  return fs.proto;
}

module.exports = { compile, OP: BASE, findCaptured: C.findCaptured, findReadonly: C.findReadonly };
