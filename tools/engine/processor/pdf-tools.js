// PDF tools in the sandbox (phase 5): combine, split, arrange, shrink, page numbers and watermark. Writing is done
// with pdf-lib; pages are read and rendered with pdf.js (page sizes, Strong shrink). Layout maths comes from
// src/shared/pdftools.mjs, the same code the windows use for their previews.
//
// New documents only ever receive copies of the pages asked for (links between pages are cut first, so a copied
// page can't drag the rest of the original along), and unreachable objects are dropped before saving: a page
// that was left out or deleted is really gone from the file.
import { UserError } from './errors.js';
import { blobBytes } from './image.js';
import { withPdf, drawPage, tooManyPages } from './pdf.js';
import { isEncrypted, openEncrypted } from './pdf-crypt.js';
import * as T from '../shared/pdftools.mjs';

const lib = () => self.PDFLib;
const SAVE = { useObjectStreams: true, addDefaultPage: false };
const MAX_PT = 14400;
const who = (name) => (name ? `“${name}”` : 'This PDF');

// The PDF tool windows ask for the password before Save is possible, so this is mostly seen from Make smaller.
const locked = (name, wrong) => Object.assign(new UserError(wrong ? `That password didn’t work for ${who(name).replace(/^This PDF$/, 'this PDF')}.` : `${who(name)} is password-protected. Use Shrink PDF, which asks for the password.`), { locked: true });

/**
 * Open a PDF with pdf-lib, with plain-English errors naming the file. A password-protected PDF is decrypted first
 * with `password` (the empty password opens files that only carry restrictions, as Preview does); the new PDF
 * never has a password.
 */
export async function loadDoc(bytes, name, limits, password) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new UserError(`${who(name)} is empty.`);
  let doc = null, n = 0;
  try {
    if (isEncrypted(bytes)) {
      const r = await openEncrypted(bytes, password || '');
      if (r && r.unsupported) throw new UserError(r.unsupported);
      if (r && r.needPassword) throw locked(name, r.wrongPassword);
      if (r) doc = r.doc;
    }
    if (!doc) doc = await lib().PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    n = doc.getPageCount();
  } catch (e) {
    if (e && e.user) throw e;
    if (/encrypt/i.test(String(e && e.message))) throw locked(name);
    throw new UserError(`${who(name)} could not be read. It may be damaged.`);
  }
  if (!n) throw new UserError(`${who(name)} could not be read. It may be damaged.`);
  if (n > limits.pages) throw new UserError(`${name ? who(name) + ': ' : ''}${tooManyPages(n, limits.pages)}`);
  return doc;
}

async function newDoc(from) {
  const doc = await lib().PDFDocument.create();
  doc.setCreator('DropDial');
  doc.setProducer('DropDial');
  if (from) {
    try { const t = from.getTitle(); if (t) doc.setTitle(t); const a = from.getAuthor(); if (a) doc.setAuthor(a); } catch { /* no details */ }
  }
  return doc;
}

/** Remove links that point at other pages (and annotations' page back-references) before copying pages. */
function cutPageLinks(doc) {
  const { PDFName, PDFDict } = lib();
  const P = PDFName.of('P'), DEST = PDFName.of('Dest'), A = PDFName.of('A'), S = PDFName.of('S');
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      a.delete(P);
      a.delete(DEST);
      const act = a.lookup(A);
      if (act instanceof PDFDict && /GoTo$/.test(String(act.get(S)))) a.delete(A);
    }
  }
}

/** Drop every object the document no longer reaches from its catalog or info. Returns how many were dropped. */
function prune(doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = lib();
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      const k = v.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      const o = ctx.lookup(v);
      if (o) stack.push(o);
    } else if (v instanceof PDFDict) { for (const [, x] of v.entries()) stack.push(x); }
    else if (v instanceof PDFArray) { for (const x of v.asArray()) stack.push(x); }
    else if (v instanceof PDFStream) stack.push(v.dict);
  }
  let n = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) { ctx.delete(ref); n++; }
  return n;
}

/** Light tidy-ups: page thumbnails, editor-private data (PieceInfo) and XMP metadata streams. */
function stripBloat(doc) {
  const { PDFName } = lib();
  const keys = ['PieceInfo', 'Thumb', 'Metadata'].map((k) => PDFName.of(k));
  for (const page of doc.getPages()) for (const k of keys) page.node.delete(k);
  for (const k of [keys[0], keys[2]]) doc.catalog.delete(k);
}

/** Compress streams stored without any compression. */
function deflateLoose(doc) {
  const { PDFRawStream, PDFName } = lib();
  const FILTER = PDFName.of('Filter'), PARMS = PDFName.of('DecodeParms');
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 512 || obj.dict.has(FILTER) || obj.dict.has(PARMS)) continue;
    const z = self.pako.deflate(obj.contents);
    if (z.length > obj.contents.length * 0.9) continue;
    obj.dict.set(FILTER, PDFName.of('FlateDecode'));
    ctx.assign(ref, PDFRawStream.of(obj.dict, z));
  }
}

/** Add copies of `indices` (0-based, may repeat) of `src` to `out`, in order. */
async function copyInto(out, src, indices) {
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  return pages;
}

const finish = async (doc) => { prune(doc); return doc.save(SAVE); };

// ------------------------------------------------------------------ page sizes (windows)
/**
 * {pages, sizes: [[w, h]]}: each page's size as seen (after /Rotate), in points. A password-protected PDF answers
 * {needPassword, wrongPassword} until `password` opens it; an encrypted PDF also says `encrypted` and what it asks
 * apps not to allow (`restricted`: ['printing', 'editing', 'copying']).
 */
export async function layout({ bytes, limits, password }) {
  let encrypted = false, restricted = [], unlocked = false;
  if (isEncrypted(bytes)) {
    let r = null;
    try { r = await openEncrypted(bytes, password || ''); } catch { r = null; }
    if (r && r.unsupported) throw new UserError(r.unsupported);
    if (r && r.needPassword) return { needPassword: true, wrongPassword: !!r.wrongPassword };
    if (r) { encrypted = true; restricted = r.restricted; unlocked = !!password; }
  }
  return withPdf(bytes, limits, async (doc) => {
    const sizes = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view;
      const w = Math.round(Math.abs(x1 - x0) * 100) / 100, h = Math.round(Math.abs(y1 - y0) * 100) / 100;
      sizes.push(page.rotate % 180 ? [h, w] : [w, h]);
    }
    return { pages: doc.numPages, sizes, encrypted, restricted, unlocked };
  }, encrypted ? password || '' : undefined);
}

// ------------------------------------------------------------------ Combine PDFs
/**
 * files: [bytes], ranges: [text | null] (empty = every page), names: [file name]. With `skipBad`, a PDF that can't be
 * read (damaged, or over the page limit) is left out and named in `skipped` ([{index, reason}]); the others are
 * combined (QA round 8). A password-protected PDF is never skipped: the window asks for its password first.
 */
export async function merge({ files, ranges, names, passwords = [], limits, skipBad = false }) {
  if (!Array.isArray(files) || files.length < 2) throw new UserError('Choose at least two PDFs.');
  const out = await newDoc();
  let total = 0;
  const skipped = [];
  for (let i = 0; i < files.length; i++) {
    let src;
    try { src = await loadDoc(files[i], names[i], limits, passwords[i]); } catch (e) {
      if (!skipBad || !(e && e.user) || e.locked) throw e;
      const many = /too many pages \((\d[\d,]*) — the limit is (\d[\d,]*)\)/i.exec(String(e.message));
      skipped.push({ index: i, reason: many ? `has too many pages (${many[1]} — the limit is ${many[2]})` : /empty/.test(String(e.message)) ? 'is empty' : 'couldn’t be read' });
      files[i] = null;
      continue;
    }
    files[i] = null;
    const r = T.parseRanges(ranges[i] || '', src.getPageCount(), { allowEmpty: true, reverse: true });
    if (r.error) throw new UserError(`${names[i]}: ${r.error}`);
    const idx = T.pageList(r.ranges).map((p) => p - 1);
    total += idx.length;
    if (total > limits.pages) throw new UserError(`The combined PDF would have more than ${limits.pages} pages.`);
    cutPageLinks(src);
    await copyInto(out, src, idx);
  }
  if (skipped.length === files.length) return { bytes: null, pages: 0, skipped };
  return { bytes: await finish(out), pages: out.getPageCount(), skipped };
}

// ------------------------------------------------------------------ Split PDF
const BATCH_PAGES = 300, BATCH_PARTS = 40;
/**
 * Plan the split (o: {mode, every, ranges}) and make parts `from`.. in one batch (bounded by pages and parts).
 * Returns {total, labels (all parts), parts: [{index, bytes}], next} — call again with from = next until next = total.
 */
export async function split({ bytes, o, from = 0, limits, password }) {
  const src = await loadDoc(bytes, null, limits, password);
  const plan = T.planSplit(src.getPageCount(), o);
  if (plan.error) throw new UserError(plan.error);
  cutPageLinks(src);
  const parts = [];
  let i = from, pages = 0;
  for (; i < plan.parts.length && parts.length < BATCH_PARTS && (pages < BATCH_PAGES || !parts.length); i++) {
    const p = plan.parts[i];
    const doc = await newDoc(src);
    const list = T.pageList([p]).map((n) => n - 1); // a backwards range makes a part with its pages reversed
    await copyInto(doc, src, list);
    parts.push({ index: i, bytes: await finish(doc) });
    pages += list.length;
  }
  return { total: plan.parts.length, labels: plan.parts.map((p) => p.label), parts, next: i };
}

// ------------------------------------------------------------------ Arrange pages
/** pages: [{src (0-based, or -1 for a blank page), rotate, w?, h?}] — the new document, in order. */
export async function arrange({ bytes, pages, limits, password }) {
  const { degrees } = lib();
  const src = await loadDoc(bytes, null, limits, password);
  const n = src.getPageCount();
  if (!Array.isArray(pages) || !pages.length) throw new UserError('Keep at least one page.');
  if (pages.some((p) => p.src >= n)) throw new UserError('The PDF changed since the window was opened. Open Arrange pages again.');
  cutPageLinks(src);
  const out = await newDoc(src);
  const copied = await out.copyPages(src, pages.filter((p) => p.src >= 0).map((p) => p.src));
  let k = 0;
  for (const p of pages) {
    if (p.src < 0) { out.addPage([Math.min(MAX_PT, Math.max(1, p.w)), Math.min(MAX_PT, Math.max(1, p.h))]); continue; }
    const page = copied[k++];
    out.addPage(page);
    if (p.rotate) page.setRotation(degrees(T.rotateBy(page.getRotation().angle, p.rotate)));
  }
  return { bytes: await finish(out), pages: out.getPageCount() };
}

// ------------------------------------------------------------------ Shrink PDF
async function lightShrink(bytes, limits, password) {
  const doc = await loadDoc(bytes, null, limits, password);
  stripBloat(doc);
  deflateLoose(doc);
  doc.setProducer('DropDial');
  return finish(doc);
}

/** Shrink PDF's estimate for Light (QA round 7): the size of the tidied file, without sending it back. */
export async function tidySize({ bytes, limits, password }) {
  return { size: (await lightShrink(bytes, limits, password)).length };
}

/** Every page as a JPEG at `dpi`, one page at a time (only one page picture is in memory at once). */
async function strongShrink(bytes, dpi, quality, limits, password) {
  const out = await newDoc();
  await withPdf(bytes, limits, async (doc) => {
    try { const { info } = await doc.getMetadata(); if (info && typeof info.Title === 'string' && info.Title) out.setTitle(info.Title.slice(0, 500)); } catch { /* none */ }
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const off = await drawPage(page, dpi / 72, limits);
        const jpg = await blobBytes(off, 'image/jpeg', quality);
        off.width = off.height = 0;
        const img = await out.embedJpg(jpg);
        const w = Math.min(MAX_PT, base.width), h = Math.min(MAX_PT, base.height);
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      } finally { page.cleanup(); }
    }
  }, password || (isEncrypted(bytes) ? '' : undefined));
  return out.save(SAVE);
}

/**
 * o: {level: 'light' | 'strong', dpi, targetBytes (0 = none), soft (pages may go below 150 dpi to reach the target),
 * keepText (pictures only when clearly smaller than the tidied file)}. With a target, Light is tried first, then
 * Strong steps from the chosen sharpness down to the floor until the file fits (T.shrinkSteps). The kept result is
 * chosen by T.pickShrink: {bytes, method, dpi?, quality?, fit, smallest?: {bytes, dpi} (the smallest picture try)}.
 */
export async function shrink({ bytes, o, limits, password }) {
  const target = o.targetBytes || 0;
  let light = null, strong = null;
  if (o.level === 'light' || target || o.keepText) {
    light = { bytes: await lightShrink(bytes, limits, password), method: 'light' };
    if (!target && o.level === 'light') return { ...light, fit: true };
    if (target && light.bytes.length <= target) return { ...light, fit: true };
  }
  const keep = (r) => { if (!strong || r.bytes.length < strong.bytes.length) strong = r; return r; };
  if (!target) keep({ bytes: await strongShrink(bytes, o.dpi, T.SHRINK_QUALITY, limits, password), method: 'strong', dpi: o.dpi, quality: T.SHRINK_QUALITY });
  else {
    const steps = T.shrinkSteps(o.dpi, { soft: !!o.soft });
    for (let s = steps[0]; s; ) {
      const r = keep({ bytes: await strongShrink(bytes, s[0], s[1], limits, password), method: 'strong', dpi: s[0], quality: s[1] });
      if (r.bytes.length <= target) break;
      s = T.nextShrinkStep(steps, s, r.bytes.length, target);
    }
  }
  const size = (r) => (r ? r.bytes.length : null);
  const { pick, fit } = T.pickShrink({ level: o.level, target, keepText: !!o.keepText }, size(light), size(strong));
  const out = pick === 'light' && light ? light : strong;
  return { ...out, fit, smallest: strong && out !== strong ? { bytes: strong.bytes.length, dpi: strong.dpi } : null };
}

// ------------------------------------------------------------------ page numbers and watermark
function hexRgb(hex) {
  const { rgb } = lib();
  const n = parseInt(String(hex).slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
/** Each page with its visible box, rotation and size as seen. */
const pagesOf = (doc) => doc.getPages().map((page) => {
  const box = page.getCropBox();
  const rot = page.getRotation().angle;
  return { page, box, rot, ...T.viewSize(box, rot) };
});
const touched = (doc) => { doc.setProducer('DropDial'); doc.setModificationDate(new Date()); };

/** o: {position, style, start, size, skipFirst}. */
export async function numbers({ bytes, o, limits, password }) {
  const { StandardFonts, degrees, rgb } = lib();
  const doc = await loadDoc(bytes, null, limits, password);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const list = pagesOf(doc);
  const last = T.lastNumber(list.length, o);
  let numbered = 0;
  list.forEach(({ page, box, rot, vw, vh }, i) => {
    const n = T.numberFor(i, list.length, o);
    if (n == null) return;
    const label = T.numberLabel(o.style, n, last);
    const p = T.numberPlacement(vw, vh, o.position, o.size, T.textWidth(label, o.size));
    const u = T.viewToUser(box, rot, p.x, p.y, 0);
    page.drawText(label, { x: u.x, y: u.y, size: o.size, font, color: rgb(0.1, 0.1, 0.1), rotate: degrees(u.angle) });
    numbered++;
  });
  touched(doc);
  return { bytes: await doc.save(SAVE), numbered, pages: list.length };
}

/** o: {text, size, opacity (%), angle: 'diagonal' | 'straight', color, layout: 'center' | 'tile'}. */
export async function watermark({ bytes, o, limits, password }) {
  const { StandardFonts, degrees, pushGraphicsState, popGraphicsState, setGraphicsState } = lib();
  const text = String(o.text).trim();
  const doc = await loadDoc(bytes, null, limits, password);
  const color = hexRgb(o.color), opacity = o.opacity / 100;
  let font = null, pic = null, box = null;
  if (T.winAnsi(text)) font = await doc.embedFont(StandardFonts.HelveticaBold);
  else {
    // Other scripts: the text drawn once as a sharp picture in the system font, placed like the text would be.
    const ctx = new OffscreenCanvas(1, 1).getContext('2d');
    box = T.fallbackBox(ctx, text, o.size);
    const k = T.FALLBACK_PX;
    const c = new OffscreenCanvas(Math.ceil((box.width + 2 * box.pad) * k), Math.ceil(box.height * k));
    const g = c.getContext('2d');
    g.font = `700 ${o.size * k}px ${T.FALLBACK_FAMILY}`;
    g.fillStyle = o.color;
    g.textBaseline = 'alphabetic';
    g.fillText(text, box.pad * k, (box.height - box.below) * k);
    pic = await doc.embedPng(await blobBytes(c, 'image/png'));
  }
  const full = font ? T.textWidth(text, o.size, true) : box.width;
  let fitted = o.size;
  for (const { page, box: crop, rot, vw, vh } of pagesOf(doc)) {
    const angle = T.watermarkAngle(vw, vh, o.angle);
    const a = (angle * Math.PI) / 180;
    // Text too long for this page is made smaller to fit it (the preview does the same).
    const size = T.watermarkFit(vw, vh, { width: full, size: o.size, angle });
    const f = size / o.size;
    const width = font ? T.textWidth(text, size, true) : box.width * f;
    fitted = Math.min(fitted, size);
    // One transparency setting per page, around all copies (not one per copy).
    const gs = page.node.newExtGState('GS', doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity }));
    page.pushOperators(pushGraphicsState(), setGraphicsState(gs));
    for (const p of T.watermarkPlacements(vw, vh, { width, size, angle, layout: o.layout })) {
      if (font) {
        const u = T.viewToUser(crop, rot, p.x, p.y, angle);
        page.drawText(text, { x: u.x, y: u.y, size, font, color, rotate: degrees(u.angle) });
      } else {
        const dx = -box.pad * f, dy = -box.below * f;
        const u = T.viewToUser(crop, rot, p.x + dx * Math.cos(a) - dy * Math.sin(a), p.y + dx * Math.sin(a) + dy * Math.cos(a), angle);
        page.drawImage(pic, { x: u.x, y: u.y, width: (box.width + 2 * box.pad) * f, height: box.height * f, rotate: degrees(u.angle) });
      }
    }
    page.pushOperators(popGraphicsState());
  }
  touched(doc);
  return { bytes: await doc.save(SAVE), pages: doc.getPageCount(), fitted: fitted < o.size ? fitted : null };
}
