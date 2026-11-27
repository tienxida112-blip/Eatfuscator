"use strict";

const MARK = /^(\s*)(if|elseif) o == __OP_([A-Z]+)__ then$/;
const FALLBACK = 1e6;

function split(source) {
  const start = source.indexOf("    if o == __OP_");
  if (start < 0) return null;
  let tailAt = -1;
  {
    let at = start;
    while (at >= 0 && at < source.length) {
      const nl = source.indexOf("\n", at);
      const line = source.slice(at, nl < 0 ? source.length : nl);
      const t = line.trim();
      if (/^end\s+else$/.test(t)) {
        tailAt = at + line.indexOf("else");
        break;
      }
      if (/^else$/.test(t) && (line.length - line.trimStart().length) === 4) {
        tailAt = at + line.indexOf("else");
        break;
      }
      at = nl < 0 ? -1 : nl + 1;
    }
  }
  if (tailAt < 0) return null;
  const body = source.slice(start, tailAt);
  const blocks = [];
  let cur = null;
  for (const line of body.split("\n")) {
    const m = MARK.exec(line);
    if (m) {
      cur = { name: m[3], lines: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (!blocks.length) return null;
  for (const b of blocks) {
    while (b.lines.length && b.lines[b.lines.length - 1].trim() === "") b.lines.pop();
    b.text = b.lines.join("\n").replace(/\s+$/, "");
  }
  const tailEnd = source.indexOf("\n    end\n", tailAt);
  const end = tailEnd < 0 ? source.length : tailEnd + "\n    end\n".length;
  return {
    head: source.slice(0, start),
    tail: "    " + source.slice(tailAt, end),
    rest: source.slice(end),
    blocks,
  };
}

function reorder(source, priority) {
  const parts = split(source);
  if (!parts) return source;
  const rank = new Map();
  (priority || []).forEach((name, i) => {
    if (!rank.has(name)) rank.set(name, i);
  });
  const blocks = parts.blocks.slice();
  blocks.sort((a, b) => (rank.has(a.name) ? rank.get(a.name) : FALLBACK) - (rank.has(b.name) ? rank.get(b.name) : FALLBACK));
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    out += (i === 0 ? "    if o == __OP_" : "    elseif o == __OP_") + b.name + "__ then\n" + b.text + "\n";
  }
  return parts.head + out + parts.tail + parts.rest;
}

function names(source) {
  const parts = split(source);
  return parts ? parts.blocks.map((b) => b.name) : [];
}

module.exports = { reorder, names, split };

function tailIndex(source) {
  const start = source.indexOf("    if o == __OP_");
  if (start < 0) return -1;
  let at = start;
  while (at >= 0 && at < source.length) {
    const nl = source.indexOf("\n", at);
    const line = source.slice(at, nl < 0 ? source.length : nl);
    const t = line.trim();
    if (/^end\s+else$/.test(t)) return at + line.indexOf("else");
    if (/^else$/.test(t) && line.length - line.trimStart().length === 4) return at + line.indexOf("else");
    at = nl < 0 ? -1 : nl + 1;
  }
  return -1;
}

function inject(source, branches) {
  if (!branches || !branches.length) return source;
  const at = tailIndex(source);
  if (at < 0) return source;
  let add = "";
  for (const b of branches) add += "    elseif o == " + b.code + " then\n" + b.body + "\n";
  return source.slice(0, at) + add + source.slice(at);
}

module.exports.inject = inject;
const BODY_VARIANTS = [
  {
    id: "move-temp",
    from: "      reg[a] = reg[b]\n",
    to: "      local __V9701__=reg[b] reg[a]=__V9701__\n",
  },
  {
    id: "loadk-additive",
    from: "      reg[a] = konst[ds + T_ONE]\n",
    to: "      reg[a]=konst[ds+T_TWO-T_ONE]\n",
  },
  {
    id: "loadk-swapped",
    from: "      reg[a] = konst[ds + T_ONE]\n",
    to: "      reg[a]=konst[T_ONE+ds]\n",
  },
  {
    id: "index-temp",
    from: "      reg[a] = reg[b][reg[c]]\n",
    to: "      local __V9702__=reg[b] reg[a]=__V9702__[reg[c]]\n",
  },
  {
    id: "len-temp",
    from: "      reg[a] = #reg[b]\n",
    to: "      local __V9703__=reg[b] reg[a]=#__V9703__\n",
  },
  {
    id: "upval-swapped",
    from: "      reg[a] = ups[b + T_ONE][T_CELL]\n",
    to: "      reg[a]=ups[T_ONE+b][T_CELL]\n",
  },
  {
    id: "setfield-temp",
    from: "      reg[a][konst[c + T_ONE]] = reg[b]\n",
    to: "      local __V9704__=konst[T_ONE+c] reg[a][__V9704__]=reg[b]\n",
  },
  {
    id: "addk-temp",
    from: "      reg[a] = reg[b] + konst[c + T_ONE]\n",
    to: "      local __V9705__=konst[T_ONE+c] reg[a]=reg[b]+__V9705__\n",
  },
  {
    id: "subk-swapped",
    from: "      reg[a] = reg[b] - konst[c + T_ONE]\n",
    to: "      reg[a]=reg[b]-konst[T_ONE+c]\n",
  },
  {
    id: "divk-swapped",
    from: "      reg[a] = reg[b] / konst[c + T_ONE]\n",
    to: "      reg[a]=reg[b]/konst[T_ONE+c]\n",
  },
  {
    id: "modk-swapped",
    from: "      reg[a] = reg[b] % konst[c + T_ONE]\n",
    to: "      reg[a]=reg[b]%konst[T_ONE+c]\n",
  },
  {
    id: "jump-swapped",
    from: "      pc = pc + ds\n",
    to: "      pc=ds+pc\n",
  },
];

function varyBodies(source, rng) {
  const roll = typeof rng === "function" ? rng : Math.random;
  let out = source;
  const applied = [];
  const used = new Set();
  for (const v of BODY_VARIANTS) {
    if (out.indexOf(v.from) < 0) continue;
    if (used.has(v.from)) continue;
    if (roll() >= 0.6) continue;
    out = out.split(v.from).join(v.to);
    used.add(v.from);
    applied.push(v.id);
  }
  return { code: out, applied };
}

module.exports.varyBodies = varyBodies;
module.exports.BODY_VARIANTS = BODY_VARIANTS;

const HEAD_RE = /^\s*if o == (.+) then$/;
const BRANCH_RE = /^\s*elseif o == (.+) then$/;

function parseChain(source) {
  const start = source.indexOf("    if o == ");
  if (start < 0) return null;
  let tailAt = -1;
  let at = start;
  while (at >= 0 && at < source.length) {
    const nl = source.indexOf("\n", at);
    const line = source.slice(at, nl < 0 ? source.length : nl);
    const t = line.trim();
    const indent = line.length - line.trimStart().length;
    if (/^end\s+else$/.test(t) || (/^else$/.test(t) && indent <= 4)) {
      tailAt = at + line.indexOf("else");
      break;
    }
    at = nl < 0 ? -1 : nl + 1;
  }
  if (tailAt < 0) return null;

  let endLine = tailAt;
  {
    const before = source.lastIndexOf("\n", tailAt - 1);
    if (before > start && /^\s*end\s*$/.test(source.slice(before, tailAt))) endLine = before;
  }

  const body = source.slice(start, endLine);
  const blocks = [];
  let cur = null;
  for (const line of body.split("\n")) {
    const a = HEAD_RE.exec(line);
    const b = a ? null : BRANCH_RE.exec(line);
    if (a || b) {
      cur = { key: (a || b)[1].trim(), lines: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (!blocks.length) return null;
  for (const blk of blocks) {
    while (blk.lines.length && blk.lines[blk.lines.length - 1].trim() === "") blk.lines.pop();
    blk.text = blk.lines.join("\n").replace(/\s+$/, "");
  }

  const tailEnd = source.indexOf("\n    end\n", tailAt);
  const end = tailEnd < 0 ? source.length : tailEnd + "\n    end\n".length;
  return { head: source.slice(0, start), rest: source.slice(end), blocks };
}

function keyNumber(key) {
  if (/^0x[0-9a-f]+$/i.test(key)) return parseInt(key, 16);
  if (/^\d+$/.test(key)) return Number(key);
  return null;
}

function tree(source, options) {
  const opts = options || {};
  const parts = parseChain(source);
  if (!parts) return { code: source, applied: false, reason: "no dispatch chain" };

  const words = (parts.blocks || []).map((b, i) => ({
    key: b.key,
    value: keyNumber(b.key),
    body: b.text,
    weight: 1,
    index: i,
  })).filter((w) => w.value !== null && w.body.length);
  if (words.length < 20) return { code: source, applied: false, reason: "chain too short for a tree" };

  const weightOf = typeof opts.weight === "function" ? opts.weight : () => 1;
  for (const w of words) w.weight = Math.max(1, weightOf(w.value, w.index) | 0);

  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const pick = (n) => Math.floor(rng() * n) % n;

  words.sort((a, b) => a.value - b.value);
  const pad = (n) => "  ".repeat(n);
  const onMiss = typeof opts.onMiss === "string" && opts.onMiss.length ? opts.onMiss : "return __V0709__()";
  const trap = (depth) => `${pad(depth)}${onMiss}`;
  let nodes = 0;
  let leaves = 0;

  const pickPivot = (list) => {
    let total = 0;
    for (const w of list) total += w.weight;
    let acc = 0;
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < list.length; i++) {
      acc += list[i].weight;
      const gap = Math.abs(total - acc - acc);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return best;
  };

  const bodyAt = (text, depth) => text.split("\n").map((line) => (line.trim() ? pad(depth) + line.replace(/^ {6}/, "") : line)).join("\n");

  const leaf = (w, depth, invert) => {
    leaves += 1;
    if (invert) {
      return `${pad(depth)}if o ~= ${w.key} then\n${trap(depth + 1)}\n${pad(depth)}else\n${w.body}\n${pad(depth)}end`;
    }
    return `${pad(depth)}if o == ${w.key} then\n${w.body}\n${pad(depth)}else\n${trap(depth + 1)}\n${pad(depth)}end`;
  };

  const bst = (list, depth) => {
    if (list.length === 1) return leaf(list[0], depth, rng() < 0.35);
    const at = pickPivot(list);
    const pivot = list[at];
    const left = list.slice(0, at);
    const right = list.slice(at + 1);
    nodes += 1;
    const pivotText = rng() < 0.5 ? pivot.key : "0x" + pivot.value.toString(16).toUpperCase();
    const l = left.length ? bst(left, depth + 1) : null;
    const r = right.length ? bst(right, depth + 1) : null;

    if (!l) {
      return `${pad(depth)}if o == ${pivotText} then\n${bodyAt(pivot.body, depth + 1)}\n${pad(depth)}else\n${r}\n${pad(depth)}end`;
    }
    if (!r) {
      return `${pad(depth)}if o == ${pivotText} then\n${bodyAt(pivot.body, depth + 1)}\n${pad(depth)}else\n${l}\n${pad(depth)}end`;
    }
    const mid = bodyAt(pivot.body, depth + 2);
    const head = pick(3);
    if (head === 0) {
      return `${pad(depth)}if o < ${pivotText} then\n${l}\n${pad(depth)}else\n${pad(depth + 1)}if o == ${pivotText} then\n${mid}\n${pad(depth + 1)}else\n${r}\n${pad(depth + 1)}end\n${pad(depth)}end`;
    }
    if (head === 1) {
      return `${pad(depth)}if o >= ${pivotText} then\n${pad(depth + 1)}if o == ${pivotText} then\n${mid}\n${pad(depth + 1)}else\n${r}\n${pad(depth + 1)}end\n${pad(depth)}else\n${l}\n${pad(depth)}end`;
    }
    return `${pad(depth)}if o <= ${pivotText} then\n${pad(depth + 1)}if o == ${pivotText} then\n${mid}\n${pad(depth + 1)}else\n${l}\n${pad(depth + 1)}end\n${pad(depth)}else\n${r}\n${pad(depth)}end`;
  };

  const bucket = (list, depth) => {
    const mod = 4 + pick(5);
    const buckets = [];
    for (let b = 0; b < mod; b++) buckets.push([]);
    for (const w of list) buckets[w.value % mod].push(w);
    let out = "";
    for (let b = 0; b < mod; b++) {
      const body = buckets[b].length ? bst(buckets[b].sort((x, y) => x.value - y.value), depth + 1) : `${pad(depth + 1)}${trap(depth + 1)}`;
      if (b === 0) out += `${pad(depth)}if o % ${mod} == 0 then\n${body}\n`;
      else if (b === mod - 1) out += `${pad(depth)}else\n${body}\n`;
      else out += `${pad(depth)}elseif o % ${mod} == ${b} then\n${body}\n`;
    }
    return out + `${pad(depth)}end`;
  };

  // A separate dispatch family: an affine residue partitions the opcode space,
  // the residue branches are permuted, and each partition has its own tree.
  // No instruction is moved to a residue it cannot reach. This varies the
  // control structure rather than just spelling the same handler differently.
  const affine = (list, depth) => {
    const mod = 3 + pick(6);
    const mul = 1 + pick(7);
    const salt = pick(mod);
    const groups = Array.from({ length: mod }, () => []);
    for (const w of list) groups[(w.value * mul + salt) % mod].push(w);
    const order = Array.from({ length: mod }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = pick(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    let out = "";
    for (let i = 0; i < order.length; i++) {
      const residue = order[i];
      const group = groups[residue];
      const branch = group.length ? bst(group, depth + 1) : trap(depth + 1);
      out += `${pad(depth)}${i === 0 ? "if" : "elseif"} (o * ${mul} + ${salt}) % ${mod} == ${residue} then\n${branch}\n`;
    }
    return out + `${pad(depth)}else\n${trap(depth + 1)}\n${pad(depth)}end`;
  };

  const strategy = opts.strategy || ["bst", "bucket", "affine", "bst", "affine"][pick(5)];
  let body;
  if (strategy === "bucket" && words.length >= 24) body = bucket(words, 2);
  else if (strategy === "affine" && words.length >= 24) body = affine(words, 2);
  else body = bst(words, 2);

  const code = parts.head + body + "\n" + parts.rest;
  return { code, applied: true, stats: { leaves, nodes, branches: words.length, strategy } };
}

module.exports.tree = tree;
module.exports.parseChain = parseChain;

