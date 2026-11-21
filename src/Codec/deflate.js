"use strict";
/*
 * DEFLATE (RFC 1951), via zlib. Info-ZIP lineage, and the reason the payload
 * bank got ~9% smaller than the old LZSS scheme: LZ77 with a 32K window,
 * lazy matching, and dynamic Huffman blocks, plus stored blocks when a chunk is
 * incompressible. The decoder lives in the runtime template (Template/runtime.lua),
 * not here, because the artifact has to inflate itself.
 */
const zlib = require("zlib");

const OPTS = { level: 9, memLevel: 9, windowBits: 15 };

function compress(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (src.length === 0) return zlib.deflateRawSync(Buffer.alloc(0), OPTS);
  return zlib.deflateRawSync(src, OPTS);
}

function decompress(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (src.length === 0) return Buffer.alloc(0);
  return zlib.inflateRawSync(src);
}

// Used by the suite: proves the JS side and the Lua side agree.
function roundTrip(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return decompress(compress(src)).equals(src);
}

module.exports = { compress, decompress, roundTrip, CODEC: "deflate" };
