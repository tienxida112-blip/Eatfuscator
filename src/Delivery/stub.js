"use strict";

const WATERMARK = "-- Protected By Eatfuscator | dsc.gg/eatfuscator";
const MOD = 16777216;

function keyFor(seed) {
  return 1 + ((seed >>> 0) % 251);
}

const CHUNK_NAMES = [
  "=Workspace.LocalScript",
  "=Workspace.Script",
  "=ReplicatedStorage.Client",
  "=StarterPlayer.StarterPlayerScripts.LocalScript",
  "=ServerScriptService.Server",
  "=Workspace.Module",
];

function modInv256(m) {
  for (let i = 1; i < 256; i += 2) if ((m * i) % 256 === 1) return i;
  throw new Error("no inverse for " + m);
}

function linkParams(seed) {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const m = 2 * Math.floor(next() * 127) + 1;
  const a = 2 * Math.floor(next() * 127) + 1;
  const b = 2 * Math.floor(next() * 127) + 1;
  return { m, inv: modInv256(m), a, b, k: Math.floor(next() * 256) % 256 };
}

function linkChain(p, prev, index) {
  return (prev * p.a + (index + 1) * p.b + p.k) % 256;
}

function normalize(text) {
  return String(text).replace(/\r/g, "").replace(/^\s+/, "").replace(/\s+$/, "");
}

function checksum(text) {
  const bytes = Buffer.from(String(text), "utf8");
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum * 131 + bytes[i]) % MOD;
  return { sum, len: bytes.length };
}

function encodeLink(url, seed) {
  const key = keyFor(seed);
  const p = linkParams(seed);
  const bytes = Buffer.from(String(url), "utf8");
  let hex = "";
  let prev = p.m % 256;
  for (let i = 0; i < bytes.length; i++) {
    const c = (bytes[i] * p.m + linkChain(p, prev, i)) % 256;
    hex += c.toString(16).padStart(2, "0");
    prev = c;
  }
  const parts = 3;
  const size = Math.ceil(hex.length / parts);
  const pieces = [];
  for (let i = 0; i < parts; i++) pieces.push(hex.slice(i * size, (i + 1) * size));
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const order = pieces.map((_, i) => i + 1);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const stored = order.map((src) => pieces[src - 1]);
  return { pieces: stored, order, key, params: p };
}

function luaList(values) {
  return "{" + values.map((v) => (typeof v === "string" ? JSON.stringify(v) : v)).join(",") + "}";
}

function buildStub({ url, urls, payload, seed }) {
  const list = (urls && urls.length ? urls : url ? [url] : []).map(String);
  if (!list.length) throw new Error("stub needs a url");
  const text = normalize(String(payload === undefined || payload === null ? "" : payload));
  const { sum, len } = checksum(text);

  const base = (seed >>> 0) || 1;
  const links = list.map((u, i) => encodeLink(u, (base + i * 7919) >>> 0));
  const table = links
    .map((l) => "{" + luaList(l.pieces) + "," + luaList(l.order) + "," + luaList([l.params.m, l.params.inv, l.params.a, l.params.b, l.params.k]) + "}")
    .join(",");

  const body = [
    `local L={${table}}`,
    `local function G(q)`,
    `local a,e=pcall(function() return game:GetService("HttpService") end)`,
    `if a and e then local b,r=pcall(function() return e:GetAsync(q) end) if b and type(r)=="string" then return r end end`,
    `if type(HttpGet)=="function" then local b,r=pcall(HttpGet,q,true) if b and type(r)=="string" then return r end end`,
    `local b,r=pcall(function() return game:HttpGet(q) end) if b and type(r)=="string" then return r end`,
    `if type(request)=="function" then local b,r=pcall(request,{Url=q,Method="GET"}) if b and type(r)=="table" and type(r.Body)=="string" then return r.Body end end`,
    `if type(syn)=="table" and type(syn.request)=="function" then local b,r=pcall(syn.request,{Url=q,Method="GET"}) if b and type(r)=="table" and type(r.Body)=="string" then return r.Body end end`,
    `return nil`,
    `end`,
    `local s=""`,
    `for _,e in ipairs(L) do`,
    `local p,o,q=e[1],e[2],e[3]`,
    `local t={} for i=1,#p do t[o[i]]=p[i] end`,
    `local h="" for i=1,#p do h=h..t[i] end`,
    `local u="" local v=q[1]%0x100 local n=0`,
    `for i=1,#h,2 do local c=tonumber(h:sub(i,i+1),16) local x=(v*q[3]+(n+1)*q[4]+q[5])%0x100 u=u..string.char((c-x)%0x100*q[2]%0x100) v=c n=n+1 end`,
    `local r=G(u)`,
    `if type(r)~="string" then return end`,
    `s=s..r`,
    `end`,
    `if s:match("^%s*{") then`,
    `local a,e=pcall(function() return game:GetService("HttpService") end)`,
    `local d=nil`,
    `if a and e and e.JSONDecode then local b,r=pcall(function() return e:JSONDecode(s) end) if b then d=r end end`,
    `if type(d)~="table" then return end`,
    `if d.success==false then return end`,
    `local v=nil`,
    `for _,m in ipairs({"content","code","script","source","raw","data","body"}) do if type(d[m])=="string" then v=d[m] break end end`,
    `if type(v)~="string" then return end`,
    `s=v`,
    `end`,
    `s=s:gsub(string.char(13),"")`,
    `s=s:gsub("^%s+",""):gsub("%s+$","")`,
    `if #s~=0x${len.toString(16).toUpperCase()} then return end`,
    `local c=0 for i=1,#s do c=(c*0x83+s:byte(i))%0x1000000 end`,
    `if c~=0x${sum.toString(16).toUpperCase()} then return end`,
    `local l=loadstring or load`,
    `if type(l)~="function" then return end`,
    `local a,f=pcall(l,s,${JSON.stringify(CHUNK_NAMES[(seed >>> 0) % CHUNK_NAMES.length])})`,
    `if not a or type(f)~="function" then return end`,
    `return f()`,
  ].join(" ");

  const code = WATERMARK + "\n" + body + "\n";
  return {
    code,
    bytes: Buffer.byteLength(code),
    checksum: sum,
    length: len,
    parts: links.length,
    link: { key: links[0].key, pieces: links[0].pieces.length, order: links[0].order, urls: list },
  };
}

function luaStringList(body) {
  return body
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^"|"$/g, ""));
}

function luaNumberList(body) {
  return body.split(",").map((x) => Number(x.trim()));
}

function decodeLinkParts(stubText) {
  const link = stubText.match(/local L=\{(\{.*?\})\}\s*local function G/) || stubText.match(/local L=\{(\{.*?\})\}/);
  if (!link) throw new Error("stub has no link block");
  const out = [];
  const re = /\{(\{[^}]*\}),(\{[^}]*\}),(\{[^}]*\})\}/g;
  let m;
  while ((m = re.exec(link[1]))) {
    const pieces = luaStringList(m[1].slice(1, -1));
    const order = luaNumberList(m[2].slice(1, -1));
    const q = luaNumberList(m[3].slice(1, -1));
    const slots = [];
    for (let i = 0; i < pieces.length; i++) slots[order[i] - 1] = pieces[i];
    const hex = slots.join("");
    let url = "";
    let prev = q[0] % 256;
    for (let i = 0; i < hex.length; i += 2) {
      const c = parseInt(hex.slice(i, i + 2), 16);
      const x = (prev * q[2] + (i / 2 + 1) * q[3] + q[4]) % 256;
      const shifted = (((c - x) % 256) + 256) % 256;
      url += String.fromCharCode((shifted * q[1]) % 256);
      prev = c;
    }
    out.push(url);
  }
  if (!out.length) throw new Error("stub has no link block");
  return out;
}

function decodeLink(stubText) {
  return decodeLinkParts(stubText)[0];
}

module.exports = {
  normalize, buildStub, encodeLink, decodeLink, decodeLinkParts, checksum, WATERMARK, keyFor };
