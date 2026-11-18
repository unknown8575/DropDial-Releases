// Picture details and privacy (Info & privacy, phase 9): read, clean and edit the hidden details of JPEG, PNG and
// WebP files without touching their pixels. Used by the sandboxed processor; pure functions on bytes, unit-tested.
//
// Nothing in a file is trusted: every length and offset is checked against the bytes before it is used, directories
// are walked once each (no loops), and sizes are capped. A file that doesn't parse cleanly is refused, never "fixed".
//
//   readMeta(bytes)            → {kind, fields, gps, orientation, found: {...}, editable}
//   cleanMeta(bytes, mode)     → new bytes. mode 'location': GPS and place names only; 'all': every hidden detail
//                                (EXIF, XMP, IPTC, comments, text chunks, thumbnails, extra pictures after the image),
//                                keeping only what the picture needs to look right (colour profile, orientation).
//   editMeta(bytes, edits)     → new bytes with {title, description, artist, copyright} set ('' removes one).
// JPEG scan data, PNG IDAT and WebP image chunks are copied byte for byte, so the decoded pixels are identical.

const enc = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: false });
const latin1 = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; };
const ascii = (b, at, n) => latin1(b.subarray(at, at + n));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;

export class MetaError extends Error { constructor(m) { super(m); this.user = true; } }
const damaged = () => new MetaError('This picture’s hidden details are damaged, so they can’t be changed safely.');

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------------ CRC-32 (PNG chunks)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b, start = 0, end = b.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function kindOf(b) {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

// ------------------------------------------------------------------ TIFF (EXIF)
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const MAX_ENTRIES = 512;
const T = {
  description: 0x010e, make: 0x010f, model: 0x0110, orientation: 0x0112, software: 0x0131, modified: 0x0132, artist: 0x013b,
  copyright: 0x8298, xpTitle: 0x9c9b, xpComment: 0x9c9c, xpAuthor: 0x9c9d, xpKeywords: 0x9c9e, xpSubject: 0x9c9f, exif: 0x8769, gps: 0x8825,
  taken: 0x9003, digitized: 0x9004, offset: 0x9011, exposure: 0x829a, fnumber: 0x829d, iso: 0x8827, focal: 0x920a, focal35: 0xa405,
  owner: 0xa430, serial: 0xa431, lensMake: 0xa433, lens: 0xa434, lensSerial: 0xa435, makerNote: 0x927c, uniqueId: 0xa420, thumb: 0x0201,
};

/** A TIFF reader over `b` (the bytes after "Exif\0\0"): {le, r16, r32, ifd(off)} with every offset checked. */
function tiff(b) {
  if (b.length < 8) throw damaged();
  const id = ascii(b, 0, 2);
  if (id !== 'II' && id !== 'MM') throw damaged();
  const le = id === 'II';
  const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o) => (le ? u32le(b, o) : u32be(b, o));
  if (r16(2) !== 42) throw damaged();
  const seen = new Set();
  /** Directory at `off`: {at, n, entries: [{tag, type, count, at (entry), value (offset of the value), size}], next, nextAt}. */
  const ifd = (off) => {
    if (!off || off < 8 || off + 2 > b.length || off % 1 !== 0) return null;
    if (seen.has(off)) return null; // a loop
    seen.add(off);
    const n = r16(off);
    if (n > MAX_ENTRIES || off + 2 + n * 12 > b.length) throw damaged();
    const entries = [];
    for (let k = 0; k < n; k++) {
      const at = off + 2 + k * 12;
      const tag = r16(at), type = r16(at + 2), count = r32(at + 4);
      const unit = TYPE_SIZE[type];
      if (!unit || count > 0x10000000) continue; // unknown type: left alone, never read
      const size = unit * count;
      const value = size <= 4 ? at + 8 : r32(at + 8);
      if (value + size > b.length) continue; // points outside: never read
      entries.push({ tag, type, count, at, value, size });
    }
    const nextAt = off + 2 + n * 12;
    const next = nextAt + 4 <= b.length ? r32(nextAt) : 0;
    return { at: off, n, entries, next, nextAt };
  };
  return { b, le, r16, r32, ifd, first: r32(4) };
}

const entry = (dir, tag) => (dir ? dir.entries.find((e) => e.tag === tag) : null);
function text(t, e) {
  if (!e) return null;
  const raw = t.b.subarray(e.value, e.value + Math.min(e.size, 4000));
  if (e.type === 1 && e.tag >= 0x9c9b && e.tag <= 0x9c9f) { // Windows XP tags: UCS-2
    let s = '';
    for (let i = 0; i + 1 < raw.length; i += 2) { const c = raw[i] | (raw[i + 1] << 8); if (!c) break; s += String.fromCharCode(c); }
    return s.trim() || null;
  }
  if (e.type !== 2 && e.type !== 7) return null;
  const end = raw.indexOf(0);
  const s = utf8.decode(end >= 0 ? raw.subarray(0, end) : raw).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s || null;
}
function nums(t, e, max = 8) {
  if (!e) return null;
  const out = [];
  for (let k = 0; k < Math.min(e.count, max); k++) {
    const o = e.value + k * TYPE_SIZE[e.type];
    if (e.type === 3) out.push(t.r16(o));
    else if (e.type === 4) out.push(t.r32(o));
    else if (e.type === 9) out.push(t.r32(o) | 0);
    else if (e.type === 5 || e.type === 10) { const a = e.type === 10 ? t.r32(o) | 0 : t.r32(o), d = e.type === 10 ? t.r32(o + 4) | 0 : t.r32(o + 4); out.push(d ? a / d : NaN); }
    else if (e.type === 1 || e.type === 7) out.push(t.b[o]);
  }
  return out;
}
const num = (t, e) => { const v = nums(t, e, 1); return v && Number.isFinite(v[0]) ? v[0] : null; };

/** Everything worth showing from a TIFF/EXIF block. */
function readTiff(b) {
  const t = tiff(b);
  const d0 = t.ifd(t.first);
  if (!d0) throw damaged();
  const exifP = entry(d0, T.exif), gpsP = entry(d0, T.gps);
  const dx = exifP ? t.ifd(num(t, exifP)) : null;
  const dg = gpsP ? t.ifd(num(t, gpsP)) : null;
  const d1 = d0.next ? t.ifd(d0.next) : null;
  const s = (dir, tag) => text(t, entry(dir, tag));
  const out = {
    make: s(d0, T.make), model: s(d0, T.model), software: s(d0, T.software), modified: s(d0, T.modified), artist: s(d0, T.artist) || s(d0, T.xpAuthor),
    copyright: s(d0, T.copyright), description: s(d0, T.description), title: s(d0, T.xpTitle), comment: s(d0, T.xpComment), keywords: s(d0, T.xpKeywords),
    orientation: num(t, entry(d0, T.orientation)) || 1,
    taken: s(dx, T.taken) || s(dx, T.digitized), offset: s(dx, T.offset), lens: s(dx, T.lens), lensMake: s(dx, T.lensMake),
    serial: s(dx, T.serial) || s(dx, T.lensSerial), owner: s(dx, T.owner), uniqueId: s(dx, T.uniqueId), makerNote: !!entry(dx, T.makerNote),
    exposure: num(t, entry(dx, T.exposure)), fnumber: num(t, entry(dx, T.fnumber)), iso: num(t, entry(dx, T.iso)), focal: num(t, entry(dx, T.focal)), focal35: num(t, entry(dx, T.focal35)),
    thumbnail: !!(d1 && entry(d1, T.thumb)), gps: null, gpsTags: !!(dg && dg.n),
  };
  if (dg) {
    const dms = (tag) => { const v = nums(t, entry(dg, tag), 3); return v && v.length === 3 && v.every(Number.isFinite) ? v[0] + v[1] / 60 + v[2] / 3600 : null; };
    const ref = (tag) => (text(t, { ...(entry(dg, tag) || {}), type: 2 }) || '').toUpperCase();
    let lat = dms(2), lon = dms(4);
    if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      if (entry(dg, 1) && ref(1).startsWith('S')) lat = -lat;
      if (entry(dg, 3) && ref(3).startsWith('W')) lon = -lon;
      const alt = num(t, entry(dg, 6));
      const below = entry(dg, 5) && t.b[entry(dg, 5).value] === 1;
      out.gps = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, alt: alt != null && Number.isFinite(alt) ? Math.round((below ? -alt : alt) * 10) / 10 : null };
    }
  }
  return out;
}

/** Remove location from a TIFF block in place (a copy): the GPS pointer leaves IFD0 and the GPS directory is wiped. */
function tiffWithoutGps(src) {
  const b = src.slice();
  const t = tiff(b);
  const d0 = t.ifd(t.first);
  if (!d0) throw damaged();
  const p = entry(d0, T.gps);
  if (!p) return b;
  const dg = t.ifd(num(t, p));
  if (dg) {
    for (const e of dg.entries) if (e.size > 4) b.fill(0, e.value, e.value + e.size);
    b.fill(0, dg.at, Math.min(b.length, dg.nextAt + 4));
  }
  // Take the pointer out of IFD0: the entries after it move up one place (their values stay where they are).
  const end = d0.at + 2 + d0.n * 12;
  b.copyWithin(p.at, p.at + 12, end + 4);
  b.fill(0, end - 12 + 4, end + 4);
  const w16 = (o, v) => { if (t.le) { b[o] = v & 255; b[o + 1] = v >> 8; } else { b[o] = v >> 8; b[o + 1] = v & 255; } };
  w16(d0.at, d0.n - 1);
  return b;
}

// A small TIFF writer (big-endian) for new EXIF blocks and for edits.
function be16(v) { return [(v >> 8) & 255, v & 255]; }
function be32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
const asciiValue = (s) => ({ type: 2, bytes: concat([enc.encode(s), new Uint8Array([0])]) });
const ucs2Value = (s) => { const out = new Uint8Array(s.length * 2 + 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 * i] = c & 255; out[2 * i + 1] = c >> 8; } return { type: 1, bytes: out }; };
const shortValue = (v) => ({ type: 3, bytes: new Uint8Array(be16(v)) });

/** A new big-endian TIFF block holding just these IFD0 entries ([{tag, type, bytes}]). */
function buildTiff(list) {
  const items = list.slice().sort((a, b) => a.tag - b.tag);
  const dirSize = 2 + items.length * 12 + 4;
  let data = 8 + dirSize;
  const head = [0x4d, 0x4d, 0, 42, ...be32(8)];
  const dir = [...be16(items.length)];
  const blobs = [];
  for (const it of items) {
    const unit = TYPE_SIZE[it.type];
    const count = it.bytes.length / unit;
    dir.push(...be16(it.tag), ...be16(it.type), ...be32(count));
    if (it.bytes.length <= 4) { const v = new Uint8Array(4); v.set(it.bytes); dir.push(...v); } else {
      dir.push(...be32(data));
      const padded = it.bytes.length % 2 ? concat([it.bytes, new Uint8Array(1)]) : it.bytes;
      blobs.push(padded); data += padded.length;
    }
  }
  dir.push(0, 0, 0, 0);
  return concat([new Uint8Array(head), new Uint8Array(dir), ...blobs]);
}

/**
 * The TIFF block with IFD0's entries changed: `set` = Map(tag → {type, bytes} | null to remove). IFD0 is written
 * again at the end of the block (with the new values after it) and the header points there; everything else stays
 * at the same place, so every other offset (Exif, GPS, maker notes, thumbnail) is still right.
 */
function tiffWith(src, set) {
  const t = tiff(src);
  const d0 = t.ifd(t.first);
  if (!d0) throw damaged();
  const le = t.le;
  const w16 = (v) => (le ? [v & 255, v >> 8] : be16(v));
  const w32 = (v) => (le ? [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255] : be32(v));
  const keep = [];
  for (let k = 0; k < d0.n; k++) {
    const at = d0.at + 2 + k * 12;
    const tag = t.r16(at);
    if (set.has(tag)) continue;
    keep.push({ tag, raw: src.subarray(at, at + 12) });
  }
  let base = src.length + (src.length % 2);
  const items = [...keep];
  for (const [tag, v] of set) if (v) items.push({ tag, v });
  items.sort((a, b) => a.tag - b.tag);
  const dirAt = base;
  let data = dirAt + 2 + items.length * 12 + 4;
  const dir = [...w16(items.length)];
  const blobs = [];
  for (const it of items) {
    if (it.raw) { dir.push(...it.raw); continue; }
    const { type, bytes } = it.v;
    const b = le && type === 3 ? new Uint8Array([bytes[1], bytes[0]]) : bytes; // shorts come big-endian from shortValue
    dir.push(...w16(it.tag), ...w16(type), ...w32(b.length / TYPE_SIZE[type]));
    if (b.length <= 4) { const v = new Uint8Array(4); v.set(b); dir.push(...v); } else {
      dir.push(...w32(data));
      const padded = b.length % 2 ? concat([b, new Uint8Array(1)]) : b;
      blobs.push(padded); data += padded.length;
    }
  }
  dir.push(...w32(d0.next));
  const out = concat([src, new Uint8Array(base - src.length), new Uint8Array(dir), ...blobs]);
  out.fill(0, d0.at, Math.min(src.length, d0.nextAt + 4)); // the old directory is no longer used
  out.set(w32(dirAt), 4);
  return out;
}

const EDIT_TAGS = { title: T.xpTitle, description: T.description, artist: T.artist, copyright: T.copyright };
function editSet(edits) {
  const set = new Map();
  for (const [k, tag] of Object.entries(EDIT_TAGS)) {
    if (edits[k] === undefined) continue;
    const v = String(edits[k]).trim();
    set.set(tag, v ? (k === 'title' ? ucs2Value(v) : asciiValue(v)) : null);
    if (k === 'artist') set.set(T.xpAuthor, null); // one author, not two that disagree
  }
  return set;
}

// ------------------------------------------------------------------ XMP and IPTC
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_PLACE = /exif:GPS(Latitude|Longitude|Altitude)|photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode)|Iptc4xmpExt:Location(Created|Shown)|drone-dji:(Gps|Absolute)/i;
/** IPTC (in Photoshop's APP13) with a place: City, Sub-location, Province, Country code or Country. */
function iptcHasPlace(b) {
  for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0x1c && b[i + 1] === 0x02 && [90, 92, 95, 100, 101].includes(b[i + 2])) return true;
  return false;
}
const xmpFields = (x) => {
  const pick = (re) => { const m = re.exec(x); return m ? m[1].replace(/<[^>]+>/g, '').trim().slice(0, 500) : null; };
  return {
    title: pick(/<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/), description: pick(/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/),
    artist: pick(/<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/), place: XMP_PLACE.test(x),
  };
};

// ------------------------------------------------------------------ JPEG
/** The markers of a JPEG: {segs: [{m, start, end, data}], end (just after EOI), trailing}. Scan data is part of SOS. */
function jpegParse(b) {
  const segs = [];
  let i = 2;
  let end = b.length;
  while (i < b.length) {
    if (b[i] !== 0xff) throw damaged();
    while (i + 1 < b.length && b[i + 1] === 0xff) i++; // fill bytes
    if (i + 1 >= b.length) throw damaged();
    const m = b[i + 1];
    if (m === 0xd9) { end = i + 2; segs.push({ m, start: i, end }); break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { segs.push({ m, start: i, end: i + 2 }); i += 2; continue; }
    if (i + 4 > b.length) throw damaged();
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) throw damaged();
    let segEnd = i + 2 + len;
    if (m === 0xda) { // entropy-coded data follows until the next real marker
      let j = segEnd;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0 && b[j + 1] !== 0xff && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      segEnd = j + 1 >= b.length ? b.length : j;
    }
    segs.push({ m, start: i, end: segEnd, data: i + 4, dataEnd: i + 2 + len });
    i = segEnd;
  }
  if (!segs.some((s) => s.m === 0xda)) throw damaged();
  return { segs, end, trailing: b.length - end };
}
const isExif = (b, s) => s.m === 0xe1 && ascii(b, s.data, 6) === 'Exif\0\0';
const isXmp = (b, s) => s.m === 0xe1 && ascii(b, s.data, XMP_ID.length) === XMP_ID;
const isIcc = (b, s) => s.m === 0xe2 && ascii(b, s.data, 12) === 'ICC_PROFILE\0';
const app1 = (tiffBytes) => {
  const len = tiffBytes.length + 8;
  if (len > 0xffff) throw new MetaError('These details are too long to fit in a JPEG.');
  return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 255]), enc.encode('Exif'), new Uint8Array([0, 0]), tiffBytes]);
};

function readJpeg(b) {
  const { segs, trailing } = jpegParse(b);
  const r = { exif: null, xmp: null, iptc: false, iptcPlace: false, comment: null, extra: trailing > 0, icc: false };
  for (const s of segs) {
    if (isExif(b, s) && !r.exif) r.exif = readTiff(b.subarray(s.data + 6, s.dataEnd));
    else if (isXmp(b, s)) r.xmp = (r.xmp || '') + utf8.decode(b.subarray(s.data + XMP_ID.length, s.dataEnd)).slice(0, 200000);
    else if (s.m === 0xed) { r.iptc = true; if (iptcHasPlace(b.subarray(s.data, s.dataEnd))) r.iptcPlace = true; }
    else if (s.m === 0xfe) r.comment = utf8.decode(b.subarray(s.data, s.dataEnd)).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000) || r.comment;
    else if (isIcc(b, s)) r.icc = true;
  }
  return r;
}

function jpegRebuild(b, keepSeg, extra = [], keepTrailing = false) {
  const { segs, end } = jpegParse(b);
  const parts = [b.subarray(0, 2)];
  let inserted = false;
  for (const s of segs) {
    // New segments go after the JFIF/EXIF header area: before the first segment that isn't APP0.
    if (!inserted && s.m !== 0xe0) { parts.push(...extra); inserted = true; }
    const k = keepSeg(s);
    if (k === true) parts.push(b.subarray(s.start, s.end));
    else if (k) parts.push(k);
  }
  if (!inserted) parts.push(...extra);
  if (keepTrailing && end < b.length) parts.push(b.subarray(end));
  return concat(parts);
}

// ------------------------------------------------------------------ PNG
function pngChunks(b) {
  const out = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    if (len > b.length - i - 12) throw damaged();
    const type = ascii(b, i + 4, 4);
    out.push({ type, start: i, data: i + 8, len, end: i + 12 + len });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  if (!out.length || out[0].type !== 'IHDR' || !out.some((c) => c.type === 'IDAT')) throw damaged();
  return out;
}
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out.set(be32(data.length), 0);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  out.set(be32(crc32(out, 4, 8 + data.length)), 8 + data.length);
  return out;
}
const TEXT = ['tEXt', 'zTXt', 'iTXt'];
function pngText(b, c) {
  const d = b.subarray(c.data, c.data + c.len);
  const z = d.indexOf(0);
  if (z <= 0) return null;
  const key = latin1(d.subarray(0, z));
  if (c.type === 'tEXt') return { key, value: latin1(d.subarray(z + 1)).slice(0, 2000) };
  if (c.type === 'iTXt') {
    if (d[z + 1] !== 0) return { key, value: null }; // compressed
    let p = z + 3;
    const lang = d.indexOf(0, p); if (lang < 0) return { key, value: null };
    const tr = d.indexOf(0, lang + 1); if (tr < 0) return { key, value: null };
    return { key, value: utf8.decode(d.subarray(tr + 1)).slice(0, 200000) };
  }
  return { key, value: null };
}
const PNG_KEYS = { Title: 'title', Description: 'description', Author: 'artist', Copyright: 'copyright', Comment: 'comment', Software: 'software', 'Creation Time': 'modified' };

function readPng(b) {
  const chunks = pngChunks(b);
  const r = { exif: null, xmp: null, text: [], extra: chunks[chunks.length - 1].end < b.length, icc: chunks.some((c) => c.type === 'iCCP'), time: chunks.some((c) => c.type === 'tIME') };
  for (const c of chunks) {
    if (c.type === 'eXIf' && !r.exif) r.exif = readTiff(b.subarray(c.data, c.data + c.len));
    else if (TEXT.includes(c.type)) {
      const t = pngText(b, c);
      if (!t) continue;
      if (t.key === 'XML:com.adobe.xmp') r.xmp = t.value || '';
      else r.text.push(t);
    }
  }
  return r;
}

const placeText = (t) => /^Raw profile type (exif|app1|iptc|xmp)$/i.test(t.key) || (t.key === 'XML:com.adobe.xmp' && (t.value == null || XMP_PLACE.test(t.value)));

// ------------------------------------------------------------------ WebP
function webpChunks(b) {
  const size = u32le(b, 4);
  if (size + 8 > b.length || size < 4) throw damaged();
  const end = 8 + size;
  const out = [];
  let i = 12;
  while (i + 8 <= end) {
    const len = u32le(b, i + 4);
    if (len > end - i - 8) throw damaged();
    out.push({ type: ascii(b, i, 4), start: i, data: i + 8, len, end: i + 8 + len + (len % 2) });
    i += 8 + len + (len % 2);
  }
  if (!out.some((c) => c.type === 'VP8 ' || c.type === 'VP8L' || c.type === 'ANMF')) throw damaged();
  return out;
}
function webpChunk(type, data) {
  const pad = data.length % 2;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(enc.encode(type), 0);
  out.set([data.length & 255, (data.length >> 8) & 255, (data.length >> 16) & 255, (data.length >>> 24) & 255], 4);
  out.set(data, 8);
  return out;
}
const exifBody = (b, c) => { let d = b.subarray(c.data, c.data + c.len); if (ascii(d, 0, 6) === 'Exif\0\0') d = d.subarray(6); return d; };
function readWebp(b) {
  const chunks = webpChunks(b);
  const r = { exif: null, xmp: null, icc: chunks.some((c) => c.type === 'ICCP') };
  for (const c of chunks) {
    if (c.type === 'EXIF' && !r.exif) r.exif = readTiff(exifBody(b, c));
    else if (c.type === 'XMP ') r.xmp = utf8.decode(b.subarray(c.data, c.data + c.len)).slice(0, 200000);
  }
  return r;
}
/** Canvas size and whether there is transparency, for a new VP8X header. */
function webpCanvas(b, chunks) {
  const vp8 = chunks.find((c) => c.type === 'VP8 '), vp8l = chunks.find((c) => c.type === 'VP8L');
  if (vp8 && vp8.len >= 10) return { w: u16le(b, vp8.data + 6) & 0x3fff, h: u16le(b, vp8.data + 8) & 0x3fff, alpha: chunks.some((c) => c.type === 'ALPH') };
  if (vp8l && vp8l.len >= 5) { const v = u32le(b, vp8l.data + 1); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1, alpha: !!((v >>> 28) & 1) }; }
  throw damaged();
}
function webpRebuild(b, chunks, list) {
  let flags = 0;
  const parts = list.map((c) => c);
  const types = list.map((c) => ascii(c, 0, 4));
  const vx = types.indexOf('VP8X');
  if (vx >= 0) {
    const v = parts[vx].slice();
    flags = v[8] & ~0x0c;
    if (types.includes('EXIF')) flags |= 0x08;
    if (types.includes('XMP ')) flags |= 0x04;
    v[8] = flags;
    parts[vx] = v;
  }
  const body = concat(parts);
  const size = 4 + body.length;
  return concat([enc.encode('RIFF'), new Uint8Array([size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255]), enc.encode('WEBP'), body]);
}

// ------------------------------------------------------------------ public
const pretty = (v) => (v == null ? null : String(v));
/**
 * Hidden details of a JPEG, PNG or WebP: {kind, fields: {make, model, lens, taken, …}, gps, orientation,
 * found: {location, camera, dates, people, software, thumbnail, xmp, iptc, comment, text, extra}, any}.
 * Other kinds return {kind: null}.
 */
export function readMeta(b) {
  const kind = kindOf(b);
  if (!kind) return { kind: null };
  const r = kind === 'jpg' ? readJpeg(b) : kind === 'png' ? readPng(b) : readWebp(b);
  const e = r.exif || {};
  const x = r.xmp ? xmpFields(r.xmp) : {};
  const text = {};
  for (const t of r.text || []) { const k = PNG_KEYS[t.key]; if (k && t.value && !text[k]) text[k] = t.value.trim().slice(0, 1000); }
  const fields = {
    title: e.title || text.title || x.title || null, description: e.description || text.description || x.description || null,
    artist: e.artist || text.artist || x.artist || null, copyright: e.copyright || text.copyright || null, comment: e.comment || r.comment || text.comment || null,
    make: e.make || null, model: e.model || null, lens: [e.lensMake && e.lens && !e.lens.startsWith(e.lensMake) ? e.lensMake : null, e.lens].filter(Boolean).join(' ') || null,
    taken: e.taken || null, offset: e.offset || null, modified: e.modified || text.modified || null, software: e.software || text.software || null,
    serial: e.serial || null, owner: e.owner || null, exposure: e.exposure || null, fnumber: e.fnumber || null, iso: e.iso || null,
    focal: e.focal || null, focal35: e.focal35 || null, keywords: e.keywords || null,
  };
  const found = {
    location: !!(e.gps || e.gpsTags || x.place || r.iptcPlace || (r.text || []).some(placeText)),
    camera: !!(e.make || e.model || e.lens || e.serial || e.owner || e.makerNote || e.uniqueId),
    dates: !!(e.taken || e.modified || text.modified || r.time),
    people: !!(fields.artist || fields.copyright || e.owner),
    software: !!fields.software, thumbnail: !!e.thumbnail, xmp: r.xmp != null, iptc: !!r.iptc, comment: !!fields.comment,
    text: (r.text || []).length > 0, extra: !!r.extra, exif: !!r.exif,
  };
  for (const k of Object.keys(fields)) fields[k] = pretty(fields[k]);
  // Anything to remove at all (an EXIF block holding only the orientation doesn't count: it is kept).
  const any = Object.entries(found).some(([k, v]) => v && k !== 'exif') || Object.values(fields).some(Boolean);
  return { kind, fields, gps: e.gps || null, orientation: e.orientation || 1, found, any, icc: !!r.icc };
}

/** Remove location ('location') or every hidden detail ('all') without touching the pixels. */
export function cleanMeta(b, mode) {
  const kind = kindOf(b);
  if (!kind) throw new MetaError('Only JPEG, PNG and WebP pictures can be cleaned without saving them again.');
  const all = mode === 'all';
  const info = readMeta(b);
  const orient = info.orientation !== 1 ? buildTiff([{ tag: T.orientation, ...shortValue(info.orientation) }]) : null;
  if (kind === 'jpg') {
    return jpegRebuild(b, (s) => {
      if (isExif(b, s)) return all ? false : app1(tiffWithoutGps(b.subarray(s.data + 6, s.dataEnd)));
      if (isXmp(b, s)) return all ? false : !XMP_PLACE.test(utf8.decode(b.subarray(s.data, s.dataEnd)));
      if (s.m === 0xed) return all ? false : !iptcHasPlace(b.subarray(s.data, s.dataEnd));
      if (s.m === 0xe2) return isIcc(b, s); // colour profile stays; MPF (extra pictures) goes with them
      if (s.m === 0xfe || (s.m >= 0xe3 && s.m <= 0xef && s.m !== 0xee)) return !all;
      return true;
    }, all && orient ? [app1(orient)] : [], false);
  }
  if (kind === 'png') {
    const chunks = pngChunks(b);
    const parts = [b.subarray(0, 8)];
    for (const c of chunks) {
      const raw = b.subarray(c.start, c.end);
      if (c.type === 'IDAT' && all && orient && !parts.some((p) => ascii(p, 4, 4) === 'eXIf')) parts.push(pngChunk('eXIf', orient));
      if (c.type === 'eXIf') { if (!all) parts.push(pngChunk('eXIf', tiffWithoutGps(b.subarray(c.data, c.data + c.len)))); continue; }
      if (TEXT.includes(c.type)) { if (!all && !placeText(pngText(b, c) || { key: '' })) parts.push(raw); continue; }
      if (c.type === 'tIME' && all) continue;
      parts.push(raw);
    }
    return concat(parts);
  }
  const chunks = webpChunks(b);
  const list = [];
  for (const c of chunks) {
    const raw = b.subarray(c.start, c.end);
    if (c.type === 'EXIF') {
      if (!all) list.push(webpChunk('EXIF', tiffWithoutGps(exifBody(b, c))));
      else if (orient) list.push(webpChunk('EXIF', orient));
      continue;
    }
    if (c.type === 'XMP ') { if (!all && !XMP_PLACE.test(utf8.decode(b.subarray(c.data, c.data + c.len)))) list.push(raw); continue; }
    list.push(raw);
  }
  return webpRebuild(b, chunks, list);
}

/** Set title, description, artist and copyright ('' removes one). Values are trimmed and limited to 500 characters. */
export function editMeta(b, edits) {
  const kind = kindOf(b);
  if (!kind) throw new MetaError('Details can only be edited in JPEG, PNG and WebP pictures.');
  const clean = {};
  for (const k of Object.keys(EDIT_TAGS)) if (edits[k] !== undefined) clean[k] = String(edits[k]).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
  const set = editSet(clean);
  if (!set.size) return b;
  const addTo = (tiffBytes) => (tiffBytes ? tiffWith(tiffBytes, set) : buildTiff([...set].filter(([, v]) => v).map(([tag, v]) => ({ tag, ...v }))));
  if (kind === 'jpg') {
    const { segs } = jpegParse(b);
    const ex = segs.find((s) => isExif(b, s));
    if (ex) return jpegRebuild(b, (s) => (s.start === ex.start ? app1(addTo(b.subarray(s.data + 6, s.dataEnd))) : true), [], true);
    return jpegRebuild(b, () => true, [app1(addTo(null))], true);
  }
  if (kind === 'png') {
    // PNG's own text keys (Title, Description, Author, Copyright) as UTF-8 iTXt, replacing any with the same key.
    const KEY = { title: 'Title', description: 'Description', artist: 'Author', copyright: 'Copyright' };
    const changing = new Set(Object.keys(clean).map((k) => KEY[k]));
    const chunks = pngChunks(b);
    const parts = [b.subarray(0, 8)];
    let added = false;
    for (const c of chunks) {
      if (c.type === 'IDAT' && !added) {
        for (const [k, v] of Object.entries(clean)) if (v) parts.push(pngChunk('iTXt', concat([enc.encode(KEY[k]), new Uint8Array([0, 0, 0, 0, 0]), enc.encode(v)])));
        added = true;
      }
      if (TEXT.includes(c.type)) { const t = pngText(b, c); if (t && changing.has(t.key)) continue; }
      parts.push(b.subarray(c.start, c.end));
    }
    return concat(parts);
  }
  const chunks = webpChunks(b);
  const list = chunks.map((c) => b.subarray(c.start, c.end));
  const ex = chunks.findIndex((c) => c.type === 'EXIF');
  if (ex >= 0) list[ex] = webpChunk('EXIF', addTo(exifBody(b, chunks[ex])));
  else {
    if (!chunks.some((c) => c.type === 'VP8X')) {
      const { w, h, alpha } = webpCanvas(b, chunks);
      const v = new Uint8Array(10);
      v[0] = alpha ? 0x10 : 0;
      v.set([(w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255], 4);
      list.unshift(webpChunk('VP8X', v));
    }
    const xmp = list.findIndex((c) => ascii(c, 0, 4) === 'XMP ');
    const chunk = webpChunk('EXIF', addTo(null));
    if (xmp >= 0) list.splice(xmp, 0, chunk); else list.push(chunk);
  }
  return webpRebuild(b, chunks, list);
}

export const EDIT_FIELDS = Object.keys(EDIT_TAGS);
export { buildTiff as _buildTiff, tiffWithoutGps as _tiffWithoutGps, jpegParse as _jpegParse, pngChunk as _pngChunk, webpChunk as _webpChunk, T as TAGS };
