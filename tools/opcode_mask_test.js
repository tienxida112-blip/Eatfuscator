"use strict";
const assert = require("assert");
const op = require("../src/Vm/Image/opcodes");
const cipher = require("../src/Vm/Image/cipher");
const f = require("../src/Vm/Image/feistel");
function perms(xs) { return xs.length ? xs.flatMap((x, i) => perms(xs.filter((_, j) => i !== j)).map(t => [x, ...t])) : [[]]; }
let checked = 0, legacyMatches = 0;
for (const layout of perms([0, 1, 2, 3])) {
  op.setLayout(layout);
  for (const seed of [0, 7, 1234]) {
    const keys = { k1: 87123 + seed, k2: 93456 + seed, salt: 7531 + seed };
    const original = Array.from({length: 40}, (_, j) => op.iABC(op.BASE.MOVE, (j * 7) % 256, (j * 3) % 256, 255 - j));
    const child = {code: original.slice(), child: []}, root = {code: original.slice(), child: [child]};
    cipher.cipherCode(root, keys);
    const box = cipher.buildBox(keys), sch = f.schedule(box, f.DOMAIN_CODE, 0, 0, f.ROUNDS);
    for (const [index, proto] of [[1, root], [2, child]]) {
      let chain = cipher.chainSeed(sch.iv, index), digest = 0;
      for (let j = 0; j < original.length; j++) {
        const mixed = f.decryptWord(f.mod(proto.code[j] - chain, f.P32), sch);
        const w = f.mod(mixed - f.counterAt(j + 1, index), f.P32);
        digest = (digest * 31 + w) % 4294967296;
        const flip = cipher.opcodeFlip(box, index, j + 1);
        if (op.setField(w, "op", op.fieldOf(w, "op") - flip) === original[j]) legacyMatches++;
        const unmasked = cipher.unmaskOperands(w, box, index, j + 1);
        assert.strictEqual(op.setField(unmasked, "op", op.fieldOf(unmasked, "op") - flip), original[j]);
        assert.strictEqual(cipher.maskOperands(unmasked, box, index, j + 1), w);
        chain = cipher.chainStep(chain, w);
        checked++;
      }
      assert.strictEqual(digest, proto.codeDigest);
      assert.notStrictEqual(cipher.opcodeFlip(box, index, 1), cipher.opcodeFlip(box, index, 2), "test keys should vary by position");
    }
  }
}
assert.strictEqual(legacyMatches, 0, 'old opcode-only decoder unexpectedly recovered a full word in this sample');
console.log(`opcode and operand masks: ${checked} words checked across 24 layouts, 3 keys and 2 prototypes; opcode-only decoder recovered ${legacyMatches} full words`);
