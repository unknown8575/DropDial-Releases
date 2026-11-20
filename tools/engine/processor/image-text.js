// Edit image text in the sandbox (app processor and website): read the text of a picture or of a scanned PDF's pages
// (src/processor/ocr.js), show a picture with edits, and save it. The pixel work — the look of each line, painting
// the old words out, drawing the new ones — is src/shared/imagetext.mjs, the same code the unit tests run.
//
// Pictures keep their size and format (HEIC is saved as JPEG); a JPEG's EXIF turn is applied when it is read, so the
// result is upright on its own. A scanned PDF keeps every page and its size: pages with edits are made again from the
// edited picture, the others are copied as they are, and (unless turned off) the text read on scanned pages is added
// invisibly so the PDF can be searched and copied from.
import { UserError } from './errors.js';
import { decode, encode, blobBytes } from './image.js';
import { sniff } from './image-header.js';
import { encodeBmp } from './image-encode.js';
import { pdfjs, withPdf, drawPage } from './pdf.js';
import { loadDoc } from './pdf-tools.js';
import { kitFont, fontFile, loadFontkit, wrapPage, pageContent } from './pdf-edit.js';
import * as ocr from './ocr.js';
import * as T from '../shared/imagetext.mjs';
import * as E from '../shared/pdfedit.mjs';
import { viewToUserPoint } from '../shared/pdf-content.mjs';

const lib = () => self.PDFLib;
const KINDS = ['jpg', 'png', 'webp', 'heic'];
const K_MIN = 150 / 72, K_MAX = 300 / 72; // scanned pages are read at their own resolution, 150–300 dpi
const CHANGED = 'The file changed since its text was read. Open Edit image text again.';

const isPdf = (b) => b && b.length > 5 && new TextDecoder('latin1').decode(b.subarray(0, Math.min(1024, b.length))).includes('%PDF-');
const langsOf = (l) => (T.langOk(l) ? l : 'eng');

// ------------------------------------------------------------------ fonts
/** Loaded fontkit fonts for these keys, as the synchronous getter the shared code takes. */
async function fontsFor(keys) {
  const map = new Map();
  await Promise.all([...new Set(keys)].map(async (k) => map.set(k, await kitFont(k))));
  return (k) => { if (!map.has(k)) throw new Error('font not loaded: ' + k); return map.get(k); };
}
/** Every font key the lines, edits and added texts can need. */
function keysFor(lines, edits = [], adds = []) {
  const texts = [...lines.map((l) => l.text), ...edits.map((e) => e.text), ...adds.map((t) => t.text)];
  const keys = T.fontKeysFor(texts);
  for (const t of adds) { keys.push(E.fontKey(t.family, t.bold, t.italic)); if (/[ऀ-ॿ]/.test(t.text)) keys.push(E.fontKey(t.family, t.bold, t.italic, true)); }
  return keys;
}

// ------------------------------------------------------------------ pictures
const pixels = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

/**
 * The text of a picture (a canvas): lines in its own pixels. The reader gets a copy on white, at most IMG.ocrMax px
 * long (smaller pictures twice their size, so small text reads better).
 */
async function readLines(canvas, langs) {
  const long = Math.max(canvas.width, canvas.height);
  const s = long > T.IMG.ocrMax ? T.IMG.ocrMax / long : long < T.IMG.ocrMin ? Math.min(2, T.IMG.ocrMax / long) : 1;
  const w = Math.max(1, Math.round(canvas.width * s)), h = Math.max(1, Math.round(canvas.height * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, w, h);
  const bmp = encodeBmp(g.getImageData(0, 0, w, h));
  c.width = c.height = 0;
  const blocks = await ocr.read(bmp, langs);
  return T.linesFromBlocks(blocks, { scale: (w / canvas.width + h / canvas.height) / 2 });
}

/** Lines with their look (for windows): what lineOut gives. */
async function describe(img, lines) {
  const fonts = await fontsFor(keysFor(lines));
  const looks = lines.map((l) => T.lookOf(img, l, fonts));
  const room = T.roomOf(lines, looks, img.width, img.height);
  return lines.map((l, i) => T.lineOut(l, looks[i], room[i]));
}

async function decodePicture(bytes, limits) {
  const kind = sniff(bytes);
  if (!KINDS.includes(kind)) throw new UserError('Edit image text works on PNG, JPEG, WebP and HEIC pictures, and on scanned PDFs.');
  const { canvas } = await decode(bytes, limits);
  return { canvas, kind };
}

// ------------------------------------------------------------------ PDF pages
/**
 * What a page is: 'scan' (pictures, no visible text), 'text' (it has real text: Edit PDF text) or 'blank'; the
 * largest picture's longest side (px) and whether it already has invisible text (an earlier OCR layer).
 */
async function pageKind(page) {
  const P = await pdfjs();
  const OPS = P.OPS;
  const ol = await page.getOperatorList({ annotationMode: P.AnnotationMode.DISABLE });
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectRepeat].filter((x) => x != null));
  let render = 0, text = 0, hidden = 0, pics = 0, big = 0;
  const stack = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i] || [];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(render);
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) { if (stack.length) render = stack.pop(); }
    else if (fn === OPS.setTextRenderingMode) render = a[0] | 0;
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const n = (a[0] || []).filter((g) => g && typeof g === 'object' && g.unicode && g.unicode.trim()).length;
      if (render === 3 || render === 7) hidden += n; else text += n;
    } else if (IMG.has(fn)) {
      pics++;
      const d = typeof a[1] === 'number' ? [a[1], a[2]] : a[0] && typeof a[0] === 'object' ? [a[0].width, a[0].height] : [0, 0];
      big = Math.max(big, d[0] || 0, d[1] || 0);
    }
  }
  return { kind: text ? 'text' : pics ? 'scan' : 'blank', big, hidden: hidden > 0 };
}
/** px per point a scanned page is read at: its own picture's resolution, 150–300 dpi. */
function scaleOf(page, big) {
  const v = page.getViewport({ scale: 1 });
  return Math.min(K_MAX, Math.max(K_MIN, big / Math.max(v.width, v.height) || K_MIN));
}
async function pageRaster(page, info, limits) {
  return drawPage(page, scaleOf(page, info.big), limits);
}

// ------------------------------------------------------------------ ops
/**
 * Read the text: {bytes, limits, langs, page (PDFs: 1-based), password} → {kind: 'image' | 'pdf', pages, results:
 * [{n, kind ('image' | 'scan' | 'text' | 'blank'), w, h (px), pw, ph (PDF points), lines}]}.
 */
export async function scan({ bytes, limits, langs, page = 1, password }) {
  langs = langsOf(langs);
  if (isPdf(bytes)) {
    return withPdf(bytes, limits, async (doc) => {
      const n = Math.max(1, Math.min(doc.numPages, page | 0));
      const pg = await doc.getPage(n);
      try {
        const v = pg.getViewport({ scale: 1 });
        const info = await pageKind(pg);
        const out = { n, kind: info.kind, pw: round(v.width), ph: round(v.height), w: Math.round(v.width * 2), h: Math.round(v.height * 2), lines: [] };
        if (info.kind === 'scan') {
          const c = await pageRaster(pg, info, limits);
          const img = pixels(c);
          out.lines = await describe(img, await readLines(c, langs));
          out.w = c.width; out.h = c.height;
          c.width = c.height = 0;
        }
        return { kind: 'pdf', pages: doc.numPages, results: [out] };
      } finally { pg.cleanup(); }
    }, password);
  }
  const { canvas } = await decodePicture(bytes, limits);
  const img = pixels(canvas);
  const lines = await describe(img, await readLines(canvas, langs));
  const out = { kind: 'image', pages: 1, results: [{ n: 1, kind: 'image', w: canvas.width, h: canvas.height, lines }] };
  canvas.width = canvas.height = 0;
  return out;
}

/** Edits matched to freshly read lines: by number and text, else the first line with the same text. */
function matchEdits(lines, edits) {
  const used = new Set();
  return edits.map((e) => {
    let l = lines[e.line] && lines[e.line].text === e.old && !used.has(e.line) ? lines[e.line] : null;
    if (!l) l = lines.find((x) => x.text === e.old && !used.has(x.i));
    if (!l) throw new UserError(CHANGED);
    used.add(l.i);
    return { ...e, line: l.i };
  });
}

/** Apply edits and added texts to a canvas (in place). → {busy, checks} */
async function editCanvas(canvas, { lines, looks, room }, edits, adds) {
  const img = pixels(canvas);
  const fonts = await fontsFor(keysFor(lines, edits, adds));
  let r;
  try { r = T.applyEdits(img, lines, edits, adds, fonts, { looks, room }); } catch (e) { if (e && e.user) throw new UserError(e.message); throw e; }
  canvas.getContext('2d').putImageData(img, 0, 0);
  return r;
}

/** Freshly read lines with their looks and room, for a save. */
async function fresh(canvas, langs) {
  const img = pixels(canvas);
  const lines = await readLines(canvas, langs);
  const fonts = await fontsFor(keysFor(lines));
  const looks = lines.map((l) => T.lookOf(img, l, fonts));
  return { lines, looks, room: T.roomOf(lines, looks, img.width, img.height) };
}

/**
 * One picture or page with its edits, as the save draws it: {bytes (JPEG), width, height, page}. `lines` are the
 * page's lines as scan gave them (the app's main process passes its own copy); without them the page is read again.
 */
export async function preview({ bytes, limits, langs, page = 1, edits = [], adds = [], lines, maxSide = 1600, password }) {
  langs = langsOf(langs);
  const draw = async (canvas) => {
    const known = Array.isArray(lines) ? T.fromOut(lines) : await fresh(canvas, langs);
    const es = matchEdits(known.lines, edits.filter((e) => (e.page || 1) === page));
    await editCanvas(canvas, known, es, adds.filter((t) => (t.page || 1) === page));
    const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const out = new OffscreenCanvas(Math.max(1, Math.round(canvas.width * k)), Math.max(1, Math.round(canvas.height * k)));
    const g = out.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, out.width, out.height);
    const r = { bytes: await blobBytes(out, 'image/jpeg', 0.9), width: out.width, height: out.height, page };
    canvas.width = canvas.height = out.width = out.height = 0;
    return r;
  };
  if (isPdf(bytes)) {
    return withPdf(bytes, limits, async (doc) => {
      const pg = await doc.getPage(Math.max(1, Math.min(doc.numPages, page | 0)));
      try {
        const info = await pageKind(pg);
        if (info.kind !== 'scan') throw new UserError(T.TEXT_PAGE_NOTE);
        return draw(await pageRaster(pg, info, limits));
      } finally { pg.cleanup(); }
    }, password);
  }
  return draw((await decodePicture(bytes, limits)).canvas);
}

const squash = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');
const count = (hay, needle) => { if (!needle) return 0; let c = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0) c++; return c; };
/** Problems found by reading the result again: new words not found, old words still there. */
function check(before, after, checks, adds, where = '') {
  const was = squash(before.map((l) => l.text).join(' ')), now = squash(after.map((l) => l.text).join(' '));
  const problems = [];
  for (const c of checks) {
    const add = squash(c.add), old = squash(c.old);
    if (add && count(now, add) < 1) problems.push(`${where}“${c.add}” wasn’t read back.`);
    if (old && !add.includes(old) && count(now, old) > Math.max(0, count(was, old) - 1)) problems.push(`${where}“${c.old}” can still be read.`);
  }
  for (const t of adds) for (const row of E.cleanText(t.text, { multiline: true }).split('\n')) if (squash(row) && count(now, squash(row)) < 1) problems.push(`${where}“${row.trim()}” wasn’t read back.`);
  return problems;
}

/**
 * Save: {bytes, limits, langs, edits: [{page, line, old, text}], adds: [{page, x, y, size, text, family, bold, italic,
 * color, align}], to ('jpg' | 'png' | 'webp' for pictures), quality, searchable (scanned PDFs), password}
 * → {bytes, width, height | pages, edited, added, busy, rebuilt, verify: {ok, problems}}.
 */
export async function save({ bytes, limits, langs, edits = [], adds = [], to = 'png', quality = 0.92, searchable = true, password }) {
  langs = langsOf(langs);
  if (!edits.length && !adds.length) throw new UserError('Change or add some text first.');
  if (isPdf(bytes)) return savePdf({ bytes, limits, langs, edits, adds, quality, searchable, password });
  if (!['jpg', 'png', 'webp'].includes(to)) throw new UserError('This image format can’t be written.');
  const { canvas } = await decodePicture(bytes, limits);
  const known = await fresh(canvas, langs);
  const es = matchEdits(known.lines, edits);
  const r = await editCanvas(canvas, known, es, adds);
  const out = await encode(canvas, to, quality);
  // Read the result again: the new words should be there and the old ones gone.
  const after = await readLines(canvas, langs);
  const problems = check(known.lines, after, r.checks, adds);
  const res = { bytes: out, width: canvas.width, height: canvas.height, edited: r.checks.length, added: adds.filter((t) => t.text.trim()).length, busy: r.busy, verify: { ok: !problems.length, problems } };
  canvas.width = canvas.height = 0;
  return res;
}

async function savePdf({ bytes, limits, langs, edits, adds, quality, searchable, password }) {
  const src = await loadDoc(bytes, null, limits, password);
  const byPage = new Map();
  const get = (p) => { if (!byPage.has(p)) byPage.set(p, { edits: [], adds: [] }); return byPage.get(p); };
  for (const e of edits) get(e.page).edits.push(e);
  for (const t of adds) get(t.page).adds.push(t);
  let edited = 0, added = 0, busy = 0;
  const problems = [], plan = [];
  await withPdf(bytes, limits, async (doc) => {
    if (doc.numPages !== src.getPageCount()) throw new UserError(CHANGED);
    for (const p of byPage.keys()) if (!(p >= 1 && p <= doc.numPages)) throw new UserError(CHANGED);
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      try {
        const info = await pageKind(pg);
        const g = byPage.get(n);
        const v = pg.getViewport({ scale: 1 });
        if (g && info.kind !== 'scan') throw new UserError(`Page ${n} has real text: change it with Edit PDF text.`);
        if (g) {
          // Made again from the edited picture, at the page's own size; read again to check it and for the text layer.
          const c = await pageRaster(pg, info, limits);
          const known = await fresh(c, langs);
          const r = await editCanvas(c, known, matchEdits(known.lines, g.edits), g.adds);
          const jpg = await blobBytes(c, 'image/jpeg', quality);
          const after = await readLines(c, langs);
          problems.push(...check(known.lines, after, r.checks, g.adds, `Page ${n}: `));
          plan.push({ n, jpg, size: [v.width, v.height], lines: after, k: c.width / v.width });
          edited += r.checks.length; added += g.adds.filter((t) => t.text.trim()).length; busy += r.busy;
          c.width = c.height = 0;
        } else if (searchable && info.kind === 'scan' && !info.hidden) {
          const c = await pageRaster(pg, info, limits);
          plan.push({ n, lines: await readLines(c, langs), k: c.width / v.width });
          c.width = c.height = 0;
        } else plan.push({ n });
      } finally { pg.cleanup(); }
    }
  }, password);
  const res = await buildPdf(src, plan, { searchable });
  return { bytes: res.bytes, pages: res.pages, edited, added, busy, rebuilt: plan.filter((p) => p.jpg).length, verify: { ok: !problems.length, problems } };
}

/**
 * The saved scanned PDF, from the original (a pdf-lib document) and a plan per page: {n, jpg, size: [w, h] (points),
 * lines, k} makes the page again from an edited picture; {n, lines?, k} copies page n as it is (with `lines` added as
 * invisible text when `searchable`). → {bytes, pages}
 */
export async function buildPdf(src, plan, { searchable = true } = {}) {
  const out = await lib().PDFDocument.create();
  out.setProducer('DropDial');
  out.setCreator('DropDial');
  const title = src.getTitle(), author = src.getAuthor();
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  const layer = textLayer(out);
  for (const p of plan) {
    if (p.jpg) {
      const page = out.addPage(p.size);
      page.drawImage(await out.embedJpg(p.jpg), { x: 0, y: 0, width: p.size[0], height: p.size[1] });
      if (searchable && p.lines && p.lines.length) await layer(page, p.lines, p.k, { x: 0, y: 0, width: p.size[0], height: p.size[1] }, 0);
    } else {
      const [page] = await out.copyPages(src, [p.n - 1]);
      out.addPage(page);
      if (searchable && p.lines && p.lines.length) {
        wrapPage(out, { pg: page, content: pageContent(page), wrapped: false });
        await layer(page, p.lines, p.k, page.getCropBox(), ((page.getRotation().angle % 360) + 360) % 360);
      }
    }
  }
  return { bytes: await out.save({ useObjectStreams: true, addDefaultPage: false }), pages: out.getPageCount() };
}

/**
 * Invisible text (rendering mode 3) for a page's lines, word by word over where each word is seen, so the PDF can be
 * searched and its text copied: Noto Sans (and Noto Sans Devanagari for Hindi), embedded as subsets. `k`: picture px
 * per point; `box`/`rot`: the page's crop box and turn (view → PDF space).
 */
function textLayer(doc) {
  const made = new Map();
  let kit = false;
  const font = async (key) => {
    if (!made.has(key)) made.set(key, (async () => {
      if (!kit) { doc.registerFontkit(await loadFontkit()); kit = true; }
      return { pdf: await doc.embedFont(await fontFile(key), { subset: true }), kf: await kitFont(key) };
    })());
    return made.get(key);
  };
  const { PDFOperator, PDFNumber } = lib();
  const op = (name, ...args) => PDFOperator.of(name, args);
  const num = (v) => PDFNumber.of(Math.round(v * 1000) / 1000);
  return async (page, lines, k, box, rot) => {
    const ops = [], items = [];
    for (const l of lines) {
      const slope = l.base.x1 !== l.base.x0 ? (l.base.y1 - l.base.y0) / (l.base.x1 - l.base.x0) : 0;
      const size = Math.max(3, (l.xh / 0.53) / k);
      const th = Math.atan(slope);
      l.words.forEach((w, wi) => {
        const next = l.words[wi + 1];
        // A word and the space after it reach the next word, so search and copy see the spaces.
        const text = next ? w.text + ' ' : w.text;
        const reach = next ? next.box[0] - w.box[0] : w.box[2];
        items.push({ w, text, reach, size, th, l, slope });
      });
    }
    for (const it of items) {
      const { w, text, reach, size, th, l, slope } = it;
      const runs = E.scriptRuns(w.text);
      if (runs.length !== 1) continue; // mixed scripts inside one word: left out
      const f = await font(runs[0].deva ? 'deva' : 'sans');
      if (Array.from(w.text).some((ch) => !f.kf.hasGlyphForCodePoint(ch.codePointAt(0)))) continue;
      const width = f.pdf.widthOfTextAtSize(text, size);
      if (!(width > 0) || !(reach > 0)) continue;
      const x = w.box[0], y = l.base.y0 + (x - l.base.x0) * slope;
      const o = viewToUserPoint(box, rot, x / k, y / k);
      const along = viewToUserPoint(box, rot, (x + Math.cos(th)) / k, (y + Math.sin(th)) / k);
      const up = viewToUserPoint(box, rot, (x + Math.sin(th)) / k, (y - Math.cos(th)) / k);
      const a = [(along[0] - o[0]) * k, (along[1] - o[1]) * k], b = [(up[0] - o[0]) * k, (up[1] - o[1]) * k];
      const tz = Math.max(20, Math.min(500, (100 * (reach / k)) / width));
      const key = page.node.newFontDictionary('DDO', f.pdf.ref);
      ops.push(op('BT'), op('Tr', num(3)), op('Tf', key, num(size)), op('Tz', num(tz)),
        op('Tm', num(a[0]), num(a[1]), num(b[0]), num(b[1]), num(o[0]), num(o[1])), op('Tj', f.pdf.encodeText(text)), op('ET'));
    }
    if (ops.length) page.pushOperators(...ops);
  };
}
const round = (v) => Math.round(v * 100) / 100;

/** Close the text reader (tests). */
export const stopReader = () => ocr.stop();
