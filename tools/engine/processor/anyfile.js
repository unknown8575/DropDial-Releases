// Make smaller and Info & privacy in the sandbox (phase 9): pictures made smaller (src/shared/shrink.mjs plans), picture
// details read, cleaned and edited without touching pixels (src/shared/imagemeta.mjs), and PDF document details read,
// edited and cleared with pdf-lib. Each op takes bytes and returns bytes; nothing here can reach the file system.
import { decode, encode, hasAlpha } from './image.js';
import { UserError } from './errors.js';
import { sniff, headerSize, gifFrames } from './image-header.js';
import { encodeSmallPng } from './png.js';
import * as M from '../shared/imagemeta.mjs';

// ------------------------------------------------------------------ Make smaller (pictures)
/** Fit the canvas inside `cap` px (longest side), in halving steps for a clean result. */
function capped(canvas, cap) {
  if (!cap || Math.max(canvas.width, canvas.height) <= cap) return canvas;
  let c = canvas;
  const k = cap / Math.max(canvas.width, canvas.height);
  const tw = Math.max(1, Math.round(canvas.width * k)), th = Math.max(1, Math.round(canvas.height * k));
  while (c.width / 2 >= tw * 1.0001 && c.height / 2 >= th) {
    const half = new OffscreenCanvas(Math.round(c.width / 2), Math.round(c.height / 2));
    const x = half.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, half.width, half.height);
    c = half;
  }
  const out = new OffscreenCanvas(tw, th);
  const x = out.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, tw, th);
  return out;
}

/** plan: {to: 'jpg'|'webp'|'png'|'auto', quality, cap, mode, dither}. Returns {bytes, to, width, height, note, resized}. */
export async function shrinkImage({ bytes, plan, limits }) {
  const { canvas: full, frames } = await decode(bytes, limits);
  if (frames > 1) throw new UserError('Animated pictures can’t be made smaller here.');
  const canvas = capped(full, plan.cap);
  const resized = canvas !== full;
  let to = plan.to;
  const alpha = to === 'png' || to === 'auto' ? hasAlpha(canvas) : false;
  if (to === 'auto') to = alpha ? 'png' : 'jpg';
  let out, note;
  if (to === 'png') {
    const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    ({ bytes: out, note } = encodeSmallPng(img, alpha, { mode: plan.mode || 'lossless', dither: !!plan.dither }));
  } else {
    out = await encode(canvas, to, plan.quality);
    note = `${to === 'jpg' ? 'JPEG' : 'WebP'} at ${Math.round(plan.quality * 100)}% quality`;
  }
  return { bytes: out, to, width: canvas.width, height: canvas.height, note, resized, from: [full.width, full.height] };
}

// ------------------------------------------------------------------ Info & privacy (pictures)
const KIND_LABEL = { jpg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', heic: 'HEIC', avif: 'AVIF', ico: 'ICO', svg: 'SVG' };
/** {kind, label, width, height, frames, meta (readMeta), lossless (can be cleaned and edited without saving again)}. */
export async function imageMeta({ bytes, limits }) {
  const kind = sniff(bytes);
  if (!kind) throw new UserError('This file isn’t a picture DropDial can read. It may be damaged, or not really the type its name says.');
  let size = headerSize(bytes, kind);
  if (!size) { const { canvas } = await decode(bytes, limits); size = { width: canvas.width, height: canvas.height }; }
  let meta = { kind: null };
  try { meta = M.readMeta(bytes); } catch (e) { meta = { kind, error: e.message }; }
  return { kind, label: KIND_LABEL[kind] || kind.toUpperCase(), width: size.width, height: size.height, frames: kind === 'gif' ? gifFrames(bytes) : 1, meta, lossless: ['jpg', 'png', 'webp'].includes(kind) };
}

/**
 * A copy with hidden details removed and/or edited: o = {clean: 'none'|'location'|'all', edits: {title, …}}.
 * JPEG, PNG and WebP keep every pixel; other kinds are saved again (TIFF and BMP as themselves, HEIC and AVIF as
 * JPEG), which drops all hidden details. Returns {bytes, to, resaved}.
 */
export async function imageClean({ bytes, o, quality, limits }) {
  const kind = sniff(bytes);
  if (['jpg', 'png', 'webp'].includes(kind)) {
    let out = bytes;
    if (o.clean && o.clean !== 'none') out = M.cleanMeta(out, o.clean);
    if (o.edits && Object.keys(o.edits).length) out = M.editMeta(out, o.edits);
    // Check the result before it is saved: removed details must really be gone.
    if (o.clean && o.clean !== 'none') {
      const after = M.readMeta(out);
      const left = o.clean === 'location' ? after.found.location : after.found.location || after.found.camera || after.found.dates || after.found.xmp || after.found.iptc || after.found.thumbnail || after.found.extra;
      if (left) throw new UserError('Some details couldn’t be removed from this picture, so nothing was saved.');
    }
    return { bytes: out, to: kind, resaved: false };
  }
  if (o.edits && Object.keys(o.edits).length) throw new UserError(`Details can’t be written into ${KIND_LABEL[kind] || 'this kind of'} pictures. Remove the edits, or convert it to JPEG first.`);
  if (kind === 'gif' || kind === 'svg' || kind === 'ico') throw new UserError(`${KIND_LABEL[kind]} pictures can’t be cleaned here.`);
  const { canvas } = await decode(bytes, limits);
  const to = kind === 'tiff' || kind === 'bmp' ? kind : 'jpg';
  return { bytes: await encode(canvas, to, quality), to, resaved: true };
}

// ------------------------------------------------------------------ PDF details
const lib = () => self.PDFLib;
const KEYS = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords', creator: 'Creator', producer: 'Producer', created: 'CreationDate', modified: 'ModDate' };
function encrypted(bytes) {
  const K = 1 << 20, n = bytes.length;
  const look = (a, b) => new TextDecoder('latin1').decode(bytes.subarray(a, b)).includes('/Encrypt');
  return look(Math.max(0, n - K), n) || (n > K && look(0, K));
}
async function openPdf(bytes) {
  if (encrypted(bytes)) throw new UserError('This PDF is password-protected. Open it, save a copy without the password, then try again.');
  try { return await lib().PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }); } catch { throw new UserError('This PDF couldn’t be read. It may be damaged.'); }
}
const str = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 2000) : null);
const iso = (d) => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null);

/** {pages, title, author, subject, keywords, creator, producer, created, modified (ISO), xmp, attachments}. */
export async function pdfMeta({ bytes }) {
  const doc = await openPdf(bytes);
  const { PDFName } = lib();
  let xmp = false, files = 0;
  try { xmp = !!doc.catalog.get(PDFName.of('Metadata')); } catch { /* none */ }
  try { const names = doc.catalog.lookup(PDFName.of('Names')); files = names && names.get(PDFName.of('EmbeddedFiles')) ? 1 : 0; } catch { /* none */ }
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  return {
    pages: doc.getPageCount(), title: str(safe(() => doc.getTitle())), author: str(safe(() => doc.getAuthor())), subject: str(safe(() => doc.getSubject())),
    keywords: str(safe(() => doc.getKeywords())), creator: str(safe(() => doc.getCreator())), producer: str(safe(() => doc.getProducer())),
    created: iso(safe(() => doc.getCreationDate())), modified: iso(safe(() => doc.getModificationDate())), xmp, attachments: files > 0,
  };
}

/**
 * Edit or clear a PDF's document details. o = {clean: 'none'|'all', edits: {title, author, subject, keywords}}.
 * 'all' removes every document detail (title, author, subject, keywords, app names, dates) and the XMP metadata.
 * Pages are left exactly as they are.
 */
export async function pdfClean({ bytes, o }) {
  const doc = await openPdf(bytes);
  const { PDFName, PDFHexString } = lib();
  const info = doc.getInfoDict();
  if (o.clean === 'all') {
    for (const k of Object.values(KEYS)) info.delete(PDFName.of(k));
    for (const k of info.keys()) info.delete(k); // anything else apps put there
    doc.catalog.delete(PDFName.of('Metadata'));
  }
  const e = o.edits || {};
  for (const k of ['title', 'author', 'subject', 'keywords']) {
    if (e[k] === undefined) continue;
    const v = String(e[k]).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 2000);
    if (!v) info.delete(PDFName.of(KEYS[k]));
    else info.set(PDFName.of(KEYS[k]), PDFHexString.fromText(v));
  }
  if (o.clean !== 'all' && Object.keys(e).length) doc.catalog.delete(PDFName.of('Metadata')); // an old XMP copy would disagree with the new details
  return { bytes: await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false }) };
}
