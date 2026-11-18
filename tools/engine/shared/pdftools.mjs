// Maths shared by the PDF tools (phase 5) — page ranges and split plans, page-number and watermark layout,
// Shrink PDF steps and Arrange pages list edits — used by their windows (previews) and by the processor
// (exports), so what a window shows is what gets saved. Pure functions plus drawing through a 2D context.
//
// Coordinates: layouts work in "view space", the page as a person sees it (after the page's own /Rotate), in
// PDF points with the origin at the bottom-left and y going up. `viewToUser` turns a view point and angle into
// the page's own (unrotated) user space for drawing with pdf-lib; previews flip y for the canvas.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ================================================================== page ranges
export const MAX_RANGE_TEXT = 500;
export const MAX_PARTS = 2000;
export const RANGE_EXAMPLE = '1-3, 5, 8-end';

/** "5" or "2-7". */
export const rangeText = (r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`);
/** Pages of a list of ranges, in order (1-based; a page may repeat). A range may run backwards: 5-2 is 5, 4, 3, 2. */
export const pageList = (ranges) => ranges.flatMap((r) => (r.from <= r.to
  ? Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i)
  : Array.from({ length: r.from - r.to + 1 }, (_, i) => r.from - i)));

const TOKEN = /^(\d+|end|last)$/i;

/**
 * Read page ranges typed like "1-3, 5, 8-end" for a PDF of `pages` pages. Commas, semicolons or spaces separate
 * items; "-", "–", "—" or "to" join a range; "end"/"last" is the last page; "3-" means 3 to the end and "-4"
 * 1 to 4. Returns {ranges: [{from, to}]} or {error, fix?, fixLabel?, bad?}: `error` is a friendly sentence. Every
 * item that isn't a page number is named at once (`bad`); otherwise the first problem is explained, and `fix` is the
 * whole text with that item corrected. With `allowEmpty`, empty text means every page ({ranges: [{1, pages}], all:
 * true}). One rule for every page-range box (QA round 7): pages come in the order typed, so a backwards range is
 * fine — "34-1" is pages 34 down to 1 (Combine takes them in that order; Split makes a part with them reversed).
 * `reverse: false` keeps the old "goes backwards" hint for a caller that can't use reversed pages.
 */
export function parseRanges(text, pages, { allowEmpty = false, reverse = true } = {}) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return allowEmpty ? { ranges: [{ from: 1, to: pages }], all: true } : { error: `Type the pages, like ${RANGE_EXAMPLE}.` };
  if (raw.length > MAX_RANGE_TEXT) return { error: 'That’s too long. Use fewer ranges.' };
  const norm = raw.replace(/\s*(?:[-–—‑]|\bto\b|\.\.)\s*/gi, '-').trim();
  const items = norm.split(/[\s,;]+/).filter(Boolean);
  const ranges = [];
  const n = (t) => (/^(end|last)$/i.test(t) ? pages : Number(t));
  const fixWith = (item, repl) => {
    const fix = items.map((x) => (x === item ? repl : x)).join(', ');
    return { fix, fixLabel: repl };
  };
  const bad = [];
  let shape = null, first = null;
  for (const item of items) {
    const parts = item.split('-');
    if (parts.length > 2 || (parts.length === 2 && !parts[0] && !parts[1])) { bad.push(item); shape = shape || item; continue; }
    const [a, b] = parts.length === 1 ? [parts[0], parts[0]] : [parts[0] || '1', parts[1] || 'end'];
    if (!TOKEN.test(a) || !TOKEN.test(b)) { bad.push(item); continue; }
    if (first) continue;
    const from = n(a), to = n(b);
    if (from === 0 || to === 0) {
      const repl = parts.length === 1 ? '1' : `${from === 0 ? 1 : a}-${to === 0 ? 1 : b}`;
      first = { error: `Pages start at 1, not 0. Did you mean ${repl}?`, ...fixWith(item, repl) };
      continue;
    }
    if (from > pages || to > pages) {
      const what = `This PDF has ${plural(pages, 'page')}.`;
      if (from > pages && to > pages) { first = { error: `${what} There’s no page ${Math.min(from, to)}.` }; continue; }
      const repl = from > pages ? (reverse ? `${pages}-${to}` : `${to}-${pages}`) : `${from}-${pages}`;
      first = { error: `${what} Did you mean ${repl}?`, ...fixWith(item, repl) };
      continue;
    }
    if (from > to && !reverse) {
      const repl = `${to}-${from}`;
      first = { error: `${item} goes backwards. Did you mean ${repl}?`, ...fixWith(item, repl) };
      continue;
    }
    ranges.push({ from, to });
  }
  if (bad.length) {
    const q = (t) => `“${t}”`;
    const named = bad.length === 1 ? q(bad[0]) : bad.length <= 3 ? `${bad.slice(0, -1).map(q).join(', ')} and ${q(bad[bad.length - 1])}` : `${bad.slice(0, 2).map(q).join(', ')} and ${bad.length - 2} more`;
    const verb = bad.length === 1 ? 'isn’t' : 'aren’t';
    const what = bad.length === 1 && shape ? 'a page range' : bad.length === 1 ? 'a page number' : 'page numbers';
    return { error: `${named} ${verb} ${what}. Use numbers like ${RANGE_EXAMPLE}.`, bad };
  }
  if (first) return first;
  if (!ranges.length) return { error: `Type the pages, like ${RANGE_EXAMPLE}.` };
  if (ranges.length > MAX_PARTS) return { error: `That’s more than ${MAX_PARTS} ranges.` };
  return { ranges };
}

export const partLabel = (r) => (r.from === r.to ? `page ${r.from}` : `pages ${r.from}-${r.to}`);

export const SPLIT_MODES = [
  { value: 'pages', label: 'Every page', icon: 'files' },
  { value: 'every', label: 'Every N pages', icon: 'rows-3' },
  { value: 'ranges', label: 'Page ranges', icon: 'text-cursor-input' },
];

/**
 * The parts a split makes: {parts: [{from, to, label}]} or {error, fix?, fixLabel?}. o: {mode: 'pages' | 'every' |
 * 'ranges', every, ranges}. A split that would give back one part with every page in order is refused.
 */
export function planSplit(pages, o) {
  if (!(pages >= 1)) return { error: 'This PDF has no pages.' };
  let parts;
  if (o.mode === 'pages' || o.mode === 'every') {
    const every = o.mode === 'pages' ? 1 : o.every;
    if (!Number.isInteger(every) || every < 1) return { error: 'Enter how many pages go in each part.' };
    if (pages === 1) return { error: 'This PDF has only one page, so there’s nothing to split.' };
    if (every >= pages) return { error: `${plural(every, 'page')} in each part makes one part with all ${pages} pages — the same as the original. Choose a number below ${pages}.` };
    parts = [];
    for (let p = 1; p <= pages; p += every) parts.push({ from: p, to: Math.min(pages, p + every - 1) });
  } else if (o.mode === 'ranges') {
    const r = parseRanges(o.ranges, pages);
    if (r.error) return r;
    parts = r.ranges;
    // The whole file in its own order is a copy; the whole file backwards (end-1) is a new PDF.
    if (parts.length === 1 && parts[0].from === 1 && parts[0].to === pages) {
      return { error: `${rangeText(parts[0])} is every page — the same as the original. Type the parts you want, like ${pages > 2 ? `1-${Math.ceil(pages / 2)}, ${Math.ceil(pages / 2) + 1}-end` : '1, 2'}.` };
    }
  } else return { error: 'Choose how to split.' };
  if (parts.length > MAX_PARTS) return { error: `That makes more than ${MAX_PARTS} parts.` };
  return { parts: parts.map((p) => ({ ...p, label: partLabel(p) })) };
}

// ================================================================== text widths (Helvetica, WinAnsi)
// Advance widths (1/1000 em) of the standard Helvetica and Helvetica-Bold fonts for WinAnsi codes 32–255, as
// pdf-lib embeds them (checked by the unit tests). The exports position text with these; the previews draw the
// system's Helvetica/Arial stretched to the same width, so placement matches exactly.
const W_REG = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,500,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500';
const W_BOLD = '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,556,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556';
const WIDTHS = { regular: W_REG.split(',').map(Number), bold: W_BOLD.split(',').map(Number) };
// Unicode characters WinAnsi keeps in codes 128–159 (€, “, ”, –, — …).
const WIN_EXTRA = { 338: 140, 339: 156, 352: 138, 353: 154, 376: 159, 381: 142, 382: 158, 402: 131, 710: 136, 732: 152, 8211: 150, 8212: 151, 8216: 145, 8217: 146, 8218: 130, 8220: 147, 8221: 148, 8222: 132, 8224: 134, 8225: 135, 8226: 149, 8230: 133, 8240: 137, 8249: 139, 8250: 155, 8364: 128, 8482: 153 };
/** Cap height of Helvetica, as a fraction of the size. */
export const CAP = 0.718;

const winCode = (cp) => (cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255) ? cp : WIN_EXTRA[cp] || 0;
/** True when every character can be written with the standard PDF fonts (Latin letters, digits, common signs). */
export function winAnsi(text) {
  for (const ch of String(text)) { const c = winCode(ch.codePointAt(0)); if (!c || !WIDTHS.regular[c - 32]) return false; }
  return true;
}
/** Width in points of WinAnsi text in Helvetica (or Helvetica-Bold). */
export function textWidth(text, size, bold = false) {
  const t = WIDTHS[bold ? 'bold' : 'regular'];
  let w = 0;
  for (const ch of String(text)) { const c = winCode(ch.codePointAt(0)); w += c ? t[c - 32] || 0 : 556; }
  return (w / 1000) * size;
}

// Text that the standard fonts can't write (other scripts, emoji) is drawn as a picture in the system font.
export const FALLBACK_FAMILY = 'system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif';
export const FALLBACK_PX = 4; // picture pixels per point
/** {width (pt), pad, below, height} of the picture used for such text: it spans [−pad, width+pad] × [−below, height−below]. */
export function fallbackBox(ctx, text, size) {
  ctx.font = `700 ${size * FALLBACK_PX}px ${FALLBACK_FAMILY}`;
  const width = ctx.measureText(text).width / FALLBACK_PX;
  return { width, pad: size * 0.12, below: size * 0.28, height: size * 1.32 };
}

// ================================================================== page geometry
/** 0, 90, 180 or 270. */
export const normRotation = (deg) => ((Math.round((Number(deg) || 0) / 90) * 90) % 360 + 360) % 360;
export const rotateBy = (r, d) => normRotation(r + d);

/** The size a page is seen at: {vw, vh}, from its box {width, height} and /Rotate. */
export const viewSize = (box, rot) => (normRotation(rot) % 180 ? { vw: box.height, vh: box.width } : { vw: box.width, vh: box.height });

/**
 * A view-space point and angle (degrees, counter-clockwise) → the page's user space, for a page whose visible box
 * is `box` {x, y, width, height} and which is shown turned by `rot` (/Rotate, clockwise): {x, y, angle}.
 */
export function viewToUser(box, rot, vx, vy, angle = 0) {
  const r = normRotation(rot), W = box.width, H = box.height;
  let x, y;
  if (r === 0) { x = vx; y = vy; } else if (r === 90) { x = W - vy; y = vx; } else if (r === 180) { x = W - vx; y = H - vy; } else { x = vy; y = H - vx; }
  return { x: box.x + x, y: box.y + y, angle: ((angle + r) % 360 + 360) % 360 };
}

const rot = (u, v, deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [u * c - v * s, u * s + v * c]; };

// ================================================================== page numbers
export const NUMBER_POSITIONS = [
  { value: 'tl', label: 'Top left' }, { value: 'tc', label: 'Top centre' }, { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' }, { value: 'bc', label: 'Bottom centre' }, { value: 'br', label: 'Bottom right' },
];
export const NUMBER_STYLES = [
  { value: 'n', label: '1' },
  { value: 'page', label: 'Page 1' },
  { value: 'of', label: '1 of 12' },
];
export const NUMBER_SIZES = { min: 6, max: 48, def: 11 };
export const MAX_START = 99999;
export const NUMBER_DEFAULTS = Object.freeze({ position: 'bc', style: 'n', start: 1, size: NUMBER_SIZES.def, skipFirst: false });

/**
 * The number on page `i` (0-based) of `count`, or null when it gets none. With skipFirst the first page is left
 * blank and numbering starts on the second page with `start`.
 */
export function numberFor(i, count, o) {
  const skip = o.skipFirst ? 1 : 0;
  if (i < skip || i >= count) return null;
  return (o.start || 1) + i - skip;
}
/** The highest number used (the "12" in "1 of 12"). */
export const lastNumber = (count, o) => (o.start || 1) + Math.max(0, count - (o.skipFirst ? 1 : 0)) - 1;
/** "7", "Page 7" or "7 of 12". */
export const numberLabel = (style, n, last) => (style === 'page' ? `Page ${n}` : style === 'of' ? `${n} of ${last}` : String(n));

/** Distance from the page edge: about 5% of the short side, between 18 and 42 pt, and never less than the text size. */
export const numberMargin = (vw, vh, size) => Math.max(size, clamp(Math.min(vw, vh) * 0.05, 18, 42));

/** Where a number of `width` points goes on a vw × vh page: its baseline-left point {x, y} in view space. */
export function numberPlacement(vw, vh, position, size, width) {
  const m = numberMargin(vw, vh, size);
  const col = position[1], top = position[0] === 't';
  const x = col === 'l' ? m : col === 'r' ? vw - m - width : (vw - width) / 2;
  const y = top ? vh - m - CAP * size : m;
  return { x, y };
}

// ================================================================== watermark
export const WATERMARK = Object.freeze({ textMax: 60, sizeMin: 12, sizeMax: 200, opacityMin: 5, opacityMax: 100 });
export const WATERMARK_DEFAULTS = Object.freeze({ text: 'CONFIDENTIAL', size: 64, opacity: 25, angle: 'diagonal', color: '#d70015', layout: 'center' });
export const WATERMARK_TEXTS = ['CONFIDENTIAL', 'DRAFT', 'COPY', 'SAMPLE', 'DO NOT COPY'];
export const MAX_TILES = 400;

/** The share of the page's width and height a watermark may use (a little room is left at the edges). */
export const WATERMARK_ROOM = 0.9;
export const WATERMARK_MIN_FIT = 4; // pt: long text on a small page is never made smaller than this

/**
 * The size a watermark is drawn at on a vw × vh page: `size`, or smaller so the whole text — `width` points wide at
 * `size`, turned to `angle` — fits inside the page (WATERMARK_ROOM). Tiled copies use the same size, so no copy is
 * longer than the page. Rounded down to half a point.
 */
export function watermarkFit(vw, vh, { width, size, angle = 0 }) {
  const a = (Math.abs(angle) * Math.PI) / 180;
  const h = size * 1.1; // cap height plus room for accents and descenders
  const bw = width * Math.cos(a) + h * Math.sin(a), bh = width * Math.sin(a) + h * Math.cos(a);
  const f = Math.min(1, (WATERMARK_ROOM * vw) / Math.max(bw, 1e-6), (WATERMARK_ROOM * vh) / Math.max(bh, 1e-6));
  return f >= 1 ? size : Math.max(WATERMARK_MIN_FIT, Math.floor(size * f * 2) / 2);
}

/**
 * The smallest size the watermark gets on any of `sizes` ([[vw, vh]], as seen) when `size` doesn't fit, else null.
 * `widthAt(size)` is the text's width at a size.
 */
export function watermarkShrunk(sizes, { size, angle: mode, widthAt }) {
  let min = size;
  const width = widthAt(size);
  for (const [vw, vh] of sizes || []) min = Math.min(min, watermarkFit(vw, vh, { width, size, angle: watermarkAngle(vw, vh, mode) }));
  return min < size ? min : null;
}

/** The contrast ratio (as in WCAG, 1 to 21) of two '#rrggbb' colours. */
export function contrastRatio(a, b) {
  const lum = (hex) => {
    const n = parseInt(String(hex).slice(1, 7), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Below this contrast with the page, a watermark colour barely shows (white or pale yellow on white pages). */
export const WATERMARK_FAINT = 1.5;
/** Is the colour too close to the page's (white unless known) to be seen? */
export const watermarkFaint = (color, page = '#ffffff') => /^#[0-9a-f]{6}$/i.test(String(color)) && contrastRatio(color, page) < WATERMARK_FAINT;

/** The watermark's angle on a vw × vh page: along the page's own diagonal (bottom-left to top-right) or level. */
export const watermarkAngle = (vw, vh, mode) => (mode === 'diagonal' ? (Math.atan2(vh, vw) * 180) / Math.PI : 0);

/**
 * Where watermark text of `width` × `size` points goes: [{x, y}] baseline-left points in view space, all at
 * `angle`. Centred: the text's middle (half its cap height) on the page's middle. Tiled: a brick pattern along the
 * text's direction that covers the page, at most MAX_TILES copies (spaced out further if needed).
 */
export function watermarkPlacements(vw, vh, { width, size, angle, layout }) {
  const half = [width / 2, (CAP * size) / 2];
  const origin = (cx, cy) => { const [dx, dy] = rot(half[0], half[1], angle); return { x: cx - dx, y: cy - dy }; };
  if (layout !== 'tile') return [origin(vw / 2, vh / 2)];
  let du = width + Math.max(size * 1.6, width * 0.35), dv = size * 3.2;
  const reach = Math.hypot(vw, vh) / 2 + Math.max(width, size);
  const r = Math.hypot(width / 2, size); // around each copy's middle
  for (let tries = 0; tries < 8; tries++) {
    const out = [];
    const nu = Math.ceil(reach / du) + 1, nv = Math.ceil(reach / dv) + 1;
    for (let j = -nv; j <= nv; j++) {
      for (let i = -nu; i <= nu; i++) {
        const [ox, oy] = rot(i * du + (j & 1 ? du / 2 : 0), j * dv, angle);
        const cx = vw / 2 + ox, cy = vh / 2 + oy;
        if (cx + r < 0 || cx - r > vw || cy + r < 0 || cy - r > vh) continue;
        out.push(origin(cx, cy));
      }
    }
    if (out.length <= MAX_TILES) return out;
    du *= 1.25; dv *= 1.25;
  }
  return [origin(vw / 2, vh / 2)];
}

// ================================================================== drawing (previews)
export const PDF_FAMILY = 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif';

/**
 * Draw text placed in view space on a canvas showing the page at `k` px per point (y flipped). With `width`
 * (WinAnsi text) the system font is stretched to the export's exact width; `fallback` text is drawn as the export
 * draws its picture.
 */
export function drawViewText(ctx, text, { x, y, angle = 0, size, width, bold = false, color = '#000', opacity = 1, fallback = false }, vh, k) {
  ctx.save();
  ctx.translate(x * k, (vh - y) * k);
  ctx.rotate((-angle * Math.PI) / 180);
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  if (fallback) {
    ctx.font = `700 ${size * k}px ${FALLBACK_FAMILY}`;
  } else {
    ctx.font = `${bold ? '700 ' : ''}${size * k}px ${PDF_FAMILY}`;
    const m = ctx.measureText(text).width;
    if (m > 0 && width > 0) ctx.scale((width * k) / m, 1);
  }
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** A page picture (vw × vh points) drawn on `canvas` at k px per point, then `overlay(ctx)`. */
export function drawPage(canvas, img, vw, vh, k, overlay) {
  canvas.width = Math.max(1, Math.round(vw * k));
  canvas.height = Math.max(1, Math.round(vh * k));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (img) { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, canvas.width, canvas.height); }
  if (overlay) overlay(ctx);
  return canvas;
}

/** Page number `label` on a page, as the export draws it. */
export function drawNumber(ctx, vw, vh, k, label, o) {
  const width = textWidth(label, o.size);
  const p = numberPlacement(vw, vh, o.position, o.size, width);
  drawViewText(ctx, label, { ...p, size: o.size, width, color: '#1a1a1a' }, vh, k);
}

/** The watermark on a page, as the export draws it. `measure` is a 2D context for text the standard fonts can't write. */
export function drawWatermark(ctx, vw, vh, k, o) {
  const text = String(o.text || '').trim();
  if (!text) return;
  const fallback = !winAnsi(text);
  const widthAt = (s) => (fallback ? fallbackBox(ctx, text, s).width : textWidth(text, s, true));
  const angle = watermarkAngle(vw, vh, o.angle);
  // Text too long for the page at this size is made smaller to fit (as the export does).
  const size = watermarkFit(vw, vh, { width: widthAt(o.size), size: o.size, angle });
  const width = size === o.size ? widthAt(o.size) : widthAt(size);
  for (const p of watermarkPlacements(vw, vh, { width, size, angle, layout: o.layout })) {
    drawViewText(ctx, text, { ...p, angle, size, width, bold: true, color: o.color, opacity: o.opacity / 100, fallback }, vh, k);
  }
}

// ================================================================== Shrink PDF
export const SHRINK_LEVELS = [
  { value: 'light', label: 'Light', icon: 'feather', sub: 'Text stays text', hint: 'Keeps text sharp and selectable. Tidies the file: unused parts, extra metadata and loose data are removed.' },
  { value: 'strong', label: 'Strong', icon: 'image-down', sub: 'Text becomes an image', hint: 'Turns each page into a picture at the sharpness below. Much smaller for scans and photos, but text can no longer be selected or searched.' },
];
export const SHRINK_DPI = [
  { value: 100, label: 'Small', hint: '100 dpi: fine on screens, soft when printed' },
  { value: 150, label: 'Balanced', hint: '150 dpi: clear on screens and in print' },
  { value: 200, label: 'Sharp', hint: '200 dpi: crisp print, bigger files' },
];
export const SHRINK_QUALITY = 0.72;
export const SHRINK_TARGET = { min: 0.05, max: 500 }; // MB
/** Pages never go below this sharpness to reach a size, unless the person allows softer pages (small text stays readable). */
export const SHRINK_FLOOR_DPI = 150;
/** A result less than this much smaller is "only a little smaller": saved, but shown as a warning, not a success. */
export const SHRINK_WORTH = 0.1;
/** Pages as pictures must beat the tidied file by this much to be worth losing selectable text (Make smaller). */
export const PICTURES_WORTH = 0.25;
// How JPEG size grows with quality, relative to SHRINK_QUALITY (a rough model, used only to skip hopeless tries).
const QF = { 0.72: 1, 0.55: 0.72, 0.45: 0.6, 0.38: 0.52 };

/**
 * The Strong tries for a target size, sharpest first: [[dpi, quality]]. They stop at SHRINK_FLOOR_DPI (or the chosen
 * sharpness, if lower) and quality 0.45, unless `soft` (the person allowed softer pages): then down to 40 dpi.
 */
export function shrinkSteps(dpi, { soft = false } = {}) {
  const floor = soft ? 40 : Math.min(dpi, SHRINK_FLOOR_DPI);
  const minQ = soft ? 0.38 : 0.45;
  const raw = [[dpi, 0.72], [dpi, 0.55], [Math.round(dpi * 0.72), 0.55], [Math.round(dpi * 0.5), 0.45], [Math.round(dpi * 0.36), 0.38]];
  const steps = raw.map(([d, q]) => [Math.max(floor, d), Math.max(minQ, q)]);
  return steps.filter(([d, q], i) => d >= 40 && !steps.slice(0, i).some((s) => s[0] === d && s[1] === q));
}

/**
 * The next Strong try after one at `last` [dpi, q] made `size` bytes, aiming at `target`: the first later step whose
 * estimated size (∝ dpi² × quality factor) is within 15% of the target, else the last step; null after the last.
 */
export function nextShrinkStep(steps, last, size, target) {
  const at = steps.findIndex((s) => s[0] === last[0] && s[1] === last[1]);
  const rest = steps.slice(at + 1);
  if (!rest.length) return null;
  const est = (s) => size * ((s[0] / last[0]) ** 2) * ((QF[s[1]] || s[1] / 0.72) / (QF[last[1]] || last[1] / 0.72));
  return rest.find((s) => est(s) <= target * 1.15) || rest[rest.length - 1];
}

/**
 * Which result to keep: {pick: 'light' | 'strong', fit}. `light` and `strong` are the sizes in bytes of the tidied
 * file and of the smallest picture try (null when not made).
 * - With a target, the first result under it wins. If none is, Light keeps the tidied file (text stays readable) and
 *   Strong keeps its smallest try; either way `fit` is false.
 * - Without a target, Strong keeps the pictures, except with `keepText` (Make smaller): then pictures must be at least
 *   PICTURES_WORTH smaller than the tidied file, or the tidied file is kept.
 */
export function pickShrink({ level, target = 0, keepText = false }, light, strong) {
  const has = (n) => typeof n === 'number' && n > 0;
  if (target) {
    if (has(light) && light <= target) return { pick: 'light', fit: true };
    if (has(strong) && strong <= target) return { pick: 'strong', fit: true };
    if ((level === 'light' && has(light)) || !has(strong)) return { pick: 'light', fit: false };
    return { pick: 'strong', fit: false };
  }
  if (!has(strong)) return { pick: 'light', fit: true };
  if (keepText && has(light) && strong > light * (1 - PICTURES_WORTH)) return { pick: 'light', fit: true };
  return { pick: level === 'light' && has(light) ? 'light' : 'strong', fit: true };
}

/**
 * How a saved result should read: {warn, why}. A warning (not a green tick) when it missed its target size
 * (why 'target') or is less than SHRINK_WORTH smaller (why 'little').
 */
export function shrinkVerdict(before, after, { target = 0, fit = true } = {}) {
  if (target && !fit) return { warn: true, why: 'target' };
  if (before > 0 && after > before * (1 - SHRINK_WORTH)) return { warn: true, why: 'little' };
  return { warn: false, why: null };
}

// ================================================================== Arrange pages
/** A page of the arranged PDF: {key, src (0-based page of the original, or -1 for a blank page), rotate, w?, h? (blank size, pt)}. */
export const initialPages = (count) => Array.from({ length: count }, (_, i) => ({ key: 'p' + i, src: i, rotate: 0 }));
/** True when the list is not the original pages in order and unturned. */
export const pagesChanged = (items, count) => !(items.length === count && items.every((it, i) => it.src === i && !it.rotate));

/**
 * Move the pages with keys in `keys` (keeping their order) so they land before the page that was at `to`
 * (0..length; length = the end). Returns a new list.
 */
export function movePages(items, keys, to) {
  const set = new Set(keys);
  const moving = items.filter((it) => set.has(it.key));
  if (!moving.length) return items;
  const before = items.slice(0, clamp(to, 0, items.length)).filter((it) => !set.has(it.key)).length;
  const rest = items.filter((it) => !set.has(it.key));
  return [...rest.slice(0, before), ...moving, ...rest.slice(before)];
}

/** The pages as the processor takes them: [{src, rotate, w?, h?}]. */
export const arrangeSpec = (items) => items.map((it) => (it.src < 0 ? { src: -1, rotate: 0, w: it.w, h: it.h } : { src: it.src, rotate: it.rotate || 0 }));
