// Edit image text: the logic shared by the app's window, the website's page and the processor
// (src/processor/image-text.js). Pure code on RGBA pixels ({data, width, height}), so the unit tests run it in Node:
// OCR results → editable lines, the background around a line (and how busy it is), the text's colour, which bundled
// font matches it, painting the old words out, and drawing the new ones (src/shared/glyph-raster.mjs).
// See docs/rebuild/EDIT-IMAGE-TEXT.md.
import * as E from './pdfedit.mjs';
import { polygons, bounds, coverage } from './glyph-raster.mjs';

export { findMatches, replaceMatches, changeLabel, cleanText, unsupportedChars, unsupportedText, hexOf, CSS_FAMILY, FAMILIES, isDeva } from './pdfedit.mjs';

// ------------------------------------------------------------------ limits and words
export const IMG = Object.freeze({
  textMax: 500, edits: 2000, adds: 200,
  sizeMin: 6, sizeMax: 600, sizeDef: 32, // added text, in pixels of the picture
  findMax: 200,
  pages: 300, // scanned PDF pages read in one file
  ocrMax: 4000, // longest side handed to the text reader (larger pictures are read at this size)
  ocrMin: 1400, // pictures smaller than this are read at twice their size (small text reads better)
});
export const LANGS = Object.freeze([{ value: 'eng', label: 'English' }, { value: 'eng+hin', label: 'English + हिन्दी' }]);
export const langOk = (l) => LANGS.some((x) => x.value === l);
export const SUFFIX = 'edited';
export const BUSY_NOTE = 'The background behind this text is busy, so the patch may show. Check the preview before saving.';
export const NONE_NOTE = 'No text was found in this picture. Text that is very small, blurred, handwritten or light on a dark background may not be read. You can still add text.';
export const TEXT_PAGE_NOTE = 'This page has real text, not a picture of it — use Edit PDF text to change it. It is saved as it is.';
export const LIMIT_NOTE = 'The old text is painted over with a patch made from the background around it. On plain, gradient and lightly textured backgrounds it blends in; on busy photos it can show.';

// ------------------------------------------------------------------ OCR results → lines
const ALNUM = /[\p{L}\p{N}]/u;
const cleanWord = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/**
 * Lines from Tesseract's block output (blocks → paragraphs → lines → words), in pixels of the picture (`scale` is how
 * much larger the picture the reader saw was). A line is split where its words are far apart (table cells, a label
 * and its value), and stray marks without letters or digits are dropped. Returns [{i, text, words: [{text, box, conf,
 * start, end}], box: [x, y, w, h], base: {x0, y0, x1, y1}, angle, xh, asc, desc, conf}].
 */
export function linesFromBlocks(blocks, { scale = 1 } = {}) {
  const out = [];
  const k = 1 / (scale || 1);
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const bx = (b) => [b.x0 * k, b.y0 * k, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k];
    const words = (l.words || []).map((w) => ({ text: cleanWord(w.text), conf: w.confidence || 0, box: bx(w.bbox),
      chars: (w.symbols || []).filter((c) => c.text && c.text.trim() && c.bbox).map((c) => ({ text: c.text.trim(), box: bx(c.bbox).map(r2), conf: c.confidence || 0 })) }))
      .filter((w) => w.text && (ALNUM.test(w.text) ? w.conf >= 20 : w.conf >= 60 && w.text.length <= 3));
    if (!words.length) continue;
    const ra = l.rowAttributes || {};
    const bl = l.baseline || { x0: l.bbox.x0, y0: l.bbox.y1, x1: l.bbox.x1, y1: l.bbox.y1 };
    const base = { x0: bl.x0 * k, y0: bl.y0 * k, x1: bl.x1 * k, y1: bl.y1 * k };
    const hts = words.map((w) => w.box[3]).sort((a, b) => a - b);
    const ht = hts[hts.length >> 1];
    // Split at large gaps.
    let seg = [words[0]];
    const segs = [seg];
    for (let i = 1; i < words.length; i++) {
      const a = words[i - 1].box, b = words[i].box;
      if (b[0] - (a[0] + a[2]) > Math.max(1.4 * ht, 12)) segs.push((seg = []));
      seg.push(words[i]);
    }
    for (const s of segs) {
      if (!s.some((w) => ALNUM.test(w.text))) continue;
      const conf = s.reduce((a, w) => a + w.conf, 0) / s.length;
      if (conf < 35) continue;
      const x0 = Math.min(...s.map((w) => w.box[0])), y0 = Math.min(...s.map((w) => w.box[1]));
      const x1 = Math.max(...s.map((w) => w.box[0] + w.box[2])), y1 = Math.max(...s.map((w) => w.box[1] + w.box[3]));
      // The baseline across this part of the line.
      const slope = base.x1 !== base.x0 ? (base.y1 - base.y0) / (base.x1 - base.x0) : 0;
      const yAt = (x) => base.y0 + (x - base.x0) * slope;
      let at = 0;
      const ws = s.map((w) => { const start = at; at += Array.from(w.text).length + 1; return { ...w, box: w.box.map(r2), start, end: start + Array.from(w.text).length }; });
      out.push({
        text: ws.map((w) => w.text).join(' '), words: ws,
        box: [r2(x0), r2(y0), r2(x1 - x0), r2(y1 - y0)],
        base: { x0: r2(x0), y0: r2(yAt(x0)), x1: r2(x1), y1: r2(yAt(x1)) },
        angle: r2((Math.atan2(-slope, 1) * 180) / Math.PI),
        xh: r2(Math.max(2, ((ra.rowHeight || ht) - (ra.ascenders || 0) - (ra.descenders || 0)) * k)),
        asc: r2((ra.ascenders || ht * 0.3) * k), desc: r2((ra.descenders || ht * 0.2) * k), conf: Math.round(conf),
      });
    }
  }
  out.sort((a, b) => a.box[1] + a.box[3] / 2 - (b.box[1] + b.box[3] / 2) || a.box[0] - b.box[0]);
  // Reading order: rows top to bottom (a row is lines whose middles are close), left to right within a row.
  const rows = [];
  for (const l of out) {
    const mid = l.box[1] + l.box[3] / 2;
    const row = rows.find((r) => Math.abs(r.mid - mid) < Math.min(r.h, l.box[3]) * 0.5);
    if (row) row.lines.push(l); else rows.push({ mid, h: l.box[3], lines: [l] });
  }
  const ordered = rows.flatMap((r) => r.lines.sort((a, b) => a.box[0] - b.box[0]));
  ordered.forEach((l, i) => { l.i = i; });
  return ordered;
}
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ pixels
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const median = (arr) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[s.length >> 1]; };
const hex3 = (c) => E.hexOf([c[0], c[1], c[2]]);
export const rgbOf = (hex) => { const v = parseInt(String(hex).slice(1), 16) || 0; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

/** A median filter then a 3-wide mean over a profile of [r, g, b, a] values. */
function smooth(prof, win) {
  const n = prof.length, h = win >> 1, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const tmp = [];
      for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) tmp.push(prof[j][c]);
      v[c] = median(tmp);
    }
    out[i] = v;
  }
  return out.map((_, i) => [0, 1, 2, 3].map((c) => (out[Math.max(0, i - 1)][c] + out[i][c] + out[Math.min(n - 1, i + 1)][c]) / 3));
}

/**
 * The background of a box [x, y, w, h] (pixels), from the pixels around it: along each side the median of a band a
 * few pixels deep (other text in the band is outvoted), smoothed, then joined across the box (a Coons patch: exact for
 * flat colours and straight gradients, smooth for curved ones). Also how much the band varies once that smooth part
 * is taken away (sigma, 0–255), which says whether the background is flat, a gradient, textured or busy.
 * → {x0, y0, x1, y1, at(x, y) → [r, g, b, a], texture(x, y) → [dr, dg, db], sigma, level, mean: [r, g, b, a]}
 */
export function background(img, box) {
  const { data, width: W, height: H } = img;
  const x0 = clamp(Math.floor(box[0]), 0, W - 1), y0 = clamp(Math.floor(box[1]), 0, H - 1);
  const x1 = clamp(Math.ceil(box[0] + box[2]), x0 + 1, W), y1 = clamp(Math.ceil(box[1] + box[3]), y0 + 1, H);
  const bw = x1 - x0, bh = y1 - y0;
  const pad = clamp(Math.round(bh * 0.3), 3, 20);
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  // Raw bands: rows above and below (for every column from x0-1 to x1), columns left and right.
  const band = (fixed, from, to, along, horizontal) => {
    const rows = [];
    for (let t = from; t <= to; t++) if (t >= 0 && t < (horizontal ? H : W)) rows.push(t);
    if (!rows.length) return null;
    return along.map((s) => rows.map((t) => (horizontal ? px(clamp(s, 0, W - 1), t) : px(t, clamp(s, 0, H - 1)))));
  };
  const xs = Array.from({ length: bw + 2 }, (_, i) => x0 - 1 + i), ys = Array.from({ length: bh + 2 }, (_, i) => y0 - 1 + i);
  const raw = {
    top: band(0, y0 - pad, y0 - 1, xs, true), bottom: band(0, y1, y1 + pad - 1, xs, true),
    left: band(0, x0 - pad, x0 - 1, ys, false), right: band(0, x1, x1 + pad - 1, ys, false),
  };
  const win = Math.max(3, Math.round(bh * 0.8)) | 1;
  const prof = {};
  for (const [k, b] of Object.entries(raw)) prof[k] = b ? smooth(b.map((list) => [0, 1, 2, 3].map((c) => median(list.map((p) => p[c])))), win) : null;
  // Sides that are off the picture: from the others.
  const all = Object.values(raw).filter(Boolean).flat(2);
  const flat = all.length ? [0, 1, 2, 3].map((c) => median(all.map((p) => p[c]))) : [255, 255, 255, 255];
  const lerp = (a, b, t) => a.map((v, c) => v * (1 - t) + b[c] * t);
  if (!prof.top && !prof.bottom) {
    const L = prof.left, R = prof.right;
    prof.top = xs.map((_, i) => (L && R ? lerp(L[0], R[0], i / (xs.length - 1)) : (L || R || [flat])[0]));
    prof.bottom = xs.map((_, i) => (L && R ? lerp(L[L.length - 1], R[R.length - 1], i / (xs.length - 1)) : (L || R) ? (L || R)[(L || R).length - 1] : flat));
  }
  if (!prof.top) prof.top = prof.bottom; if (!prof.bottom) prof.bottom = prof.top;
  if (!prof.left) prof.left = ys.map((_, j) => lerp(prof.top[0], prof.bottom[0], j / (ys.length - 1)));
  if (!prof.right) prof.right = ys.map((_, j) => lerp(prof.top[prof.top.length - 1], prof.bottom[prof.bottom.length - 1], j / (ys.length - 1)));
  const T = prof.top, B = prof.bottom, L = prof.left, R = prof.right;
  const nT = T.length - 1, nL = L.length - 1;
  const c00 = lerp(T[0], L[0], 0.5), c10 = lerp(T[nT], R[0], 0.5), c01 = lerp(B[0], L[nL], 0.5), c11 = lerp(B[nT], R[nL], 0.5);
  const at = (x, y) => {
    const i = clamp(Math.round(x) - (x0 - 1), 0, nT), j = clamp(Math.round(y) - (y0 - 1), 0, nL);
    const u = i / nT, v = j / nL;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      out[c] = clamp((1 - v) * T[i][c] + v * B[i][c] + (1 - u) * L[j][c] + u * R[j][c]
        - ((1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c]), 0, 255);
    }
    return out;
  };
  // How much the bands vary around their smooth profile.
  const res = [];
  for (const [k, b] of Object.entries(raw)) {
    if (!b) continue;
    const pr = prof[k];
    b.forEach((list, s) => list.forEach((p) => res.push(luma(p[0], p[1], p[2]) - luma(pr[s][0], pr[s][1], pr[s][2]))));
  }
  const mad = median(res.map(Math.abs));
  const sigma = 1.4826 * mad;
  const outliers = res.length ? res.filter((r) => Math.abs(r) > Math.max(28, 4 * sigma)).length / res.length : 0;
  const lum = [...T, ...B, ...L, ...R].map((p) => luma(p[0], p[1], p[2]));
  const spread = Math.max(...lum) - Math.min(...lum);
  const level = sigma > 9 || outliers > 0.14 ? 'busy' : sigma > 2.2 || outliers > 0.06 ? 'textured' : spread > 12 ? 'gradient' : 'flat';
  // Texture for a patch: the band's own variation, mirrored in from the nearer side above or below, kept small.
  const amp = Math.max(4, 2.5 * sigma);
  const texture = (x, y) => {
    const i = clamp(Math.round(x) - (x0 - 1), 0, nT);
    const above = y - y0 < (y1 - y0) / 2;
    const b = (above ? raw.top : raw.bottom) || raw.top || raw.bottom;
    if (!b) return [0, 0, 0];
    const pr = b === raw.top ? T : B;
    const list = b[i];
    const d = above ? y - y0 : y1 - 1 - y;
    const p = list[above ? list.length - 1 - (d % list.length) : d % list.length];
    return [0, 1, 2].map((c) => clamp(p[c] - pr[i][c], -amp, amp));
  };
  const mean = [0, 1, 2, 3].map((c) => median([...T, ...B].map((p) => p[c])));
  return { x0, y0, x1, y1, at, texture, sigma: r2(sigma), level, mean };
}

/**
 * The text in a box against its background: how far each pixel is from the background (d, per pixel of the box),
 * the contrast (C: the 97th percentile of d) and the text colour (the median of the pixels that differ most).
 */
export function ink(img, bg) {
  const { data, width: W } = img;
  const bw = bg.x1 - bg.x0, bh = bg.y1 - bg.y0;
  const d = new Float32Array(bw * bh);
  for (let y = bg.y0; y < bg.y1; y++) for (let x = bg.x0; x < bg.x1; x++) {
    const i = (y * W + x) * 4, m = bg.at(x, y);
    const a = data[i + 3] / 255, ma = m[3] / 255;
    // Compare as seen on white, so transparent parts count by their alpha.
    let s = 0;
    for (let c = 0; c < 3; c++) { const v = data[i + c] * a + 255 * (1 - a) - (m[c] * ma + 255 * (1 - ma)); s += v * v; }
    d[(y - bg.y0) * bw + (x - bg.x0)] = Math.sqrt(s);
  }
  const sorted = Float32Array.from(d).sort();
  const C = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))] : 0;
  const strong = [];
  for (let y = bg.y0; y < bg.y1; y++) for (let x = bg.x0; x < bg.x1; x++) {
    if (d[(y - bg.y0) * bw + (x - bg.x0)] >= 0.7 * C) { const i = (y * W + x) * 4; strong.push([data[i], data[i + 1], data[i + 2]]); }
  }
  const color = strong.length ? [0, 1, 2].map((c) => median(strong.map((p) => p[c]))) : [0, 0, 0];
  const tStrong = Math.max(18, 0.45 * C, 3 * bg.sigma + 10), tWeak = Math.max(10, 0.15 * C, 2.5 * bg.sigma + 6);
  return { d, w: bw, h: bh, C, color, tStrong, tWeak, dAt: (x, y) => { const xi = Math.round(x) - bg.x0, yi = Math.round(y) - bg.y0; return xi < 0 || yi < 0 || xi >= bw || yi >= bh ? 0 : d[yi * bw + xi]; } };
}

// ------------------------------------------------------------------ fonts and drawing
/** The styles tried when matching a line's look: the bundled families, regular and bold. */
export const STYLES = Object.freeze([['sans', false], ['sans', true], ['serif', false], ['serif', true], ['mono', false], ['mono', true]]);
/** Bundled font keys a set of lines can need (src/shared/pdfedit.mjs FONT_FILES). */
export function fontKeysFor(texts) {
  const keys = new Set(STYLES.map(([f, b]) => E.fontKey(f, b, false)));
  if (texts.some((t) => /[ऀ-ॿ]/.test(t))) { keys.add('deva'); keys.add('deva-b'); }
  return [...keys];
}

/**
 * Shape text in a style: [{text, font, glyphs, positions, deva}] runs (Hindi in Noto Sans Devanagari) and the whole
 * advance in em. `fonts(key)` gives a loaded fontkit font. Throws a message for characters no bundled font can write.
 */
export function shape(text, { family = 'sans', bold = false, italic = false }, fonts) {
  const runs = [];
  let adv = 0;
  for (const r of E.scriptRuns(text)) {
    const font = fonts(E.fontKey(family, bold, italic, r.deva));
    const missing = [...new Set(Array.from(r.text).filter((ch) => !/[\s‌‍]/.test(ch) && !font.hasGlyphForCodePoint(ch.codePointAt(0))))];
    if (missing.length) { const err = new Error(E.unsupportedText(missing).replace('in the PDF', 'here') + '.'); err.user = true; throw err; }
    const run = font.layout(r.text);
    const upem = font.unitsPerEm;
    const w = run.positions.reduce((a, p) => a + p.xAdvance, 0) / upem;
    runs.push({ text: r.text, font, glyphs: run.glyphs, positions: run.positions, upem, adv: w, deva: r.deva, slant: E.needsSlant(family, italic, r.deva) });
    adv += w;
  }
  return { runs, adv };
}

/**
 * Polygons for shaped text: pen origin (x, y) on the baseline, `size` px per em, horizontal scale hs, angle (degrees,
 * counter-clockwise as seen), all in picture pixels.
 */
export function textPolys(sh, { x = 0, y = 0, size = 16, hs = 1, angle = 0 }) {
  const th = (angle * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
  const polys = [];
  let pen = 0;
  for (const r of sh.runs) {
    const k = 1 / r.upem, t1 = r.slant ? Math.tan((E.SLANT * Math.PI) / 180) : 0;
    r.glyphs.forEach((g, gi) => {
      const p = r.positions[gi];
      const ox = pen + p.xOffset * k, oy = p.yOffset * k;
      const map = (gx, gy) => {
        const ex = ox + gx * k, ey = oy + gy * k; // em, y up
        const lx = (ex + t1 * ey) * size * hs, ly = -ey * size;
        return [x + lx * cs + ly * sn, y - lx * sn + ly * cs];
      };
      polygons(g.path.commands, map, polys);
      pen += p.xAdvance * k;
    });
  }
  return polys;
}

/** Composite coverage `cov` (over rect [rx, ry, rw, rh]) in colour rgb onto the picture. Returns the rect touched. */
function paint(img, cov, rx, ry, rw, rh, rgb) {
  const { data, width: W, height: H } = img;
  for (let j = 0; j < rh; j++) {
    const y = ry + j;
    if (y < 0 || y >= H) continue;
    for (let i = 0; i < rw; i++) {
      const a = cov[j * rw + i];
      if (a <= 0) continue;
      const x = rx + i;
      if (x < 0 || x >= W) continue;
      const o = (y * W + x) * 4;
      const A = data[o + 3] / 255;
      const outA = a + A * (1 - a);
      for (let c = 0; c < 3; c++) data[o + c] = Math.round((rgb[c] * a + data[o + c] * A * (1 - a)) / (outA || 1));
      data[o + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * Draw one line of text into the picture: {text, family, bold, italic, size (px per em), hs, angle, x, y (pen origin on
 * the baseline), color (#hex), maxWidth (px; narrowed to 75 % at most to fit), soft (0–1: blur like the picture's
 * own text edges)}. Returns {rect: [x0, y0, x1, y1], width, fit}.
 */
export function drawText(img, o, fonts) {
  const sh = shape(o.text, o, fonts);
  const width = sh.adv * o.size * (o.hs || 1);
  const fit = o.maxWidth > 0 && width > o.maxWidth ? Math.max(0.75, o.maxWidth / width) : 1;
  const polys = textPolys(sh, { ...o, hs: (o.hs || 1) * fit });
  const b = bounds(polys);
  if (!b) return { rect: null, width: width * fit, fit };
  const rx = Math.floor(b[0]) - 1, ry = Math.floor(b[1]) - 1, rw = Math.ceil(b[2]) - rx + 2, rh = Math.ceil(b[3]) - ry + 2;
  let cov = coverage(polys, rx, ry, rw, rh);
  if (o.soft > 0.05) cov = blur3(cov, rw, rh, Math.min(1, o.soft));
  paint(img, cov, rx, ry, rw, rh, rgbOf(o.color));
  return { rect: [rx, ry, rx + rw, ry + rh], width: width * fit, fit };
}
function blur3(cov, w, h, k) {
  const out = new Float32Array(cov.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const wt = dx || dy ? (dx && dy ? 0.25 : 0.5) : 1;
      s += cov[yy * w + xx] * wt; n += wt;
    }
    out[y * w + x] = cov[y * w + x] * (1 - k) + (s / n) * k;
  }
  return out;
}

// ------------------------------------------------------------------ a line's look
/** The frame of a line: its baseline start, the direction along it and down from it (picture pixels). */
function frame(l) {
  const th = (l.angle * Math.PI) / 180;
  return { ox: l.base.x0, oy: l.base.y0, ux: Math.cos(th), uy: -Math.sin(th), vx: Math.sin(th), vy: Math.cos(th) };
}
const toUV = (f, x, y) => [(x - f.ox) * f.ux + (y - f.oy) * f.uy, (x - f.ox) * f.vx + (y - f.oy) * f.vy];
const fromUV = (f, u, v) => [f.ox + u * f.ux + v * f.vx, f.oy + u * f.uy + v * f.vy];

/** The u-range (along the baseline) of an axis-aligned box. */
function uRange(f, box) {
  const us = [[box[0], box[1]], [box[0] + box[2], box[1]], [box[0], box[1] + box[3]], [box[0] + box[2], box[1] + box[3]]].map(([x, y]) => toUV(f, x, y)[0]);
  return [Math.min(...us), Math.max(...us)];
}

/** Ink inside a box, measured upright in the line's frame: {u0, u1, v0, v1 (ink extent), mask, mw, mh, mu, mv} or null. */
function inkIn(l, f, ik, box, vTop, vBot) {
  let [ua, ub] = uRange(f, box);
  const th = Math.abs(Math.sin((l.angle * Math.PI) / 180)) * box[3];
  ua += th / 2; ub -= th / 2;
  const u0 = Math.floor(ua) - 1, u1 = Math.ceil(ub) + 1, v0 = Math.floor(vTop), v1 = Math.ceil(vBot);
  const mw = u1 - u0 + 1, mh = v1 - v0 + 1;
  if (mw < 2 || mh < 2) return null;
  const m = new Uint8Array(mw * mh);
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity, n = 0;
  for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
    const [x, y] = fromUV(f, u0 + i, v0 + j);
    if (ik.dAt(x, y) >= ik.tStrong) { m[j * mw + i] = 1; n++; if (i < a) a = i; if (i > b) b = i; if (j < c) c = j; if (j > d) d = j; }
  }
  if (b < a || d < c) return null;
  return { u0: u0 + a, u1: u0 + b + 1, v0: v0 + c, v1: v0 + d + 1, mask: m, mw, mh, mu: u0, mv: v0, n };
}

/** The ink box of shaped text at 1 px per em (x right, y down from the baseline). */
function inkEm(sh) {
  const b = bounds(textPolys(sh, { size: 1 }));
  return b && b[2] - b[0] > 1e-6 && b[3] - b[1] > 1e-6 ? b : null;
}

/**
 * How unlike a picture's character a bundled glyph is: the glyph is squeezed into the character's ink box and
 * compared with a pixel of slack (1 − F1), plus how much more or less ink it has (stroke weight) and how much it had
 * to be stretched (letter shapes: mono, narrow or wide). → {score, sx, sy}
 */
function mismatch(sh, em, wi) {
  const sx = (wi.u1 - wi.u0) / (em[2] - em[0]), sy = (wi.v1 - wi.v0) / (em[3] - em[1]);
  const polys = textPolys(sh, { size: 1 }).map((p) => p.map(([x, y]) => [wi.u0 + (x - em[0]) * sx - wi.mu, wi.v0 + (y - em[1]) * sy - wi.mv]));
  const cov = coverage(polys, 0, 0, wi.mw, wi.mh);
  const R = new Uint8Array(cov.length);
  let nr = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i] >= 0.5) { R[i] = 1; nr++; }
  if (!nr || !wi.n) return { score: 2, sx, sy };
  const Md = dilate(wi.mask, wi.mw, wi.mh, 1), Rd = dilate(R, wi.mw, wi.mh, 1);
  let tp = 0, tr = 0, both = 0, any = 0;
  for (let i = 0; i < R.length; i++) {
    if (R[i] && Md[i]) tp++; if (wi.mask[i] && Rd[i]) tr++;
    if (R[i] && wi.mask[i]) both++; if (R[i] || wi.mask[i]) any++;
  }
  const prec = tp / nr, rec = tr / wi.n;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  return { score: (1 - f1) + (1 - both / any) + 0.6 * Math.abs(Math.log(nr / wi.n)), sx, sy };
}

/**
 * How a line looks, from its pixels: the background (level, colour), the text colour, the bundled style that
 * matches it best (sans / serif / mono, regular or bold: up to 18 of its characters are drawn into their own boxes
 * in each style and compared with the ink), the size (px per em) and width (hs) that match, where each word's pen
 * starts (u along the baseline) and the baseline itself (v0). `fonts(key)` gives loaded fontkit fonts; without
 * fonts only the colours and background are measured.
 */
export function lookOf(img, l, fonts) {
  const bg = background(img, [l.box[0] - 1, l.box[1] - 1, l.box[2] + 2, l.box[3] + 2]);
  const ik = ink(img, bg);
  const f = frame(l);
  const ht = Math.max(4, l.xh + l.asc + l.desc);
  const vTop = -(ht - l.desc) * 1.3 - 2, vBot = l.desc * 1.6 + 2;
  const look = {
    color: hex3(ik.color), bg: hex3(bg.mean), level: bg.level, sigma: bg.sigma, contrast: Math.round(ik.C),
    font: { family: 'sans', bold: false, italic: false }, size: r2(Math.max(6, (l.xh || ht * 0.5) / 0.53)), hs: 1, v0: 0,
    pens: l.words.map((w) => r2(uRange(f, w.box)[0])), soft: 0,
  };
  // Soft edges (photos, scans): the share of the ink that is only partly dark.
  let part = 0, full = 0;
  for (let i = 0; i < ik.d.length; i++) { const v = ik.d[i]; if (v >= 0.85 * ik.C) full++; else if (v >= 0.25 * ik.C) part++; }
  look.soft = r2(clamp((part / Math.max(1, full) - 0.6) / 1.5, 0, 1));
  if (!fonts) return look;
  // Up to 18 characters, from the longest words read with confidence.
  // (Hindi words are compared whole: the reader's pieces of a Devanagari word don't match its glyphs one to one.)
  const chars = [];
  for (const w of l.words.filter((x) => x.conf >= 45).sort((a, b) => (b.chars || []).length - (a.chars || []).length)) {
    if (/[ऀ-ॿ]/.test(w.text)) { if (chars.length < 18) chars.push(w); continue; }
    for (const c of w.chars || []) if (ALNUM.test(c.text) && c.conf >= 40 && chars.length < 18) chars.push(c);
  }
  const inks = chars.map((c) => ({ c, wi: inkIn(l, f, ik, c.box, vTop, vBot) })).filter((x) => x.wi && x.wi.u1 - x.wi.u0 >= 2 && x.wi.v1 - x.wi.v0 >= 4);
  // Monospaced text has the same pitch from character to character (pairs of digits don't count: most fonts have
  // equal-width digits).
  const steps = [];
  for (const w of l.words) {
    const cs = (w.chars || []).map((c) => ({ t: c.text, u: (uRange(f, c.box)[0] + uRange(f, c.box)[1]) / 2 }));
    for (let i = 1; i < cs.length; i++) if (!(/\p{N}/u.test(cs[i - 1].t) && /\p{N}/u.test(cs[i].t))) steps.push(cs[i].u - cs[i - 1].u);
  }
  let mono = null;
  if (steps.length >= 3) {
    const m = steps.reduce((a, b) => a + b, 0) / steps.length;
    const sd = Math.sqrt(steps.reduce((a, b) => a + (b - m) ** 2, 0) / steps.length);
    mono = m > 0 && sd / m < 0.12;
  }
  let best = null;
  for (const [family, bold] of STYLES) {
    if (mono !== null && (family === 'mono') !== mono) continue;
    let total = 0, n = 0;
    const fits = [];
    for (const { c, wi } of inks) {
      let sh;
      try { sh = shape(c.text, { family, bold }, fonts); } catch { continue; }
      const em = inkEm(sh);
      if (!em) continue;
      const m = mismatch(sh, em, wi);
      total += m.score + 0.5 * Math.abs(Math.log(m.sx / m.sy)); n++;
      fits.push(m);
    }
    if (!n) continue;
    const score = total / n;
    if (!best || score < best.score) best = { family, bold, score, fits };
  }
  if (!best) return look;
  const style = { family: best.family, bold: best.bold };
  const size = median(best.fits.map((x) => x.sy));
  look.font = { ...style, italic: false };
  look.size = r2(size); look.match = r2(Math.max(0, 1 - best.score));
  // Each word measured with the matched style: the width it needs (hs: how much wider or narrower the picture's
  // letters and spacing are), the baseline (from where its ink ends) and its pen start.
  const v0s = [], widths = [];
  const measured = l.words.map((w) => {
    const wi = inkIn(l, f, ik, w.box, vTop, vBot);
    let sh = null;
    try { sh = shape(w.text, style, fonts); } catch { sh = null; }
    const em = sh && inkEm(sh);
    if (!wi || !em) return null;
    if (w.conf >= 45 && ALNUM.test(w.text)) {
      v0s.push(wi.v1 - em[3] * size);
      if (Array.from(w.text).length >= 3) widths.push((wi.u1 - wi.u0) / ((em[2] - em[0]) * size));
    }
    return { wi, em };
  });
  const hs = widths.length ? clamp(median(widths), 0.8, 1.25) : 1;
  look.hs = r2(hs);
  look.pens = measured.map((m, k) => (m ? r2(m.wi.u0 - m.em[0] * size * hs) : look.pens[k]));
  look.v0 = v0s.length ? r2(median(v0s)) : 0;
  return look;
}

/** How far a line can grow along its baseline (from its first pen) before it meets other text or the picture's edge. */
export function roomOf(lines, looks, W, H) {
  return lines.map((l, i) => {
    const f = frame(l), lk = looks[i];
    const start = lk.pens[0] || 0;
    const end = uRange(f, l.box)[1];
    let room = Infinity;
    lines.forEach((o, j) => {
      if (j === i || Math.abs(o.angle - l.angle) > 2) return;
      const [u, v] = toUV(f, o.base.x0, o.base.y0);
      if (Math.abs(v - lk.v0) < 0.6 * lk.size && u > end - 0.3 * lk.size) room = Math.min(room, u - start);
    });
    // The picture's edge along the baseline.
    for (const t of [0, 1]) {
      const ex = t ? W : 0, ey = t ? H : 0;
      if (Math.abs(f.ux) > 1e-6) { const s = (ex - f.ox) / f.ux; if (s > 0) room = Math.min(room, s - start); }
      if (Math.abs(f.uy) > 1e-6) { const s = (ey - f.oy) / f.uy; if (s > 0) room = Math.min(room, s - start); }
    }
    return r2(room);
  });
}

// ------------------------------------------------------------------ editing
/**
 * What an edit of a line changes, by words: the words kept at the start (`keep`), the text drawn from the first
 * changed word's pen to the end of the line (`draw`), and the old text that goes (`old`). null when nothing changed.
 */
export function planLine(l, next) {
  const text = E.cleanText(next);
  if (text === l.text) return null;
  const oldW = l.words.map((w) => w.text);
  const newW = text.split(/\s+/).filter(Boolean);
  let p = 0;
  while (p < oldW.length && p < newW.length && oldW[p] === newW[p]) p++;
  // Text only added at the end of the line: keep every word, draw the addition after a space.
  const append = p === oldW.length;
  return { keep: p, draw: newW.slice(p).join(' '), old: oldW.slice(p).join(' '), append, text };
}

/** Is pixel (x, y) inside the part of a line from u = ua to u = ub (whole height, with a margin)? */
function inSpan(f, x, y, ua, ub, vTop, vBot) { const [u, v] = toUV(f, x, y); return u >= ua && u <= ub && v >= vTop && v <= vBot; }

/**
 * Paint out the ink of a line from u = ua to its end (picture pixels in the line's frame): pixels that differ from
 * the background, grown by a pixel or two for soft edges, are replaced by the background (its smooth part plus the
 * band's own texture), with a half-blended rim. Returns the rect changed [x0, y0, x1, y1] or null.
 */
function paintOut(img, l, lk, bg, ik, ua, ub) {
  const { data, width: W } = img;
  const f = frame(l);
  const ht = Math.max(4, l.xh + l.asc + l.desc);
  const vTop = lk.v0 - Math.max(ht - l.desc, lk.size * 1.05) - 3, vBot = lk.v0 + Math.max(l.desc, lk.size * 0.3) + 3;
  const bw = bg.x1 - bg.x0, bh = bg.y1 - bg.y0;
  const mask = new Uint8Array(bw * bh);
  for (let y = bg.y0; y < bg.y1; y++) for (let x = bg.x0; x < bg.x1; x++) {
    const k = (y - bg.y0) * bw + (x - bg.x0);
    if (ik.d[k] > ik.tWeak && inSpan(f, x + 0.5, y + 0.5, ua, ub, vTop, vBot)) mask[k] = 1;
  }
  const r = 1 + Math.round(lk.size / 28) + (bg.sigma > 2 || lk.soft > 0.3 ? 1 : 0);
  const grown = dilate(mask, bw, bh, r), rim = dilate(grown, bw, bh, 1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
    const k = j * bw + i;
    if (!rim[k]) continue;
    const x = bg.x0 + i, y = bg.y0 + j;
    const o = (y * W + x) * 4;
    const m = bg.at(x, y), t = bg.texture(x, y);
    const a = grown[k] ? 1 : 0.5;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(clamp(m[c] + t[c], 0, 255) * a + data[o + c] * (1 - a));
    data[o + 3] = Math.round(m[3] * a + data[o + 3] * (1 - a));
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return x1 >= x0 ? [x0, y0, x1 + 1, y1 + 1] : null;
}
function dilate(m, w, h, r) {
  if (r <= 0) return m;
  // Square dilation in two passes.
  const t = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (let d = -r; d <= r && !on; d++) { const xx = x + d; if (xx >= 0 && xx < w && m[y * w + xx]) on = 1; }
    t[y * w + x] = on;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (let d = -r; d <= r && !on; d++) { const yy = y + d; if (yy >= 0 && yy < h && t[yy * w + x]) on = 1; }
    out[y * w + x] = on;
  }
  return out;
}

/**
 * Apply edits to a picture: edits [{line, old, text}] of `lines` (from linesFromBlocks), added texts [{x, y (top-left,
 * px), size (px), text, family, bold, italic, color, align}], with `looks` (lookOf for each line, or null to measure
 * here) and `room` (roomOf). Changes `img` in place. Returns {changed: [[x0, y0, x1, y1]], busy (lines edited on a
 * busy background), checks: [{old, add}]}. Throws a user error when the picture changed since the window read it.
 */
export function applyEdits(img, lines, edits, adds, fonts, { looks = null, room = null } = {}) {
  const changed = [], checks = [];
  let busy = 0;
  const lk = looks || [];
  for (const e of edits) {
    const l = lines[e.line];
    if (!l || l.text !== e.old) { const err = new Error('The picture changed since its text was read. Open Edit image text again.'); err.user = true; throw err; }
    const plan = planLine(l, e.text);
    if (!plan) continue;
    const look = lk[e.line] || lookOf(img, l, fonts);
    const bg = background(img, [l.box[0] - 1, l.box[1] - 1, l.box[2] + 2, l.box[3] + 2]);
    const ik = ink(img, bg);
    const f = frame(l);
    const lineEnd = uRange(f, l.box)[1];
    let pen;
    if (plan.append) {
      const last = l.words[l.words.length - 1];
      const end = uRange(f, last.box)[1];
      pen = end + 0.28 * look.size * look.hs;
    } else pen = look.pens[plan.keep];
    if (!plan.append) {
      const ua = Math.max(uRange(f, l.words[plan.keep].box)[0], look.pens[plan.keep]) - 1;
      const rect = paintOut(img, l, look, bg, ik, ua - Math.max(1, look.size * 0.04), lineEnd + look.size * 0.08 + 2);
      if (rect) changed.push(rect);
    }
    if (bg.level === 'busy') busy++;
    if (plan.draw) {
      const [x, y] = fromUV(f, pen, look.v0);
      const start = look.pens[0] || 0;
      const maxWidth = room && Number.isFinite(room[e.line]) ? room[e.line] - (pen - start) - 0.15 * look.size : 0;
      const r = drawText(img, { text: plan.draw, family: look.font.family, bold: look.font.bold, italic: false, size: look.size, hs: look.hs, angle: l.angle, x, y, color: e.color || look.color, maxWidth, soft: look.soft }, fonts);
      if (r.rect) changed.push(r.rect);
    }
    checks.push({ old: plan.old, add: plan.draw, line: e.line });
  }
  for (const t of adds || []) {
    const rows = E.cleanText(t.text, { multiline: true }).split('\n');
    const lh = E.METRICS.line * t.size;
    const widths = rows.map((row) => (row.trim() ? shape(row, t, fonts).adv * t.size : 0));
    const boxW = Math.max(0, ...widths);
    rows.forEach((row, i) => {
      if (!row.trim()) return;
      const dx = t.align === 'center' ? (boxW - widths[i]) / 2 : t.align === 'right' ? boxW - widths[i] : 0;
      const r = drawText(img, { text: row, family: t.family, bold: t.bold, italic: t.italic, size: t.size, hs: 1, angle: 0, x: t.x + dx, y: t.y + E.firstBaseline() * t.size + i * lh, color: t.color }, fonts);
      if (r.rect) changed.push(r.rect);
    });
  }
  return { changed, busy, checks };
}

/** What windows get for a line: its words, box, frame and look. */
export function lineOut(l, look, room) {
  return {
    i: l.i, text: l.text, box: l.box, base: l.base, angle: l.angle, conf: l.conf, xh: l.xh, asc: l.asc, desc: l.desc,
    words: l.words.map((w) => ({ text: w.text, box: w.box, start: w.start, end: w.end })),
    size: look.size, hs: look.hs, v0: look.v0, pens: look.pens, font: look.font, color: look.color, bg: look.bg, level: look.level, soft: look.soft,
    room: Number.isFinite(room) ? room : null,
  };
}
/** Lines as windows got them (lineOut) → what applyEdits takes: {lines, looks, room}. */
export function fromOut(list) {
  const lines = list.map((l) => ({ i: l.i, text: l.text, box: l.box, base: l.base, angle: l.angle, xh: l.xh, asc: l.asc, desc: l.desc, conf: l.conf, words: l.words }));
  const looks = list.map((l) => ({ size: l.size, hs: l.hs, v0: l.v0, pens: l.pens, font: l.font, color: l.color, bg: l.bg, level: l.level, soft: l.soft || 0 }));
  return { lines, looks, room: list.map((l) => (l.room == null ? Infinity : l.room)) };
}

/** The line and word under a point (picture pixels), for a click: {line, word} or null. */
export function hit(lines, x, y) {
  for (const l of lines) {
    const [bx, by, bw, bh] = l.box;
    if (x < bx - 2 || x > bx + bw + 2 || y < by - 2 || y > by + bh + 2) continue;
    let word = 0, best = Infinity;
    l.words.forEach((w, i) => { const cx = w.box[0] + w.box[2] / 2, d = Math.abs(x - cx) - w.box[2] / 2; if (d < best) { best = d; word = i; } });
    return { line: l.i, word };
  }
  return null;
}
