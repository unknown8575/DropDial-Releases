// PNG writing for Make smaller (phase 9): better-packed PNGs (best filter per row, strongest deflate) and palette PNGs
// with up to 256 colours — exact when the picture already has that few, otherwise chosen with gifenc's quantizer and,
// for photos, Floyd–Steinberg dithering so gradients stay smooth. Rows are compressed as they are made (pako streaming),
// so even large pictures don't need a second full copy in memory.
import { quantize, applyPalette } from './vendor/gifenc.esm.js';
import { crc32 } from '../shared/imagemeta.mjs';

const pako = () => self.pako;
const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function ihdr(w, h, depth, type) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  d[8] = depth; d[9] = type; // compression, filter and interlace stay 0
  return chunk('IHDR', d);
}

/** Filter one row: the filter (0–4) whose output has the smallest sum of absolute values (the usual heuristic). */
function filterRow(cur, prev, bpp, out) {
  const n = cur.length;
  let best = 0, bestSum = Infinity;
  const tmp = out.tmp;
  for (let f = 0; f < 5; f++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = cur[i];
      else if (f === 1) v = cur[i] - a;
      else if (f === 2) v = cur[i] - b;
      else if (f === 3) v = cur[i] - ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      v &= 255;
      tmp[f][i + 1] = v;
      sum += v < 128 ? v : 256 - v;
      if (sum >= bestSum) break;
    }
    if (sum < bestSum) { bestSum = sum; best = f; }
  }
  tmp[best][0] = best;
  return tmp[best];
}

/** Deflate rows given by `row(y)` (raw bytes of row y), filtering each when `filter`; returns the zlib stream. */
function deflateRows(h, stride, bpp, row, { filter, level }) {
  const d = new (pako().Deflate)({ level, memLevel: 9 });
  const out = { tmp: Array.from({ length: 5 }, () => new Uint8Array(stride + 1)) };
  const plain = new Uint8Array(stride + 1);
  let prev = null;
  const batch = [];
  let size = 0;
  const flush = (last) => { d.push(concat(batch.splice(0)), last); size = 0; };
  for (let y = 0; y < h; y++) {
    const cur = row(y);
    let line;
    if (filter === 'up') { // one cheap filter (large pictures): each byte less the one above
      line = new Uint8Array(cur.length + 1); line[0] = prev ? 2 : 0;
      if (prev) for (let i = 0; i < cur.length; i++) line[i + 1] = (cur[i] - prev[i]) & 255; else line.set(cur, 1);
    } else if (filter) line = filterRow(cur, prev, bpp, out).slice();
    else { plain[0] = 0; plain.set(cur, 1); line = plain.slice(); }
    batch.push(line); size += line.length;
    if (size > 1 << 20) flush(false);
    prev = cur;
  }
  flush(true);
  if (d.err) throw new Error('PNG compression failed');
  return d.result;
}

const levelFor = (w, h) => (w * h <= 12e6 ? 9 : 6);

/** RGBA pixels (ImageData) → a well-packed truecolour PNG (RGB when fully opaque). */
export function encodePacked(img, alpha) {
  const { width: w, height: h, data } = img;
  const bpp = alpha ? 4 : 3;
  const stride = w * bpp;
  const buf = new Uint8Array(stride);
  const row = (y) => {
    if (alpha) return data.subarray(y * w * 4, (y + 1) * w * 4);
    for (let x = 0, o = y * w * 4; x < w; x++, o += 4) { buf[x * 3] = data[o]; buf[x * 3 + 1] = data[o + 1]; buf[x * 3 + 2] = data[o + 2]; }
    return buf.slice();
  };
  const idat = deflateRows(h, stride, bpp, row, { filter: true, level: levelFor(w, h) });
  return concat([SIG, ihdr(w, h, 8, alpha ? 6 : 2), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

/**
 * An opaque canvas → an 8-bit RGB PNG (no alpha channel; QA round 7: a JPEG photo saved as PNG was RGBA). Pixels
 * are read in strips, so a large photo never needs a second full copy; pictures over 12 MP use one fast filter.
 */
export function encodeRgb(canvas) {
  const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d');
  const stripRows = Math.max(1, Math.floor(4e6 / w));
  let strip = null, top = 0;
  const row = (y) => {
    if (!strip || y >= top + strip.height) { top = y; strip = ctx.getImageData(0, y, w, Math.min(stripRows, h - y)); }
    const src = strip.data, line = new Uint8Array(w * 3);
    for (let x = 0, o = (y - top) * w * 4, k = 0; x < w; x++, o += 4) { line[k++] = src[o]; line[k++] = src[o + 1]; line[k++] = src[o + 2]; }
    return line;
  };
  const big = w * h > 12e6;
  const idat = deflateRows(h, w * 3, 3, row, { filter: big ? 'up' : true, level: 6 });
  return concat([SIG, ihdr(w, h, 8, 2), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

/** A palette PNG from indices (one byte per pixel) and colours [[r, g, b, a?]]. */
function encodeIndexed(w, h, index, palette) {
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((c, i) => plte.set([c[0], c[1], c[2]], i * 3));
  const alphas = palette.map((c) => (c.length > 3 ? c[3] : 255));
  let last = -1;
  alphas.forEach((a, i) => { if (a < 255) last = i; });
  const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
  const per = 8 / depth;
  const stride = Math.ceil(w / per);
  const buf = new Uint8Array(stride);
  const row = (y) => {
    const src = index.subarray(y * w, (y + 1) * w);
    if (depth === 8) return src;
    buf.fill(0);
    for (let x = 0; x < w; x++) buf[(x / per) | 0] |= src[x] << (8 - depth - (x % per) * depth);
    return buf.slice();
  };
  // Filters seldom help palette pictures; plain rows pack better.
  const idat = deflateRows(h, stride, 1, row, { filter: false, level: levelFor(w, h) });
  return concat([SIG, ihdr(w, h, depth, 3), chunk('PLTE', plte), ...(last >= 0 ? [chunk('tRNS', new Uint8Array(alphas.slice(0, last + 1)))] : []),
    chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

/** The picture's exact colours when there are 256 or fewer ([[r,g,b,a]] and indices), else null. */
function exactPalette(img) {
  const px = new Uint32Array(img.data.buffer, img.data.byteOffset, img.data.length / 4);
  const map = new Map();
  const index = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) {
    let k = map.get(px[i]);
    if (k === undefined) { if (map.size >= 256) return null; k = map.size; map.set(px[i], k); }
    index[i] = k;
  }
  const palette = [...map.keys()].map((v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]);
  return { palette, index };
}

/** Floyd–Steinberg dithering of an opaque picture onto `palette` (nearest colours cached on a 5-6-5 grid). */
function dither(img, palette) {
  const { width: w, height: h, data } = img;
  const index = new Uint8Array(w * h);
  const cache = new Int16Array(65536).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    let k = cache[key];
    if (k >= 0) return k;
    let best = 0, bd = Infinity;
    for (let i = 0; i < palette.length; i++) { const p = palette[i]; const dr = p[0] - r, dg = p[1] - g, db = p[2] - b; const d = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (d < bd) { bd = d; best = i; } }
    cache[key] = best;
    return best;
  };
  let errA = new Float32Array((w + 2) * 3), errB = new Float32Array((w + 2) * 3);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < h; y++) {
    errB.fill(0);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, e = (x + 1) * 3;
      const r = clamp(data[o] + errA[e]), g = clamp(data[o + 1] + errA[e + 1]), b = clamp(data[o + 2] + errA[e + 2]);
      const k = nearest(r | 0, g | 0, b | 0);
      index[y * w + x] = k;
      const p = palette[k];
      const er = (r - p[0]) * 0.85, eg = (g - p[1]) * 0.85, eb = (b - p[2]) * 0.85; // a little under full strength: less noise, smaller files
      errA[e + 3] += er * 7 / 16; errA[e + 4] += eg * 7 / 16; errA[e + 5] += eb * 7 / 16;
      errB[e - 3] += er * 3 / 16; errB[e - 2] += eg * 3 / 16; errB[e - 1] += eb * 3 / 16;
      errB[e] += er * 5 / 16; errB[e + 1] += eg * 5 / 16; errB[e + 2] += eb * 5 / 16;
      errB[e + 3] += er / 16; errB[e + 4] += eg / 16; errB[e + 5] += eb / 16;
    }
    [errA, errB] = [errB, errA];
  }
  return index;
}

/**
 * PNG for Make smaller. mode 'lossless': exact palette when ≤ 256 colours, else better packing (no pixel changes).
 * mode 'palette': 256 colours (dithered for opaque pictures when `dither`). Returns {bytes, note}.
 */
export function encodeSmallPng(img, alpha, { mode, dither: useDither }) {
  const exact = exactPalette(img);
  if (exact) return { bytes: encodeIndexed(img.width, img.height, exact.index, exact.palette), note: `PNG with its ${exact.palette.length} colours, packed better` };
  if (mode === 'lossless') return { bytes: encodePacked(img, alpha), note: 'PNG packed better, every pixel the same' };
  const rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
  const format = alpha ? 'rgba4444' : 'rgb565';
  const palette = quantize(rgba, 256, { format, clearAlpha: alpha, oneBitAlpha: false });
  const index = !alpha && useDither ? dither(img, palette) : applyPalette(rgba, palette, format);
  return { bytes: encodeIndexed(img.width, img.height, index, palette), note: `PNG with 256 colours${!alpha && useDither ? ', smoothly blended' : ''}` };
}
