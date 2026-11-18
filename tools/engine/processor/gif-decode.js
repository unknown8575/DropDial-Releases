// GIF frames read by the app itself (QA round 8), for thumbnails of animated GIFs: the same result on every computer,
// without the browser's video-frame path (on a Mac that drew some animated GIFs as a black square). Frames are
// composed as a browser shows them — transparency, frame offsets and each frame's disposal (keep, clear to
// transparent, or go back to the frame before) — until one shows something. Pure functions on bytes (unit-tested).

const u16 = (b, i) => b[i] | (b[i + 1] << 8);

/** Skip a run of GIF data sub-blocks starting at i; returns the index after the terminator. */
function skipBlocks(b, i) {
  while (i < b.length) { const n = b[i]; i += 1; if (!n) return i; i += n; }
  return b.length;
}

/** LZW-decode one frame's indices (w × h), tolerant of short or over-long data as browsers are. */
function lzw(b, start, minSize, count) {
  const out = new Uint8Array(count);
  if (minSize < 2 || minSize > 11) return out;
  const clear = 1 << minSize, end = clear + 1;
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let c = 0; c < clear; c++) { prefix[c] = -1; suffix[c] = c; first[c] = c; }
  let size = minSize + 1, mask = (1 << size) - 1, next = end + 1, prev = -1;
  let bits = 0, acc = 0, o = 0;
  let i = start, left = 0;
  while (o < count) {
    while (bits < size) {
      if (!left) { if (i >= b.length) return out; left = b[i++]; if (!left) return out; }
      acc |= b[i++] << bits; bits += 8; left--;
    }
    const code = acc & mask;
    acc >>>= size; bits -= size;
    if (code === clear) { size = minSize + 1; mask = (1 << size) - 1; next = end + 1; prev = -1; continue; }
    if (code === end) break;
    let c = code, sp = 0;
    if (prev < 0) { if (code >= next) break; out[o++] = suffix[code]; prev = code; continue; }
    if (code >= next) { stack[sp++] = first[prev]; c = prev; }
    while (c >= clear && sp < 4096) { stack[sp++] = suffix[c]; c = prefix[c]; }
    stack[sp++] = c;
    const head = c;
    while (sp && o < count) out[o++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = prev; suffix[next] = head; first[next] = first[prev];
      next++;
      if (next > mask && size < 12) { size++; mask = (1 << size) - 1; }
    }
    prev = code;
  }
  return out;
}

/**
 * Read a GIF's frames: {width, height, frames: [{x, y, w, h, interlace, palette, transparent, disposal, data, minSize}]}
 * (`data`: where the frame's image data starts). Throws on a file that isn't a GIF.
 */
export function parseGif(bytes, { maxFrames = 2000 } = {}) {
  const b = bytes;
  if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== 'GIF') throw new Error('not a GIF');
  const width = u16(b, 6), height = u16(b, 8), packed = b[10];
  let i = 13, global = null;
  if (packed & 0x80) { const n = 3 * (1 << ((packed & 7) + 1)); global = b.subarray(i, i + n); i += n; }
  const frames = [];
  let gce = null;
  while (i < b.length && frames.length < maxFrames) {
    const t = b[i++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[i++];
      if (label === 0xf9 && b[i] >= 4) { const p = b[i + 1]; gce = { disposal: (p >> 2) & 7, transparent: p & 1 ? b[i + 4] : -1 }; }
      i = skipBlocks(b, i);
      continue;
    }
    if (t !== 0x2c) break; // unknown block: stop here, as browsers do
    const x = u16(b, i), y = u16(b, i + 2), w = u16(b, i + 4), h = u16(b, i + 6), p = b[i + 8];
    i += 9;
    let palette = global;
    if (p & 0x80) { const n = 3 * (1 << ((p & 7) + 1)); palette = b.subarray(i, i + n); i += n; }
    const minSize = b[i++];
    frames.push({ x, y, w, h, interlace: !!(p & 0x40), palette, transparent: gce ? gce.transparent : -1, disposal: gce ? gce.disposal : 0, data: i, minSize });
    i = skipBlocks(b, i);
    gce = null;
  }
  return { width, height, frames };
}

/** Rows of an interlaced frame in the order they are stored. */
function rowOrder(h, interlace) {
  if (!interlace) return null;
  const rows = [];
  for (const [s, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let r = s; r < h; r += step) rows.push(r);
  return rows;
}

/**
 * Do RGBA pixels show something, seen on white (not empty, not one flat colour all over)? A shape on a transparent
 * background counts; a frame that is all black or all clear doesn't. Read on a grid of at most ~64k points.
 */
export function showsSomething(data, w, h) {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 65536)));
  let min = 765, max = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4, a = data[i + 3] / 255;
    const v = (data[i] + data[i + 1] + data[i + 2]) * a + 765 * (1 - a);
    if (v < min) min = v; if (v > max) max = v;
  }
  return max - min >= 12;
}

/**
 * The first frame of a GIF that shows something, composed as a browser would show it at that moment:
 * {data (RGBA), width, height, frame (index), frames (count read)}. When none does within `maxFrames` (or
 * `budgetMs`), the first frame. `limit` caps width × height.
 */
export function firstVisibleGif(bytes, { maxFrames = 300, budgetMs = 3000, limit = 50e6 } = {}) {
  const t0 = Date.now();
  const { width: W, height: H, frames } = parseGif(bytes, { maxFrames });
  if (!W || !H || W * H > limit || !frames.length) throw new Error('unreadable GIF');
  const canvas = new Uint8ClampedArray(W * H * 4);
  let firstShot = null;
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    const saved = fr.disposal === 3 ? canvas.slice() : null;
    const pal = fr.palette;
    const w = Math.min(fr.w, Math.max(0, W - fr.x)), h = Math.min(fr.h, Math.max(0, H - fr.y));
    if (pal && fr.w && fr.h) {
      const idx = lzw(bytes, fr.data, fr.minSize, fr.w * fr.h);
      const order = rowOrder(fr.h, fr.interlace);
      for (let r = 0; r < fr.h; r++) {
        const yy = order ? order[r] : r;
        if (yy >= h) continue;
        for (let xx = 0; xx < w; xx++) {
          const k = idx[r * fr.w + xx];
          if (k === fr.transparent || 3 * k + 2 >= pal.length) continue;
          const o = ((fr.y + yy) * W + fr.x + xx) * 4;
          canvas[o] = pal[3 * k]; canvas[o + 1] = pal[3 * k + 1]; canvas[o + 2] = pal[3 * k + 2]; canvas[o + 3] = 255;
        }
      }
    }
    if (!firstShot) firstShot = canvas.slice();
    if (showsSomething(canvas, W, H)) return { data: canvas, width: W, height: H, frame: f, frames: frames.length };
    if (Date.now() - t0 > budgetMs) break;
    // Disposal before the next frame: 2 clears the frame's area, 3 puts back what was there before it.
    if (fr.disposal === 2) for (let yy = 0; yy < h; yy++) canvas.fill(0, ((fr.y + yy) * W + fr.x) * 4, ((fr.y + yy) * W + fr.x + w) * 4);
    else if (fr.disposal === 3 && saved) canvas.set(saved);
  }
  return { data: firstShot, width: W, height: H, frame: 0, frames: frames.length };
}

/** RGBA pixels laid on a white background (transparent parts show white, as on a web page). */
export function onWhite(data) {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + 255 * (1 - a)); out[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a)); out[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a)); out[i + 3] = 255;
  }
  return out;
}
