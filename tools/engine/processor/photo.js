// Photo tools in the sandbox: decode, draw with the same code the tool windows use for their previews
// (src/shared/photo.mjs), encode. Each op returns {bytes, width, height} plus anything the main process reports.
import { decode, encode, blobBytes } from './image.js';
import { UserError } from './errors.js';
import { sniff, headerSize, jpegOrientation } from './image-header.js';
import * as P from '../shared/photo.mjs';
import * as C from '../shared/compose.mjs';

const WRITABLE = ['jpg', 'png', 'webp', 'tiff', 'bmp'];
function target(to) { if (!WRITABLE.includes(to)) throw new UserError('This image format can’t be written.'); return to; }
const q01 = (q) => (Number.isFinite(q) ? P.clamp(q, 0.01, 1) : 0.9);

async function done(canvas, to, quality, extra = {}) {
  return { bytes: await encode(canvas, target(to), q01(quality)), width: canvas.width, height: canvas.height, ...extra };
}

export async function adjust({ bytes, settings, to, quality, limits }) {
  const { canvas } = await decode(bytes, limits);
  const out = P.drawAdjusted(new OffscreenCanvas(canvas.width, canvas.height), canvas, canvas.width, canvas.height, { ...P.ADJUST_DEFAULTS, ...settings });
  return done(out, to, quality);
}

export async function rotate({ bytes, turn, to, quality, limits }) {
  const { canvas } = await decode(bytes, limits);
  const out = P.drawTurned(new OffscreenCanvas(1, 1), canvas, canvas.width, canvas.height, turn);
  return done(out, to, quality);
}

/** crop: {x, y, w, h} as fractions of the picture; angle in degrees. Out-of-picture crops are pulled in. */
export async function crop({ bytes, rect, angle, to, quality, limits }) {
  const { canvas } = await decode(bytes, limits);
  const W = canvas.width, H = canvas.height;
  let r = { x: rect.x * W, y: rect.y * H, w: rect.w * W, h: rect.h * H };
  if (!P.rectInside(r, angle, W, H, 0.5)) r = P.fitToAngle(r, angle, W, H);
  const ow = Math.max(1, Math.round(r.w)), oh = Math.max(1, Math.round(r.h));
  const out = P.drawCrop(new OffscreenCanvas(ow, oh), canvas, W, H, r, angle, ow, oh);
  return done(out, to, quality);
}

export async function backdrop({ bytes, settings, to, quality, limits }) {
  const { canvas } = await decode(bytes, limits);
  const L = P.backdropLayout(canvas.width, canvas.height, settings);
  const out = P.drawBackdrop(new OffscreenCanvas(L.cw, L.ch), canvas, L, settings, 1);
  return done(out, to, quality, { scaled: L.k < 0.999 });
}

/**
 * resize: o = {mode, long, percent, width, height, noEnlarge, targetBytes}. In 'size' mode the quality (and if
 * needed the size) is searched so the file fits under targetBytes; {fit: {quality, scale, size}} says how.
 * `keepSame`: when the new size is the picture's own size, nothing is made ({same: true, width, height}), as the
 * result would only be the same picture saved again (QA round 8).
 */
export async function resize({ bytes, o, to, quality, limits, keepSame = false }) {
  let { canvas, kind } = await decode(bytes, limits);
  const t = P.resizeTarget(canvas.width, canvas.height, o);
  if (!t) throw new UserError('Enter a width or a height.');
  if (keepSame && o.mode !== 'size' && t[0] === canvas.width && t[1] === canvas.height) return { same: true, width: t[0], height: t[1] };
  const issues = P.resizeIssues([{ w: canvas.width, h: canvas.height }], o);
  if (issues.error) throw new UserError(issues.error);
  // Drawings are redrawn at the new size, so they stay sharp.
  if (kind === 'svg' && (t[0] > canvas.width || t[1] > canvas.height)) {
    ({ canvas } = await decode(bytes, limits, { scale: Math.max(t[0] / canvas.width, t[1] / canvas.height) }));
  }
  if (o.mode !== 'size') {
    const out = P.drawResized(new OffscreenCanvas(1, 1), canvas, canvas.width, canvas.height, t[0], t[1]);
    return done(out, to, quality, { enlarged: t[0] > canvas.width || t[1] > canvas.height });
  }
  if (to !== 'jpg' && to !== 'webp') throw new UserError('A file size limit works with JPEG or WebP.');
  const mime = to === 'jpg' ? 'image/jpeg' : 'image/webp';
  const sized = new Map(); // scale → canvas (flattened on white for JPEG)
  const at = (s) => {
    if (!sized.has(s)) {
      const w = Math.max(1, Math.round(canvas.width * s)), h = Math.max(1, Math.round(canvas.height * s));
      const c = P.drawResized(new OffscreenCanvas(1, 1), canvas, canvas.width, canvas.height, w, h);
      if (to === 'jpg') { const f = new OffscreenCanvas(w, h); const x = f.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); x.drawImage(c, 0, 0); sized.set(s, f); } else sized.set(s, c);
    }
    return sized.get(s);
  };
  let last = null;
  const fit = await P.fitFileSize(async (q, s) => { const c = at(s); last = { bytes: await blobBytes(c, mime, q), c }; return last.bytes.length; }, o.targetBytes, { width: canvas.width });
  if (!fit.ok) {
    const sm = fit.smallest;
    const w = Math.round(canvas.width * sm.scale), h = Math.round(canvas.height * sm.scale);
    throw new UserError(`Couldn’t make it smaller than ${kb(o.targetBytes)}: the smallest was ${kb(sm.size)} at ${w} × ${h} pixels. Try a larger limit.`);
  }
  return { bytes: last.bytes, width: last.c.width, height: last.c.height, fit: { quality: Math.round(fit.quality * 100), scale: fit.scale, size: fit.size } };
}

function kb(n) { return n >= 1024 * 1024 ? (n / 1048576).toFixed(n >= 10485760 ? 1 : 2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

/** A random seed for the pixelate/blur shuffle, so exports can't be matched against a known pattern. */
function randomSeed() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] | 1; }

/**
 * redact: boxes ({x, y, w, h} fractions of the picture) hidden in `style` ('black', 'blur' or 'pixelate').
 * Black boxes are real black pixels; the result is re-encoded, so no metadata (location, camera) is carried over.
 */
export async function redact({ bytes, boxes, style, to, quality, limits }) {
  if (!Array.isArray(boxes) || !boxes.length || boxes.length > C.MAX_BOXES) throw new UserError('Draw at least one box over what you want to hide.');
  if (!C.REDACT_STYLES.some((s) => s.value === style)) throw new UserError('Choose how to hide the details.');
  const { canvas } = await decode(bytes, limits);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  C.redactBoxes(ctx, canvas.width, canvas.height, boxes, style, { seed: randomSeed() });
  return done(canvas, to, quality);
}

/** A picture's size as it is shown (EXIF turns applied) from its header when that is enough, else by decoding it. */
async function shownSize(bytes, limits) {
  const kind = sniff(bytes);
  if (['png', 'jpg', 'gif', 'webp', 'bmp'].includes(kind)) {
    const s = headerSize(bytes, kind);
    if (s && s.width > 0 && s.height > 0) return kind === 'jpg' && jpegOrientation(bytes) >= 5 ? { w: s.height, h: s.width } : { w: s.width, h: s.height };
  }
  const { canvas } = await decode(bytes, limits);
  const out = { w: canvas.width, h: canvas.height };
  canvas.width = canvas.height = 0;
  return out;
}

/**
 * collage: images (bytes, in order) laid out with collageLayout and drawn with drawCollageCell — the same code
 * as the window's preview. Pictures are decoded one at a time, so only one is in memory with the collage.
 */
export async function collage({ images, o, to, quality, limits }) {
  if (!Array.isArray(images) || images.length < 2 || images.length > C.MAX_COLLAGE) throw new UserError(`A collage takes 2 to ${C.MAX_COLLAGE} pictures.`);
  const sizes = [];
  for (const b of images) sizes.push(await shownSize(b, limits));
  const L = C.collageLayout(sizes.map((s) => s.w / s.h), o);
  if (L.tooSmall) throw new UserError('The pictures don’t fit at this size. Use less spacing, a wider collage or another layout.');
  const out = new OffscreenCanvas(L.W, L.H);
  const ctx = C.drawCollageBackground(out, L, o, 1);
  for (let i = 0; i < images.length; i++) {
    const { canvas } = await decode(images[i], limits);
    C.drawCollageCell(ctx, L, i, canvas, canvas.width, canvas.height, o, (o.items || [])[i], 1, true);
    canvas.width = canvas.height = 0;
    images[i] = null;
  }
  return done(out, to, quality, { scaled: L.k < 0.999 });
}
