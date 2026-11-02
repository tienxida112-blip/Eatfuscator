"use strict";

/**
 * Eatfuscator chunk image — dsc.gg/eatfuscator
 *
 * Serialises the compiled proto tree into one byte string. The image is what
 * travels through the existing cipher/LZ/CJK pipeline, so no Lua text and no
 * printable payload ever appears in the artifact.
 *
 *   u16  proto count
 *   per proto: u8 numparams, u8 isvararg, u8 upvalues, u8 reserved,
 *              u16 code count, u16 const count, u16 child count,
 *              code   : n * u32 little endian
 *              consts : n * (u8 tag [1 nil,2 false,3 true,4 number,5 string]
 *                            + u16 length + ascii/raw bytes)
 *              upvals : n * (u8 kind, u8 index)
 *              child  : n * u16 proto index
 */

const TAG = { NIL: 1, FALSE: 2, TRUE: 3, NUMBER: 4, STRING: 5 };
const TYPES = ["nil", "false", "true", "number", "string"];
const FIELD_WIDTH = [1, 1, 1, 1, 2, 2, 2]; // numParams, isVararg, uvCount, reserved, ncode, nk, nchild
const FIELD_ORDER = [0, 1, 2, 3, 4, 5, 6]; // the order a plain build writes
const TAG_OF = { nil: 1, false: 2, true: 3, number: 4, string: 5 };

function numText(v) {
  if (Number.isInteger(v) && Math.abs(v) <= 9007199254740991) return String(v);
  if (!isFinite(v)) return v > 0 ? "inf" : v < 0 ? "-inf" : "nan";
  return v.toPrecision(17);
}

function indexProtos(root) {
  const order = [];
  const seen = new Map();
  const visit = (p) => {
    if (seen.has(p)) return seen.get(p);
    const idx = order.length;
    seen.set(p, idx);
    order.push(p);
    for (const c of p.child) visit(c);
    return idx;
  };
  visit(root);
  return { order, seen };
}

function serialize(root, layout = {}) {
  const fieldOrder = layout.fieldOrder || FIELD_ORDER;
  const tagOf = layout.tagOf || TAG_OF;
  if (fieldOrder.length !== 7) throw new Error("image layout: header order needs 7 fields");
  const { order, seen } = indexProtos(root);
  const out = [];

  const u8 = (v) => out.push(v & 0xff);
  const u16 = (v) => out.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  u16(order.length);

  for (const p of order) {
    // the seven header fields are written in the order this build chose, so the
    // same loader cannot read two artifacts with one fixed reader
    const header = [
      () => u8(p.numParams),
      () => u8(p.isVararg ? 1 : 0),
      () => u8(p.uv.length),
      () => u8(0),
      () => u16(p.code.length),
      () => u16(p.k.length),
      () => u16(p.child.length),
    ];
    for (const field of fieldOrder) {
      if (FIELD_WIDTH[field] === undefined) throw new Error("image layout: bad header field");
      header[field]();
    }

    for (const word of p.code) u32(word >>> 0);

    for (const kon of p.k) {
      if (kon.t === "nil") u8(tagOf.nil);
      else if (kon.t === "boolean") u8(kon.v ? tagOf.true : tagOf.false);
      else if (kon.t === "number") {
        // the text is already enciphered when a stream key is in play (see
        // Image/cipher.js); the encoder never sees the digits either way
        const text = kon.enc ? String(kon.v) : numText(kon.v);
        u8(tagOf.number);
        u16(text.length);
        for (let i = 0; i < text.length; i++) u8(text.charCodeAt(i));
      } else {
        const bytes = Buffer.from(String(kon.v), "latin1"); // source is byte-exact latin1
        if (bytes.length > 0xffff) throw new Error("constant string too long");
        u8(tagOf.string);
        u16(bytes.length);
        for (const b of bytes) u8(b);
      }
    }

    for (const uv of p.uv) {
      u8(uv.kind || (uv.fromReg ? 1 : 2));
      u8(uv.idx);
    }

    for (const c of p.child) u16(seen.get(c));
  }

  return Buffer.from(out);
}

module.exports = { serialize, indexProtos, numText, TAG, TYPES, FIELD_ORDER, TAG_OF };
