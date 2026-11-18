// Drawing and maths shared by the phase 4 image tools — Hide details (redaction), Images to PDF (page layout
// and "Scan look") and Collage — used by their windows (previews) and by the processor (exports), so what the
// window shows is what gets saved. Pure functions plus drawing through a 2D context: no DOM, no files.
import { clamp, makeCanvas, roundRect, drawResized, MAX_MP, MAX_SIDE } from './photo.mjs';

// ================================================================== Hide details (redaction)
export const REDACT_STYLES = [
  { value: 'black', label: 'Black', icon: 'square', hint: 'Solid black boxes replace the pixels underneath. The safest choice for text and numbers.' },
  { value: 'blur', label: 'Blur', icon: 'droplet', hint: 'A heavy blur, strong enough that text can’t be read back.' },
  { value: 'pixelate', label: 'Pixelate', icon: 'grid-3x3', hint: 'Large blocks, slightly shuffled in colour so the text can’t be rebuilt.' },
];
export const MAX_BOXES = 200;
/** The smallest box side, as a fraction of the picture. */
export const MIN_BOX = 0.004;

/** A box {x, y, w, h} (fractions of the picture, may reach past its edges) cut to the picture; null when nothing is left. */
export function clipBox(b) {
  if (!b) return null;
  const x0 = clamp(b.x, 0, 1), y0 = clamp(b.y, 0, 1), x1 = clamp(b.x + b.w, 0, 1), y1 = clamp(b.y + b.h, 0, 1);
  if (!(x1 - x0 > 0 && y1 - y0 > 0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The box between two corner points (any order, may be outside the picture), cut to the picture. */
export const boxFromPoints = (ax, ay, bx, by) => clipBox({ x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });

/** Move a box; it keeps its size and stays inside the picture. */
export const moveBox = (b, dx, dy) => ({ ...b, x: clamp(b.x + dx, 0, 1 - b.w), y: clamp(b.y + dy, 0, 1 - b.h) });

/**
 * Drag a handle ('tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l') to (px, py); the box stays inside the picture and at least
 * `min` big. Other fields of the box (e.g. a time range in Blur areas) are kept.
 */
export function resizeBox(b, handle, px, py, min = MIN_BOX) {
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  px = clamp(px, 0, 1); py = clamp(py, 0, 1);
  if (handle.includes('l')) x0 = Math.max(0, Math.min(px, x1 - min));
  if (handle.includes('r')) x1 = Math.min(1, Math.max(px, x0 + min));
  if (handle.includes('t')) y0 = Math.max(0, Math.min(py, y1 - min));
  if (handle.includes('b')) y1 = Math.min(1, Math.max(py, y0 + min));
  return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whole pixels covering a box on a W × H picture: never smaller than the box, so no edge of what is hidden shows. */
export function boxPixels(b, W, H) {
  const x0 = clamp(Math.floor(b.x * W + 1e-9), 0, W), y0 = clamp(Math.floor(b.y * H + 1e-9), 0, H);
  const x1 = clamp(Math.ceil((b.x + b.w) * W - 1e-9), 0, W), y1 = clamp(Math.ceil((b.y + b.h) * H - 1e-9), 0, H);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Block size (pixels of the full picture) for blur and pixelate: about a third of the box's short side, so a line
 * of text gets only two or three blocks from top to bottom; never under 8 px or 1.2% of the picture.
 */
export const redactBlock = (bw, bh, W, H) => Math.max(8, Math.round(Math.max(W, H) * 0.012), Math.ceil(Math.min(bw, bh) / 2.5));

/** A small, repeatable shuffle (−amp…amp) for a block, so averaged blocks can't be matched back to known text. */
function jitter(i, j, c, seed, amp) {
  let h = (Math.imul(i + 1, 73856093) ^ Math.imul(j + 1, 19349663) ^ Math.imul(c + 1, 83492791) ^ Math.imul(seed | 0, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (((h ^ (h >>> 16)) >>> 0) % (2 * amp + 1)) - amp;
}

/**
 * Average each bs × bs block of RGBA pixels (rw × rh, blocks from the top-left) and shuffle each average a little.
 * Returns {gw, gh, cells} with one RGBA value per block.
 */
export function blockAverages(data, rw, rh, bs, seed = 1, amp = 7) {
  const gw = Math.max(1, Math.ceil(rw / bs)), gh = Math.max(1, Math.ceil(rh / bs));
  const cells = new Uint8ClampedArray(gw * gh * 4);
  for (let j = 0; j < gh; j++) {
    const ya = j * bs, yb = Math.min(rh, ya + bs);
    for (let i = 0; i < gw; i++) {
      const xa = i * bs, xb = Math.min(rw, xa + bs);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = ya; y < yb; y++) {
        for (let x = xa, p = (y * rw + xa) * 4; x < xb; x++, p += 4) { r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3]; n++; }
      }
      const o = (j * gw + i) * 4;
      n = n || 1;
      cells[o] = r / n + jitter(i, j, 0, seed, amp); cells[o + 1] = g / n + jitter(i, j, 1, seed, amp);
      cells[o + 2] = b / n + jitter(i, j, 2, seed, amp); cells[o + 3] = a / n;
    }
  }
  return { gw, gh, cells };
}

/** Fill every block of `data` (rw × rh) with its value from blockAverages. */
export function fillBlocks(data, rw, rh, bs, { gw, cells }) {
  for (let y = 0; y < rh; y++) {
    const row = Math.floor(y / bs) * gw;
    for (let x = 0, p = y * rw * 4; x < rw; x++, p += 4) {
      const o = (row + Math.floor(x / bs)) * 4;
      data[p] = cells[o]; data[p + 1] = cells[o + 1]; data[p + 2] = cells[o + 2]; data[p + 3] = cells[o + 3];
    }
  }
}

/**
 * Hide the boxes on a picture already drawn at W × H on `ctx`. `full` = [width, height] of the real picture
 * (block sizes follow it, so a preview looks like the export). `live` (preview only) is a box being drawn or
 * moved, shown see-through so it can be aimed. `seed` shuffles pixelate/blur blocks (random for exports).
 */
export function redactBoxes(ctx, W, H, boxes, style, { full = [W, H], seed = 7, live = -1 } = {}) {
  const k = W / full[0];
  boxes.forEach((box, n) => {
    const b = clipBox(box);
    if (!b) return;
    const r = boxPixels(b, W, H);
    if (!r.w || !r.h) return;
    if (n === live) { ctx.fillStyle = style === 'black' ? 'rgba(0,0,0,0.55)' : 'rgba(128,128,128,0.45)'; ctx.fillRect(r.x, r.y, r.w, r.h); return; }
    if (style === 'black') { ctx.fillStyle = '#000000'; ctx.fillRect(r.x, r.y, r.w, r.h); return; }
    const bs = Math.max(1, Math.round(redactBlock(b.w * full[0], b.h * full[1], full[0], full[1]) * k));
    const img = ctx.getImageData(r.x, r.y, r.w, r.h);
    const avg = blockAverages(img.data, r.w, r.h, bs, seed);
    // Pixelate first: what's left underneath is only shuffled block averages, even for the blur.
    fillBlocks(img.data, r.w, r.h, bs, avg);
    ctx.putImageData(img, r.x, r.y);
    if (style !== 'blur') return;
    // Blur: the blocks drawn smoothly bigger (edges repeated so the sides stay solid), then softened.
    const { gw, gh, cells } = avg;
    const tiny = makeCanvas(gw + 2, gh + 2);
    const tc = tiny.getContext('2d');
    const pad = tc.createImageData(gw + 2, gh + 2);
    for (let j = 0; j < gh + 2; j++) for (let i = 0; i < gw + 2; i++) {
      const s = (clamp(j - 1, 0, gh - 1) * gw + clamp(i - 1, 0, gw - 1)) * 4, d = (j * (gw + 2) + i) * 4;
      pad.data[d] = cells[s]; pad.data[d + 1] = cells[s + 1]; pad.data[d + 2] = cells[s + 2]; pad.data[d + 3] = cells[s + 3];
    }
    tc.putImageData(pad, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const soft = bs * 0.7;
    if (soft >= 0.5) ctx.filter = `blur(${soft.toFixed(2)}px)`;
    ctx.drawImage(tiny, r.x - bs, r.y - bs, (gw + 2) * bs, (gh + 2) * bs); // block centres line up with the pixelated blocks
    ctx.restore();
  });
}

/** Draw the picture (shown at sw × sh) with its boxes hidden onto `canvas`, sized to sw × sh. */
export function drawRedacted(canvas, src, sw, sh, boxes, style, opts = {}) {
  const w = Math.max(1, Math.round(sw)), h = Math.max(1, Math.round(sh));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  redactBoxes(ctx, w, h, boxes, style, opts);
  return canvas;
}

// ================================================================== Images to PDF
/** Paper sizes in points (1/72 inch), portrait. */
export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
export const PDF_PAGES = [
  { value: 'fit', label: 'Fit each image', icon: 'scan', hint: 'Every page is the size of its picture' },
  { value: 'a4', label: 'A4', hint: '210 × 297 mm' },
  { value: 'letter', label: 'Letter', hint: '8.5 × 11 in' },
];
export const PDF_MARGINS = [{ value: 0, label: 'None' }, { value: 6, label: 'Small' }, { value: 12, label: 'Medium' }, { value: 20, label: 'Large' }];
export const MAX_PDF_IMAGES = 200;
export const MAX_PT = 14400; // the largest page side PDF readers accept
const MM = 72 / 25.4;
const PX = 0.75; // a picture pixel at 96 dpi, in points

/**
 * Where a picture of iw × ih pixels goes: {pw, ph, x, y, w, h, landscape} in points, y measured from the top.
 * o: {page: 'fit'|'a4'|'letter', orientation: 'auto'|'portrait'|'landscape', margin (mm)}.
 * "Fit" pages are the picture's size at 96 dpi plus the margin; paper sizes fit the picture inside the margin.
 */
export function pageLayout(iw, ih, o) {
  const m = Math.max(0, o.margin || 0) * MM;
  if (o.page !== 'a4' && o.page !== 'letter') {
    let w = iw * PX, h = ih * PX;
    const k = Math.min(1, (MAX_PT - 2 * m) / Math.max(w, h));
    w = Math.max(1, w * k); h = Math.max(1, h * k);
    return { pw: w + 2 * m, ph: h + 2 * m, x: m, y: m, w, h, landscape: w > h };
  }
  let [pw, ph] = PAGE_SIZES[o.page];
  const landscape = o.orientation === 'landscape' || (o.orientation !== 'portrait' && iw > ih);
  if (landscape) [pw, ph] = [ph, pw];
  const aw = Math.max(1, pw - 2 * m), ah = Math.max(1, ph - 2 * m);
  const k = Math.min(aw / iw, ah / ih);
  const w = iw * k, h = ih * k;
  return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h, landscape };
}

/** "Portrait · 210 × 297 mm": a page's shape and size in words. */
export function describePage(L) {
  const mm = (pt) => Math.round(pt / MM);
  return `${L.pw > L.ph ? 'Landscape' : 'Portrait'} · ${mm(L.pw)} × ${mm(L.ph)} mm`;
}

/** The largest side a "Scan look" page picture keeps (A4 at 300 dpi). */
export const SCAN_MAX_SIDE = 3508;

/**
 * "Scan look": turns a photo of a document into clean black on white, in place (RGBA, w × h). The paper's
 * brightness is estimated locally (the brightest part of each small area, smoothed), each pixel is compared
 * with it, and a soft threshold makes ink black and paper white — shadows and uneven light disappear.
 */
export function scanLook(data, w, h) {
  const n = w * h;
  const L = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = data[i + 3] / 255;
    L[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a); // transparent = paper
  }
  // Paper brightness on a coarse grid: block maxima, spread to neighbours (so text-filled blocks see paper), smoothed.
  const bs = Math.max(4, Math.round(Math.max(w, h) / 48));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  let grid = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / bs) * gw;
    for (let x = 0; x < w; x++) { const g = gy + Math.floor(x / bs), v = L[y * w + x]; if (v > grid[g]) grid[g] = v; }
  }
  const pass = (src, pick) => {
    const out = new Float32Array(src.length);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      let acc = 0, cnt = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = clamp(j + dj, 0, gh - 1), ii = clamp(i + di, 0, gw - 1), v = src[jj * gw + ii];
        if (pick === 'max') acc = Math.max(acc, v); else { acc += v; cnt++; }
      }
      out[j * gw + i] = pick === 'max' ? acc : acc / cnt;
    }
    return out;
  };
  grid = pass(pass(pass(grid, 'max'), 'mean'), 'mean');
  // Compare each pixel with the paper there (bilinear between grid centres) and map ink → 0, paper → 255.
  const LO = 0.58, HI = 0.86;
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / bs - 0.5, 0, gh - 1), j0 = Math.floor(fy), j1 = Math.min(gh - 1, j0 + 1), ty = fy - j0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / bs - 0.5, 0, gw - 1), i0 = Math.floor(fx), i1 = Math.min(gw - 1, i0 + 1), tx = fx - i0;
      const top = grid[j0 * gw + i0] * (1 - tx) + grid[j0 * gw + i1] * tx;
      const bot = grid[j1 * gw + i0] * (1 - tx) + grid[j1 * gw + i1] * tx;
      const paper = Math.max(24, top * (1 - ty) + bot * ty);
      let t = clamp((L[y * w + x] / paper - LO) / (HI - LO), 0, 1);
      t = t * t * (3 - 2 * t);
      const v = Math.round(t * 255), i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return data;
}

/** A canvas of `src` (shown at sw × sh) with the scan look, at most `maxSide` on its longer side. */
export function drawScanned(src, sw, sh, maxSide = SCAN_MAX_SIDE) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = drawResized(makeCanvas(1, 1), src, sw, sh, w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  scanLook(img.data, w, h);
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Draw one PDF page for a preview: white paper of L.pw × L.ph points at `scale` px per point, the picture in
 * its place. `src` is the picture (already scanned when the scan look is on).
 */
export function drawPdfPage(canvas, src, L, scale) {
  const w = Math.max(1, Math.round(L.pw * scale)), h = Math.max(1, Math.round(L.ph * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, L.x * scale, L.y * scale, L.w * scale, L.h * scale);
  return canvas;
}

// ================================================================== Collage
export const COLLAGE_LAYOUTS = [
  { value: 'grid', label: 'Grid', icon: 'layout-grid' },
  { value: 'row', label: 'Row', icon: 'columns-3' },
  { value: 'column', label: 'Column', icon: 'rows-3' },
  { value: 'spotlight', label: 'Spotlight', icon: 'layout-panel-left', hint: 'The first picture large, the others beside it' },
];
export const COLLAGE_SHAPES = [
  { value: 'auto', label: 'Auto', ratio: null, hint: 'Shaped to suit the pictures' },
  { value: 'square', label: '1:1', ratio: 1, hint: 'Square post' },
  { value: 'portrait', label: '4:5', ratio: 4 / 5, hint: 'Portrait post' },
  { value: 'story', label: '9:16', ratio: 9 / 16, hint: 'Story, Reels, Status' },
  { value: 'landscape', label: '16:9', ratio: 16 / 9, hint: 'YouTube, slides' },
];
export const COLLAGE_WIDTHS = [
  { value: 1080, label: '1080', hint: 'Instagram and WhatsApp' },
  { value: 2048, label: '2048', hint: 'Sharp on most screens' },
  { value: 4096, label: '4096', hint: 'Print and big screens' },
];
export const COLLAGE_DEFAULTS = Object.freeze({ layout: 'grid', fit: 'fill', shape: 'auto', spacing: 12, radius: 0, background: '#ffffff', width: 2048 });
export const MAX_COLLAGE = 30;
export const COLLAGE_MIN_WIDTH = 320;
export const COLLAGE_MAX_WIDTH = 8000;
/** Spacing and corners are in thousandths of the collage's width (so they look the same at any size). */
export const SPACING_MAX = 60;
export const RADIUS_MAX = 100;
const MIN_CELL = 8;

/** Columns of a grid of n pictures (the last row may have fewer, which are made wider). */
export const gridCols = (n) => Math.max(1, Math.ceil(Math.sqrt(n)));
/** Pictures per row: full rows of `cols`, then the rest. */
export function rowsOf(n, cols) { const out = []; for (let left = n; left > 0; left -= cols) out.push(Math.min(cols, left)); return out; }

/** Lay out lines of cells in a frame: equal line heights, cells in a line share its length; edges on whole pixels. */
function place(x, y, w, h, counts, g, out, across = false) {
  const lines = counts.length;
  const [len, cross] = across ? [h, w] : [w, h]; // len: along a line, cross: across the lines
  const lh = (cross - (lines - 1) * g) / lines;
  counts.forEach((k, li) => {
    const c0 = Math.round(li * (lh + g)), c1 = Math.round(li * (lh + g) + lh);
    const cw = (len - (k - 1) * g) / k;
    for (let j = 0; j < k; j++) {
      const a0 = Math.round(j * (cw + g)), a1 = Math.round(j * (cw + g) + cw);
      out.push(across ? { x: x + c0, y: y + a0, w: c1 - c0, h: a1 - a0 } : { x: x + a0, y: y + c0, w: a1 - a0, h: c1 - c0 });
    }
  });
}

function layoutAt(aspects, o, W) {
  const n = aspects.length;
  const g = Math.round(((o.spacing || 0) / 1000) * W);
  const a = clamp(Math.exp(aspects.reduce((s, x) => s + Math.log(x > 0 ? x : 1), 0) / Math.max(1, n)), 0.5, 2);
  const shape = COLLAGE_SHAPES.find((s) => s.value === o.shape);
  const ratio = shape && shape.ratio;
  const cells = [];
  let H;
  if (o.layout === 'spotlight' && n >= 2) {
    const m = n - 1;
    const strip = rowsOf(m, Math.min(m, 4));
    const share = strip.length === 1 ? 2 / 3 : 0.55;
    const tall = !!ratio && ratio < 0.95;
    if (!tall) {
      H = ratio ? Math.round(W / ratio) : Math.round(((W - 3 * g) * share) / a + 2 * g);
      const iw = W - 3 * g, ih = H - 2 * g, bigW = Math.round(iw * share);
      cells.push({ x: g, y: g, w: bigW, h: ih });
      place(2 * g + bigW, g, iw - bigW, ih, strip, g, cells, true);
    } else {
      H = Math.round(W / ratio);
      const iw = W - 2 * g, ih = H - 3 * g, bigH = Math.round(ih * share);
      cells.push({ x: g, y: g, w: iw, h: bigH });
      place(g, 2 * g + bigH, iw, ih - bigH, strip, g, cells, false);
    }
  } else {
    const counts = o.layout === 'row' ? [n] : o.layout === 'column' ? Array(n).fill(1) : rowsOf(n, gridCols(n));
    const cols = Math.max(...counts), rows = counts.length;
    H = ratio ? Math.round(W / ratio) : Math.round(rows * ((W - (cols + 1) * g) / cols / a) + (rows + 1) * g);
    place(g, g, W - 2 * g, H - 2 * g, counts, g, cells, false);
  }
  H = Math.max(1, H);
  const tooSmall = cells.some((c) => c.w < MIN_CELL || c.h < MIN_CELL);
  return { W, H, gap: g, cells, radius: ((o.radius || 0) / 1000) * W, tooSmall };
}

/**
 * Where every picture goes in a collage, from the pictures' shapes (width / height each) and the settings
 * {layout, shape, spacing, radius, width}: {W, H, gap, radius, cells: [{x, y, w, h}], k, tooSmall}.
 * The collage is made smaller (k < 1) when it would pass the 100-megapixel or 30000-pixel limits.
 */
export function collageLayout(aspects, o) {
  const want = Math.round(clamp(o.width || COLLAGE_DEFAULTS.width, 1, COLLAGE_MAX_WIDTH));
  let L = layoutAt(aspects, o, want);
  let W = want;
  for (let tries = 0; tries < 4 && (L.W * L.H > MAX_MP * 1e6 * 0.98 || Math.max(L.W, L.H) > MAX_SIDE); tries++) {
    const k = Math.min(Math.sqrt((MAX_MP * 1e6 * 0.97) / (L.W * L.H)), (MAX_SIDE * 0.995) / Math.max(L.W, L.H));
    W = Math.max(1, Math.floor(W * k));
    L = layoutAt(aspects, o, W);
  }
  return { ...L, k: W / want };
}

/** The picture's place when it covers a cell (Fill), showing the part at `focus` ({x, y} 0–1, 0.5 = middle). */
export function coverRect(iw, ih, cell, focus = { x: 0.5, y: 0.5 }) {
  const s = Math.max(cell.w / iw, cell.h / ih);
  const w = iw * s, h = ih * s;
  return { x: cell.x - (w - cell.w) * clamp(focus.x, 0, 1), y: cell.y - (h - cell.h) * clamp(focus.y, 0, 1), w, h };
}
/** The picture's place when it is shown whole in a cell (Fit), centred. */
export function containRect(iw, ih, cell) {
  const s = Math.min(cell.w / iw, cell.h / ih);
  const w = iw * s, h = ih * s;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}
/** Dragging a Fill picture by (dx, dy) collage pixels moves what shows: the new focus. */
export function panFocus(focus, dx, dy, iw, ih, cell) {
  const r = coverRect(iw, ih, cell, focus);
  const ox = r.w - cell.w, oy = r.h - cell.h;
  return { x: ox > 0.5 ? clamp(focus.x - dx / ox, 0, 1) : 0.5, y: oy > 0.5 ? clamp(focus.y - dy / oy, 0, 1) : 0.5 };
}

/** The background of a collage at `scale` (the canvas is resized to L.W × L.H × scale). */
export function drawCollageBackground(canvas, L, o, scale = 1) {
  const w = Math.max(1, Math.round(L.W * scale)), h = Math.max(1, Math.round(L.H * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = o.background || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return ctx;
}

/**
 * Draw picture i (`src`, iw × ih pixels as drawn) into its cell. Fill covers the cell (at its focus); Fit
 * shows the whole picture. Rounded corners follow the picture's visible outline. `shrink` (exports) first
 * makes very large pictures smaller in steps, for a sharper, smoother result.
 */
export function drawCollageCell(ctx, L, i, src, iw, ih, o, focus, scale = 1, shrink = false) {
  const c = L.cells[i];
  if (!c) return;
  const cell = { x: c.x * scale, y: c.y * scale, w: c.w * scale, h: c.h * scale };
  const fill = o.fit !== 'fit';
  const r = fill ? coverRect(iw, ih, cell, focus) : containRect(iw, ih, cell);
  const vis = fill ? cell : r; // what shows
  const rad = Math.min(L.radius * scale, vis.w / 2, vis.h / 2);
  let pic = src, pw = iw, ph = ih;
  if (shrink && (iw > r.w * 2 || ih > r.h * 2)) {
    pic = drawResized(makeCanvas(1, 1), src, iw, ih, Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h)));
    pw = pic.width; ph = pic.height;
  }
  ctx.save();
  if (rad > 0.25) roundRect(ctx, vis.x, vis.y, vis.w, vis.h, rad);
  else { ctx.beginPath(); ctx.rect(vis.x, vis.y, vis.w, vis.h); }
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pic, 0, 0, pw, ph, r.x, r.y, r.w, r.h);
  ctx.restore();
  if (pic !== src) { pic.width = 0; pic.height = 0; }
}

/** Draw a whole collage: pics[i] = {src, w, h} (or null while loading), focus[i] = {x, y}. */
export function drawCollage(canvas, L, pics, o, focus = [], scale = 1) {
  const ctx = drawCollageBackground(canvas, L, o, scale);
  pics.forEach((p, i) => { if (p && p.src) drawCollageCell(ctx, L, i, p.src, p.w, p.h, o, focus[i], scale); });
  return canvas;
}
