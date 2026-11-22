"use strict";

const https = require("https");
const http = require("http");

const DEFAULT_ENDPOINT = "https://api.rubis.app/v2/scrap";
const DEFAULT_TIMEOUT = 20000;

function endpoint() {
  return process.env.RUBIS_ENDPOINT || DEFAULT_ENDPOINT;
}

function timeoutMs() {
  const v = Number(process.env.RUBIS_TIMEOUT || DEFAULT_TIMEOUT);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT;
}

function request(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      reject(new Error(`bad url: ${url}`));
      return;
    }
    const lib = u.protocol === "http:" ? http : https;
    const payload = body === undefined || body === null ? null : Buffer.from(String(body), "utf8");
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      timeout: timeoutMs(),
      headers: Object.assign(
        payload ? { "Content-Type": "text/plain; charset=utf-8", "Content-Length": payload.length } : {},
        headers || {}
      ),
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs()}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(text) {
  const head = String(text || "").trimStart().slice(0, 1);
  if (head !== "{" && head !== "[") return { isJson: false, value: null };
  try {
    return { isJson: true, value: JSON.parse(text) };
  } catch (_) {
    return { isJson: false, value: null };
  }
}

function queryString(params) {
  const out = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return out.length ? "?" + out.join("&") : "";
}

function makeAccessKey(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < (n || 24); i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function createScrap(text, opts) {
  const options = opts || {};
  const url = endpoint() + queryString({
    public: options.public === true ? "true" : undefined,
    accessKey: options.public === true ? undefined : options.accessKey,
    title: options.title,
  });
  const res = await request("POST", url, String(text));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`rubis refused the upload: HTTP ${res.status} ${String(res.body).slice(0, 160)}`);
  }
  const parsed = parseJson(res.body);
  if (!parsed.isJson || !parsed.value || typeof parsed.value !== "object") {
    throw new Error(`rubis returned a non-JSON body: ${String(res.body).slice(0, 120)}`);
  }
  const v = parsed.value;
  if (v.success === false) throw new Error(`rubis rejected the upload: ${v.message || "no message"}`);
  const id = v.scrapID || v.id;
  if (!id) throw new Error("rubis response has no scrap id");
  return {
    id,
    raw: v.raw || `https://api.rubis.app/v2/scrap/${id}/raw`,
    rawWithKey: v.raw_with_key || null,
    view: v.view || null,
    public: v.public === true,
    title: v.title || null,
    createdAt: v.createdAt || null,
  };
}

async function fetchScrap(rawUrl) {
  const res = await request("GET", rawUrl, null, { Accept: "text/plain" });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`rubis fetch failed: HTTP ${res.status} ${String(res.body).slice(0, 120)}`);
  }
  return res.body;
}

function extractText(body) {
  const parsed = parseJson(body);
  if (!parsed.isJson || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: true, text: body };
  }
  const v = parsed.value;
  if (v.success === false) {
    return { ok: false, reason: `rubis said no: ${v.message || "no message"}` };
  }
  for (const k of ["content", "code", "script", "source", "raw", "data", "body"]) {
    if (typeof v[k] === "string" && v[k].length) return { ok: true, text: v[k] };
  }
  return { ok: false, reason: "json body carried no script text" };
}

async function verify(rawUrl, expected) {
  const body = await fetchScrap(rawUrl);
  if (body === expected) return { ok: true, bytes: Buffer.byteLength(body) };
  const got = Buffer.byteLength(body);
  const want = Buffer.byteLength(expected);
  return {
    ok: false,
    bytes: got,
    reason: got === want ? "same length, different bytes" : `${want} uploaded, ${got} served`,
  };
}

module.exports = {
  endpoint,
  createScrap,
  fetchScrap,
  extractText,
  verify,
  parseJson,
  makeAccessKey,
  request,
};
