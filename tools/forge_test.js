"use strict";
const assert = require("assert");
const f = require("../src/Vm/Image/stackvm");
const { createRNG } = require("../src/Core/rng");
function decode(stream, ops) {
  let p = 0;
  const h = f.unpack(stream[p++]);
  assert.strictEqual(h.op, ops.HEAD);
  const count = h.operand;
  assert.strictEqual(stream[p++], stream.length);
  const pairHeader = f.unpack(stream[p++]);
  assert.strictEqual(pairHeader.op, ops.PAIRS);
  const pairs = [];
  for (let i = 0; i < pairHeader.operand; i++) pairs.push([stream[p++], stream[p++]]);
  let value; const words = [], shapes = new Set(); let shape = "";
  while (words.length < count) {
    assert(p < stream.length, "truncated forge");
    const { op, operand } = f.unpack(stream[p++]);
    if (op === ops.LIT) { value = operand; shape = "L"; }
    else if (op === ops.LIT_HI) { value += operand * f.LO24; shape += "H"; }
    else if (op === ops.MAD) { assert(pairs[operand]); value = f.madMod(value, ...pairs[operand]); shape += "M"; }
    else if (op === ops.ADD) { value = (value + operand) % f.MOD; shape += "A"; }
    else if (op === ops.SWAP) { value = (value % 65536) * 65536 + Math.floor(value / 65536); shape += "S"; }
    else if (op === ops.STORE) { words.push(value); shapes.add(shape); }
    else throw new Error("invalid forge opcode");
  }
  assert.strictEqual(p, stream.length);
  return { words, shapes };
}
const words = [0, 1, 0xffffffff, 0x80000000, 0x00010000, 0xffff0000,
  ...Array.from({length: 256}, (_, i) => (i * 0x1234567) >>> 0)];
const signatures = new Set();
for (let seed = 0; seed < 100; seed++) {
  const ops = f.createForgeMap(seed), a = createRNG(seed), b = createRNG(seed);
  assert.strictEqual(new Set(Object.values(ops)).size, Object.keys(ops).length);
  const tokens = f.encodeProto(words, a, ops);
  assert.deepStrictEqual(tokens, f.encodeProto(words, b, ops), `seed ${seed}: nondeterministic`);
  const decoded = decode(tokens, ops);
  assert.deepStrictEqual(decoded.words, words, `seed ${seed}: round trip`);
  assert(decoded.shapes.size >= 3, `seed ${seed}: no instruction shape variety`);
  signatures.add(Object.values(ops).join(","));
}
assert.strictEqual(signatures.size, 100, "forge opcode layouts should vary across tested seeds");
console.log("forge: 26,200 words round-tripped across 100 seeded layouts");
