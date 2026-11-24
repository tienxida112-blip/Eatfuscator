"use strict";

const TAG = { NIL: 1, FALSE: 2, TRUE: 3, NUMBER: 4, STRING: 5 };
const TYPES = ["nil", "false", "true", "number", "string"];
const FIELD_WIDTH = [1, 1, 1, 1, 2, 2, 2];
const FIELD_ORDER = [0, 1, 2, 3, 4, 5, 6];
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

    const header = [
      () => u8(p.numParams),
      () => u8(p.isVararg ? 1 : 0),
      () => u8(p.uv.length),
      () => u8(0),
      // code.length is the length of whatever is stored in the image - a stack
      // program after the forge pass - so a proto that went through the forge
      // records its register word count in wordCount instead.
      () => u16(p.wordCount !== undefined ? p.wordCount : p.code.length),
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

        const text = kon.enc ? String(kon.v) : numText(kon.v);
        u8(tagOf.number);
        u16(text.length);
        for (let i = 0; i < text.length; i++) u8(text.charCodeAt(i));
      } else {
        // A string constant carries a 32-bit length. It used to be 16 bits, which
        // capped a literal at 65 535 bytes - real obfuscator output routinely
        // carries one payload literal of hundreds of kilobytes, and the build died
        // on it with "constant string too long". 1 MB per constant is far past
        // anything the VM will see and still leaves the field cheap.
        const bytes = Buffer.from(String(kon.v), "latin1");
        if (bytes.length > 0x100000) throw new Error(`constant string too long: ${bytes.length} bytes`);
        u8(tagOf.string);
        u32(bytes.length);
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
