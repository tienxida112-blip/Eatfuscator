#!/usr/bin/env node
"use strict";
// Inspect an Eatfuscator bootstrap without running it. This only extracts the
// compressed loader, not the original Lua source or the virtualized bytecode.
const fs = require("fs");
const zlib = require("zlib");

function extract(text) {
  const input = String(text);
  const start = /=\[(=*)\[EAT-/.exec(input);
  if (!start) throw new Error("compressed EAT- payload not found");
  const open = start.index + start[0].length - 4;
  const close = "]" + start[1] + "]";
  const end = input.indexOf(close, open);
  if (end < 0) throw new Error("unterminated payload literal");
  const blob = input.slice(open, end);
  const prefix = input.slice(0, start.index);
  const literal = /local\s+[A-Za-z_][A-Za-z0-9_]*=\[(=*)\[([\s\S]*?)\]\1\]/g;
  let m, alphabet = null;
  while ((m = literal.exec(prefix))) {
    if (m[2].length === 91 && new Set(m[2]).size === 91) alphabet = m[2];
  }
  if (!alphabet) throw new Error("bootstrap alphabet not found");
  const tail = input.slice(end + close.length);
  const sizeMatch = /^\s*local\s+[A-Za-z_][A-Za-z0-9_]*=(\d+)\b/.exec(tail);
  const keyMatch = /\([A-Za-z_][A-Za-z0-9_]*\*(\d+)\+(\d+)\)%256\)%256\)/.exec(tail);
  if (!sizeMatch || !keyMatch) throw new Error("bootstrap size or byte transform not found");
  const size = Number(sizeMatch[1]), k1 = Number(keyMatch[1]), k2 = Number(keyMatch[2]);
  const data = blob.slice(4);
  if (data.length % 5 || size > data.length / 5 * 4 || size < 0) throw new Error("invalid packed length");
  const out = Buffer.alloc(size);
  let pos = 0;
  for (let i = 0; i < data.length; i += 5) {
    let word = 0;
    for (let j = 0; j < 5; j++) {
      const digit = alphabet.indexOf(data[i + j]);
      if (digit < 0) throw new Error("invalid payload symbol");
      word = word * 91 + digit;
    }
    if (word > 0xffffffff) throw new Error("invalid packed word");
    for (let j = 0; j < 4 && pos < size; j++) {
      const byte = Math.floor(word / Math.pow(256, 3 - j)) % 256;
      out[pos] = (byte - (pos * k1 + k2) % 256 + 256) % 256;
      pos++;
    }
  }
  return zlib.inflateRawSync(out, { maxOutputLength: 64 * 1024 * 1024 });
}

if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error("usage: node tools/extract_stage.js <artifact.lua> <loader.lua>");
    const stage = extract(fs.readFileSync(input, "utf8"));
    fs.writeFileSync(output, stage);
    console.log(`Extracted loader: ${stage.length} bytes`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { extract };
