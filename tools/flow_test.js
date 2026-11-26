"use strict";
const assert = require("assert");
const { BASE, setLayout, iABC, iAD, fieldOf } = require("../src/Vm/Image/opcodes");
const { shuffleFlow } = require("../src/Vm/Image/flow");
const { createRNG } = require("../src/Core/rng");

// The tiny interpreter is deliberately independent of the transformer. It
// covers fall-through, skip and forward/backward relative branches.
function run(code) {
  let pc = 0, r = false, count = 0;
  for (let steps = 0; steps < 200; steps++) {
    const w = code[pc++];
    assert.notStrictEqual(w, undefined, "jump outside code");
    const op = fieldOf(w, "op"), a = fieldOf(w, "a"), b = fieldOf(w, "b"), c = fieldOf(w, "c");
    const d = b + c * 256 - 32768;
    if (op === BASE.LOADBOOL) { r = b !== 0; if (c !== 0) pc++; }
    else if (op === BASE.TEST) { if ((r ? 0 : 1) === c) pc++; }
    else if (op === BASE.MOVE) count++;
    else if (op === BASE.JMP) pc += d;
    else if (op === BASE.RETURN) return [r, count];
    else throw new Error("unexpected opcode " + op + " at " + (pc - 1));
  }
  throw new Error("step limit");
}
for (const layout of [[0,1,2,3],[3,2,1,0],[1,3,0,2]]) {
  setLayout(layout);
  for (let seed = 0; seed < 100; seed++) {
    for (const v of [0, 1]) {
      const original = [
        iABC(BASE.LOADBOOL, 1, v, 0), iABC(BASE.TEST, 1, 0, 0),
        iAD(BASE.JMP, 0, 1), iABC(BASE.MOVE, 1, 1, 0),
        iABC(BASE.RETURN, 0, 1, 0),
      ];
      const expected = run(original);
      const proto = { code: original.slice(), child: [] };
      const r = createRNG(seed); const stats = shuffleFlow(proto, BASE, () => r.word() / 4294967296);
      assert.strictEqual(stats.protos, 1);
      assert.deepStrictEqual(run(proto.code), expected);
      assert(proto.code.length > original.length && proto.code.length <= 1 + 3 * original.length);
    }
  }
  for (let seed = 0; seed < 100; seed++) {
    const original = [iABC(BASE.LOADBOOL, 1, 0, 0), iABC(BASE.MOVE, 1, 1, 0),
      iABC(BASE.TEST, 1, 0, 0), iAD(BASE.JMP, 0, 1), iABC(BASE.RETURN, 0, 1, 0),
      iABC(BASE.LOADBOOL, 1, 1, 0), iAD(BASE.JMP, 0, -6)];
    const proto = { code: original.slice(), child: [] }, r = createRNG(seed);
    shuffleFlow(proto, BASE, () => r.word() / 4294967296);
    assert.deepStrictEqual(run(proto.code), run(original));
  }
  const large = { code: Array(10922).fill(iABC(BASE.RETURN, 0, 1, 0)), child: [] };
  const s = shuffleFlow(large, BASE, () => 0.5);
  assert.strictEqual(s.skipped, 1);
  assert.strictEqual(large.code.length, 10922);
}
console.log("flow relocation: 900 branch cases and 3 size-limit cases passed");
