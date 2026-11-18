// PDF reading (pdf.js) and writing (pdf-lib) in the sandbox: page counts, page pictures, text, and
// pictures → PDF. Only the pages asked for are rendered, so long documents are handled in chunks.
import { UserError } from './errors.js';
import { decode, encode, hasAlpha, blobBytes } from './image.js';
import { sniff, headerSize, jpegOrientation, jpegComponents, stripJpegMetadata } from './image-header.js';
import { pageLayout, drawScanned, MAX_PDF_IMAGES } from '../shared/compose.mjs';

export const MAX_PAGES = 2000; // bank statements; conversions pass LIMITS.pdfPages from the main process

let lib = null;
export async function pdfjs() {
  if (!lib) {
    lib = await import('./vendor/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return lib;
}

export async function closeJs(doc) {
  if (!doc) return;
  try { await doc.destroy(); } catch { /* closed */ }
  try { if (doc.__task) await doc.__task.destroy(); } catch { /* closed */ }
}

/** Open a PDF with pdf.js, with plain-English errors. The caller closes it with closeJs. */
async function openPdf(bytes, maxPages, password) {
  const pdf = await pdfjs();
  const task = pdf.getDocument({
    data: bytes.slice(), password: password || undefined, isEvalSupported: false, enableXfa: false, useSystemFonts: false,
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true, stopAtErrors: false,
  });
  let doc;
  try { doc = await task.promise; } catch (e) {
    try { await task.destroy(); } catch { /* closed */ }
    if (e && e.name === 'PasswordException') throw new UserError(password ? 'That password didn’t work.' : 'This PDF is password-protected.');
    throw new UserError('This PDF could not be read. It may be damaged.');
  }
  doc.__task = task;
  if (doc.numPages > maxPages) { const n = doc.numPages; await closeJs(doc); throw new UserError(tooManyPages(n, maxPages)); }
  return doc;
}

/** The one wording for the page limit, wherever it applies. */
export const tooManyPages = (n, max) => `Too many pages (${n} — the limit is ${max}).`;

/** `password` (optional) opens a password-protected PDF; it is only used for this call. */
export async function withPdf(bytes, limits, fn, password) {
  const doc = await openPdf(bytes, limits.pages, password);
  try { return await fn(doc); } finally { await closeJs(doc); }
}

export const info = ({ bytes, limits, password }) => withPdf(bytes, limits, async (doc) => ({ pages: doc.numPages }), password);

/**
 * One page (as seen, after its /Rotate) on white at k px per point (1 = 72 dpi), limited so it never exceeds the
 * image limits. Returns an OffscreenCanvas; the caller frees it.
 */
export async function drawPage(page, k, limits) {
  const base = page.getViewport({ scale: 1 });
  k = Math.min(k, 8000 / Math.max(base.width, base.height), Math.sqrt((limits.mp * 1e6) / (base.width * base.height)));
  const viewport = page.getViewport({ scale: k });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, viewport, background: '#ffffff' }).promise;
  const off = new OffscreenCanvas(canvas.width, canvas.height);
  off.getContext('2d').drawImage(canvas, 0, 0);
  canvas.width = canvas.height = 0;
  return off;
}

/**
 * Render pages first..last (1-based) as JPEG or PNG on white. Size: `maxSide` px for the longest side, or
 * `scale` (1 = 72 dpi), limited so a page never exceeds the image limits.
 */
export function render({ bytes, first, last, format, quality, maxSide, scale = 2, limits, password }) {
  return withPdf(bytes, limits, async (doc) => {
    const out = [];
    for (let n = Math.max(1, first); n <= Math.min(last, doc.numPages); n++) {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const off = await drawPage(page, maxSide ? maxSide / Math.max(base.width, base.height) : scale, limits);
        out.push({ page: n, bytes: await blobBytes(off, format === 'png' ? 'image/png' : 'image/jpeg', quality), width: off.width, height: off.height });
        off.width = off.height = 0;
      } finally { page.cleanup(); }
    }
    return { pages: out };
  }, password);
}

// ------------------------------------------------------------------ text
/** Text items of a page as lines, top to bottom: [{y, size, text}]. */
function pageLines(content) {
  const items = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const [, , c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || it.height || 10;
    items.push({ x, y, size, end: x + (it.width || 0), text: it.str });
  }
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) <= Math.min(line.size, it.size) * 0.5) { line.items.push(it); line.size = Math.max(line.size, it.size); }
    else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let text = '';
    for (let i = 0; i < l.items.length; i++) {
      const it = l.items[i], prev = l.items[i - 1];
      if (prev && !/\s$/.test(text) && !/^\s/.test(it.text) && it.x - prev.end > it.size * 0.2) text += ' ';
      text += it.text;
    }
    return { y: l.y, size: l.size, text: text.replace(/\s+/g, ' ').trim() };
  });
}

/** Lines joined into paragraphs: a bigger gap or a change of text size starts a new one. Big text is a heading. */
function paragraphs(lines) {
  if (!lines.length) return [];
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)];
  const out = [];
  let cur = null, prev = null;
  for (const l of lines) {
    const sameSize = prev && Math.abs(l.size - prev.size) <= Math.max(1, prev.size * 0.15);
    if (cur && sameSize && prev.y - l.y <= prev.size * 1.75) {
      cur.text = /[a-z]-$/.test(cur.text) && /^[a-z]/.test(l.text) ? cur.text.slice(0, -1) + l.text : cur.text + ' ' + l.text;
    } else {
      cur = { text: l.text, heading: l.size >= body * 1.3 && l.text.length < 200 };
      out.push(cur);
    }
    prev = l;
  }
  return out;
}

/** Paragraphs of every page: [[{text, heading}]]. A PDF without any text (a scan) is refused. */
async function readParagraphs(doc) {
  const pages = [];
  let chars = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    try {
      const paras = paragraphs(pageLines(await page.getTextContent()));
      chars += paras.reduce((k, p) => k + p.text.length, 0);
      pages.push(paras);
    } finally { page.cleanup(); }
  }
  if (!chars) throw new UserError('This PDF has no text to copy. It looks like a scanned document.');
  return pages;
}

export const text = ({ bytes, limits }) => withPdf(bytes, limits, async (doc) => ({
  text: (await readParagraphs(doc)).map((paras) => paras.map((p) => p.text).join('\n\n')).filter(Boolean).join('\n\n') + '\n',
}));

export const paragraphsOf = ({ bytes, limits }) => withPdf(bytes, limits, readParagraphs);

// ------------------------------------------------------------------ pictures → PDF
const MAX_PT = 14400; // the largest page size PDF readers accept

/**
 * Embed one picture: JPEGs as they are (without their metadata) when that shows them correctly, PNGs as they
 * are, everything else re-encoded (PNG if it has transparency, otherwise JPEG). Returns {img, width, height} in px.
 */
async function embedImage(pdf, bytes, quality, limits) {
  const kind = sniff(bytes);
  const size = (kind === 'jpg' || kind === 'png') && headerSize(bytes, kind);
  if (size && size.width * size.height <= limits.mp * 1e6 && Math.max(size.width, size.height) <= limits.side) {
    try {
      if (kind === 'png') return sized(await pdf.embedPng(bytes));
      if (jpegOrientation(bytes) === 1 && [1, 3].includes(jpegComponents(bytes))) return sized(await pdf.embedJpg(stripJpegMetadata(bytes)));
    } catch { /* unusual encoding: re-encode below */ }
  }
  const { canvas } = await decode(bytes, limits, { scale: 2 }); // SVGs are drawn at twice their size, for sharpness
  const img = hasAlpha(canvas) ? await pdf.embedPng(await encode(canvas, 'png')) : await pdf.embedJpg(await encode(canvas, 'jpg', quality));
  const s = kind === 'svg' ? 2 : 1;
  return { img, width: canvas.width / s, height: canvas.height / s };
}
const sized = (img) => ({ img, width: img.width, height: img.height });

/** Why a picture was left out of a PDF, in a few words ("fake.jpg isn’t a picture"). */
export function skipReason(e) {
  const m = String((e && e.message) || '');
  if (/isn’t a picture/.test(m)) return 'isn’t a picture';
  if (/too large/.test(m)) return 'is too large';
  if (/password/i.test(m)) return 'is password-protected';
  return 'couldn’t be read (it may be damaged)';
}

/**
 * One page per picture, each page the picture's size (at 96 dpi), in the given order. With `skipBad`, pictures
 * that can't be read are left out ({skipped: [{index, reason}]}); it fails only when none can be read.
 */
export async function imagesToPdf({ images, quality, limits, skipBad = false }) {
  const pdf = await self.PDFLib.PDFDocument.create();
  pdf.setCreator('DropDial');
  pdf.setProducer('DropDial');
  const skipped = [];
  let first = null;
  for (const [index, bytes] of images.entries()) {
    let one;
    try { one = await embedImage(pdf, bytes, quality, limits); } catch (e) {
      if (!skipBad || !(e && e.user)) throw e;
      first = first || e;
      skipped.push({ index, reason: skipReason(e) });
      images[index] = null;
      continue;
    }
    images[index] = null;
    const { img, width, height } = one;
    let w = width * 0.75, h = height * 0.75;
    const k = Math.min(1, MAX_PT / Math.max(w, h));
    w = Math.max(1, w * k); h = Math.max(1, h * k);
    pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  if (!pdf.getPageCount()) { if (skipBad && first) return { bytes: null, skipped }; throw first || new UserError('None of these pictures could be read.'); } // main names them
  return { bytes: await pdf.save(), skipped };
}

/** A picture with the "Scan look" (clean black on white), embedded as PNG. Size reported as the original's. */
async function embedScanned(pdf, bytes, limits) {
  const kind = sniff(bytes);
  const s = kind === 'svg' ? 2 : 1;
  const { canvas } = await decode(bytes, limits, { scale: s });
  const scanned = drawScanned(canvas, canvas.width, canvas.height);
  const img = await pdf.embedPng(await encode(scanned, 'png'));
  const out = { img, width: canvas.width / s, height: canvas.height / s };
  canvas.width = canvas.height = scanned.width = scanned.height = 0;
  return out;
}

/**
 * Images to PDF (the tool): one page per picture in the given order, laid out with pageLayout — the same maths
 * as the window's preview. o: {page, orientation, margin (mm), scan}.
 */
export async function fromImages({ images, o, quality, limits, skipBad = false }) {
  if (!Array.isArray(images) || !images.length) throw new UserError('Choose at least one picture.');
  if (images.length > MAX_PDF_IMAGES) throw new UserError(`A PDF can have up to ${MAX_PDF_IMAGES} pictures here. Make two PDFs instead.`);
  const pdf = await self.PDFLib.PDFDocument.create();
  pdf.setCreator('DropDial');
  pdf.setProducer('DropDial');
  const skipped = [];
  for (let i = 0; i < images.length; i++) {
    let one;
    // With `skipBad`, a picture that can't be read is left out (and reported) instead of stopping the PDF.
    try { one = o.scan ? await embedScanned(pdf, images[i], limits) : await embedImage(pdf, images[i], quality, limits); } catch (e) {
      if (!skipBad || !(e && e.user)) throw e;
      skipped.push({ index: i, reason: skipReason(e) });
      images[i] = null;
      continue;
    }
    const { img, width, height } = one;
    images[i] = null;
    const L = pageLayout(width, height, o);
    pdf.addPage([L.pw, L.ph]).drawImage(img, { x: L.x, y: L.ph - L.y - L.h, width: L.w, height: L.h });
  }
  if (!pdf.getPageCount()) return { bytes: null, skipped, pages: 0 };
  return { bytes: await pdf.save(), pages: pdf.getPageCount(), skipped };
}
