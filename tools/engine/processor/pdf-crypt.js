// Opening password-protected PDFs for writing (QA round 7). pdf.js reads them for previews; pdf-lib, which writes
// the new PDF, can't decrypt, so this file does it: the PDF standard security handler — RC4 40–128 bit (R2–R4),
// AES-128 (R4) and AES-256 (R5/R6). Objects are parsed by pdf-lib with compressed object streams held back, every
// string and stream is decrypted with its own key, then the held-back object streams are decrypted and unpacked.
// The result is an ordinary, unencrypted pdf-lib document; the password is only used here and never kept.
// Works in the processor page and in Node (unit tests): pdf-lib comes from self.PDFLib, AES and SHA-2 from WebCrypto.
const L = () => self.PDFLib;
const subtle = () => globalThis.crypto.subtle;

// ------------------------------------------------------------------ small crypto pieces
const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const same = (a, b, n) => { if (a.length < n || b.length < n) return false; for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };

/** MD5 of bytes (RFC 1321). */
export function md5(bytes) {
  const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  const n = bytes.length, total = ((n + 8) >>> 6) + 1 << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[n] = 0x80;
  const bits = n * 8;
  for (let i = 0; i < 4; i++) m[total - 8 + i] = (bits >>> (8 * i)) & 255;
  m[total - 4] = Math.floor(n / 2 ** 29) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const w = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = m[off + 4 * i] | (m[off + 4 * i + 1] << 8) | (m[off + 4 * i + 2] << 16) | (m[off + 4 * i + 3] << 24);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const s = S[(i >> 4) * 4 + (i & 3)];
      const x = (a + f + K[i] + w[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, k) => { for (let i = 0; i < 4; i++) out[4 * k + i] = (v >>> (8 * i)) & 255; });
  return out;
}

/** RC4 (encrypting and decrypting are the same). */
export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const aesKey = (key, use) => subtle().importKey('raw', key, { name: 'AES-CBC' }, false, [use]);
/** AES-CBC encryption without padding (data is whole blocks). */
async function aesEncrypt(key, iv, data) {
  const k = await aesKey(key, 'encrypt');
  return new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, k, data)).subarray(0, data.length);
}
/** AES-CBC decryption of whole blocks, leaving any padding in place. WebCrypto insists on valid padding, so a block
 *  that decrypts to a full padding block is added after the data and taken off again. */
async function aesDecryptRaw(key, iv, data) {
  if (!data.length) return new Uint8Array(0);
  const last = data.subarray(data.length - 16);
  const extra = (await subtle().encrypt({ name: 'AES-CBC', iv: last }, await aesKey(key, 'encrypt'), new Uint8Array(16).fill(16))).slice(0, 16);
  const k = await aesKey(key, 'decrypt');
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, k, concat(data, new Uint8Array(extra))));
}
/** A PDF AES string or stream: a 16-byte IV, then the data with PKCS#7 padding (taken off when it is valid). */
async function aesOpen(key, data) {
  if (data.length < 32) return new Uint8Array(0);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  const out = await aesDecryptRaw(key, data.subarray(0, 16), body);
  const p = out[out.length - 1];
  if (p >= 1 && p <= 16 && out.length >= p && out.subarray(out.length - p).every((v) => v === p)) return out.subarray(0, out.length - p);
  return out;
}
const sha = async (name, data) => new Uint8Array(await subtle().digest(name, data));

/** The hash of PDF 2.0 (algorithm 2.B, R6) — or plain SHA-256 for R5. */
async function hash2B(pw, salt, udata, r) {
  let K = await sha('SHA-256', concat(pw, salt, udata));
  if (r < 6) return K;
  for (let i = 0; ; i++) {
    const one = concat(pw, K, udata);
    const K1 = new Uint8Array(one.length * 64);
    for (let j = 0; j < 64; j++) K1.set(one, j * one.length);
    const E = await aesEncrypt(K.subarray(0, 16), K.subarray(16, 32), K1);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod += E[j];
    K = await sha(['SHA-256', 'SHA-384', 'SHA-512'][mod % 3], E);
    if (i >= 63 && E[E.length - 1] <= i - 31) break;
  }
  return K.subarray(0, 32);
}

// ------------------------------------------------------------------ the security handler
const bytesOf = (v) => (v && typeof v.asBytes === 'function' ? v.asBytes() : new Uint8Array(0));
const numOf = (v, def) => (v && typeof v.asNumber === 'function' ? v.asNumber() : def);
const nameOf = (v) => (v && typeof v.decodeText === 'function' ? v.decodeText() : v ? String(v).replace(/^\//, '') : '');
function pwBytes(password, utf8) {
  const s = String(password || '');
  if (utf8) return new TextEncoder().encode(s.normalize('NFKC')).subarray(0, 127);
  // R2–R4: PDFDocEncoding, which matches Latin-1 for the characters people type; anything else as UTF-8.
  if ([...s].every((c) => c.charCodeAt(0) < 256)) return Uint8Array.from([...s].map((c) => c.charCodeAt(0))).subarray(0, 32);
  return new TextEncoder().encode(s).subarray(0, 32);
}
const pad32 = (pw) => concat(pw.subarray(0, 32), PAD.subarray(0, 32 - Math.min(32, pw.length)));

/** What the Encrypt dictionary says: {v, r, n (key bytes), O, U, OE, UE, P, metadata, stm, str ('rc4'|'aes'|'aes256'|null)}. */
function readEncrypt(enc) {
  const { PDFName, PDFDict } = L();
  const get = (k) => enc.lookup(PDFName.of(k));
  const filter = nameOf(get('Filter'));
  if (filter && filter !== 'Standard') return { unsupported: `This PDF uses a kind of protection (${filter}) DropDial can’t open.` };
  const v = numOf(get('V'), 0), r = numOf(get('R'), 2);
  let n = Math.round(numOf(get('Length'), 40) / 8);
  const meta = get('EncryptMetadata');
  const info = { v, r, O: bytesOf(get('O')), U: bytesOf(get('U')), OE: bytesOf(get('OE')), UE: bytesOf(get('UE')), P: numOf(get('P'), -1) | 0, metadata: !(meta && String(meta) === 'false') };
  let stm = 'rc4', str = 'rc4';
  if (v >= 4) {
    const cf = get('CF');
    const method = (which) => {
      const f = nameOf(get(which)) || 'Identity';
      if (f === 'Identity') return null;
      const d = cf instanceof PDFDict ? cf.lookup(PDFName.of(f)) : null;
      const cfm = d instanceof PDFDict ? nameOf(d.lookup(PDFName.of('CFM'))) : 'None';
      return cfm === 'AESV3' ? 'aes256' : cfm === 'AESV2' ? 'aes' : cfm === 'V2' ? 'rc4' : null;
    };
    stm = method('StmF'); str = method('StrF');
    if (v === 4) n = 16;
  }
  if (v === 5 || r >= 5) { n = 32; if (stm) stm = 'aes256'; if (str) str = 'aes256'; }
  if (r === 2) n = 5;
  if (!(n >= 5 && n <= 32) || !(r >= 2 && r <= 6) || !(v >= 1 && v <= 5) || v === 3) return { unsupported: 'This PDF uses a kind of protection DropDial can’t open.' };
  return { ...info, n, stm, str };
}

/** The file key for R2–R4 from a padded user password (algorithm 2). */
function key2(padded, e, id0) {
  const p = new Uint8Array(4);
  for (let i = 0; i < 4; i++) p[i] = (e.P >>> (8 * i)) & 255;
  let h = md5(concat(padded, e.O.subarray(0, 32), p, id0, e.r >= 4 && !e.metadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)));
  if (e.r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, e.n));
  return h.subarray(0, e.n);
}
/** Does this key open the file as its user (algorithms 4 and 5)? */
function userKeyOk(key, e, id0) {
  if (e.r === 2) return same(rc4(key, PAD), e.U, 32);
  let x = rc4(key, md5(concat(PAD, id0)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return same(x, e.U, 16);
}
/** The padded user password recovered with the owner password (algorithm 7). */
function ownerToUser(pw, e) {
  let h = md5(pad32(pw));
  if (e.r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const key = h.subarray(0, e.n);
  if (e.r === 2) return rc4(key, e.O.subarray(0, 32));
  let x = e.O.subarray(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(key.map((b) => b ^ i), x);
  return x;
}

/** {key, owner} when `password` opens the file (as its user or owner), or null. */
export async function fileKey(e, id0, password) {
  if (e.r >= 5) {
    const pw = pwBytes(password, true);
    const U = e.U.subarray(0, 48), O = e.O.subarray(0, 48);
    if (U.length < 48 || O.length < 48) return null;
    if (same(await hash2B(pw, U.subarray(32, 40), new Uint8Array(0), e.r), U, 32)) {
      return { key: await aesDecryptRaw(await hash2B(pw, U.subarray(40, 48), new Uint8Array(0), e.r), new Uint8Array(16), e.UE.subarray(0, 32)), owner: false };
    }
    if (same(await hash2B(pw, O.subarray(32, 40), U, e.r), O, 32)) {
      return { key: await aesDecryptRaw(await hash2B(pw, O.subarray(40, 48), U, e.r), new Uint8Array(16), e.OE.subarray(0, 32)), owner: true };
    }
    return null;
  }
  const pw = pwBytes(password, false);
  let key = key2(pad32(pw), e, id0);
  if (userKeyOk(key, e, id0)) return { key, owner: false };
  key = key2(pad32(ownerToUser(pw, e)), e, id0);
  if (userKeyOk(key, e, id0)) return { key, owner: true };
  return null;
}

/** The key for one object (algorithm 1); AES-256 uses the file key itself. */
function objectKey(file, ref, method) {
  if (method === 'aes256') return file;
  const n = ref.objectNumber, g = ref.generationNumber;
  const extra = Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255);
  const h = md5(concat(file, extra, method === 'aes' ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0)));
  return h.subarray(0, Math.min(file.length + 5, 16));
}
async function decryptWith(method, key, data) {
  if (!method || !data.length) return data;
  return method === 'rc4' ? rc4(key, data) : aesOpen(key, data);
}

// ------------------------------------------------------------------ parsing with object streams held back
let patched = false;
/** pdf-lib unpacks object streams as it parses; for an encrypted file they are kept for later (contexts marked
 *  __ddHold only — every other load is untouched). */
function patchParser() {
  if (patched) return;
  patched = true;
  const { PDFParser, PDFObjectStreamParser } = L();
  const header = PDFParser.prototype.parseIndirectObjectHeader;
  PDFParser.prototype.parseIndirectObjectHeader = function () {
    const ref = header.call(this);
    if (this.context && this.context.__ddHold) this.context.__ddHold.last = ref;
    return ref;
  };
  const forStream = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = function (raw, tick) {
    const hold = raw && raw.dict && raw.dict.context && raw.dict.context.__ddHold;
    if (hold) return { parseIntoContext: async () => { hold.streams.push({ ref: hold.last, raw }); } };
    return forStream.call(this, raw, tick);
  };
}

/** A quick look for an /Encrypt entry in the trailer (at the end, or at the start of a linearized file). */
export function isEncrypted(bytes) {
  const K = 1 << 20, n = bytes.length;
  const look = (a, b) => new TextDecoder('latin1').decode(bytes.subarray(a, b)).includes('/Encrypt');
  return look(Math.max(0, n - K), n) || (n > K && look(0, K));
}

/** Permission bits (P) as plain words: what the PDF asks apps not to allow. */
export function restrictionsOf(P) {
  const no = [];
  if (!(P & 4)) no.push('printing');
  if (!(P & 8) || !(P & 1024)) no.push('editing');
  if (!(P & 16)) no.push('copying');
  return no;
}

/**
 * Parse and decrypt an encrypted PDF. Returns {doc (pdf-lib PDFDocument), restricted: [words], owner} when the
 * password (empty for files that only have restrictions) opens it, or {needPassword: true, wrongPassword} when not,
 * or {unsupported: message}.
 */
export async function openEncrypted(bytes, password) {
  const { PDFParser, ParseSpeeds, PDFDocument, PDFObjectStreamParser, PDFRawStream, PDFDict, PDFArray, PDFString, PDFHexString, PDFName, PDFRef } = L();
  patchParser();
  const parser = PDFParser.forBytesWithOptions(bytes, ParseSpeeds.Fastest, false, false);
  const hold = { streams: [], last: null };
  parser.context.__ddHold = hold;
  let ctx;
  try { ctx = await parser.parseDocument(); } finally { delete parser.context.__ddHold; }
  const encRef = ctx.trailerInfo.Encrypt;
  const enc = encRef ? ctx.lookup(encRef) : null;
  if (!(enc instanceof PDFDict)) return null; // not encrypted after all
  const e = readEncrypt(enc);
  if (e.unsupported) return { unsupported: e.unsupported };
  let id0 = new Uint8Array(0);
  const ids = ctx.trailerInfo.ID && ctx.lookup(ctx.trailerInfo.ID);
  if (ids instanceof PDFArray && ids.size()) id0 = bytesOf(ids.lookup(0));
  const tries = password ? [password] : [''];
  let found = null;
  for (const pw of tries) if ((found = await fileKey(e, id0, pw))) break;
  if (!found) return { needPassword: true, wrongPassword: !!password };

  const TYPE = PDFName.of('Type'), META = PDFName.of('Metadata'), FILTER = PDFName.of('Filter');
  const skip = new Set([encRef instanceof PDFRef ? encRef.toString() : '']);
  // Strings inside a dictionary or array, replaced by their decrypted bytes (as hex strings, which keep any byte).
  const fix = async (obj, key) => {
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) {
        if (v instanceof PDFString || v instanceof PDFHexString) obj.set(k, await plain(v, key));
        else if (v instanceof PDFDict || v instanceof PDFArray) await fix(v, key);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        if (v instanceof PDFString || v instanceof PDFHexString) obj.set(i, await plain(v, key));
        else if (v instanceof PDFDict || v instanceof PDFArray) await fix(v, key);
      }
    }
  };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const plain = async (s, key) => PDFHexString.of(hex(await decryptWith(e.str, key, s.asBytes())));
  const crypted = (dict) => {
    const f = dict.lookup(FILTER);
    const names = f instanceof PDFArray ? f.asArray().map(String) : f ? [String(f)] : [];
    return !names.includes('/Crypt');
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (skip.has(ref.toString())) continue;
    const kStr = e.str ? objectKey(found.key, ref, e.str) : null;
    if (obj instanceof PDFRawStream) {
      if (kStr) await fix(obj.dict, kStr);
      const isMeta = obj.dict.lookup(TYPE) === META;
      if (e.stm && crypted(obj.dict) && !(isMeta && !e.metadata)) {
        const data = await decryptWith(e.stm, objectKey(found.key, ref, e.stm), obj.contents);
        ctx.assign(ref, PDFRawStream.of(obj.dict, data));
      }
    } else if (kStr && (obj instanceof PDFDict || obj instanceof PDFArray)) await fix(obj, kStr);
    else if (kStr && (obj instanceof PDFString || obj instanceof PDFHexString)) ctx.assign(ref, await plain(obj, kStr));
  }
  // The object streams, decrypted and then unpacked (objects inside them were never encrypted on their own).
  for (const { ref, raw } of hold.streams) {
    const data = ref && e.stm ? await decryptWith(e.stm, objectKey(found.key, ref, e.stm), raw.contents) : raw.contents;
    try { await PDFObjectStreamParser.forStream(PDFRawStream.of(raw.dict, data)).parseIntoContext(); } catch { /* a damaged object stream: its objects are missing */ }
  }
  if (encRef instanceof PDFRef) ctx.delete(encRef);
  delete ctx.trailerInfo.Encrypt;
  const doc = new PDFDocument(ctx, false, false);
  return { doc, restricted: restrictionsOf(e.P), owner: found.owner };
}
