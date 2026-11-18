// Drawing and maths shared by the photo tools' live previews (renderer) and their exports (processor), so
// what the window shows is what gets saved. Pure functions plus canvas drawing through a 2D context only:
// no DOM, no file access. The maths parts are also unit-tested in Node.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** A typed colour as "#rrggbb": "#abc" / "abc" / "f00" / "#AABBCC" → "#aabbcc"; null when it isn't one. */
export function normHex(t) {
  const m = HEX.exec(String(t || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return '#' + h.toLowerCase();
}
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ output formats
/** Formats a picture can be saved in again as itself; anything else ("Same as original") becomes PNG. */
export const RESAVE = ['jpg', 'png', 'webp', 'tiff', 'bmp'];
const LABEL = { jpg: 'JPEG', png: 'PNG', webp: 'WebP', tiff: 'TIFF', bmp: 'BMP', ico: 'ICO', heic: 'HEIC', avif: 'AVIF', svg: 'SVG', gif: 'GIF' };
/** {to, note?}: the format a result is written in for a chosen output ('same', 'jpg', 'png', 'webp'). */
export function outputFormat(source, choice = 'same') {
  if (choice !== 'same') return { to: choice };
  if (RESAVE.includes(source)) return { to: source };
  return { to: 'png', note: `${LABEL[source] || 'This format'} pictures are saved as PNG.` };
}

// ------------------------------------------------------------------ adjust
export const ADJUST_DEFAULTS = Object.freeze({ light: 0, contrast: 0, color: 0, warmth: 0, tint: 0, sharpness: 0, vignette: 0, fade: 0 });
/** Each setting's range (whole numbers). */
export const ADJUST_RANGE = Object.freeze({ light: [-100, 100], contrast: [-100, 100], color: [-100, 100], warmth: [-100, 100], tint: [-100, 100], sharpness: [0, 100], vignette: [0, 100], fade: [0, 100] });
export const ADJUST_KEYS = Object.keys(ADJUST_DEFAULTS);

/** Ready-made looks: each is a full set of settings, so the sliders show what a look does. */
export const LOOKS = [
  { id: 'vivid', label: 'Vivid', s: { light: 4, contrast: 22, color: 38, warmth: 4, sharpness: 18 } },
  { id: 'golden', label: 'Golden', s: { light: 8, contrast: 8, color: 12, warmth: 42, tint: 6, vignette: 18 } },
  { id: 'crisp', label: 'Crisp', s: { light: 2, contrast: 18, color: -6, warmth: -26, tint: -4, sharpness: 34 } },
  { id: 'matte', label: 'Matte', s: { light: 6, contrast: -22, color: -18, warmth: 8, fade: 46 } },
  { id: 'mono', label: 'Mono', s: { contrast: 12, color: -100, sharpness: 10 } },
  { id: 'noir', label: 'Noir', s: { light: -10, contrast: 52, color: -100, sharpness: 22, vignette: 44 } },
].map((l) => ({ ...l, s: { ...ADJUST_DEFAULTS, ...l.s } }));

export const isNeutral = (s) => ADJUST_KEYS.every((k) => !s[k]);
export const sameSettings = (a, b) => ADJUST_KEYS.every((k) => (a[k] || 0) === (b[k] || 0));

/** Gains for warmth (amber ↔ blue) and tint (magenta ↔ green), per channel. */
function gains(s) {
  const w = (s.warmth || 0) / 100, t = (s.tint || 0) / 100;
  return [1 + 0.11 * w + 0.04 * t, 1 - 0.08 * t, 1 - 0.11 * w + 0.04 * t];
}

/** The tone curve for light, contrast and fade (0..1 → 0..1). */
export function toneCurve(s) {
  const L = (s.light || 0) / 100, C = (s.contrast || 0) / 100, F = (s.fade || 0) / 100;
  const gamma = 2 ** (-L * 1.25);
  return (v) => {
    v = clamp(v, 0, 1) ** gamma;
    if (C >= 0) { const sm = v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v); v += C * (sm - v); }
    else v = 0.5 + (v - 0.5) * (1 + C * 0.55);
    return F * 0.15 + v * (1 - F * 0.2);
  };
}

/** Lookup tables (one per channel) for white balance and tone. */
export function adjustLuts(s) {
  const g = gains(s), tone = toneCurve(s);
  return g.map((k) => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = Math.round(tone((i / 255) * k) * 255); return t; });
}

/**
 * Apply adjust settings to RGBA pixels: `src` → `dst` (both Uint8ClampedArray of w × h × 4; may be the same
 * array except when sharpening). Alpha is kept.
 */
export function adjustPixels(src, dst, w, h, s) {
  const [lr, lg, lb] = adjustLuts(s);
  const k = 1 + clamp((s.color || 0) / 100, -1, 1);
  const V = (s.vignette || 0) / 100;
  const sharp = (s.sharpness || 0) / 100;
  const out = sharp > 0 && dst === src ? new Uint8ClampedArray(src.length) : dst;
  const cx = (w - 1) / 2 || 1, cy = (h - 1) / 2 || 1;
  for (let y = 0, i = 0; y < h; y++) {
    const dy = (y - cy) / cy;
    for (let x = 0; x < w; x++, i += 4) {
      let r = lr[src[i]], g = lg[src[i + 1]], b = lb[src[i + 2]];
      if (k !== 1) { const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = Y + (r - Y) * k; g = Y + (g - Y) * k; b = Y + (b - Y) * k; }
      if (V) {
        const dx = (x - cx) / cx;
        const d = Math.sqrt((dx * dx + dy * dy) / 2);
        const t = clamp((d - 0.32) / 0.75, 0, 1);
        const f = 1 - V * 0.62 * t * t * (3 - 2 * t);
        r *= f; g *= f; b *= f;
      }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = src[i + 3];
    }
  }
  if (sharp > 0) sharpen(out, dst, w, h, sharp * 1.3);
  return dst;
}

/** Unsharp mask with a 3 × 3 neighbourhood: `src` → `dst` (different arrays). */
function sharpen(src, dst, w, h, amount) {
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const sum = src[(y0 * w + x0) * 4 + c] + src[(y0 * w + x) * 4 + c] + src[(y0 * w + x1) * 4 + c]
          + src[(y * w + x0) * 4 + c] + src[i + c] + src[(y * w + x1) * 4 + c]
          + src[(y1 * w + x0) * 4 + c] + src[(y1 * w + x) * 4 + c] + src[(y1 * w + x1) * 4 + c];
        dst[i + c] = src[i + c] + amount * (src[i + c] - sum / 9);
      }
      dst[i + 3] = src[i + 3];
    }
  }
}

/** The settings Auto works out (the others are kept from what was set). */
export const AUTO_KEYS = ['light', 'contrast', 'color', 'warmth', 'tint'];
/** Auto's white balance stays gentle: at most this much warmth or tint. */
export const AUTO_WB_MAX = 25;

/**
 * Auto: settings that improve exposure, contrast, colour and white balance, worked out from the pixels.
 * Keeps sharpness, vignette and fade as they are in `base`. White balance reads only near-grey pixels away from
 * the edges: strong colours (an orange border, a red shirt) and frames say nothing about the light. When too few
 * such pixels are found it is left alone, and it never goes past ±AUTO_WB_MAX.
 */
export function autoAdjust(data, w, h, base = ADJUST_DEFAULTS) { return autoScan(data, w, h, base).out; }

function autoScan(data, w, h, base) {
  const n = w * h;
  const step = Math.max(1, Math.floor(n / 160000));
  const hist = new Uint32Array(256);
  let count = 0, sumY = 0, sumSat = 0, mr = 0, mg = 0, mb = 0, mid = 0, paper = 0;
  let pr = 0, pg = 0, pb = 0, pn = 0; // light near-grey pixels (the paper of a page), not clipped white
  const mx0 = Math.floor(w * 0.06), my0 = Math.floor(h * 0.06);
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.round(Y)]++; count++; sumY += Y;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx ? (mx - mn) / mx : 0;
    if (Y >= 232 && sat < 0.08) paper++;
    sumSat += sat;
    const x = p % w, y = (p - x) / w;
    const inside = x >= mx0 && x < w - mx0 && y >= my0 && y < h - my0;
    if (inside && Y > 30 && Y < 245 && sat < 0.5) { mr += r; mg += g; mb += b; mid++; }
    if (inside && Y >= 150 && Y < 253 && sat < 0.15) { pr += r; pg += g; pb += b; pn++; }
  }
  const out = { ...ADJUST_DEFAULTS, sharpness: base.sharpness || 0, vignette: base.vignette || 0, fade: base.fade || 0 };
  if (!count) return { out, page: false };
  const pct = (q) => { let acc = 0; const lim = q * count; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lim) return v / 255; } return 1; };
  const lo = pct(0.005), hi = pct(0.995), mean = sumY / count / 255;
  // A page or screenshot (mostly white or near-white background) is already as bright as it should be: Light would
  // only darken the white, which looks the same, so it is left alone.
  const page = paper >= count * AUTO_PAGE;
  // Light: bring the average towards a mid tone.
  if (mean > 0.02 && mean < 0.98 && !(page && mean > 0.47)) {
    const g = Math.log(0.47) / Math.log(mean);
    out.light = Math.round(clamp((-Math.log2(g) / 1.25) * 100 * 0.8, -60, 60));
  }
  // Contrast: stretch a flat picture.
  const spread = hi - lo;
  if (spread < 0.86) out.contrast = Math.round(clamp((0.86 - spread) * 110, 0, 45));
  // Colour: a little more for dull pictures.
  const sat = sumSat / count;
  if (sat > 0.03 && sat < 0.28) out.color = Math.round(clamp((0.28 - sat) * 110, 0, 28));
  // A page only gets a touch of contrast (cleaner text) and no extra colour: its look should stay as it is.
  if (page) { out.contrast = Math.min(out.contrast, AUTO_PAGE_CONTRAST); out.color = 0; }
  // White balance: neutralise a colour cast in the near-grey pixels (partly, so the mood stays). Needs enough of
  // them (a tenth of the picture); tiny corrections are dropped. On a page only the paper counts (dark text says
  // nothing about the light), and clean white paper has no cast.
  if (page) { mr = pr; mg = pg; mb = pb; mid = pn; }
  if (mid > Math.max(50, count * 0.1) && sat > 0.03) {
    mr /= mid; mg /= mid; mb /= mid;
    const q = mb / mr; // warmth gain ratio (1 + .11w) / (1 - .11w) = q
    const m = (mr + mb) / 2;
    const gentle = (v) => { const r = Math.round(clamp(v * 0.5, -AUTO_WB_MAX, AUTO_WB_MAX)); return Math.abs(r) < 3 ? 0 : r; };
    out.warmth = gentle(((q - 1) / (q + 1) / 0.11) * 100);
    out.tint = gentle(((1 - m / mg) / 0.08) * 100);
  }
  for (const k of ADJUST_KEYS) if (Object.is(out[k], -0)) out[k] = 0;
  return { out, page };
}

/** Auto treats a picture as a page or screenshot when this share of it is near-white background. */
export const AUTO_PAGE = 0.4;
/** The most contrast Auto gives a page or screenshot. */
export const AUTO_PAGE_CONTRAST = 8;
/** Auto reads every picture from a copy of this size (longer side), so a picture gets the same Auto alone or in a batch. */
export const AUTO_SIDE = 480;

/**
 * Auto as the Adjust photo window uses it: autoAdjust, and when nothing needs fixing a touch of contrast so the
 * button visibly does something, except on a page or screenshot, which is left as it is ({settings, page, nothing}).
 */
export function autoSettings(data, w, h, base = ADJUST_DEFAULTS) {
  const { out, page } = autoScan(data, w, h, base);
  if (!isNeutral(out)) return { settings: out, page, nothing: false };
  return page ? { settings: out, page, nothing: true } : { settings: { ...out, contrast: 6 }, page, nothing: false };
}

/** Draw `src` (shown at sw × sh) with the settings onto `canvas`, sized to sw × sh. */
export function drawAdjusted(canvas, src, sw, sh, s) {
  const w = Math.max(1, Math.round(sw)), h = Math.max(1, Math.round(sh));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (isNeutral(s)) return canvas;
  const img = ctx.getImageData(0, 0, w, h);
  adjustPixels(img.data, img.data, w, h, s);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ------------------------------------------------------------------ rotate and flip
/** {turns: quarter turns clockwise 0–3, flipH, flipV}; mirroring is applied before turning. */
export function normalizeTurn(o) {
  let turns = ((Math.round(o.turns || 0) % 4) + 4) % 4, flipH = !!o.flipH, flipV = !!o.flipV;
  if (flipH && flipV) { flipH = false; flipV = false; turns = (turns + 2) % 4; }
  return { turns, flipH, flipV };
}
export const isIdentityTurn = (o) => { const n = normalizeTurn(o); return !n.turns && !n.flipH && !n.flipV; };
/** Turn the picture as it is seen: dir +1 right (clockwise), −1 left. */
export const turnBy = (o, dir) => normalizeTurn({ ...o, turns: (o.turns || 0) + dir });
/** Mirror the picture as it is seen ('h' left↔right, 'v' top↔bottom), whatever its current turn. */
export function flipBy(o, axis) {
  const n = normalizeTurn(o);
  const odd = n.turns % 2 === 1;
  const flipSourceH = (axis === 'h') !== odd;
  return normalizeTurn({ ...n, flipH: flipSourceH ? !n.flipH : n.flipH, flipV: flipSourceH ? n.flipV : !n.flipV });
}
export const turnedSize = (w, h, o) => (normalizeTurn(o).turns % 2 ? [h, w] : [w, h]);
/** Words for the current turn: "Turned right · Mirrored". */
export function describeTurn(o) {
  const n = normalizeTurn(o);
  const parts = [];
  if (n.turns === 1) parts.push('Turned right');
  if (n.turns === 2) parts.push('Upside down');
  if (n.turns === 3) parts.push('Turned left');
  if (n.flipH) parts.push(n.turns % 2 ? 'flipped top to bottom' : 'mirrored');
  if (n.flipV) parts.push(n.turns % 2 ? 'mirrored' : 'flipped top to bottom');
  if (!parts.length) return 'As it was';
  const s = parts.join(', ');
  return s[0].toUpperCase() + s.slice(1);
}

/** Draw `src` (shown at sw × sh) turned and mirrored onto `canvas`, scaled by k (the canvas is resized). */
export function drawTurned(canvas, src, sw, sh, o, k = 1) {
  const n = normalizeTurn(o);
  const [ow, oh] = turnedSize(sw, sh, n);
  const w = Math.max(1, Math.round(ow * k)), h = Math.max(1, Math.round(oh * k));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(w / 2, h / 2);
  ctx.rotate(n.turns * Math.PI / 2);
  ctx.scale(n.flipH ? -1 : 1, n.flipV ? -1 : 1);
  const dw = sw * k, dh = sh * k;
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  return canvas;
}

// ------------------------------------------------------------------ crop and straighten
/** Shapes for cropping: ratio is width / height (null = free, 'original' = the picture's own). */
export const CROP_SHAPES = [
  { value: 'free', label: 'Free', ratio: null },
  { value: 'original', label: 'Original', ratio: 'original' },
  { value: '1:1', label: '1:1', ratio: 1 },
  { value: '4:5', label: '4:5', ratio: 4 / 5 },
  { value: '3:2', label: '3:2', ratio: 3 / 2 },
  { value: '16:9', label: '16:9', ratio: 16 / 9 },
  { value: '9:16', label: '9:16', ratio: 9 / 16 },
  { value: 'passport', label: 'Passport', ratio: 35 / 45 },
];
export const MAX_STRAIGHTEN = 15;
const EPS = 1e-6;

/** Is the rect (pixels, in the W × H frame) inside the frame and inside the picture turned by `deg`? */
export function rectInside(r, deg, W, H, tol = 0.01) {
  if (r.w <= 0 || r.h <= 0) return false;
  if (r.x < -tol || r.y < -tol || r.x + r.w > W + tol || r.y + r.h > H + tol) return false;
  if (!deg) return true;
  const a = -deg * DEG, c = Math.cos(a), s = Math.sin(a);
  for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const dx = px - W / 2, dy = py - H / 2;
    const qx = dx * c - dy * s, qy = dx * s + dy * c;
    if (Math.abs(qx) > W / 2 + tol || Math.abs(qy) > H / 2 + tol) return false;
  }
  return true;
}

/**
 * The largest rect with this centre and shape (width / height = aspect) that stays inside the frame and the
 * turned picture, no bigger than `maxH` tall. Returns a rect (w/h may be 0 if the centre is outside).
 */
export function fitCentered(cx, cy, aspect, deg, W, H, maxH = Infinity) {
  let s = Math.min(maxH / 2, cx / aspect, (W - cx) / aspect, cy, H - cy);
  if (deg) {
    const a = -deg * DEG, c = Math.cos(a), sn = Math.sin(a);
    const dx = cx - W / 2, dy = cy - H / 2;
    const ux = dx * c - dy * sn, uy = dx * sn + dy * c;
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const vx = sx * aspect * c - sy * sn, vy = sx * aspect * sn + sy * c;
      if (Math.abs(vx) > EPS) s = Math.min(s, (W / 2 - ux * Math.sign(vx)) / Math.abs(vx));
      if (Math.abs(vy) > EPS) s = Math.min(s, (H / 2 - uy * Math.sign(vy)) / Math.abs(vy));
    }
  }
  s = Math.max(0, s);
  return { x: cx - s * aspect, y: cy - s, w: 2 * s * aspect, h: 2 * s };
}

/** The biggest crop of this shape that fits when the picture is turned by `deg` (centred). */
export const largestRect = (aspect, deg, W, H) => fitCentered(W / 2, H / 2, aspect, deg, W, H);

/**
 * Keep a crop filled with picture when straightening: the rect the person chose (`want`) shrinks about its
 * centre just enough to fit at `deg`, moving towards the middle if its centre would leave the picture.
 */
export function fitToAngle(want, deg, W, H) {
  if (rectInside(want, deg, W, H)) return { ...want };
  const aspect = want.w / want.h;
  const cx = want.x + want.w / 2, cy = want.y + want.h / 2;
  const atMiddle = fitCentered(W / 2, H / 2, aspect, deg, W, H, want.h).h;
  const goal = Math.min(want.h, atMiddle * 0.9);
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const r = fitCentered(cx + (W / 2 - cx) * t, cy + (H / 2 - cy) * t, aspect, deg, W, H, want.h);
    if (r.h >= goal - EPS) return r;
  }
  return fitCentered(W / 2, H / 2, aspect, deg, W, H, want.h);
}

const lerpRect = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });
/** Go from `from` (allowed) towards `to` as far as allowed (bisection). */
function towards(from, to, ok) {
  if (ok(to)) return to;
  let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (ok(lerpRect(from, to, m))) lo = m; else hi = m; }
  return lerpRect(from, to, lo);
}

/** Move a crop by (dx, dy), sliding along the edges of the picture instead of stopping. */
export function moveRect(r, dx, dy, deg, W, H) {
  const ok = (q) => rectInside(q, deg, W, H);
  const a = towards(r, { ...r, x: r.x + dx }, ok);
  return towards(a, { ...a, y: a.y + dy }, ok);
}

/**
 * Drag a handle ('tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l') to (px, py). With a fixed shape (`aspect`),
 * the opposite corner stays put and the shape is kept. `min` is the smallest side in pixels.
 */
export function dragHandle(r, handle, px, py, { aspect = null, deg = 0, W, H, min = 8 }) {
  const ok = (q) => q.w >= min - EPS && q.h >= min - EPS && rectInside(q, deg, W, H);
  const L = handle.includes('l'), R = handle.includes('r'), T = handle.includes('t'), B = handle.includes('b');
  if (aspect) {
    // Anchor: the opposite corner (or edge middle for side handles).
    const ax = L ? r.x + r.w : R ? r.x : r.x + r.w / 2;
    const ay = T ? r.y + r.h : B ? r.y : r.y + r.h / 2;
    const make = (h) => {
      const w = h * aspect;
      const x = L ? ax - w : R ? ax : ax - w / 2;
      const y = T ? ay - h : B ? ay : ay - h / 2;
      return { x, y, w, h };
    };
    let hh;
    if ((L || R) && (T || B)) hh = Math.max(Math.abs(px - ax) / aspect, Math.abs(py - ay));
    else if (L || R) hh = Math.abs(px - ax) / aspect;
    else hh = Math.abs(py - ay);
    hh = Math.max(hh, min / aspect, min);
    const next = make(hh);
    if (ok(next)) return next;
    let lo = r.h, hi = hh;
    if (hh < r.h) return ok(next) ? next : r;
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ok(make(m))) lo = m; else hi = m; }
    return make(lo);
  }
  let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (L) x1 = Math.min(px, x2 - min);
  if (R) x2 = Math.max(px, x1 + min);
  const ex = { x: x1, y: r.y, w: x2 - x1, h: r.h };
  const a = towards(r, ex, ok);
  y1 = a.y; y2 = a.y + a.h;
  if (T) y1 = Math.min(py, y2 - min);
  if (B) y2 = Math.max(py, y1 + min);
  return towards(a, { x: a.x, y: y1, w: a.w, h: y2 - y1 }, ok);
}

/**
 * The transform from source pixels (the picture drawn at 0,0 W × H) to output pixels for a crop `r` (pixels in
 * the W × H frame) of the picture turned by `deg` about its centre, scaled to outW × outH. [a, b, c, d, e, f]
 * as for ctx.setTransform.
 */
export function cropMatrix(r, deg, W, H, outW, outH) {
  const kx = outW / r.w, ky = outH / r.h;
  const t = deg * DEG, c = Math.cos(t), s = Math.sin(t);
  // out = K · (R · (p − C) + C − r.xy)
  const ex = W / 2 - r.x - (c * W / 2 - s * H / 2), ey = H / 2 - r.y - (s * W / 2 + c * H / 2);
  return [kx * c, ky * s, -kx * s, ky * c, kx * ex, ky * ey];
}
/** Apply a matrix to a point. */
export const applyMatrix = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invertMatrix(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Output size in pixels for a normalised crop of a W × H picture. */
export const cropSize = (n, W, H) => [Math.max(1, Math.round(n.w * W)), Math.max(1, Math.round(n.h * H))];

/**
 * Draw a crop onto `canvas` (resized to outW × outH). `src` is shown at W × H (it may be a smaller preview of
 * the picture); `r` is in pixels of that W × H frame. The full frame with deg ≠ 0 shows the turned picture.
 */
export function drawCrop(canvas, src, W, H, r, deg, outW, outH, background = null) {
  const w = Math.max(1, Math.round(outW)), h = Math.max(1, Math.round(outH));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...cropMatrix(r, deg, W, H, w, h));
  ctx.drawImage(src, 0, 0, W, H);
  ctx.restore();
  return canvas;
}

// ------------------------------------------------------------------ background and frame
export const BACKDROP_SHAPES = [
  { value: 'original', label: 'Original', ratio: null },
  { value: 'square', label: 'Square post', ratio: 1 },
  { value: 'portrait', label: 'Portrait 4:5', ratio: 4 / 5 },
  { value: 'story', label: 'Story 9:16', ratio: 9 / 16, size: [1080, 1920] }, // a fixed story canvas; the picture is fitted inside
  { value: 'youtube', label: 'YouTube 16:9', ratio: 16 / 9 },
];
export const BACKDROP_DEFAULTS = Object.freeze({ fill: 'gradient', color: '#f2f2f4', color2: '#ffb37a', from: '#ff7a2f', angle: 135, blur: 60, padding: 8, radius: 4, shadow: 40, shape: 'original' });
export const MAX_MP = 100;
export const MAX_SIDE = 30000;

/**
 * Where everything goes on the canvas, in output pixels, for a picture of iw × ih.
 * {cw, ch, x, y, w, h, radius, shadow: {blur, dy, alpha}, blur, k} — k < 1 when the canvas had to be scaled
 * down to stay within the 100-megapixel limit. A shape with a fixed `size` (Story: 1080 × 1920) keeps that canvas
 * and fits the picture inside it, with the padding as a share of the canvas width (k stays 1).
 */
export function backdropLayout(iw, ih, o) {
  const S = Math.max(iw, ih);
  const pad = clamp(o.padding || 0, 0, 40) / 100;
  const shape = BACKDROP_SHAPES.find((s) => s.value === o.shape);
  const ratio = shape && shape.ratio;
  let W, Hh, w, h, k = 1;
  if (shape && shape.size) {
    [W, Hh] = shape.size;
    const m = pad * Math.min(W, Hh);
    const fit = Math.min(Math.max(1, W - 2 * m) / iw, Math.max(1, Hh - 2 * m) / ih);
    w = iw * fit; h = ih * fit;
  } else {
    const m = pad * S;
    let cw = iw + 2 * m, ch = ih + 2 * m;
    if (ratio) { cw = Math.max(cw, ch * ratio); ch = cw / ratio; }
    k = Math.min(1, Math.sqrt((MAX_MP * 1e6 * 0.98) / (cw * ch)), MAX_SIDE / Math.max(cw, ch));
    W = Math.max(1, Math.round(cw * k)); Hh = Math.max(1, Math.round(ch * k));
    w = iw * k; h = ih * k;
  }
  const sh = clamp(o.shadow || 0, 0, 100) / 100;
  return {
    cw: W, ch: Hh, x: (W - w) / 2, y: (Hh - h) / 2, w, h, k,
    radius: (clamp(o.radius || 0, 0, 50) / 50) * (Math.min(w, h) / 2), // 50% = fully round ends
    shadow: { blur: sh * 0.045 * Math.max(w, h), dy: sh * 0.018 * Math.max(w, h), alpha: 0.12 + 0.3 * sh },
    blur: (clamp(o.blur || 0, 0, 100) / 100) * 0.1 * Math.max(W, Hh),
  };
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Start and end points of a CSS-style gradient angle (0° = upwards, 90° = to the right) across w × h. */
export function gradientLine(angle, w, h) {
  const a = angle * DEG, dx = Math.sin(a), dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  return [w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half];
}

/** A 2D canvas of w × h that works in windows and in the processor. */
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c;
}

/**
 * Draw the framed picture onto `canvas`. `src` is the picture (any size), `L` its layout from backdropLayout
 * on the picture's real size, and `scale` the drawing scale (1 for export, smaller for a preview).
 */
export function drawBackdrop(canvas, src, L, o, scale = 1) {
  const W = Math.max(1, Math.round(L.cw * scale)), H = Math.max(1, Math.round(L.ch * scale));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  if (o.fill === 'blur') {
    // A blurred copy covering the canvas, drawn a little bigger so its edges stay solid.
    const b = L.blur * scale;
    const cover = Math.max(W / L.w, H / L.h) / scale;
    const dw = L.w * scale * cover + 4 * b, dh = L.h * scale * cover + 4 * b;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, W, H);
    if (b > 0.5) ctx.filter = `blur(${b.toFixed(2)}px)`;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, 0, W, H);
  } else if (o.fill === 'gradient') {
    const g = ctx.createLinearGradient(...gradientLine(o.angle || 0, W, H));
    g.addColorStop(0, o.from || '#000000');
    g.addColorStop(1, o.color2 || '#ffffff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = o.color || '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  // The picture with rounded corners is drawn on its own layer, so the shadow follows its real outline
  // (transparent pictures cast a shadow only where they have pixels).
  const x = L.x * scale, y = L.y * scale, w = L.w * scale, h = L.h * scale, r = L.radius * scale;
  const lw = Math.max(1, Math.round(w)), lh = Math.max(1, Math.round(h));
  const layer = makeCanvas(lw, lh);
  const lc = layer.getContext('2d');
  lc.imageSmoothingQuality = 'high';
  if (r > 0.25) { roundRect(lc, 0, 0, lw, lh, r * (lw / w)); lc.clip(); }
  lc.drawImage(src, 0, 0, lw, lh);
  if (L.shadow.blur * scale > 0.25) {
    ctx.shadowColor = `rgba(0,0,0,${L.shadow.alpha.toFixed(3)})`;
    ctx.shadowBlur = L.shadow.blur * scale;
    ctx.shadowOffsetY = L.shadow.dy * scale;
  }
  ctx.drawImage(layer, x, y, w, h);
  ctx.restore();
  return canvas;
}

// ------------------------------------------------------------------ resize
export const RESIZE_PRESETS = {
  long: [{ value: 1080, label: '1080', hint: 'Instagram and WhatsApp' }, { value: 1600, label: '1600', hint: 'Email and the web' }, { value: 2048, label: '2048', hint: 'Sharp on most screens' }, { value: 3840, label: '4K', hint: '3840 pixels' }],
  percent: [{ value: 25, label: '25%' }, { value: 50, label: '50%' }, { value: 75, label: '75%' }, { value: 200, label: '200%' }],
  size: [{ value: 100, label: '100 KB' }, { value: 200, label: '200 KB' }, { value: 500, label: '500 KB' }, { value: 1024, label: '1 MB' }, { value: 2048, label: '2 MB' }],
};

/**
 * The longest side Resize starts with (QA round 7), so pressing Save doesn't enlarge the picture: the largest preset
 * not over its longest side, or that side itself when every preset is larger. For several pictures, the largest one
 * decides (smaller ones get the usual "will be enlarged" warning). `sizes`: [{w, h}].
 */
export function defaultLongSide(sizes, fallback = 1600) {
  const longest = (sizes || []).filter((s) => s && s.w > 0 && s.h > 0).map((s) => Math.max(s.w, s.h));
  if (!longest.length) return fallback;
  const m = Math.max(...longest);
  const fit = RESIZE_PRESETS.long.map((p) => p.value).filter((v) => v <= m);
  return fit.length ? Math.max(...fit) : m;
}

/**
 * The size a w × h picture becomes: [width, height], or null when nothing is chosen yet.
 * o: {mode: 'long'|'percent'|'exact'|'size', long, percent, width, height, noEnlarge}
 */
export function resizeTarget(w, h, o) {
  let tw, th;
  if (o.mode === 'long') { const k = o.long / Math.max(w, h); tw = w * k; th = h * k; }
  else if (o.mode === 'percent') { tw = (w * o.percent) / 100; th = (h * o.percent) / 100; }
  else if (o.mode === 'exact') {
    if (o.width && o.height) { tw = o.width; th = o.height; }
    else if (o.width) { tw = o.width; th = (h * o.width) / w; }
    else if (o.height) { th = o.height; tw = (w * o.height) / h; }
    else return null;
  } else return [w, h];
  if (!(tw > 0 && th > 0)) return null;
  if (o.noEnlarge && (tw > w || th > h)) {
    // Smaller pictures keep their size (with both boxes set, they are only made to fit).
    const k = Math.min(w / tw, h / th, 1);
    if (o.mode === 'exact' && o.width && o.height) { tw = Math.min(tw, w); th = Math.min(th, h); }
    else { tw *= k; th *= k; }
  }
  return [Math.max(1, Math.round(tw)), Math.max(1, Math.round(th))];
}

/**
 * Checks for a set of pictures ([{w, h, name}]): {error} when a result would be too big, else {warnings}
 * about enlarging and stretching.
 */
export function resizeIssues(sizes, o) {
  const warnings = [];
  let enlarged = 0, stretched = 0;
  for (const s of sizes) {
    const t = resizeTarget(s.w, s.h, o);
    if (!t) return { error: 'Enter a width or a height.' };
    if (t[0] * t[1] > MAX_MP * 1e6 || Math.max(t[0], t[1]) > MAX_SIDE) {
      const mp = (t[0] * t[1]) / 1e6;
      return { error: `${sizes.length > 1 ? (s.name || 'A picture') + ' would become' : 'The result would be'} ${t[0]} × ${t[1]} pixels (${mp >= 10 ? Math.round(mp) : mp.toFixed(1)} megapixels). The limit is ${MAX_MP} megapixels.` };
    }
    if (t[0] > s.w || t[1] > s.h) enlarged++;
    if (Math.abs(t[0] / t[1] - s.w / s.h) / (s.w / s.h) > 0.01) stretched++;
  }
  const many = sizes.length > 1;
  if (enlarged) warnings.push(many ? `${enlarged === sizes.length ? 'All' : enlarged + ' of ' + sizes.length} pictures will be enlarged, which makes them softer.` : 'This makes the picture bigger than it is, so it will look softer.');
  if (stretched) warnings.push(many ? `${stretched === sizes.length ? 'All' : stretched + ' of ' + sizes.length} pictures will change shape and look stretched.` : 'The shape changes, so the picture will look stretched. Leave one box empty to keep its shape.');
  return { warnings };
}

/**
 * Find the best quality (and, if needed, a smaller size) whose file fits under `target` bytes.
 * `encode(quality 0–1, scale 0–1)` → Promise<size in bytes> (it may keep the bytes itself).
 * Always finishes: at most `maxEncodes` encodes. Returns {ok, quality, scale, size, tries, smallest}.
 */
export async function fitFileSize(encode, target, { minQuality = 0.08, maxQuality = 0.92, minScale = 0.04, maxEncodes = 26, width = Infinity } = {}) {
  let tries = 0, smallest = null;
  const run = async (q, s) => {
    tries++;
    const size = await encode(q, s);
    if (!smallest || size < smallest.size) smallest = { size, quality: q, scale: s };
    return size;
  };
  let scale = 1;
  while (tries < maxEncodes) {
    const high = await run(maxQuality, scale);
    if (high <= target) return { ok: true, quality: maxQuality, scale, size: high, tries, smallest };
    const low = await run(minQuality, scale);
    if (low <= target) {
      let lo = minQuality, hi = maxQuality, loSize = low;
      while (hi - lo > 0.02 && tries < maxEncodes - 1) {
        const m = (lo + hi) / 2;
        const sz = await run(m, scale);
        if (sz <= target) { lo = m; loSize = sz; } else hi = m;
      }
      // Encode the winner last, so an encoder that keeps the latest bytes keeps these.
      const size = await run(lo, scale);
      return { ok: size <= target, quality: lo, scale, size: size <= target ? size : loSize, tries, smallest };
    }
    if (scale <= minScale || width * scale < 16) break;
    // Too big even at the lowest quality: make the picture smaller in proportion to the overshoot.
    scale = Math.max(minScale, scale * clamp(Math.sqrt(target / low) * 0.9, 0.25, 0.9));
  }
  return { ok: false, quality: smallest ? smallest.quality : minQuality, scale: smallest ? smallest.scale : scale, size: smallest ? smallest.size : Infinity, tries, smallest };
}

/**
 * Draw `src` (shown at sw × sh) scaled to tw × th onto `canvas`, halving in steps when making it much
 * smaller so fine detail doesn't shimmer.
 */
export function drawResized(canvas, src, sw, sh, tw, th) {
  tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
  let cur = src, cw = sw, ch = sh;
  while (cw / 2 >= tw * 1.0001 && ch / 2 >= th * 1.0001) {
    const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
    const step = makeCanvas(nw, nh);
    const c = step.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, nw, nh);
    cur = step; cw = nw; ch = nh;
  }
  if (canvas.width !== tw) canvas.width = tw;
  if (canvas.height !== th) canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, tw, th);
  return canvas;
}
