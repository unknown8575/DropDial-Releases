// Image decoding and encoding in the sandbox. Every decode checks the pixel size before any pixels are
// allocated. Re-encoding drops EXIF and other metadata, so converted images don't carry location details.
import { scanPicture } from './qr-scan.js';
import { UserError } from './errors.js';
import { sniff, headerSize, gifFrames, jpegOrientation } from './image-header.js';
import { encodeBmp, encodeTiff, encodeGif, encodeIco } from './image-encode.js';
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';
import { encodeRgb } from './png.js';
import { firstVisibleGif, showsSomething, onWhite } from './gif-decode.js';

export { UserError }; // statement.js imports it from here

const DAMAGED = 'This image could not be read. It may be damaged.';
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

let heifLib = null;
const libheif = async () => (heifLib ||= (await import('./vendor/libheif-bundle.mjs')).default());

function checkSize(w, h, limits) {
  if (!(w > 0 && h > 0)) throw new UserError(DAMAGED);
  if (w * h > limits.mp * 1e6 || Math.max(w, h) > limits.side) {
    throw new UserError(`This image is too large (${w} × ${h} pixels). The limit is ${limits.mp} megapixels.`);
  }
}

/** A canvas; `opaque` ones (JPEG photos) have no alpha channel, so a PNG made from them is RGB, not RGBA. */
function newCanvas(w, h, opaque = false) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', opaque ? { alpha: false } : undefined);
  ctx.imageSmoothingQuality = 'high';
  if (opaque) c.opaque = true;
  return [c, ctx];
}

function fromImageData(data) {
  const [c, ctx] = newCanvas(data.width, data.height);
  ctx.putImageData(data, 0, 0);
  return c;
}

/**
 * Decode any supported image to a canvas: {canvas, kind, frames}. GIFs give their first frame; EXIF rotation
 * is applied. `scale` renders SVGs larger than their stated size (for sharp PDF pages).
 */
export const NOT_A_PICTURE = 'This file isn’t a picture DropDial can read. It may be damaged, or not really the type its name says.';
export async function decode(bytes, limits, { scale = 1, fitMP = 0 } = {}) {
  const kind = sniff(bytes);
  if (!kind) throw new UserError(NOT_A_PICTURE);
  if (kind === 'svg') { const canvas = await decodeSvg(bytes, limits, scale, fitMP); return { canvas, kind, frames: 1, scale: canvas.svgScale }; }
  if (kind === 'tiff') return { canvas: decodeTiff(bytes, limits), kind, frames: 1 };
  const size = headerSize(bytes, kind);
  if (!size) throw new UserError(DAMAGED);
  checkSize(size.width, size.height, limits);
  if (kind === 'heic') return { canvas: await decodeHeic(bytes, limits), kind, frames: 1 };
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' }); } catch { throw new UserError(DAMAGED); }
  try {
    checkSize(bmp.width, bmp.height, limits);
    const [c, ctx] = newCanvas(bmp.width, bmp.height, kind === 'jpg');
    ctx.drawImage(bmp, 0, 0);
    return { canvas: c, kind, frames: kind === 'gif' ? gifFrames(bytes) : 1 };
  } finally { bmp.close(); }
}

/**
 * A picture already fitted inside maxSide, for previews and thumbnails: large photos are scaled while decoding
 * (createImageBitmap's resize), so a 108 MP photo never needs a full-size canvas. Animated pictures give a frame
 * that shows something (the first one, or a later one when the first is blank). → {canvas, width, height} (original size).
 */
export async function decodeFitted(bytes, limits, maxSide) {
  const kind = sniff(bytes);
  if (!kind) throw new UserError(NOT_A_PICTURE);
  const size = headerSize(bytes, kind);
  const plain = ['jpg', 'png', 'webp', 'bmp', 'gif', 'ico'].includes(kind) && size;
  if (!plain) { const { canvas } = await decode(bytes, limits); return { canvas: fit(canvas, maxSide), width: canvas.width, height: canvas.height }; }
  checkSize(size.width, size.height, limits);
  if ((kind === 'gif' || kind === 'webp' || kind === 'png') && typeof ImageDecoder !== 'undefined') {
    const still = await animatedStill(bytes, kind, maxSide);
    if (still) return still;
  }
  const k = Math.min(1, maxSide / Math.max(size.width, size.height));
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes]), k < 1 ? { imageOrientation: 'from-image', resizeWidth: Math.max(1, Math.round(size.width * k)), resizeHeight: Math.max(1, Math.round(size.height * k)), resizeQuality: 'high' } : { imageOrientation: 'from-image' });
  } catch { throw new UserError(DAMAGED); }
  try {
    // EXIF rotation can swap the sides: fit what came back.
    const [c, ctx] = newCanvas(bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const turned = kind === 'jpg' && jpegOrientation(bytes) >= 5;
    return { canvas: fit(c, maxSide), width: turned ? size.height : size.width, height: turned ? size.width : size.height };
  } finally { bmp.close(); }
}

/** Is a frame blank (all transparent, or one flat colour all over, seen on white)? Read from a small copy. */
function blankFrame(c) {
  const t = fit(c, 32), d = pixels(t);
  return !showsSomething(d.data, d.width, d.height);
}

/** A decoded frame's pixels read on the CPU (copyTo), not drawn from the video frame; drawImage only as a fallback. */
async function frameCanvas(image) {
  const w = image.displayWidth, h = image.displayHeight;
  try {
    const buf = new Uint8ClampedArray(w * h * 4);
    await image.copyTo(buf, { format: 'RGBA', colorSpace: 'srgb' });
    return fromImageData(new ImageData(buf, w, h));
  } catch {
    const [c, ctx] = newCanvas(w, h);
    ctx.drawImage(image, 0, 0);
    return c;
  }
}

/**
 * The first frame of an animated GIF/WebP/APNG that shows something, fitted, laid on white (QA round 8). GIFs are
 * read by the app itself (gif-decode.js: transparency and disposal composed frame by frame), so every computer
 * shows the same still; WebP and APNG frames come from WebCodecs' ImageDecoder, read back pixel by pixel.
 */
async function animatedStill(bytes, kind, maxSide) {
  if (kind === 'gif') {
    if (gifFrames(bytes) < 2) return null;
    try {
      const r = firstVisibleGif(bytes);
      return { canvas: fit(fromImageData(new ImageData(onWhite(r.data), r.width, r.height)), maxSide), width: r.width, height: r.height };
    } catch { /* not readable here: the browser's decoder below */ }
  }
  const type = { gif: 'image/gif', webp: 'image/webp', png: 'image/png' }[kind];
  let dec;
  try {
    dec = new ImageDecoder({ data: bytes, type });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack ? dec.tracks.selectedTrack.frameCount : 1;
    if (n < 2) return null;
    let first = null;
    for (const i of [0, 1, Math.floor(n / 4), Math.floor(n / 2)].filter((x, k, a) => x < n && a.indexOf(x) === k)) {
      const { image } = await dec.decode({ frameIndex: i });
      try {
        const f = fit(flatten(await frameCanvas(image)), maxSide);
        if (!first) first = { canvas: f, width: image.displayWidth, height: image.displayHeight };
        if (!blankFrame(f)) return { canvas: f, width: image.displayWidth, height: image.displayHeight };
      } finally { image.close(); }
    }
    return first;
  } catch { return null; } finally { try { dec && dec.close(); } catch { /* closed */ } }
}

function decodeTiff(bytes, limits) {
  const U = self.UTIF;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let ifd;
  try { ifd = U.decode(buf).find((x) => x.t256 && x.t257); } catch { /* reported below */ }
  if (!ifd) throw new UserError(DAMAGED);
  const w = ifd.t256[0], h = ifd.t257[0];
  checkSize(w, h, limits);
  let rgba;
  try { U.decodeImage(buf, ifd); rgba = U.toRGBA8(ifd); } catch { throw new UserError('This TIFF image could not be read. It may be damaged or use an unusual compression.'); }
  if (!rgba || rgba.length < w * h * 4) throw new UserError(DAMAGED);
  return fromImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h));
}

async function decodeHeic(bytes, limits) {
  const lib = await libheif();
  let images = [];
  try { images = new lib.HeifDecoder().decode(bytes) || []; } catch { /* reported below */ }
  if (!images.length) throw new UserError('This HEIC photo could not be read. It may be damaged.');
  try {
    const img = images.find((i) => i.is_primary()) || images[0];
    const w = img.get_width(), h = img.get_height();
    checkSize(w, h, limits);
    const data = new ImageData(w, h);
    await new Promise((resolve, reject) => img.display(data, (d) => (d ? resolve() : reject(new UserError('This HEIC photo could not be read. It may be damaged.')))));
    return fromImageData(data);
  } finally { for (const i of images) i.free(); }
}

const SVG_UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
/** An SVG's size from its root element: width/height, else its viewBox, else the browser default 300 × 150. */
function svgSize(text) {
  const root = (/<svg\b[^>]*>/i.exec(text) || [''])[0];
  const attr = (n) => (new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root) || [])[1];
  const len = (v) => { const m = /^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v || ''); return m ? Number(m[1]) * SVG_UNITS[(m[2] || '').toLowerCase()] : 0; };
  const vb = (attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const ratio = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : 0;
  let w = len(attr('width')), h = len(attr('height'));
  if (!w && !h && ratio) { w = vb[2]; h = vb[3]; }
  if (w && !h) h = ratio ? w / ratio : 150;
  if (h && !w) w = ratio ? h * ratio : 300;
  return { width: w || 300, height: h || 150 };
}

async function decodeSvg(bytes, limits, scale, fitMP = 0) {
  const text = new TextDecoder().decode(bytes);
  if (/<!ENTITY/i.test(text)) throw new UserError('This SVG uses XML entities, which aren’t supported.');
  const size = svgSize(text);
  // `fitMP`: enlarge by `scale` only as far as that many megapixels (and the size limits) allow, never below 1×.
  if (fitMP > 0) scale = Math.max(1, Math.min(scale, Math.sqrt((fitMP * 1e6) / (size.width * size.height)), limits.side / Math.max(size.width, size.height)));
  const w = Math.max(1, Math.round(size.width * scale)), h = Math.max(1, Math.round(size.height * scale));
  checkSize(w, h, limits);
  // Drawn through <img>: scripts never run and nothing outside the file is loaded.
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new UserError('This SVG could not be drawn. It may be damaged.'); }
    const [c, ctx] = newCanvas(w, h);
    ctx.drawImage(img, 0, 0, w, h);
    c.svgScale = scale;
    return c;
  } finally { URL.revokeObjectURL(url); }
}

// ------------------------------------------------------------------ helpers
const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);

/** Does any pixel have transparency? Scans in strips and stops at the first one. */
export function hasAlpha(c) {
  const ctx = c.getContext('2d');
  const strip = Math.max(1, Math.floor(4e6 / c.width));
  for (let y = 0; y < c.height; y += strip) {
    const d = ctx.getImageData(0, y, c.width, Math.min(strip, c.height - y)).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  }
  return false;
}

/** The picture on an opaque background (for formats without transparency). An opaque canvas is used as it is. */
function flatten(c, color = '#ffffff') {
  if (c.opaque) return c;
  const [out, ctx] = newCanvas(c.width, c.height, true);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

/** Fit within maxSide (never enlarging). */
function fit(c, maxSide) {
  const k = Math.min(1, maxSide / Math.max(c.width, c.height));
  if (k === 1) return c;
  const [out, ctx] = newCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  ctx.drawImage(c, 0, 0, out.width, out.height);
  return out;
}

export async function blobBytes(c, type, quality) {
  return new Uint8Array(await (await c.convertToBlob({ type, quality })).arrayBuffer());
}

/** Encode a canvas as jpg, png, webp, bmp, tiff, gif or ico. `quality` (0–1) applies to JPEG and WebP. */
export async function encode(c, to, quality = 0.9) {
  switch (to) {
    // A picture without transparency is saved without an alpha channel (RGB PNG and TIFF; QA round 7).
    case 'png': return c.opaque || !hasAlpha(c) ? encodeRgb(c) : blobBytes(c, 'image/png');
    case 'jpg': return blobBytes(flatten(c), 'image/jpeg', quality);
    case 'webp': return blobBytes(c, 'image/webp', quality);
    case 'bmp': return encodeBmp(pixels(flatten(c)));
    case 'tiff': return encodeTiff(pixels(c), !c.opaque && hasAlpha(c));
    case 'gif': return encodeGif(pixels(c), hasAlpha(c));
    case 'ico': return encodeIco(c, ICO_SIZES);
    default: throw new UserError('This image format can’t be written.');
  }
}

// ------------------------------------------------------------------ operations
/** Convert one image. For AVIF/HEIC the main process asks for a PNG and finishes the job. */
export async function convert({ bytes, to, quality, limits, scale = 1, fitMP = 0 }) {
  const { canvas, scale: used } = await decode(bytes, limits, { scale, fitMP });
  const alpha = to === 'png' ? !canvas.opaque && hasAlpha(canvas) : undefined;
  const out = { bytes: await encode(canvas, to, quality), width: canvas.width, height: canvas.height, alpha, scale: used || 1 };
  canvas.width = canvas.height = 0; // let a large picture's memory go now
  return out;
}

/**
 * An animated WebP or APNG → an animated GIF: every frame (WebCodecs' ImageDecoder composes them) with its delay,
 * looping as the source does. At most 2000 frames and 2 gigapixels in all.
 */
export async function animate({ bytes, to, limits }) {
  if (to !== 'gif') throw new UserError('This format can’t be animated here.');
  const kind = sniff(bytes);
  const size = kind && headerSize(bytes, kind);
  if (!size) throw new UserError(NOT_A_PICTURE);
  checkSize(size.width, size.height, limits);
  const dec = new ImageDecoder({ data: bytes, type: kind === 'png' ? 'image/png' : 'image/webp' });
  try {
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    const n = track ? track.frameCount : 1;
    if (n > 2000 || n * size.width * size.height > 2e9) throw new UserError('This animation is too long or too large to turn into a GIF.');
    const gif = GIFEncoder();
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      try {
        const [c, ctx] = newCanvas(image.displayWidth, image.displayHeight);
        ctx.drawImage(image, 0, 0);
        const d = pixels(c);
        const alpha = hasAlpha(c);
        const format = alpha ? 'rgba4444' : 'rgb565';
        const palette = quantize(d.data, 256, alpha ? { format, oneBitAlpha: true } : { format });
        const index = applyPalette(d.data, palette, format);
        const clear = alpha ? palette.findIndex((p) => p[3] === 0) : -1;
        const delay = Math.max(20, Math.round((image.duration || 100000) / 1000));
        gif.writeFrame(index, d.width, d.height, { palette, delay, repeat: i === 0 ? (track.repetitionCount === Infinity ? 0 : Math.max(0, Math.round(track.repetitionCount || 0))) : undefined, transparent: clear >= 0, transparentIndex: Math.max(0, clear), dispose: alpha ? 2 : -1 });
      } finally { image.close(); }
    }
    gif.finish();
    return { bytes: gif.bytes(), frames: n };
  } finally { try { dec.close(); } catch { /* closed */ } }
}

/** Frames in a GIF without decoding any pixels (1 for other pictures). */
export async function frames({ bytes }) {
  return { frames: sniff(bytes) === 'gif' ? gifFrames(bytes) : 1 };
}

export async function info({ bytes, limits }) {
  const { canvas, kind, frames } = await decode(bytes, limits);
  return { width: canvas.width, height: canvas.height, kind, frames };
}

/** A small preview (WebP keeps transparency) and the picture's full size. Large photos are scaled while decoding. */
export async function preview({ bytes, maxSide, limits }) {
  const { canvas, width, height } = await decodeFitted(bytes, limits, maxSide);
  return { bytes: await blobBytes(canvas, 'image/webp', 0.85), mime: 'image/webp', width, height };
}

/** Read a QR code, trying the full picture, then a smaller copy (large photos are often easier that way). */
export async function readQR({ bytes, limits }) {
  const { canvas } = await decode(bytes, limits);
  // Every code in the picture (src/processor/qr-scan.js); then, for one code that is very large or soft, smaller sizes.
  const first = fit(flatten(canvas), 1600);
  // Small pictures (a sharp 33 × 33 px code) are enlarged pixel for pixel first (QA round 8).
  const { codes, finders, edge } = scanPicture(pixels(first), self.jsQR);
  if (codes.length) return { text: codes[0].text, codes: codes.map((c) => c.text), finders };
  for (const side of [800, 400]) {
    if (Math.max(canvas.width, canvas.height) <= side) break;
    const c = fit(flatten(canvas), side);
    const d = pixels(c);
    const code = self.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) return { text: code.data, codes: [code.data], finders };
  }
  return { text: null, codes: [], finders, edge };
}
