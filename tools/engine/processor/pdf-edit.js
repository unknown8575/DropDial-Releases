// Edit PDF text in the sandbox (app processor and website): find the text lines of pages, show a page with edits,
// and save the edited PDF.
//
// Reading: pdf.js's operator list gives every text-show operator's glyphs (their text, widths and spacing flags), the
// fonts and the fill colour; the page's own content streams (pdf-lib) are followed by src/shared/pdf-content.mjs,
// which gives each glyph its place and the exact operator and bytes it came from. Both see the operators in the same
// order (forms included); a page where they don't agree, or with fonts whose codes can't be split, is read from
// pdf.js's text content instead and can only be covered.
//
// Writing: the changed glyphs are cut out of their operators (copied Form XObjects when the text is inside one), the
// new text is drawn in the bundled fonts (src/processor/vendor/fonts, subset) or the same standard PDF font, and
// objects nothing uses any more (the old content streams) are dropped, so the old text is gone from the file. The
// saved PDF is read back with pdf.js to check.
import { UserError } from './errors.js';
import { pdfjs, closeJs, drawPage, tooManyPages } from './pdf.js';
import { blobBytes } from './image.js';
import { loadDoc, prune } from './pdf-tools.js';
import { isEncrypted } from './pdf-crypt.js';
import * as C from '../shared/pdf-content.mjs';
import * as E from '../shared/pdfedit.mjs';
import { winAnsi } from '../shared/pdftools.mjs';

const lib = () => self.PDFLib;
const SAVE = { useObjectStreams: true, addDefaultPage: false };

// ------------------------------------------------------------------ bundled fonts
let loadFile = async (file) => {
  const r = await fetch(new URL('./vendor/fonts/' + file, import.meta.url));
  if (!r.ok) throw new Error('font ' + file + ' missing');
  return new Uint8Array(await r.arrayBuffer());
};
/** Tests (Node) read the font files from disk. */
export function setFontLoader(fn) { loadFile = fn; fileCache.clear(); }
const fileCache = new Map();
const fontFile = (key) => { const f = E.FONT_FILES[key]; if (!fileCache.has(f)) { const p = loadFile(f); fileCache.set(f, p); p.catch(() => fileCache.delete(f)); } return fileCache.get(f); };
// fontkit (MIT) is loaded only when text is written; its UMD build sets self.fontkit when imported as a module.
let kitP = null;
const fontkit = () => (kitP ||= self.fontkit ? Promise.resolve(self.fontkit) : import('./vendor/fontkit.umd.min.js').then(() => self.fontkit));
const kitCache = new Map();
async function kitFont(key) {
  if (!kitCache.has(key)) kitCache.set(key, Promise.all([fontFile(key), fontkit()]).then(([b, fk]) => fk.create(b)));
  return kitCache.get(key);
}

const STD = { Helvetica: 'Helvetica', 'Helvetica-Bold': 'HelveticaBold', 'Helvetica-Oblique': 'HelveticaOblique', 'Helvetica-BoldOblique': 'HelveticaBoldOblique',
  'Times-Roman': 'TimesRoman', 'Times-Bold': 'TimesRomanBold', 'Times-Italic': 'TimesRomanItalic', 'Times-BoldItalic': 'TimesRomanBoldItalic',
  Courier: 'Courier', 'Courier-Bold': 'CourierBold', 'Courier-Oblique': 'CourierOblique', 'Courier-BoldOblique': 'CourierBoldOblique' };
/** The standard PDF font a non-embedded simple font stands for, or null. */
function standardOf(dict) {
  const { PDFName, PDFDict } = lib();
  const sub = String(dict.get(PDFName.of('Subtype')) || '');
  if (!/^\/(Type1|TrueType|MMType1)$/.test(sub)) return null;
  const fd = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  if (fd && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)))) return null;
  const base = String(dict.get(PDFName.of('BaseFont')) || '').replace(/^\//, '');
  if (STD[base]) return STD[base];
  const m = /^(Arial|ArialMT|Helvetica|TimesNewRoman(?:PS)?(?:MT)?|Times|CourierNew(?:PS)?(?:MT)?)(?:[,-](Bold|Italic|BoldItalic|BoldOblique|Oblique)(?:MT)?)?$/i.exec(base);
  if (!m) return null;
  const fam = /^times/i.test(m[1]) ? 'Times' : /^courier/i.test(m[1]) ? 'Courier' : 'Helvetica';
  const st = (m[2] || '').toLowerCase();
  const b = st.includes('bold'), i = st.includes('italic') || st.includes('oblique');
  if (fam === 'Times') return b && i ? 'TimesRomanBoldItalic' : b ? 'TimesRomanBold' : i ? 'TimesRomanItalic' : 'TimesRoman';
  return fam + (b && i ? 'BoldOblique' : b ? 'Bold' : i ? 'Oblique' : '');
}

/** The fonts of one document being written: the bundled ones (embedded once, subset) and standard ones. */
function fontBank(doc) {
  const made = new Map();
  let kit = false;
  const embed = (key) => {
    if (!made.has(key)) {
      made.set(key, (async () => {
        if (key.startsWith('std:')) return doc.embedFont(lib().StandardFonts[key.slice(4)]);
        if (!kit) { doc.registerFontkit(await fontkit()); kit = true; }
        return doc.embedFont(await fontFile(key), { subset: true });
      })());
    }
    return made.get(key);
  };
  /**
   * Runs to draw `text` in a style: [{text, font, slant}] — Devanagari in Noto Sans Devanagari, the rest in the style's
   * bundled font or `std` (a standard font) when it can write all of it. Throws when a character can't be written.
   */
  async function runs(text, { family, bold, italic, std }) {
    const out = [];
    for (const r of E.scriptRuns(text)) {
      if (!r.deva && std && winAnsi(r.text)) { out.push({ text: r.text, font: await embed('std:' + std), slant: false }); continue; }
      const key = E.fontKey(family, bold, italic, r.deva);
      const kf = await kitFont(key);
      const missing = [...new Set(Array.from(r.text).filter((ch) => !/[\s‌‍]/.test(ch) && !kf.hasGlyphForCodePoint(ch.codePointAt(0))))];
      if (missing.length) throw new UserError(E.unsupportedText(missing) + '.');
      out.push({ text: r.text, font: await embed(key), slant: E.needsSlant(family, italic, r.deva) });
    }
    return out;
  }
  return { runs };
}

// ------------------------------------------------------------------ reading pages
const STD_FONT_URL = () => new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href;
async function openJs(bytes, limits, password) {
  const P = await pdfjs();
  const task = P.getDocument({
    data: bytes.slice(), password: password || undefined, isEvalSupported: false, enableXfa: false, useSystemFonts: false, disableFontFace: true,
    fontExtraProperties: true, standardFontDataUrl: STD_FONT_URL(), cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
    stopAtErrors: false, verbosity: 0,
  });
  let doc;
  try { doc = await task.promise; } catch (e) {
    try { await task.destroy(); } catch { /* closed */ }
    if (e && e.name === 'PasswordException') throw new UserError(password ? 'That password didn’t work.' : 'This PDF is password-protected.');
    throw new UserError('This PDF could not be read. It may be damaged.');
  }
  doc.__task = task;
  if (doc.numPages > limits.pages) { const n = doc.numPages; await closeJs(doc); throw new UserError(tooManyPages(n, limits.pages)); }
  return doc;
}

/** The decoded bytes of a stream object (null when its filter can't be read). */
function streamBytes(s) {
  const { PDFRawStream, decodePDFRawStream } = lib();
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    if (s && typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
  } catch { /* unknown filter */ }
  return null;
}
/** A page's content streams as one byte array (a newline between them), or null. */
function pageContent(page) {
  const { PDFArray, PDFName } = lib();
  const node = page.node;
  const c = node.get(PDFName.of('Contents'));
  if (!c) return new Uint8Array(0);
  const obj = node.context.lookup(c);
  const list = obj instanceof PDFArray ? obj.asArray().map((r) => node.context.lookup(r)) : [obj];
  const parts = [];
  for (const s of list) { const b = streamBytes(s); if (!b) return null; parts.push(b, Uint8Array.of(10)); }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const parseHex = (v) => {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number')) return E.hexOf(v.map((x) => (x <= 1 ? x * 255 : x)));
  return null;
};
// Glyph text: compatibility forms unfolded (ligatures → letters); control characters (unmapped glyphs) dropped.
const nfkc = (u) => { let t = String(u || ''); try { t = t.normalize('NFKC'); } catch { /* as is */ } return t.replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, ''); };

/** What pdf.js draws on a page: each text-show's glyphs, font, colour and rendering mode, and whether it has pictures. */
async function readOps(page) {
  const P = await pdfjs();
  const OPS = P.OPS;
  const ol = await page.getOperatorList({ annotationMode: P.AnnotationMode.DISABLE });
  const shows = [];
  let st = { fill: '#000000', stroke: '#000000', render: 0, font: null };
  const stack = [];
  let pictures = 0;
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask].filter((x) => x != null));
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) stack.push(st);
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) { if (stack.length) st = stack.pop(); }
    else if (fn === OPS.setFillRGBColor) { const c = parseHex(a); if (c) st = { ...st, fill: c }; }
    else if (fn === OPS.setStrokeRGBColor) { const c = parseHex(a); if (c) st = { ...st, stroke: c }; }
    else if (fn === OPS.setTextRenderingMode) st = { ...st, render: a[0] | 0 };
    else if (fn === OPS.setFont) st = { ...st, font: a[0] };
    else if (fn === OPS.showText || fn === OPS.showSpacedText) shows.push({ glyphs: (a[0] || []).filter((g) => g && typeof g === 'object'), font: st.font, color: st.render === 1 || st.render === 5 ? st.stroke : st.fill, render: st.render });
    else if (IMG.has(fn)) pictures++;
  }
  return { shows, pictures };
}

/** A pdf.js font's details: {name, style, fm0, ascent, descent}. */
function jsFont(page, name, cache) {
  if (cache.has(name)) return cache.get(name);
  let f = null;
  try { if (name && page.commonObjs.has(name)) f = page.commonObjs.get(name); } catch { f = null; }
  const info = {
    name: (f && f.name) || '',
    style: E.fontStyle({ name: (f && f.name) || '', bold: f && f.bold, italic: f && f.italic, black: f && f.black, mono: f && f.isMonospace, serif: f && f.isSerifFont }),
    fm0: f && Array.isArray(f.fontMatrix) && f.fontMatrix[0] ? f.fontMatrix[0] : 0.001,
    ascent: f && f.ascent > 0.3 && f.ascent < 1.5 ? f.ascent : 0.9,
    descent: f && f.descent < 0 && f.descent > -0.8 ? -f.descent : 0.22,
    vertical: !!(f && f.vertical),
  };
  cache.set(name, info);
  return info;
}

const uniq = (() => { let n = 0; return () => ++n; })();

/** Resolved fonts and forms of a pdf-lib page for the content walker. */
function pageResolver(doc) {
  const { PDFName, PDFDict, PDFRef, PDFStream, PDFArray, PDFNumber } = lib();
  const ctx = doc.context;
  const fonts = new Map(), forms = new Map();
  const keyOf = (ref, obj) => (ref instanceof PDFRef ? ref.toString() : (obj.__ddKey ||= 'x' + uniq()));
  function font(name, res) {
    if (!(res instanceof PDFDict)) return null;
    const dict = res.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (!dict) return null;
    const ref = dict.get(PDFName.of(name));
    const fd = ref && ctx.lookup(ref);
    if (!(fd instanceof PDFDict)) return null;
    const key = keyOf(ref, fd);
    if (fonts.has(key)) return fonts.get(key);
    const sub = String(fd.get(PDFName.of('Subtype')) || '');
    let codes = (b) => Array.from(b, () => 1), vertical = false;
    if (sub === '/Type0') {
      const enc = fd.get(PDFName.of('Encoding'));
      const encObj = enc && ctx.lookup(enc);
      if (encObj instanceof PDFStream) {
        const text = streamBytes(encObj);
        const ranges = text ? C.parseCodespace(new TextDecoder('latin1').decode(text)) : [];
        const wmode = encObj.dict.lookupMaybe(PDFName.of('WMode'), PDFNumber);
        vertical = !!(wmode && wmode.asNumber() === 1);
        codes = ranges.length ? (b) => C.codesByRanges(ranges, b) : () => null;
      } else {
        const n = String(encObj || '').replace(/^\//, '');
        vertical = /-V$/.test(n);
        // Identity and the 2-byte UCS-2 CMaps have fixed 2-byte codes; others (legacy CJK encodings) are mixed.
        codes = /^Identity-[HV]$|UCS2-[HV]$/.test(n) ? (b) => (b.length % 2 ? null : Array.from({ length: b.length / 2 }, () => 2)) : () => null;
      }
    }
    const h = { key, dict: fd, std: standardOf(fd), codes, vertical };
    fonts.set(key, h);
    return h;
  }
  function form(name, res) {
    if (!(res instanceof PDFDict)) return null;
    const dict = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!dict) return null;
    const ref = dict.get(PDFName.of(name));
    const s = ref && ctx.lookup(ref);
    if (!(s instanceof PDFStream) || String(s.dict.get(PDFName.of('Subtype'))) !== '/Form') return null;
    const key = keyOf(ref, s);
    if (forms.has(key)) return forms.get(key);
    const bytes = streamBytes(s);
    if (!bytes) throw new C.ContentError('form filter');
    const m = s.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
    const matrix = m && m.size() === 6 ? m.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) : null;
    const h = { key, ref, stream: s, bytes, matrix, resources: s.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || null };
    forms.set(key, h);
    return h;
  }
  return { font, form };
}

const instanceId = (path) => ['page', ...path.map((p) => p.index)].join('>');

/**
 * Read one page (1-based n): {n, box, rot, vw, vh, scan, mode ('remove' | 'cover'), lines: [...], glyphs, shows, …}.
 * `jsDoc` is the pdf.js document, `doc` the pdf-lib one (the same bytes).
 */
async function analyse(jsDoc, doc, n) {
  const page = await jsDoc.getPage(n);
  try {
    const pg = doc.getPage(n - 1);
    const box = pg.getCropBox();
    const rot = ((pg.getRotation().angle % 360) + 360) % 360;
    const vw = rot % 180 ? box.height : box.width, vh = rot % 180 ? box.width : box.height;
    const { shows, pictures } = await readOps(page);
    const fontCache = new Map();
    const resolver = pageResolver(doc);
    const evs = [], dos = [];
    let mode = 'remove', content = null;
    try {
      content = pageContent(pg);
      if (!content) throw new C.ContentError('page filter');
      const count = C.walkContent(content, {
        resources: pg.node.Resources(),
        font: resolver.font, form: resolver.form,
        width: (k, i) => {
          const s = shows[k];
          const g = s && s.glyphs[i];
          if (!g) throw new C.ContentError('count');
          return (g.width || 0) * jsFont(page, s.font, fontCache).fm0 * 1000;
        },
        onShow: (ev) => evs.push(ev), onDo: (ev) => dos.push(ev),
      });
      if (count !== shows.length || evs.some((ev) => ev.glyphs.length !== shows[ev.k].glyphs.length)) throw new C.ContentError('count');
    } catch (e) {
      if (!(e && e.content)) throw e;
      mode = 'cover';
    }
    const glyphs = []; // view-space glyphs for groupLines
    const recs = []; // what each glyph is: operator, user-space place, style
    if (mode === 'remove') {
      for (const ev of evs) {
        const s = shows[ev.k];
        const jf = jsFont(page, s.font, fontCache);
        const trm = C.textMatrix(ev);
        const size = Math.hypot(trm[2], trm[3]);
        const invisible = s.render === 3 || s.render === 7 || size < 0.5 || ev.vertical || jf.vertical;
        for (const g of ev.glyphs) {
          const pj = s.glyphs[g.i];
          const [x0, y0] = C.userToView(box, rot, g.x0, g.y0);
          const [x1, y1] = C.userToView(box, rot, g.x1, g.y1);
          glyphs.push({ u: nfkc(pj.unicode), x0, y0, x1, y1, size, invisible });
          recs.push({ ev, g, trm, color: s.color, font: jf, std: ev.font && ev.font.std, cover: false });
        }
      }
    } else {
      // Read from pdf.js's text content: whole items, characters spread evenly over each item's width.
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        if (!it.str || !Array.isArray(it.transform)) continue;
        const [a, b, c, d, e, f] = it.transform;
        const size = Math.hypot(c, d), len = Math.hypot(a, b) || 1;
        const st = tc.styles[it.fontName] || {};
        const chars = Array.from(it.str);
        const ux = a / len, uy = b / len;
        const step = (it.width || 0) / Math.max(1, chars.length);
        const jf = { ...jsFont(page, it.fontName, fontCache) };
        if (!jf.name && st.fontFamily) jf.style = E.fontStyle({ name: st.fontFamily, mono: st.fontFamily === 'monospace', serif: st.fontFamily === 'serif' });
        chars.forEach((ch, j) => {
          const gx0 = e + ux * step * j, gy0 = f + uy * step * j;
          const [x0, y0] = C.userToView(box, rot, gx0, gy0);
          const [x1, y1] = C.userToView(box, rot, gx0 + ux * step, gy0 + uy * step);
          glyphs.push({ u: nfkc(ch), x0, y0, x1, y1, size, invisible: size < 0.5 });
          recs.push({ ev: null, g: { x0: gx0, y0: gy0, x1: gx0 + ux * step, y1: gy0 + uy * step }, trm: [a, b, c, d, 0, 0], color: '#000000', font: jf, std: null, cover: true });
        });
      }
    }
    const lines = E.groupLines(glyphs).map((l, i) => lineInfo(l, i, recs, glyphs, vw, vh, rot));
    measureRoom(lines, vw, vh);
    const visible = glyphs.some((g) => !g.invisible && g.u && g.u.trim());
    return { n, box, rot, vw, vh, lines, recs, evs, dos, content, mode, scan: !visible && pictures > 0, pg };
  } finally { page.cleanup(); }
}

/** A line as windows see it, plus what the writer needs. */
function lineInfo(l, i, recs, glyphs, vw, vh, rot) {
  const r0 = recs[l.glyphs[0]];
  const trm = r0.trm;
  const sx = Math.hypot(trm[0], trm[1]), sy = Math.hypot(trm[2], trm[3]) || 1;
  // A box around the line (view space), from the baseline's ends, the font's ascent and descent.
  const [dx, dy] = [l.x1 - l.x, l.y1 - l.y];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len; // along the baseline (view, y down)
  const nx = uy, ny = -ux; // up from the baseline
  const asc = r0.font.ascent * l.size, desc = r0.font.descent * l.size;
  const pts = [[l.x, l.y], [l.x1, l.y1]].flatMap(([x, y]) => [[x + nx * asc, y + ny * asc], [x - nx * desc, y - ny * desc]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cover = l.glyphs.some((g) => recs[g].cover);
  const angle = l.glyphs.length > 1 || len > 0.01 ? l.angle : Math.round((((Math.atan2(trm[1], trm[0]) * 180) / Math.PI - rot) % 360 + 540) % 360 - 180);
  return {
    i, text: l.text, chars: l.chars, glyphs: l.glyphs,
    x: round(l.x), y: round(l.y), w: round(len), size: round(l.size), angle, hs: round(sx / sy),
    asc: round(asc), desc: round(desc),
    box: [round(Math.min(...xs)), round(Math.min(...ys)), round(Math.max(...xs) - Math.min(...xs)), round(Math.max(...ys) - Math.min(...ys))],
    font: { ...r0.font.style, name: r0.font.name.replace(/^[A-Z]{6}\+/, '') },
    color: r0.color || '#000000', mode: cover ? 'cover' : 'remove', ux, uy,
  };
}
const round = (v) => Math.round(v * 100) / 100;

/** How far (view points along its baseline, from its start) each line can grow before it meets other text or the page edge. */
function measureRoom(lines, vw, vh) {
  for (const l of lines) {
    let room = Infinity;
    for (const o of lines) {
      if (o === l || Math.abs(((o.angle - l.angle + 540) % 360) - 180) > 1) continue;
      const ex = o.x - l.x, ey = o.y - l.y;
      const along = ex * l.ux + ey * l.uy, across = -ex * l.uy + ey * l.ux;
      if (Math.abs(across) < 0.5 * l.size && along > l.w - 0.5 * l.size) room = Math.min(room, along);
    }
    // The page edge, for level text.
    if (Math.abs(l.angle) < 1) room = Math.min(room, vw - l.x);
    else if (Math.abs(l.angle - 90) < 1) room = Math.min(room, l.y);
    else if (Math.abs(l.angle + 90) < 1) room = Math.min(room, vh - l.y);
    l.room = room;
  }
}

/** What windows get for a page. */
const pageOut = (a) => ({
  n: a.n, w: round(a.vw), h: round(a.vh), rot: a.rot, scan: a.scan, mode: a.mode,
  lines: a.lines.map((l) => ({ i: l.i, text: l.text, x: l.x, y: l.y, w: l.w, size: l.size, angle: l.angle, hs: l.hs, asc: l.asc, desc: l.desc, box: l.box, font: l.font, color: l.color, mode: l.mode })),
});

async function openBoth(bytes, limits, password) {
  const enc = isEncrypted(bytes);
  const doc = await loadDoc(bytes, null, limits, password);
  const jsDoc = await openJs(bytes, limits, enc ? password || '' : undefined);
  return { doc, jsDoc };
}

// ------------------------------------------------------------------ ops
/** Pages first..last (1-based): {pages (count), results: [{n, w, h, rot, scan, mode, lines}]}. */
export async function scan({ bytes, limits, password, first = 1, last = 1 }) {
  const { doc, jsDoc } = await openBoth(bytes, limits, password);
  try {
    const out = [];
    const total = jsDoc.numPages;
    for (let n = Math.max(1, first | 0); n <= Math.min(total, last | 0); n++) out.push(pageOut(await analyse(jsDoc, doc, n)));
    return { pages: total, results: out };
  } finally { await closeJs(jsDoc); }
}

// ------------------------------------------------------------------ writing
const hexRgb = (hex) => { const v = parseInt(String(hex).slice(1), 16) || 0; return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };
const n = (v) => lib().PDFNumber.of(Math.round(v * 10000) / 10000);
const op = (name, ...args) => lib().PDFOperator.of(name, args);

/**
 * The plan for one page's edits: glyph removals by show number, covers, and texts to draw. edits: [{line, old, text}]
 * (line = the page's line number). Throws a UserError when the PDF changed since the window read it.
 */
function planPage(a, edits) {
  const removals = new Map(); // show number k → Set of glyph numbers
  const covers = [], draws = [], checks = [];
  for (const e of edits) {
    const l = a.lines[e.line];
    if (!l || l.text !== e.old) throw new UserError('The PDF changed since it was opened. Open Edit PDF text again.');
    const next = E.cleanText(e.text);
    if (next === l.text) continue;
    let p = E.keptPrefix(l.text, next);
    // The first glyph to remove: the glyph of the first changed character (a ligature is redrawn whole).
    let cut = l.glyphs.length;
    for (let c = p; c < l.chars.length; c++) if (l.chars[c].g >= 0) { cut = l.glyphs.indexOf(l.chars[c].g); break; }
    if (cut < l.glyphs.length) {
      const g = l.glyphs[cut];
      const firstChar = l.chars.findIndex((ch) => ch.g === g);
      if (firstChar >= 0 && firstChar < p) p = firstChar;
    }
    const gone = l.glyphs.slice(cut);
    const nextArr = Array.from(next);
    const add = nextArr.slice(p).join('');
    const oldPart = Array.from(l.text).slice(p).join('');
    // Where the new text starts: the first removed glyph's origin, or the end of the line when only adding.
    const at = gone.length ? a.recs[gone[0]] : a.recs[l.glyphs[l.glyphs.length - 1]];
    const origin = gone.length ? [at.g.x0, at.g.y0] : [at.g.x1, at.g.y1];
    const lin = at.trm.slice(0, 4);
    const sx = Math.hypot(lin[0], lin[1]) || 1;
    if (gone.length) {
      const cover = l.mode === 'cover' || gone.some((g) => a.recs[g].cover);
      if (cover) {
        const last = a.recs[gone[gone.length - 1]];
        const adv = Math.hypot(last.g.x1 - origin[0], last.g.y1 - origin[1]) / sx;
        covers.push({ lin, origin, adv, asc: at.font.ascent, desc: at.font.descent, line: l });
      } else for (const g of gone) { const r = a.recs[g]; if (!removals.has(r.ev.k)) removals.set(r.ev.k, new Set()); removals.get(r.ev.k).add(r.g.i); }
    }
    // What is drawn: the changed words in the style of the first changed character, then the unchanged end of the
    // line in its own styles (a bold or italic word after the change stays bold or italic).
    let s = 0;
    while (s < l.chars.length - p && s < nextArr.length - p && l.chars[l.chars.length - 1 - s].c === nextArr[nextArr.length - 1 - s]) s++;
    // Letter and word spacing are carried over (in the drawing matrix's units: the font size is in the matrix).
    const styleOf = (r) => {
      const fs = r.ev && r.ev.fs ? r.ev.fs : 0;
      const tc = fs ? r.ev.tc / fs : 0, tw = fs ? r.ev.tw / fs : 0;
      return { lin: r.trm.slice(0, 4), color: r.color, tc, tw, style: { ...r.font.style, std: r.std }, key: `${r.font.name}|${r.color}|${tc.toFixed(4)}|${tw.toFixed(4)}|${r.trm.slice(0, 4).map((v) => v.toFixed(3))}` };
    };
    const pieces = [];
    const mid = nextArr.slice(p, nextArr.length - s).join('');
    let last = styleOf(at);
    if (mid) pieces.push({ text: mid, ...last });
    for (const ch of l.chars.slice(l.chars.length - s)) {
      const st = ch.g >= 0 ? styleOf(a.recs[ch.g]) : last;
      const prev = pieces[pieces.length - 1];
      if (prev && prev.key === st.key) prev.text += ch.c; else pieces.push({ text: ch.c, ...st });
      last = st;
    }
    // Room for the new text (user-space points along the line): up to the next text on it, or the page edge.
    const startAlong = gone.length ? alongOf(a, l, gone[0]) : l.w;
    const room = Number.isFinite(l.room) ? l.room - startAlong - 0.15 * l.size : Infinity;
    if (pieces.some((x) => x.text.trim())) draws.push({ pieces, origin, room, line: l });
    checks.push({ old: oldPart, add, cover: l.mode === 'cover', line: l.i });
  }
  return { removals, covers, draws, checks };
}
/** View distance along a line's baseline from its start to a glyph's origin. */
function alongOf(a, l, gi) {
  const r = a.recs[gi];
  const [x, y] = C.userToView(a.box, a.rot, r.g.x0, r.g.y0);
  return (x - l.x) * l.ux + (y - l.y) * l.uy;
}

/**
 * Cut the planned glyphs out of the page and copies of its forms. A form with a change is copied, and the copy takes the
 * original's place in a copy of the resources that use it (also copied), so other pages that share the form or the
 * resources don't change, and an original nothing uses any more is dropped when saving. Returns false when it can't be
 * written.
 */
function removeGlyphs(doc, a, removals) {
  if (!removals.size) return true;
  const { PDFName, PDFDict } = lib();
  const ctx = doc.context;
  // Group the removals by where the operator is: the page, or one use of a form.
  const inst = new Map(); // id → {edits, swaps, depth, form?, parent, doIndex, doName, res}
  const get = (id) => { if (!inst.has(id)) inst.set(id, { id, edits: [], swaps: [] }); return inst.get(id); };
  get('page').bytes = a.content;
  for (const d of a.dos) {
    const it = get(instanceId(d.path) + '>' + d.index);
    Object.assign(it, { form: d.form, parent: instanceId(d.path), doIndex: d.index, doName: d.name, res: d.res, depth: d.path.length + 1, bytes: d.form.bytes });
  }
  for (const ev of a.evs) {
    const set = removals.get(ev.k);
    if (set) get(instanceId(ev.path)).edits.push({ index: ev.index, remove: set, ev });
  }
  // Every instance on the way to a changed one changes too (it must draw the copy).
  const changed = new Set([...inst.values()].filter((x) => x.edits.length).map((x) => x.id));
  for (const id of [...changed]) { let p = inst.get(id).parent; while (p) { changed.add(p); p = inst.get(p) && inst.get(p).parent; } }
  const order = [...changed].map((id) => inst.get(id)).sort((x, y) => (y.depth || 0) - (x.depth || 0));
  for (const it of order) {
    let res = null;
    const renames = [];
    if (it.swaps.length) {
      // A copy of the resources the forms were found in, with the copies in their place.
      const ops = C.parseOps(it.bytes);
      res = it.swaps[0].res.clone(ctx);
      const old = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
      const xo = old ? old.clone(ctx) : ctx.obj({});
      res.set(PDFName.of('XObject'), xo);
      const uses = (name) => ops.filter((o) => o.op === 'Do' && o.args[0] && o.args[0].name === name).length;
      for (const sw of it.swaps) {
        if (uses(sw.name) === 1) { xo.set(PDFName.of(sw.name), sw.ref); continue; }
        let name;
        do name = 'DDx' + uniq(); while (xo.has(PDFName.of(name)));
        xo.set(PDFName.of(name), sw.ref);
        renames.push({ index: sw.index, rename: name });
      }
      // A name whose every use now draws a copy is dropped (so the original can go).
      for (const sw of it.swaps) if (uses(sw.name) > 1 && it.swaps.filter((x) => x.name === sw.name).length === uses(sw.name)) xo.delete(PDFName.of(sw.name));
    }
    const out = C.rewriteContent(it.bytes, [...it.edits, ...renames]);
    if (!out) return false;
    if (it.id === 'page') {
      // Balance q/Q so the new text is drawn in the page's own space.
      let depth = 0;
      for (const o of C.parseOps(out)) { if (o.op === 'q') depth++; else if (o.op === 'Q' && depth > 0) depth--; }
      const wrapped = new Uint8Array(out.length + 4 + (depth + 1) * 2);
      wrapped.set([113, 10]); wrapped.set(out, 2);
      let at = out.length + 2;
      wrapped[at++] = 10;
      for (let i = 0; i <= depth; i++) { wrapped[at++] = 81; wrapped[at++] = 10; }
      a.pg.node.set(PDFName.of('Contents'), ctx.register(flate(ctx, wrapped.subarray(0, at), null)));
      if (res) a.pg.node.set(PDFName.of('Resources'), res);
      a.wrapped = true;
    } else {
      const copy = flate(ctx, out, it.form.stream.dict);
      // A form without resources of its own used the ones it was drawn with: the copy gets those (copied) too.
      if (res) copy.dict.set(PDFName.of('Resources'), res);
      else if (!it.form.resources) copy.dict.set(PDFName.of('Resources'), it.res);
      inst.get(it.parent).swaps.push({ index: it.doIndex, name: it.doName, ref: ctx.register(copy), res: it.res });
    }
  }
  return true;
}

/** Put the page's own content between q and Q (closing any q it leaves open), so text added after it starts clean. */
function wrapPage(doc, a) {
  if (a.wrapped) return;
  const { PDFName, PDFArray } = lib();
  const ctx = doc.context, node = a.pg.node;
  let depth = 0;
  if (a.content) { try { for (const o of C.parseOps(a.content)) { if (o.op === 'q') depth++; else if (o.op === 'Q' && depth > 0) depth--; } } catch { depth = 0; } }
  const cur = node.get(PDFName.of('Contents'));
  const list = cur ? (ctx.lookup(cur) instanceof PDFArray ? ctx.lookup(cur).asArray() : [cur]) : [];
  const enc = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  const open = ctx.register(ctx.stream(enc('q\n'))), close = ctx.register(ctx.stream(enc('\n' + 'Q\n'.repeat(depth + 1))));
  node.set(PDFName.of('Contents'), ctx.obj([open, ...list, close]));
  a.wrapped = true;
}

/** A Flate stream with `bytes`, keeping the other entries of `dict` (a form's BBox, Matrix, Resources…). */
function flate(ctx, bytes, dict) {
  const { PDFName, PDFRawStream } = lib();
  const d = dict ? dict.clone(ctx) : ctx.obj({});
  for (const k of ['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms']) d.delete(PDFName.of(k));
  d.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  return PDFRawStream.of(d, self.pako.deflate(bytes));
}

/**
 * A run's advance at size 1, with letter spacing (every glyph) and word spacing (spaces of single-byte fonts: the standard
 * ones; the bundled fonts are written with 2-byte codes, where PDF word spacing doesn't apply).
 */
function runWidth(run, pc) {
  const chars = Array.from(run.text);
  const glyphs = run.font.embedder && run.font.embedder.font && run.font.embedder.font.layout ? null : chars.length;
  const count = glyphs != null ? glyphs : run.font.embedder.font.layout(run.text).glyphs.length;
  const single = !run.font.embedder || !run.font.embedder.font || !run.font.embedder.font.layout;
  return run.font.widthOfTextAtSize(run.text, 1) + (pc.tc || 0) * count + (single ? (pc.tw || 0) * chars.filter((c) => c === ' ').length : 0);
}

/** Draw texts and covers on a page with raw operators (exact matrices; one text object per run). */
async function drawOn(doc, page, bank, { covers = [], draws = [] }, bg = [1, 1, 1]) {
  const ops = [];
  for (const c of covers) {
    const [a, b, cc, d] = c.lin;
    ops.push(op('q'), op('rg', n(bg[0]), n(bg[1]), n(bg[2])), op('cm', n(a), n(b), n(cc), n(d), n(c.origin[0]), n(c.origin[1])),
      op('re', n(-0.02), n(-c.desc - 0.04), n(c.adv + 0.04), n(c.asc + c.desc + 0.08)), op('f'), op('Q'));
  }
  for (const t of draws) {
    // Each piece in its own style and size, one after the other along the line.
    const pieces = [];
    for (const pc of t.pieces) {
      const runs = await bank.runs(pc.text, pc.style);
      const em = runs.reduce((w, r) => w + runWidth(r, pc), 0);
      pieces.push({ ...pc, runs, length: em * Math.hypot(pc.lin[0], pc.lin[1]) });
    }
    const total = pieces.reduce((w, pc) => w + pc.length, 0);
    // Narrow the text a little (to 75% at most) when it would run into the next text or off the page.
    const fit = Number.isFinite(t.room) && t.room > 0 && total > t.room ? Math.max(0.75, t.room / total) : 1;
    let [x, y] = t.origin;
    for (const pc of pieces) {
      let [a, b, c, d] = pc.lin;
      a *= fit; b *= fit;
      const [r, g, bl] = hexRgb(pc.color);
      // Text state from scratch (whatever the page left set doesn't apply).
      ops.push(op('q'), op('rg', n(r), n(g), n(bl)), op('BT'), op('Tr', n(0)), op('Tc', n(pc.tc || 0)), op('Tw', n(pc.tw || 0)), op('Tz', n(100)), op('Ts', n(0)));
      for (const run of pc.runs) {
        const key = page.node.newFontDictionary('DDF', run.font.ref);
        const t1 = run.slant ? Math.tan((E.SLANT * Math.PI) / 180) : 0;
        // Skew in glyph space first: [1 0 t 1 0 0] × [a b c d x y].
        const m = [a, b, c + t1 * a, d + t1 * b, x, y];
        ops.push(op('Tf', key, n(1)), op('Tm', ...m.map(n)), op('Tj', run.font.encodeText(run.text)));
        const w = runWidth(run, pc);
        x += a * w; y += b * w;
      }
      ops.push(op('ET'), op('Q'));
    }
  }
  if (ops.length) page.pushOperators(...ops);
  return ops.length;
}

/** Added text boxes on a page: {x, y (view, top-left), size, text, family, bold, italic, color, align}. */
function addDraws(a, adds) {
  const out = [];
  for (const t of adds) {
    const lines = E.cleanText(t.text, { multiline: true }).split('\n');
    const lh = E.METRICS.line * t.size;
    lines.forEach((text, i) => {
      if (!text.trim()) return;
      const vy = t.y + E.firstBaseline() * t.size + i * lh;
      out.push({ text, vx: t.x, vy, t });
    });
  }
  return out;
}

/** Apply edits ({line, old, text}) and added boxes to page analysis `a` of `doc`. Returns {checks, covered}. */
async function applyPage(doc, a, edits, adds, bank) {
  const plan = planPage(a, edits);
  let covered = plan.covers.length;
  if (!removeGlyphs(doc, a, plan.removals)) {
    // Couldn't write the cut: cover these lines instead (said in the result).
    for (const e of edits) {
      const l = a.lines[e.line];
      if (l.mode === 'remove') l.mode = 'cover';
    }
    return applyPage(doc, a, edits, adds, bank);
  }
  // Added boxes: in view space, turned to user space (upright on a rotated page).
  const draws = [...plan.draws];
  const pending = addDraws(a, adds);
  const widths = new Map();
  for (const p of pending) {
    const runs = await bank.runs(p.text, { family: p.t.family, bold: p.t.bold, italic: p.t.italic });
    widths.set(p, runs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, 1), 0) * p.t.size);
  }
  // Alignment: within the box, as wide as its longest line.
  const boxWidth = new Map();
  for (const p of pending) boxWidth.set(p.t, Math.max(boxWidth.get(p.t) || 0, widths.get(p)));
  for (const p of pending) {
    const bw = boxWidth.get(p.t), w = widths.get(p);
    const dx = p.t.align === 'center' ? (bw - w) / 2 : p.t.align === 'right' ? bw - w : 0;
    const o = C.viewToUserPoint(a.box, a.rot, p.vx + dx, p.vy);
    const ox = C.viewToUserPoint(a.box, a.rot, p.vx + dx + 1, p.vy);
    const oy = C.viewToUserPoint(a.box, a.rot, p.vx + dx, p.vy - 1);
    const s = p.t.size;
    draws.push({ pieces: [{ text: p.text, lin: [(ox[0] - o[0]) * s, (ox[1] - o[1]) * s, (oy[0] - o[0]) * s, (oy[1] - o[1]) * s], color: p.t.color, style: { family: p.t.family, bold: p.t.bold, italic: p.t.italic } }], origin: o, room: Infinity });
  }
  if (plan.covers.length || draws.length) wrapPage(doc, a);
  await drawOn(doc, a.pg, bank, { covers: plan.covers, draws });
  return { checks: plan.checks, covered, added: adds };
}

/** Edits and adds grouped by page number. */
function byPage(edits = [], adds = []) {
  const m = new Map();
  const get = (p) => { if (!m.has(p)) m.set(p, { edits: [], adds: [] }); return m.get(p); };
  for (const e of edits) get(e.page).edits.push(e);
  for (const t of adds) get(t.page).adds.push(t);
  return m;
}

const squash = (s) => nfkc(s).replace(/\s+/g, '');
const count = (hay, needle) => { if (!needle) return 0; let c = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0) c++; return c; };
async function pageTexts(jsDoc, pages) {
  const out = new Map();
  for (const n of pages) {
    const page = await jsDoc.getPage(n);
    try { out.set(n, squash((await page.getTextContent()).items.map((i) => i.str || '').join(''))); } finally { page.cleanup(); }
  }
  return out;
}

/**
 * Save: {bytes, limits, password, edits: [{page, line, old, text}], adds: [{page, x, y, size, text, family, bold, italic,
 * color, align}]} → {bytes, pages, edited, added, covered, verify: {ok, problems}}.
 */
export async function save({ bytes, limits, password, edits = [], adds = [] }) {
  const { doc, jsDoc } = await openBoth(bytes, limits, password);
  const groups = byPage(edits, adds);
  if (!groups.size) throw new UserError('Change some text first.');
  const bank = fontBank(doc);
  const results = new Map();
  let before;
  try {
    for (const [p, g] of [...groups].sort((x, y) => x[0] - y[0])) {
      if (!(p >= 1 && p <= doc.getPageCount())) throw new UserError('The PDF changed since it was opened. Open Edit PDF text again.');
      const a = await analyse(jsDoc, doc, p);
      results.set(p, await applyPage(doc, a, g.edits, g.adds, bank));
    }
    before = await pageTexts(jsDoc, [...groups.keys()]);
  } finally { await closeJs(jsDoc); }
  prune(doc);
  doc.setProducer('DropDial');
  doc.setModificationDate(new Date());
  const out = await doc.save(SAVE);
  // Read it back: the old text must be gone (where it was removed), the new text there.
  const problems = [];
  const after = await withJs(out, limits, (d) => pageTexts(d, [...groups.keys()]));
  let edited = 0, added = 0, covered = 0;
  for (const [p, r] of results) {
    const text = after.get(p), was = before.get(p);
    covered += r.covered;
    const removed = new Map(), wanted = new Map();
    for (const c of r.checks) {
      edited++;
      const o = squash(c.old), w = squash(c.add);
      if (o && !c.cover) removed.set(o, (removed.get(o) || 0) + 1);
      if (w && !/[ऀ-ॿ]/.test(w)) wanted.set(w, (wanted.get(w) || 0) + 1);
    }
    for (const t of r.added) {
      added++;
      for (const line of E.cleanText(t.text, { multiline: true }).split('\n')) { const w = squash(line); if (w && !/[ऀ-ॿ]/.test(w)) wanted.set(w, (wanted.get(w) || 0) + 1); }
    }
    for (const [o, k] of removed) {
      let comesBack = 0;
      for (const [w, kw] of wanted) comesBack += count(w, o) * kw;
      if (count(text, o) > Math.max(0, count(was, o) - k) + comesBack) problems.push(`Page ${p}: “${o}” is still in the text.`);
    }
    for (const [w, k] of wanted) if (count(text, w) < Math.min(k, 1)) problems.push(`Page ${p}: “${w}” was not found after saving.`);
  }
  return { bytes: out, pages: doc.getPageCount(), edited, added, covered, verify: { ok: !problems.length, problems } };
}

async function withJs(bytes, limits, fn) {
  const d = await openJs(bytes, limits);
  try { return await fn(d); } finally { await closeJs(d); }
}

/**
 * One page with its edits, as a picture (the same code as Save): {bytes (JPEG), width, height, page}. Only the
 * page's own edits and added boxes are drawn.
 */
export async function preview({ bytes, limits, password, page: p, edits = [], adds = [], maxSide = 1400 }) {
  const { doc, jsDoc } = await openBoth(bytes, limits, password);
  let one;
  try {
    const a = await analyse(jsDoc, doc, p);
    const bank = fontBank(doc);
    await applyPage(doc, a, edits.filter((e) => e.page === p), adds.filter((t) => t.page === p), bank);
    await doc.flush();
    one = await lib().PDFDocument.create();
    const [copy] = await one.copyPages(doc, [p - 1]);
    one.addPage(copy);
  } finally { await closeJs(jsDoc); }
  const small = await one.save(SAVE);
  return withJs(small, limits, async (d) => {
    const page = await d.getPage(1);
    try {
      const base = page.getViewport({ scale: 1 });
      const off = await drawPage(page, maxSide / Math.max(base.width, base.height), limits);
      const jpg = await blobBytes(off, 'image/jpeg', 0.9);
      const r = { bytes: jpg, width: off.width, height: off.height, page: p };
      off.width = off.height = 0;
      return r;
    } finally { page.cleanup(); }
  });
}

// Exposed for tests.
export const _internal = { analyse, openBoth, pageContent, planPage };

// The bundled fonts, loaded once, and putting a page's own content between q and Q, for Edit image text too
// (src/processor/image-text.js).
export { kitFont, fontFile, fontkit as loadFontkit, wrapPage, pageContent };
