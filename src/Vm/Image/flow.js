"use strict";

// Split the instruction stream into varied blocks and shuffle them. A pair of
// jumps preserves the VM's one-instruction skip semantics; relative loop/jump
// operands are relocated to the shuffled destination. This is not encryption:
// the executed path can still be reconstructed by tracing the jumps.
const { fieldOf, iAD } = require("./opcodes");

function shuffleProto(proto, ops, rng, stats) {
  for (const child of proto.child) shuffleProto(child, ops, rng, stats);
  const old = proto.code;
  const n = old.length;
  // A signed 16-bit branch must span the entire layout. Never truncate it.
  if (!n || 1 + 3 * n > 32766) { stats.skipped++; return; }
  const branch = new Set([ops.JMP, ops.FORPREP, ops.FORLOOP, ops.TFORPREP, ops.TFORLOOP]);
  const skip = new Set([ops.TEST, ops.TESTSET, ops.EQ, ops.NE, ops.LT, ops.LE, ops.GT, ops.GE, ops.LOADBOOL]);
  const terminal = new Set([ops.RETURN, ops.TAILCALL]);
  const targetOf = (i, w) => i + 1 + fieldOf(w, "b") + 256 * fieldOf(w, "c") - 32768;
  // Do not change malformed or unusual fall-through semantics. The original
  // compiler output still runs, but this prototype is not shuffled.
  for (let i = 0; i < n; i++) {
    const w = old[i], op = fieldOf(w, "op");
    if (branch.has(op) && (targetOf(i, w) < 0 || targetOf(i, w) >= n)) { stats.skipped++; return; }
    if (skip.has(op) && i + 2 >= n) { stats.skipped++; return; }
    if (i + 1 >= n && !terminal.has(op) && op !== ops.JMP && op !== ops.TFORPREP) { stats.skipped++; return; }
  }
  // Form variable-length blocks. A skip, branch or return must end its block so
  // both fall-through and skip destinations keep their original meaning. A jump
  // into the middle is legal: `at` maps every instruction, not just block heads.
  const blocks = [];
  for (let first = 0; first < n;) {
    const max = 1 + Math.floor(rng() * 4);
    let end = first;
    while (end < n) {
      const op = fieldOf(old[end], "op");
      end++;
      if (branch.has(op) || skip.has(op) || terminal.has(op) || end - first >= max) break;
    }
    blocks.push({ first, end });
    first = end;
  }
  const order = blocks.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const at = new Array(n);
  let next = 1;
  for (const block of order) {
    block.base = next;
    for (let i = block.first; i < block.end; i++) at[i] = next++;
    next += 2;
  }
  const jump = (from, to) => {
    const d = to - from - 1;
    if (d < -32768 || d > 32767) throw new Error("flow: relocated jump out of range");
    return iAD(ops.JMP, 0, d) >>> 0;
  };
  const out = new Array(next);
  out[0] = jump(0, at[0]);
  for (const block of order) {
    for (let i = block.first; i < block.end; i++) {
      const w = old[i] >>> 0, op = fieldOf(w, "op"), p = at[i];
      out[p] = branch.has(op) ? iAD(op, fieldOf(w, "a"), at[targetOf(i, w)] - p - 1) >>> 0 : w;
    }
    const last = block.end - 1, p = at[last];
    // The second slot is only reachable from a skip; the first preserves normal
    // fall-through, including the non-taken side of conditional loop branches.
    out[p + 1] = jump(p + 1, at[last + 1 < n ? last + 1 : last]);
    out[p + 2] = jump(p + 2, at[last + 2 < n ? last + 2 : last]);
  }
  proto.code = out;
  stats.protos++;
  stats.words += n;
}

function shuffleFlow(root, ops, rng) {
  if (typeof rng !== "function") throw new Error("flow: seeded rng required");
  const stats = { protos: 0, words: 0, skipped: 0 };
  shuffleProto(root, ops, rng, stats);
  return stats;
}
module.exports = { shuffleFlow };
