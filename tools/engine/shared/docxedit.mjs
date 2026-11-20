// Edit Word text: the logic shared by the app's window, the website's page and the processor (src/processor/docx-edit.js).
// Pure code, no DOM: a small XML reader that keeps every element's place in the source text, the document model the
// windows show (paragraphs with their runs, pictures, tables, headers, footers, notes and text boxes), the plan that
// says which runs a changed paragraph touches, and the writer that changes only those w:t elements in the part's own
// text — everything else in the file keeps its exact bytes. See docs/rebuild/EDIT-WORD-TEXT.md.
import { findPattern, changeLabel, isDeva, fontStyle, CSS_FAMILY } from './pdfedit.mjs';

export { changeLabel };

// ------------------------------------------------------------------ limits and words
export const DOCX = Object.freeze({
  textMax: 20000, // characters in one paragraph after an edit
  edits: 5000, // changed paragraphs in one save
  adds: 500, // added paragraphs
  findMax: 200,
  matchesMax: 5000,
  xmlMax: 64 * 1024 * 1024, // one XML part, uncompressed
  fileMax: 500 * 1024 * 1024, // the .docx itself
  picMax: 15 * 1024 * 1024, // one picture shown in the window
  picsMax: 60 * 1024 * 1024, // all pictures shown
  paras: 200000,
  units: 1000, // marked parts (fields, pictures…) in one paragraph
  depth: 256, // XML nesting
});
export const SUFFIX = 'edited';

/** An error written for people (shown as it is). */
export class DocxError extends Error { constructor(message) { super(message); this.user = true; } }

export const MSG = Object.freeze({
  damaged: 'This Word document couldn’t be read. It may be damaged.',
  encrypted: 'This Word document is protected with a password, so it can’t be opened here. Open it in Word, remove the password (File → Info → Protect Document → Encrypt with Password), save it, and try again.',
  oldDoc: 'This is an older Word document (.doc), even though its name ends in .docx. Open it in Word, Pages, LibreOffice or Google Docs and save it as a Word document (.docx) first.',
  unsupported: 'This document contains unsupported content, so it wasn’t opened.',
  tooLarge: 'This Word document is too large to open.',
  changed: 'The document changed since it was opened. Close this window and open it again.',
  tracked: 'This paragraph has tracked changes. Accept or reject them in Word first: DropDial doesn’t change text that is waiting for review.',
  toc: 'This is part of a table of contents. Word makes it from the headings: change a heading, then update the table in Word.',
  fieldPara: 'This paragraph is made by a field, and Word fills it in, so it can’t be changed here.',
  control: 'This paragraph is in a locked content control, so it can’t be changed here.',
  complex: 'This paragraph has too many fields and pictures to change here.',
  noUnits: 'Pictures, fields and other marked parts (shown with a grey background) can’t be moved, copied or deleted here. Change only the text around them.',
  here: 'Text can’t be added at this spot: it is inside a field.',
});

/**
 * How to change the words of another kind of document (by extension), or ''. DropDial can't turn these into .docx
 * itself, so the note names the apps that can.
 */
export function otherFormatNote(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'doc') return 'To change its words, open it in Word, Pages, LibreOffice or Google Docs, save it as a Word document (.docx), then use Edit Word text.';
  if (e === 'odt') return 'To change its words, save it as Word (.docx) in LibreOffice (File → Save As), then use Edit Word text.';
  if (e === 'rtf') return 'To change its words, save it as a Word document (.docx) in Word, LibreOffice or Pages, then use Edit Word text.';
  if (e === 'pages') return 'To change its words, export it as Word in Pages (File → Export To → Word), then use Edit Word text.';
  if (e === 'docm' || e === 'dotx' || e === 'dotm') return 'To change its words, save it as a Word document (.docx) in Word, then use Edit Word text.';
  return '';
}

// ------------------------------------------------------------------ marked parts in a paragraph's code
// A paragraph's text is edited as its "code": its characters, with each marked part (a field result, a picture, a
// note mark…) as one character from the end of Unicode's private use plane 16, which no document uses.
const LOCK0 = 0x10fc00;
export const lockChar = (k) => String.fromCodePoint(LOCK0 + k);
export function lockIndex(s, at = 0) { const c = String(s).codePointAt(at); return c >= LOCK0 && c < LOCK0 + 1024 ? c - LOCK0 : -1; }
const LOCK_RE = /[\u{10FC00}-\u{10FFFF}]/u;
const LOCKS_RE = /[\u{10FC00}-\u{10FFFF}]/gu;
export const hasLock = (s) => LOCK_RE.test(String(s));
const locksOf = (s) => String(s).match(LOCKS_RE) || [];

// ------------------------------------------------------------------ XML
const NS = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup': 'wpg',
  'urn:schemas-microsoft-com:vml': 'v',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'pr',
  'http://schemas.microsoft.com/office/word/2010/wordml': 'w14',
};
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const bad = () => { throw new DocxError(MSG.damaged); };

/** XML text with its five entities and character references read. */
export function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    if (ENT[e] === undefined) bad();
    return ENT[e];
  });
}
/** Text for XML: &, <, > escaped; characters XML 1.0 can't hold are left out. */
export function escapeXml(s) {
  return String(s).replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const ATTR = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Read XML into elements that know where they are in the source: {name, prefix, local, k ("w:p"), attrs [[name, value]],
 * start, openEnd (after the start tag), closeStart, end, self (written <x/>), kids, parent}. A DTD or entity
 * declaration is refused (Word never needs one, and it rules out entity attacks).
 */
export function parseXml(src) {
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new DocxError(MSG.unsupported);
  const root = { k: '#root', name: '#root', kids: [], ns: Object.assign(Object.create(null), { xml: XML_NS }), parent: null };
  const stack = [root];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const c = src.charCodeAt(lt + 1);
    if (c === 63) { const e = src.indexOf('?>', lt + 2); if (e < 0) bad(); i = e + 2; continue; }
    if (c === 33) {
      if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) bad(); i = e + 3; continue; }
      if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); if (e < 0) bad(); i = e + 3; continue; }
      bad();
    }
    if (c === 47) {
      const e = src.indexOf('>', lt + 2);
      if (e < 0) bad();
      const top = stack.pop();
      if (top === root || top.name !== src.slice(lt + 2, e).trim()) bad();
      top.closeStart = lt; top.end = e + 1;
      i = e + 1;
      continue;
    }
    let j = lt + 1, q = 0;
    for (; j < n; j++) {
      const ch = src.charCodeAt(j);
      if (q) { if (ch === q) q = 0; } else if (ch === 34 || ch === 39) q = ch; else if (ch === 62) break;
    }
    if (j >= n) bad();
    const self = src.charCodeAt(j - 1) === 47;
    const body = src.slice(lt + 1, self ? j - 1 : j);
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    if (!name || /[<>"'=&]/.test(name)) bad();
    const attrs = [];
    if (sp >= 0) {
      const rest = body.slice(sp);
      ATTR.lastIndex = 0;
      let m;
      while ((m = ATTR.exec(rest))) attrs.push([m[1], unescapeXml(m[2] !== undefined ? m[2] : m[3])]);
    }
    const parent = stack[stack.length - 1];
    let scope = parent.ns;
    for (const [an, av] of attrs) {
      if (an !== 'xmlns' && !an.startsWith('xmlns:')) continue;
      if (scope === parent.ns) scope = Object.create(parent.ns);
      scope[an === 'xmlns' ? '' : an.slice(6)] = av;
    }
    const colon = name.indexOf(':');
    const prefix = colon < 0 ? '' : name.slice(0, colon);
    const local = colon < 0 ? name : name.slice(colon + 1);
    const node = { name, prefix, local, k: (NS[scope[prefix]] || '?') + ':' + local, attrs, ns: scope, start: lt, openEnd: j + 1, closeStart: j + 1, end: j + 1, self, kids: [], parent };
    parent.kids.push(node);
    if (!self) { stack.push(node); if (stack.length > DOCX.depth) throw new DocxError(MSG.unsupported); }
    i = j + 1;
  }
  if (stack.length !== 1) bad();
  return root;
}
/** The text inside an element (entities and CDATA read). */
export function innerText(src, node) {
  if (node.self) return '';
  const s = src.slice(node.openEnd, node.closeStart);
  if (s.indexOf('<') < 0) return unescapeXml(s);
  let out = '';
  for (const part of s.split(/(<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>)/)) {
    if (part.startsWith('<![CDATA[')) out += part.slice(9, -3);
    else if (!part.startsWith('<')) out += unescapeXml(part);
  }
  return out;
}
const attr = (el, local) => { if (!el) return null; for (const [n, v] of el.attrs) { const c = n.indexOf(':'); if ((c < 0 ? n : n.slice(c + 1)) === local) return v; } return null; };
const kid = (el, k) => (el ? el.kids.find((c) => c.k === k) || null : null);
const kidsOf = (el, k) => (el ? el.kids.filter((c) => c.k === k) : []);
const docEl = (root) => root.kids[0] || null;
function* descend(el) { for (const c of el.kids) { yield c; yield* descend(c); } }
/** Descendants, without going into elements of kind `skip` (they are yielded, their insides aren't). */
function* descendSkip(el, skip) { for (const c of el.kids) { yield c; if (c.k !== skip) yield* descendSkip(c, skip); } }
const hasAncestor = (x, k, stop) => { for (let a = x.parent; a && a !== stop; a = a.parent) if (a.k === k) return true; return false; };
const findDeep = (el, k) => { if (!el) return null; for (const c of descend(el)) if (c.k === k) return c; return null; };
const onOff = (el) => !!el && !/^(0|false|off|none)$/i.test(attr(el, 'val') || '');
const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

// ------------------------------------------------------------------ the package
const uncompressed = (f) => (f && f._data && Number.isFinite(f._data.uncompressedSize) ? f._data.uncompressedSize : 0);
async function partText(zip, name, required = false) {
  const f = name && zip.file(name);
  if (!f) { if (required) bad(); return null; }
  if (uncompressed(f) > DOCX.xmlMax) throw new DocxError(MSG.tooLarge);
  const s = await f.async('string');
  if (s.length > DOCX.xmlMax) throw new DocxError(MSG.tooLarge);
  return s;
}
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
const relsName = (p) => dirOf(p) + '_rels/' + p.slice(p.lastIndexOf('/') + 1) + '.rels';
function resolvePath(base, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const parts = (target.startsWith('/') ? target.slice(1) : base + target).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') { if (!out.length) return null; out.pop(); } else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
/** A part's relationships: id → {type (last word), target (path in the package or external URL), external}. */
async function relsOf(zip, part) {
  const map = new Map();
  const s = await partText(zip, relsName(part));
  if (!s) return map;
  for (const r of descend(parseXml(s))) {
    if (r.local !== 'Relationship') continue;
    const external = /^external$/i.test(attr(r, 'TargetMode') || '');
    const target = attr(r, 'Target') || '';
    const type = (attr(r, 'Type') || '').split('/').pop();
    map.set(attr(r, 'Id'), { type, external, target: external ? target : resolvePath(dirOf(part), target) });
  }
  return map;
}

/** Is this a password-protected Office file (an OLE container with an EncryptedPackage), an old .doc, or neither? */
export function oleKind(b) {
  if (!(b && b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)) return null;
  const has = (word) => {
    const t = Array.from(word, (ch) => [ch.charCodeAt(0), 0]).flat();
    outer: for (let i = 0; i + t.length <= b.length; i++) { for (let k = 0; k < t.length; k++) if (b[i + k] !== t[k]) continue outer; return true; }
    return false;
  };
  if (has('EncryptedPackage') || has('EncryptionInfo')) return 'encrypted';
  if (has('WordDocument')) return 'doc';
  return 'ole';
}

// ------------------------------------------------------------------ styles (for showing the document)
const HL = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };
const hex = (v) => (v && /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : null);

/** Run properties from a w:rPr element (only those the window shows). */
function rprOf(rPr, theme) {
  const o = {};
  if (!rPr) return o;
  for (const c of rPr.kids) {
    switch (c.k) {
      case 'w:b': o.b = onOff(c); break;
      case 'w:bCs': o.csB = onOff(c); break;
      case 'w:i': o.i = onOff(c); break;
      case 'w:iCs': o.csI = onOff(c); break;
      case 'w:u': { const v = attr(c, 'val') || 'single'; o.u = v === 'none' ? '' : v; break; }
      case 'w:strike': o.s = onOff(c); break;
      case 'w:dstrike': o.s = onOff(c) || o.s; break;
      case 'w:caps': o.caps = onOff(c); break;
      case 'w:smallCaps': o.sc = onOff(c); break;
      case 'w:vanish': o.hide = onOff(c); break;
      case 'w:sz': o.sz = num(attr(c, 'val'), 22) / 2; break;
      case 'w:szCs': o.csSz = num(attr(c, 'val'), 22) / 2; break;
      case 'w:color': { const v = attr(c, 'val'); o.c = v === 'auto' ? null : hex(v); break; }
      case 'w:highlight': o.hl = HL[attr(c, 'val')] || null; break;
      case 'w:shd': { const f = hex(attr(c, 'fill')); if (f) o.bg = f; break; }
      case 'w:vertAlign': { const v = attr(c, 'val'); o.va = v === 'superscript' ? 'sup' : v === 'subscript' ? 'sub' : ''; break; }
      case 'w:rFonts': {
        const th = (t) => (t && theme ? (/^major/.test(t) ? (/Bidi/.test(t) ? theme.majorCs : theme.major) : (/Bidi/.test(t) ? theme.minorCs : theme.minor)) : null);
        const f = attr(c, 'ascii') || attr(c, 'hAnsi') || th(attr(c, 'asciiTheme') || attr(c, 'hAnsiTheme'));
        if (f) o.f = f;
        const cs = attr(c, 'cs') || th(attr(c, 'cstheme'));
        if (cs) o.csF = cs;
        break;
      }
      default: break;
    }
  }
  return o;
}
/** Paragraph properties from a w:pPr element (twips → px at 96 dpi: ÷ 15). */
function pprOf(pPr) {
  const o = {};
  if (!pPr) return o;
  for (const c of pPr.kids) {
    switch (c.k) {
      case 'w:jc': { const v = attr(c, 'val'); o.al = v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v === 'both' || v === 'distribute' || /kashida/.test(v || '') ? 'justify' : 'left'; break; }
      case 'w:ind': {
        const l = attr(c, 'left') ?? attr(c, 'start'), r = attr(c, 'right') ?? attr(c, 'end');
        if (l != null) o.il = num(l) / 15;
        if (r != null) o.ir = num(r) / 15;
        if (attr(c, 'hanging') != null) { o.fi = -num(attr(c, 'hanging')) / 15; }
        else if (attr(c, 'firstLine') != null) o.fi = num(attr(c, 'firstLine')) / 15;
        break;
      }
      case 'w:spacing': {
        if (attr(c, 'before') != null) o.sb = num(attr(c, 'before')) / 15;
        if (onOff({ attrs: [['val', attr(c, 'beforeAutospacing') || '0']] })) o.sb = 14 * 4 / 3;
        if (attr(c, 'after') != null) o.sa = num(attr(c, 'after')) / 15;
        if (onOff({ attrs: [['val', attr(c, 'afterAutospacing') || '0']] })) o.sa = 14 * 4 / 3;
        if (attr(c, 'line') != null) { const rule = attr(c, 'lineRule') || 'auto'; o.lh = rule === 'auto' ? { m: num(attr(c, 'line'), 240) / 240 } : { px: num(attr(c, 'line'), 240) / 15 }; }
        break;
      }
      case 'w:numPr': {
        const id = attr(kid(c, 'w:numId'), 'val'), lv = attr(kid(c, 'w:ilvl'), 'val');
        if (id != null) o.numId = id;
        if (lv != null) o.ilvl = Math.max(0, Math.min(8, parseInt(lv, 10) || 0));
        break;
      }
      case 'w:outlineLvl': o.ol = num(attr(c, 'val'), 9); break;
      case 'w:contextualSpacing': o.ctx = onOff(c); break;
      case 'w:shd': { const f = hex(attr(c, 'fill')); if (f) o.bg = f; break; }
      case 'w:pageBreakBefore': o.pb = onOff(c); break;
      default: break;
    }
  }
  return o;
}

class Styles {
  constructor(tree, theme, numbering) {
    this.theme = theme;
    this.byId = new Map();
    this.defR = {}; this.defP = {};
    this.defPara = null; this.defChar = null; this.defTable = null;
    const root = tree && docEl(tree);
    if (root) {
      const dd = kid(root, 'w:docDefaults');
      this.defR = rprOf(kid(kid(dd, 'w:rPrDefault'), 'w:rPr'), theme);
      this.defP = pprOf(kid(kid(dd, 'w:pPrDefault'), 'w:pPr'));
      for (const s of kidsOf(root, 'w:style')) {
        const id = attr(s, 'styleId');
        const type = attr(s, 'type') || 'paragraph';
        const st = { id, type, name: (attr(kid(s, 'w:name'), 'val') || id || '').toLowerCase(), basedOn: attr(kid(s, 'w:basedOn'), 'val'),
          r: rprOf(kid(s, 'w:rPr'), theme), p: pprOf(kid(s, 'w:pPr')), borders: tableBorders(kid(kid(s, 'w:tblPr'), 'w:tblBorders')) };
        this.byId.set(id, st);
        if (onOff({ attrs: [['val', attr(s, 'default') || '0']] })) { if (type === 'paragraph') this.defPara = id; else if (type === 'character') this.defChar = id; else if (type === 'table') this.defTable = id; }
      }
    }
    this.numbering = numbering;
    this.cache = new Map();
  }
  chain(id) {
    const out = [];
    for (let s = this.byId.get(id), n = 0; s && n < 30; s = this.byId.get(s.basedOn), n++) out.unshift(s);
    return out;
  }
  /** Paragraph properties of a style (with what it is based on). */
  paraStyle(id) {
    const key = 'p' + id;
    if (!this.cache.has(key)) {
      const chain = this.chain(this.byId.has(id) ? id : this.defPara);
      const p = Object.assign({}, ...chain.map((s) => s.p));
      const r = Object.assign({}, ...chain.map((s) => s.r));
      const leaf = chain[chain.length - 1];
      this.cache.set(key, { p, r, name: leaf ? leaf.name : '', id: leaf ? leaf.id : null });
    }
    return this.cache.get(key);
  }
  charStyle(id) {
    const key = 'c' + id;
    if (!this.cache.has(key)) this.cache.set(key, Object.assign({}, ...this.chain(id).map((s) => s.r)));
    return this.cache.get(key);
  }
  tableStyle(id) {
    const key = 't' + id;
    if (!this.cache.has(key)) {
      const chain = this.chain(id || this.defTable);
      this.cache.set(key, { p: Object.assign({}, ...chain.map((s) => s.p)), r: Object.assign({}, ...chain.map((s) => s.r)), borders: chain.reduce((b, s) => (s.borders == null ? b : s.borders), null) });
    }
    return this.cache.get(key);
  }
}
function tableBorders(el) {
  if (!el) return null;
  const sides = el.kids.filter((c) => /^w:(top|left|bottom|right|start|end|insideH|insideV)$/.test(c.k));
  if (!sides.length) return null;
  return sides.some((c) => !/^(nil|none)$/i.test(attr(c, 'val') || 'none'));
}

function readTheme(tree) {
  const t = { major: null, minor: null, majorCs: null, minorCs: null };
  if (!tree) return t;
  for (const el of descend(tree)) {
    if (el.k !== 'a:majorFont' && el.k !== 'a:minorFont') continue;
    const which = el.k === 'a:majorFont' ? 'major' : 'minor';
    t[which] = attr(kid(el, 'a:latin'), 'typeface') || null;
    t[which + 'Cs'] = attr(kid(el, 'a:cs'), 'typeface') || null;
  }
  return t;
}

// ------------------------------------------------------------------ list numbers
const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = (n) => { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const letters = (n) => { if (n < 1) return ''; const c = String.fromCharCode(97 + ((n - 1) % 26)); return c.repeat(Math.floor((n - 1) / 26) + 1); };
const BULLETS = { '': '•', '': '▪', '': '➢', '': '✓', '': '❖', '': '◦', '': '●', '': '■', '': '➔', '': '•', o: '◦', '': '' };
function formatNumber(n, fmt) {
  switch (fmt) {
    case 'none': return '';
    case 'decimalZero': return n < 10 ? '0' + n : String(n);
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'ordinal': return n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
    case 'hindiNumbers': case 'hindiCounting': return String(n).replace(/\d/g, (d) => String.fromCharCode(0x966 + Number(d)));
    default: return String(n);
  }
}
function readNumbering(tree) {
  const abs = new Map(), nums = new Map();
  const root = tree && docEl(tree);
  if (!root) return { abs, nums };
  for (const a of kidsOf(root, 'w:abstractNum')) {
    const levels = new Map();
    for (const l of kidsOf(a, 'w:lvl')) {
      levels.set(parseInt(attr(l, 'ilvl'), 10) || 0, { start: parseInt(attr(kid(l, 'w:start'), 'val'), 10) || (attr(kid(l, 'w:start'), 'val') === '0' ? 0 : 1),
        fmt: attr(kid(l, 'w:numFmt'), 'val') || 'decimal', text: attr(kid(l, 'w:lvlText'), 'val') ?? '', p: pprOf(kid(l, 'w:pPr')), r: rprOf(kid(l, 'w:rPr'), null), suff: attr(kid(l, 'w:suff'), 'val') || 'tab' });
    }
    abs.set(attr(a, 'abstractNumId'), { levels, link: attr(kid(a, 'w:numStyleLink'), 'val') });
  }
  for (const nEl of kidsOf(root, 'w:num')) {
    const over = new Map();
    for (const o of kidsOf(nEl, 'w:lvlOverride')) {
      const s = attr(kid(o, 'w:startOverride'), 'val');
      if (s != null) over.set(parseInt(attr(o, 'ilvl'), 10) || 0, parseInt(s, 10) || 0);
    }
    nums.set(attr(nEl, 'numId'), { abs: attr(kid(nEl, 'w:abstractNumId'), 'val'), over });
  }
  return { abs, nums };
}

// ------------------------------------------------------------------ the scan
const FIELD_NAMES = { PAGE: 'Page number', NUMPAGES: 'Number of pages', SECTIONPAGES: 'Number of pages', DATE: 'Date', TIME: 'Time', CREATEDATE: 'Date', SAVEDATE: 'Date',
  PRINTDATE: 'Date', TOC: 'Table of contents', REF: 'Cross-reference', PAGEREF: 'Cross-reference', NOTEREF: 'Cross-reference', SEQ: 'Caption number', MERGEFIELD: 'Mail-merge field',
  DOCPROPERTY: 'Document property', FILENAME: 'File name', AUTHOR: 'Author', TITLE: 'Title', IF: 'Formula', '=': 'Formula', STYLEREF: 'Heading', INDEX: 'Index', ASK: 'Field', FORMCHECKBOX: 'Check box', FORMDROPDOWN: 'Drop-down' };
// Fields whose result Word keeps as typed: their text can be changed.
const FREE_FIELDS = new Set(['HYPERLINK', 'FORMTEXT']);
// Marks that are not text: their label is shown, but find doesn't see it.
const TEXTLESS = new Set(['pic', 'box', 'obj', 'break', 'math']);
const fieldType = (code) => { const m = /^\s*(=|[A-Za-z]+)/.exec(code || ''); return m ? m[1].toUpperCase() : ''; };
const fieldTitle = (type) => `${FIELD_NAMES[type] || 'Field'}: Word fills this in, so it can’t be changed here.`;
const SYMBOLS = { F0B7: '•', F0A7: '▪', F0FC: '✓', F0E0: '→', F0D8: '➢', F06C: '●', F0A8: '◦', F071: '☐', F078: '☒', F0FE: '☑' };

/**
 * Read a .docx (a JSZip instance) into the model the windows show and the context the save needs. Returns
 * {model, ctx}. model: {page, styles, stories, paras, order, info}; see docs/rebuild/EDIT-WORD-TEXT.md.
 */
export async function scanDocx(zip, { images = true } = {}) {
  const pkgRels = await relsOf(zip, '');
  let mainPath = 'word/document.xml';
  for (const r of pkgRels.values()) if (r.type === 'officeDocument' && r.target && !r.external) mainPath = r.target;
  // the package rels live at _rels/.rels: relsOf('') reads "_rels/.rels"
  const mainSrc = await partText(zip, mainPath, true);
  const docRels = await relsOf(zip, mainPath);
  const byType = (t) => [...docRels.values()].filter((r) => r.type === t && !r.external && r.target).map((r) => r.target);
  const readTree = async (p) => { const s = await partText(zip, p); return s ? parseXml(s) : null; };
  const theme = readTheme(await readTree(byType('theme')[0]));
  const numbering = readNumbering(await readTree(byType('numbering')[0]));
  const styles = new Styles(await readTree(byType('styles')[0]), theme, numbering);
  const settings = await readTree(byType('settings')[0]);
  const info = { track: !!(settings && findDeep(docEl(settings), 'w:trackRevisions') && onOff(findDeep(docEl(settings), 'w:trackRevisions'))),
    protect: (() => { const p = settings && findDeep(docEl(settings), 'w:documentProtection'); return p && onOff({ attrs: [['val', attr(p, 'enforcement') || '0']] }) ? attr(p, 'edit') || 'readOnly' : null; })() };

  const S = new Scan(zip, styles, numbering, images);
  const main = S.addPart(mainPath, mainSrc, 'body', docRels);
  const body = kid(docEl(main.tree), 'w:body');
  if (!body) bad();
  // Page size and margins from the last section.
  const sect = kid(body, 'w:sectPr');
  const pg = kid(sect, 'w:pgSz'), mar = kid(sect, 'w:pgMar');
  const model = S.model;
  model.page = { w: num(attr(pg, 'w'), 12240) / 15, h: num(attr(pg, 'h'), 15840) / 15, ml: num(attr(mar, 'left'), 1440) / 15, mr: num(attr(mar, 'right'), 1440) / 15, mt: num(attr(mar, 'top'), 1440) / 15, mb: num(attr(mar, 'bottom'), 1440) / 15 };
  model.page.w = Math.max(200, Math.min(4000, model.page.w));
  model.page.ml = Math.max(0, Math.min(model.page.w / 3, model.page.ml)); model.page.mr = Math.max(0, Math.min(model.page.w / 3, model.page.mr));
  model.info = info;

  // Headers and footers, in the order the sections name them.
  const sects = [...descend(body)].filter((e) => e.k === 'w:sectPr');
  const hf = [];
  sects.forEach((s, si) => {
    for (const ref of s.kids) {
      if (ref.k !== 'w:headerReference' && ref.k !== 'w:footerReference') continue;
      const r = docRels.get(attr(ref, 'id'));
      if (!r || r.external || !r.target || hf.some((x) => x.path === r.target)) continue;
      const type = attr(ref, 'type') || 'default';
      const kind = ref.k === 'w:headerReference' ? 'header' : 'footer';
      hf.push({ path: r.target, kind, label: (kind === 'header' ? 'Header' : 'Footer') + (type === 'first' ? ' · first page' : type === 'even' ? ' · even pages' : '') + (sects.length > 1 ? ` · section ${si + 1}` : '') });
    }
  });
  const bodyStory = S.story('body', 'Document', main);
  bodyStory.blocks = await S.walkBlocks(body, main, bodyStory, { fields: [] });
  for (const x of hf) {
    const src = await partText(zip, x.path);
    if (!src) continue;
    const part = S.addPart(x.path, src, x.kind, await relsOf(zip, x.path));
    const st = S.story(x.kind, x.label, part);
    st.blocks = await S.walkBlocks(docEl(part.tree), part, st, { fields: [] });
  }
  for (const [type, kind, label] of [['footnotes', 'footnote', 'Footnotes'], ['endnotes', 'endnote', 'Endnotes']]) {
    const p = byType(type)[0];
    const src = p && await partText(zip, p);
    if (!src) continue;
    const part = S.addPart(p, src, kind + 's', await relsOf(zip, p));
    const st = S.story('notes', label, part);
    st.blocks = [];
    const nums = kind === 'footnote' ? S.footNums : S.endNums;
    const notes = kidsOf(docEl(part.tree), 'w:' + kind).filter((n) => !/separator|continuation/i.test(attr(n, 'type') || ''));
    notes.sort((a, b) => (nums.get(attr(a, 'id')) || 1e9) - (nums.get(attr(b, 'id')) || 1e9));
    for (const n of notes) {
      const no = nums.get(attr(n, 'id'));
      if (no == null) continue; // a note nothing refers to is not shown by Word either
      S.noteLabel = kind === 'endnote' ? roman(no) : String(no);
      st.blocks.push({ t: 'note', n: S.noteLabel, blocks: await S.walkBlocks(n, part, st, { fields: [] }) });
    }
    S.noteLabel = null;
  }
  // Empty headers and footers are left out of the window (nothing to change in them).
  model.stories = model.stories.filter((s) => s.kind === 'body' || S.hasText(s.blocks));
  model.order = [];
  const orderOf = (blocks) => { for (const b of blocks) { if (b.t === 'p') model.order.push(b.key); else if (b.t === 'table') for (const r of b.rows) for (const c of r.cells) orderOf(c.blocks); else if (b.t === 'note') orderOf(b.blocks); } };
  const rank = { header: 0, body: 1, footer: 2, notes: 3, textbox: 4 };
  model.stories.sort((a, b) => rank[a.kind] - rank[b.kind]);
  for (const s of model.stories) orderOf(s.blocks);
  model.counts = { paras: model.order.length, locked: model.order.filter((k) => model.paras[k].lock).length };
  return { model, ctx: S };
}

class Scan {
  constructor(zip, styles, numbering, images) {
    this.zip = zip; this.styles = styles; this.numbering = numbering; this.images = images;
    this.parts = [];
    this.model = { styles: [], stories: [], paras: {} };
    this.styleKeys = new Map();
    this.footNums = new Map(); this.endNums = new Map();
    this.counters = new Map();
    this.boxes = 0;
    this.picBytes = 0;
    this.pics = new Map();
    this.noteLabel = null;
    this.ctxOf = new Map(); // key → save context {part, p, pieces, units, ...}
  }
  addPart(path, src, kind, rels) {
    const part = { index: this.parts.length, path, src, tree: parseXml(src), kind, rels, n: 0 };
    this.parts.push(part);
    return part;
  }
  story(kind, label, part) {
    const s = { id: 's' + this.model.stories.length, kind, label, part: part.path, blocks: [] };
    this.model.stories.push(s);
    return s;
  }
  hasText(blocks) {
    return blocks.some((b) => (b.t === 'p' ? !!this.model.paras[b.key].text.trim() || /[\u{10FC00}-\u{10FFFF}]/u.test(this.model.paras[b.key].code)
      : b.t === 'table' ? b.rows.some((r) => r.cells.some((c) => this.hasText(c.blocks))) : b.t === 'note' ? true : false));
  }
  styleIndex(o) {
    const k = JSON.stringify(o);
    let i = this.styleKeys.get(k);
    if (i === undefined) { i = this.model.styles.length; this.model.styles.push(o); this.styleKeys.set(k, i); }
    return i;
  }

  /** Blocks of a container (body, cell, header, note, text box): paragraphs, tables; content controls opened. */
  async walkBlocks(el, part, story, env) {
    const out = [];
    for (const c of el.kids) {
      if (c.k === 'w:p') out.push(await this.paragraph(c, part, story, env));
      else if (c.k === 'w:tbl') out.push(await this.table(c, part, story, env));
      else if (c.k === 'w:sdt') out.push(...await this.walkBlocks(kid(c, 'w:sdtContent') || { kids: [] }, part, story, { ...env, sdt: sdtInfo(c, env.sdt) }));
      else if (c.k === 'w:customXml' || c.k === 'w:ins' || c.k === 'w:moveTo') out.push(...await this.walkBlocks(c, part, story, env));
      else if (c.k === 'mc:AlternateContent') { const ch = kid(c, 'mc:Choice') || kid(c, 'mc:Fallback'); if (ch) out.push(...await this.walkBlocks(ch, part, story, env)); }
    }
    return out;
  }

  async table(tbl, part, story, env) {
    const tblPr = kid(tbl, 'w:tblPr');
    const styleId = attr(kid(tblPr, 'w:tblStyle'), 'val');
    const ts = this.styles.tableStyle(styleId);
    const direct = tableBorders(kid(tblPr, 'w:tblBorders'));
    const tw = kid(tblPr, 'w:tblW');
    const wType = attr(tw, 'type'), wVal = num(attr(tw, 'w'));
    const width = wType === 'pct' ? Math.min(100, wVal > 100 ? wVal / 50 : wVal) + '%' : wType === 'dxa' && wVal > 0 ? Math.round(wVal / 15) + 'px' : null;
    const rowsOf = (el) => el.kids.flatMap((c) => (c.k === 'w:tr' ? [c] : c.k === 'w:sdt' ? rowsOf(kid(c, 'w:sdtContent') || { kids: [] }) : c.k === 'w:customXml' ? rowsOf(c) : []));
    const cellsOf = (el) => el.kids.flatMap((c) => (c.k === 'w:tc' ? [c] : c.k === 'w:sdt' ? cellsOf(kid(c, 'w:sdtContent') || { kids: [] }) : c.k === 'w:customXml' ? cellsOf(c) : []));
    const rows = [];
    const tenv = { ...env, table: ts };
    for (const tr of rowsOf(tbl)) {
      const cells = [];
      for (const tc of cellsOf(tr)) {
        const pr = kid(tc, 'w:tcPr');
        const vm = kid(pr, 'w:vMerge');
        const cw = kid(pr, 'w:tcW');
        cells.push({ span: Math.max(1, Math.min(64, parseInt(attr(kid(pr, 'w:gridSpan'), 'val'), 10) || 1)), vm: vm ? (attr(vm, 'val') === 'restart' ? 'r' : 'c') : null,
          bg: hex(attr(kid(pr, 'w:shd'), 'fill')), w: attr(cw, 'type') === 'dxa' && num(attr(cw, 'w')) > 0 ? Math.round(num(attr(cw, 'w')) / 15) : null,
          blocks: await this.walkBlocks(tc, part, story, tenv) });
      }
      rows.push({ cells });
    }
    return { t: 'table', rows, borders: direct != null ? direct : !!ts.borders, width };
  }

  /** A paragraph: its pieces, marked parts, look and lock; returns {t: 'p', key}. */
  async paragraph(p, part, story, env, shadow = false) {
    const index = shadow ? -1 : part.n++;
    const key = part.index + ':' + index;
    if (!shadow && Object.keys(this.model.paras).length >= DOCX.paras) throw new DocxError(MSG.tooLarge);
    const pPr = kid(p, 'w:pPr');
    const ps = this.styles.paraStyle(attr(kid(pPr, 'w:pStyle'), 'val'));
    const tbl = env.table || { p: {}, r: {} };
    const direct = pprOf(pPr);
    const pp = { ...this.styles.defP, ...tbl.p, ...ps.p, ...direct };
    const baseR = { ...this.styles.defR, ...tbl.r, ...ps.r };
    const st = { part, p, key, pieces: [], units: [], tracked: false, fields: env.fields || [], unitOf: new Map(), boxes: [], shadow, sdt: env.sdt || null };
    const fieldsAtStart = st.fields.filter((f) => f.state === 'result' && !FREE_FIELDS.has(f.type));
    // The paragraph mark's own revision marks (an inserted or deleted paragraph) count as tracked changes.
    const markR = kid(pPr, 'w:rPr');
    if (markR && markR.kids.some((c) => /^w:(ins|del|moveFrom|moveTo)$/.test(c.k))) st.tracked = true;
    await this.inline(p, st, { baseR, link: false });
    // A text box's text, from the Fallback (VML) copy too, so both stay the same.
    const fieldOpenAtEnd = st.fields.length > 0;
    // Code and display text.
    let code = '', text = '';
    const segs = [];
    for (let i = 0; i < st.pieces.length; i++) {
      const pc = st.pieces[i];
      if (pc.u >= 0) {
        const prev = st.pieces[i - 1];
        if (prev && prev.u === pc.u) continue;
        segs.push({ u: pc.u, c0: code.length });
        code += lockChar(pc.u);
        text += st.units[pc.u].text;
      } else {
        pc.c0 = code.length;
        code += pc.text; text += pc.text;
      }
    }
    // Paragraph look.
    const markStyle = this.styleIndex(this.look({ ...baseR, ...rprOf(markR, this.styles.theme) }));
    let list = null;
    const numId = pp.numId;
    if (numId && numId !== '0' && !shadow) list = this.listLabel(numId, pp.ilvl || 0, baseR);
    const lvl = list && list.lvl ? list.lvl.p : {};
    const ppx = { ...this.styles.defP, ...tbl.p, ...lvl, ...ps.p, ...direct };
    const heading = /^heading (\d)$/.exec(ps.name);
    const look = { al: ppx.al || 'left', il: ppx.il || 0, ir: ppx.ir || 0, fi: ppx.fi || 0, sb: ppx.sb || 0, sa: ppx.sa || 0, lh: ppx.lh || null, bg: ppx.bg || null, ctx: !!ppx.ctx, sid: ps.id || '', pb: !!ppx.pb,
      h: heading ? Number(heading[1]) : ps.name === 'title' ? 1 : 0 };
    let lock = null;
    if (st.tracked) lock = MSG.tracked;
    else if (fieldsAtStart.length) lock = fieldsAtStart.some((f) => f.type === 'TOC') ? MSG.toc : MSG.fieldPara;
    else if (st.sdt && st.sdt.locked) lock = MSG.control;
    else if (st.units.length > DOCX.units) lock = MSG.complex;
    const par = {
      key, code, text, lock,
      pieces: st.pieces.map((pc) => ({ k: pc.k, t: pc.text, s: pc.s, u: pc.u })),
      units: st.units.map((u) => ({ k: u.kind, t: TEXTLESS.has(u.kind) ? '' : u.text, label: u.text, title: u.title, before: u.before != null, after: u.after != null, img: u.img || null, box: u.box || null, pieces: u.pieces || null })),
      mark: markStyle, look, list: list ? { label: list.label, s: list.s, tab: list.tab } : null, canAdd: !fieldOpenAtEnd && !shadow, story: story.id,
      where: story.kind === 'body' ? (env.table ? 'Table' : '') : story.kind === 'notes' ? (this.noteLabel ? `${story.label.replace(/s$/, '')} ${this.noteLabel}` : story.label) : story.label,
    };
    if (shadow) return { par, st };
    this.model.paras[key] = par;
    this.ctxOf.set(key, { st, par, lite: par });
    // Text boxes found in this paragraph become their own stories (their paragraphs were read above).
    return { t: 'p', key };
  }

  /** Runs and other inline content of a paragraph (or hyperlink, field, control…), in order. */
  async inline(el, st, env) {
    for (const c of el.kids) {
      switch (c.k) {
        case 'w:r': await this.run(c, st, env); break;
        case 'w:hyperlink': await this.inline(c, st, { ...env, link: true }); break;
        case 'w:smartTag': case 'w:customXml': case 'w:bdo': case 'w:dir': await this.inline(c, st, env); break;
        case 'w:sdt': {
          const info = sdtInfo(c, st.sdt);
          const was = st.sdt;
          st.sdt = info;
          await this.inline(kid(c, 'w:sdtContent') || { kids: [] }, st, { ...env, sdtEl: c, sdtLock: info.locked ? { el: c, info } : env.sdtLock });
          st.sdt = was;
          break;
        }
        case 'w:fldSimple': {
          const f = { type: fieldType(attr(c, 'instr')), state: 'result', simple: c };
          st.fields.push(f);
          await this.inline(c, st, env);
          st.fields.pop();
          break;
        }
        case 'w:ins': case 'w:moveTo': st.tracked = true; await this.inline(c, st, env); break;
        case 'w:del': case 'w:moveFrom': st.tracked = true; break;
        case 'mc:AlternateContent': { const ch = kid(c, 'mc:Choice') || kid(c, 'mc:Fallback'); if (ch) await this.inline(ch, st, env); break; }
        case 'm:oMath': case 'm:oMathPara': {
          const t = [...descend(c)].filter((x) => x.k === 'm:t').map((x) => innerText(st.part.src, x)).join('');
          this.unitPiece(st, { kind: 'math', text: t || '[equation]', title: 'Equation: change it in Word.', node: c, before: c.start, after: c.end }, null, env);
          break;
        }
        default: break;
      }
    }
  }

  async run(r, st, env) {
    const rPr = kid(r, 'w:rPr');
    const own = rprOf(rPr, this.styles.theme);
    const cstyle = this.styles.charStyle(attr(kid(rPr, 'w:rStyle'), 'val'));
    const props = { ...env.baseR, ...cstyle, ...own };
    if (env.link && !own.c && !cstyle.c) props.c = props.c || '#0563c1';
    if (env.link && own.u === undefined && cstyle.u === undefined) props.u = props.u || 'single';
    const s = this.styleIndex(this.look(props));
    const hidden = !!props.hide;
    const src = st.part.src;
    for (const c of r.kids) {
      const top = st.fields[st.fields.length - 1];
      const inCode = st.fields.some((f) => f.state === 'code');
      switch (c.k) {
        case 'w:fldChar': {
          const t = attr(c, 'fldCharType');
          if (t === 'begin') st.fields.push({ type: '', code: '', state: 'code', begin: r, beginIn: st.key });
          else if (t === 'separate' && top) { top.state = 'result'; top.type = fieldType(top.code); }
          else if (t === 'end' && top) { top.end = r; top.endIn = st.key; st.fields.pop(); }
          continue;
        }
        case 'w:instrText': if (top && top.state === 'code') top.code += innerText(src, c); continue;
        default: break;
      }
      if (inCode) continue;
      const k = c.k;
      if (k === 'w:t') { if (!hidden) this.piece(st, { k: 't', text: tText(src, c), node: c, run: r, s, rPr }, env); }
      else if (k === 'w:tab') { if (!hidden) this.piece(st, { k: 'tab', text: '\t', node: c, run: r, s, rPr }, env); }
      else if (k === 'w:br' || k === 'w:cr') {
        if (hidden) continue;
        const type = attr(c, 'type');
        if (type === 'page' || type === 'column') this.unitPiece(st, { kind: 'break', text: '', title: type === 'page' ? 'Page break' : 'Column break', node: c, run: r, before: r.start, after: r.end }, s, env);
        else this.piece(st, { k: 'br', text: '\n', node: c, run: r, s, rPr }, env);
      } else if (k === 'w:noBreakHyphen') { if (!hidden) this.piece(st, { k: 'nbh', text: '‑', node: c, run: r, s, rPr }, env); }
      else if (k === 'w:sym') {
        const code = (attr(c, 'char') || '').toUpperCase();
        const ch = SYMBOLS[code] || (/^[0-9A-F]{4}$/.test(code) && !/^F0/.test(code) ? String.fromCharCode(parseInt(code, 16)) : '□');
        this.unitPiece(st, { kind: 'sym', text: ch, title: 'Symbol', node: c, run: r, before: r.start, after: r.end }, s, env);
      } else if (k === 'w:ptab') this.unitPiece(st, { kind: 'tab', text: '\t', title: 'Tab', node: c, run: r, before: r.start, after: r.end }, s, env);
      else if (k === 'w:footnoteReference' || k === 'w:endnoteReference') {
        const nums = k === 'w:footnoteReference' ? this.footNums : this.endNums;
        const id = attr(c, 'id');
        if (!st.shadow && !nums.has(id)) nums.set(id, nums.size + 1);
        const n = nums.get(id) || '?';
        const label = k === 'w:endnoteReference' ? roman(n) : String(n);
        this.unitPiece(st, { kind: 'note', text: label, title: `${k === 'w:footnoteReference' ? 'Footnote' : 'Endnote'} ${label}: its text is under ${k === 'w:footnoteReference' ? 'Footnotes' : 'Endnotes'}.`, node: c, run: r, before: r.start, after: r.end }, this.styleIndex(this.look({ ...props, va: 'sup' })), env);
      } else if (k === 'w:footnoteRef' || k === 'w:endnoteRef') {
        this.unitPiece(st, { kind: 'note', text: this.noteLabel || '', title: 'Note number', node: c, run: r, before: r.start, after: r.end }, this.styleIndex(this.look({ ...props, va: 'sup' })), env);
      } else if (k === 'w:drawing' || k === 'w:pict' || k === 'w:object' || k === 'mc:AlternateContent' || k === 'w:contentPart') {
        await this.object(c, r, st, s, env);
      } else if (k === 'w:ruby') {
        const base = kid(c, 'w:rubyBase');
        const t = base ? [...descend(base)].filter((x) => x.k === 'w:t').map((x) => innerText(src, x)).join('') : '';
        this.unitPiece(st, { kind: 'obj', text: t, title: 'Ruby text', node: c, run: r, before: r.start, after: r.end }, s, env);
      }
    }
  }

  /** A changeable piece of text, unless it sits in a field result or a locked control (then it is part of a mark). */
  piece(st, pc, env) {
    const lockField = st.fields.find((f) => f.state === 'result' && !FREE_FIELDS.has(f.type));
    if (lockField) {
      this.unitPiece(st, { kind: 'field', field: lockField, text: pc.text, title: fieldTitle(lockField.type), run: pc.run }, pc.s, env, pc);
      return;
    }
    if (env.sdtLock) {
      const info = env.sdtLock.info;
      this.unitPiece(st, { kind: 'control', sdt: env.sdtLock.el, text: pc.text, title: info.bound ? 'Linked content control: Word fills it in from the document’s data.' : 'Locked content control.', run: pc.run }, pc.s, env, pc);
      return;
    }
    st.pieces.push({ ...pc, u: -1, sdt: st.sdt && st.sdt.placeholder ? st.sdt : null });
  }

  /**
   * A marked part: one unit per field result, control, picture or note mark. Text pieces of the same field (or control)
   * in a row join one unit; `piece` keeps their look for the window.
   */
  unitPiece(st, u, s, env, pc = null) {
    const last = st.pieces[st.pieces.length - 1];
    const owner = u.field || u.sdt || null;
    if (owner && last && last.u >= 0 && st.units[last.u].owner === owner) {
      const unit = st.units[last.u];
      unit.text += u.text;
      unit.pieces.push({ k: pc ? pc.k : 't', t: u.text, s });
      unit.lastRun = u.run;
      st.pieces.push({ k: 'u', text: u.text, s, u: last.u });
      return;
    }
    const unit = { ...u, owner, pieces: owner ? [{ k: pc ? pc.k : 't', t: u.text, s }] : null, lastRun: u.run };
    if (owner && u.field) {
      // Before and after a complex field: its begin and end runs (when they are in this paragraph); a simple field: itself.
      const f = u.field;
      if (f.simple) { unit.before = f.simple.start; unit.after = f.simple.end; }
      else { unit.field = f; unit.before = f.beginIn === st.key ? f.begin.start : null; }
    } else if (owner && u.sdt) { unit.before = u.sdt.start; unit.after = u.sdt.end; }
    unit.k = st.units.length;
    st.units.push(unit);
    st.pieces.push({ k: 'u', text: u.text, s, u: unit.k });
  }

  /** A picture, shape, chart or text box in a run. */
  async object(el, r, st, s, env) {
    const all = [...descend(el)];
    const choice = el.k === 'mc:AlternateContent' ? kid(el, 'mc:Choice') : el;
    const fallback = el.k === 'mc:AlternateContent' ? kid(el, 'mc:Fallback') : null;
    const scope = choice ? [...descendSkip(choice, 'w:txbxContent')] : all;
    const boxesIn = choice ? [...descend(choice)] : all;
    const boxes = boxesIn.filter((x) => x.k === 'w:txbxContent' && !hasAncestor(x, 'w:txbxContent', choice || el));
    const blip = scope.find((x) => x.k === 'a:blip' && attr(x, 'embed')) || scope.find((x) => x.k === 'v:imagedata' && attr(x, 'id'));
    const unit = { kind: 'obj', text: '', title: 'Drawing', node: el, run: r, before: r.start, after: r.end };
    const ext = scope.find((x) => x.k === 'wp:extent');
    let w = ext ? num(attr(ext, 'cx')) / 9525 : 0, h = ext ? num(attr(ext, 'cy')) / 9525 : 0;
    if (!w) {
      const shape = scope.find((x) => x.k === 'v:shape' || x.k === 'v:rect' || x.k === 'v:roundrect');
      const css = (attr(shape, 'style') || '').toLowerCase();
      const len = (name) => { const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)(pt|px|in|cm|mm)?`).exec(css); if (!m) return 0; const v = parseFloat(m[1]); return m[2] === 'px' ? v : m[2] === 'in' ? v * 96 : m[2] === 'cm' ? v * 96 / 2.54 : m[2] === 'mm' ? v * 96 / 25.4 : v * 4 / 3; };
      w = len('width'); h = len('height');
    }
    if (blip) {
      unit.kind = 'pic'; unit.title = 'Picture';
      unit.img = await this.picture(st.part, attr(blip, 'embed') || attr(blip, 'id'), w, h);
    }
    if (boxes.length && !st.shadow) {
      unit.kind = 'box';
      const fb = fallback ? [...descend(fallback)].filter((x) => x.k === 'w:txbxContent' && !hasAncestor(x, 'w:txbxContent', fallback)) : [];
      const ids = [];
      for (let bi = 0; bi < boxes.length; bi++) {
        const n = ++this.boxes;
        const story = this.story('textbox', `Text box ${n}`, st.part);
        ids.push({ id: story.id, n });
        story.blocks = await this.walkBlocks(boxes[bi], st.part, story, { fields: [] });
        // The VML copy (for older readers): its paragraphs follow the same edits when their text is the same.
        if (fb[bi]) {
          const mine = [...descend(boxes[bi])].filter((x) => x.k === 'w:p');
          const theirs = [...descend(fb[bi])].filter((x) => x.k === 'w:p');
          if (mine.length === theirs.length) {
            for (let k = 0; k < mine.length; k++) {
              const key = this.keyOfNode(st.part, mine[k]);
              if (!key) continue;
              const shadow = await this.paragraph(theirs[k], st.part, story, { fields: [] }, true);
              if (shadow.par.code === this.model.paras[key].code) this.ctxOf.get(key).mirror = shadow;
            }
          }
        }
      }
      unit.box = ids.map((x) => x.id);
      unit.text = ids.map((x) => `Text box ${x.n}`).join(', ');
      unit.title = `${unit.text}: its text is under Text boxes.`;
      if (unit.img) unit.kind = 'pic';
    } else if (boxes.length) unit.kind = 'box';
    if (!blip && !boxes.length) {
      const chart = all.some((x) => x.local === 'chart'), smart = all.some((x) => x.local === 'relIds');
      unit.title = chart ? 'Chart' : smart ? 'SmartArt' : 'Shape';
      unit.text = '';
      unit.img = { w: Math.round(w), h: Math.round(h), alt: unit.title };
    }
    this.unitPiece(st, unit, s, env);
  }
  keyOfNode(part, node) {
    for (const [key, c] of this.ctxOf) if (c.st.p === node && c.st.part === part) return key;
    return null;
  }

  async picture(part, id, w, h) {
    const rel = part.rels.get(id);
    const out = { w: Math.round(w) || 0, h: Math.round(h) || 0, alt: 'Picture' };
    if (!rel || rel.external || !rel.target || !this.images) return out;
    const ext = (rel.target.split('.').pop() || '').toLowerCase();
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: null }[ext];
    if (!type) { out.alt = `Picture (${ext.toUpperCase() || 'unknown'})`; return out; }
    const f = this.zip.file(rel.target);
    if (!f) return out;
    if (this.pics.has(rel.target)) return { ...out, src: this.pics.get(rel.target) };
    const size = uncompressed(f);
    if (size > DOCX.picMax || this.picBytes + size > DOCX.picsMax) return out;
    this.picBytes += size;
    const src = `data:${type};base64,` + await f.async('base64');
    this.pics.set(rel.target, src);
    return { ...out, src };
  }

  /** A list item's number or bullet, counted per list. */
  listLabel(numId, ilvl, baseR) {
    const N = this.numbering;
    const n = N.nums.get(numId);
    if (!n) return null;
    let a = N.abs.get(n.abs);
    if (a && a.link && !a.levels.size) {
      const st = this.styles.paraStyle(a.link);
      const linked = st.p.numId && N.nums.get(st.p.numId);
      if (linked) a = N.abs.get(linked.abs) || a;
    }
    const lvl = a && a.levels.get(ilvl);
    if (!lvl) return null;
    let c = this.counters.get(numId);
    if (!c) { c = Array(9).fill(null); this.counters.set(numId, c); }
    const startOf = (L) => (n.over.has(L) ? n.over.get(L) : (a.levels.get(L) || { start: 1 }).start);
    c[ilvl] = c[ilvl] == null ? startOf(ilvl) : c[ilvl] + 1;
    for (let L = ilvl + 1; L < 9; L++) c[L] = null;
    let label;
    if (lvl.fmt === 'bullet') label = lvl.text in BULLETS ? BULLETS[lvl.text] : lvl.text.length === 1 && /[-]/.test(lvl.text) ? '•' : lvl.text;
    else label = lvl.text.replace(/%([1-9])/g, (_, d) => { const L = Number(d) - 1; const v = c[L] == null ? startOf(L) : c[L]; return formatNumber(v, (a.levels.get(L) || lvl).fmt); });
    const s = this.styleIndex(this.look({ ...baseR, ...lvl.r, u: '' }));
    return { label, s, tab: lvl.suff !== 'nothing' ? (lvl.suff === 'space' ? 'space' : 'tab') : '', lvl };
  }

  /** The look the window draws: font, size (pt), bold, italic, underline, strike, colour, highlight, raise. */
  look(p) {
    const o = { f: p.f || 'Calibri', sz: p.sz || 11 };
    if (p.b) o.b = 1;
    if (p.i) o.i = 1;
    if (p.u) o.u = p.u;
    if (p.s) o.s = 1;
    if (p.c) o.c = p.c;
    if (p.hl) o.hl = p.hl; else if (p.bg) o.hl = p.bg;
    if (p.va) o.va = p.va;
    if (p.caps) o.caps = 1;
    if (p.sc) o.sc = 1;
    if (p.csF && p.csF !== o.f) o.csF = p.csF;
    if (p.csSz && p.csSz !== o.sz) o.csSz = p.csSz;
    if (p.csB !== undefined && !!p.csB !== !!p.b) o.csB = p.csB ? 1 : 0;
    if (p.csI !== undefined && !!p.csI !== !!p.i) o.csI = p.csI ? 1 : 0;
    return o;
  }
}

function sdtInfo(sdt, outer) {
  const pr = kid(sdt, 'w:sdtPr');
  const lock = attr(kid(pr, 'w:lock'), 'val') || '';
  const bound = !!kid(pr, 'w:dataBinding');
  const check = !!(pr && pr.kids.some((c) => c.local === 'checkbox'));
  const placeholder = kid(pr, 'w:showingPlcHdr');
  const info = { el: sdt, locked: /contentLocked/.test(lock) || bound || check || !!(outer && outer.locked), bound, placeholder: placeholder ? { el: sdt, mark: placeholder } : null };
  return info;
}

// ------------------------------------------------------------------ display text and code
/** The text people see for a code (each mark as its text): {text, map: [{d0, d1, c0, c1, u}]} (u = mark or -1). */
export function displayOf(par, code = par.code) {
  let text = '';
  const map = [];
  const s = String(code);
  let run = null;
  for (let i = 0; i < s.length;) {
    const u = lockIndex(s, i);
    if (u >= 0 && par.units[u]) {
      run = null;
      const t = par.units[u].t;
      map.push({ d0: text.length, d1: text.length + t.length, c0: i, c1: i + 2, u });
      text += t;
      i += 2;
      continue;
    }
    const ch = s[i];
    if (!run) { run = { d0: text.length, d1: text.length, c0: i, c1: i, u: -1 }; map.push(run); }
    text += ch; run.d1++; run.c1++;
    i++;
  }
  return { text, map };
}
export const displayText = (par, code) => displayOf(par, code).text;

// ------------------------------------------------------------------ diff
const TOKEN = /[\u{10FC00}-\u{10FFFF}]|[\p{L}\p{N}\p{M}_]+|\s+|[^]/gu;
const tokens = (s) => { const out = []; let m; TOKEN.lastIndex = 0; while ((m = TOKEN.exec(s))) out.push(m[0]); return out; };

/**
 * Changed stretches between two texts: [{a, b, ins}] — old [a, b) becomes `ins` (UTF-16 offsets in the old text). When
 * both have the same marks in the same order, the stretches between marks are compared one by one, so a mark is
 * never part of a change.
 */
export function diffHunks(oldS, newS) {
  const lo = locksOf(oldS), ln = locksOf(newS);
  if (lo.length && lo.length === ln.length && lo.every((c, i) => c === ln[i])) {
    const out = [];
    let ao = 0, bo = 0;
    for (let k = 0; k <= lo.length; k++) {
      const ae = k < lo.length ? oldS.indexOf(lo[k], ao) : oldS.length;
      const be = k < lo.length ? newS.indexOf(lo[k], bo) : newS.length;
      for (const h of diffPlain(oldS.slice(ao, ae), newS.slice(bo, be))) out.push({ a: h.a + ao, b: h.b + ao, ins: h.ins });
      ao = ae + 2; bo = be + 2;
    }
    return out;
  }
  return diffPlain(oldS, newS);
}
function diffPlain(oldS, newS) {
  if (oldS === newS) return [];
  const A = tokens(oldS), B = tokens(newS);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const a = A.slice(p, A.length - q), b = B.slice(p, B.length - q);
  const ops = (a.length || b.length) ? (myers(a, b) || [[0, a.length, 0, b.length]]) : [];
  const offA = [0]; for (const t of A) offA.push(offA[offA.length - 1] + t.length);
  const offB = [0]; for (const t of B) offB.push(offB[offB.length - 1] + t.length);
  const hunks = [];
  for (const [i0, i1, j0, j1] of ops) {
    let s0 = offA[p + i0], s1 = offA[p + i1];
    const ins0 = newS.slice(offB[p + j0], offB[p + j1]);
    // Within the changed words, keep the letters that stay (so a word typed over in two looks keeps both).
    const oldPart = Array.from(oldS.slice(s0, s1)), newPart = Array.from(ins0);
    let k = 0;
    while (k < oldPart.length && k < newPart.length && oldPart[k] === newPart[k]) k++;
    while (k > 0 && (/\p{M}/u.test(oldPart[k] || '') || /\p{M}/u.test(newPart[k] || ''))) k--; // not between a letter and its marks
    let e = 0;
    while (e < oldPart.length - k && e < newPart.length - k && oldPart[oldPart.length - 1 - e] === newPart[newPart.length - 1 - e]) e++;
    while (e > 0 && /\p{M}/u.test(oldPart[oldPart.length - e] || '')) e--;
    s0 += oldPart.slice(0, k).join('').length;
    s1 -= e ? oldPart.slice(oldPart.length - e).join('').length : 0;
    const ins = newPart.slice(k, newPart.length - e).join('');
    if (s0 === s1 && !ins) continue;
    hunks.push({ a: s0, b: s1, ins });
  }
  return hunks;
}
/** Myers' diff of two token lists: changed ranges [[a0, a1, b0, b1]], or null when too long or too different. */
function myers(a, b) {
  const N = a.length, M = b.length, MAX = N + M;
  if (MAX > 8000) return null;
  const off = MAX + 1;
  const V = new Int32Array(2 * MAX + 3);
  const trace = [];
  const DMAX = Math.min(MAX, 700);
  let dEnd = -1;
  outer: for (let d = 0; d <= DMAX; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // V of step d - 1, for k = -d-1 … d+1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { dEnd = d; break outer; }
    }
  }
  if (dEnd < 0) return null;
  const pairs = [];
  let x = N, y = M;
  for (let d = dEnd; d >= 0; d--) {
    const S = trace[d];
    const at = (k) => S[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : at(prevK), py = d === 0 ? 0 : px - prevK;
    while (x > px && y > py) { x--; y--; pairs.push([x, y]); }
    x = px; y = py;
  }
  pairs.reverse();
  const ops = [];
  let ax = 0, by = 0;
  for (const [kx, ky] of pairs) {
    if (kx > ax || ky > by) ops.push([ax, kx, by, ky]);
    ax = kx + 1; by = ky + 1;
  }
  if (ax < N || by < M) ops.push([ax, N, by, M]);
  return ops;
}

// ------------------------------------------------------------------ the plan of an edit
/**
 * What an edit of a paragraph does to its pieces: {ok: true, out: [{i, text | keep, before, after}], runs: [{at, u, style, text}]}
 * or {ok: false, error}. `out` covers every piece: a text piece's new text; a tab or break kept or not, with text added
 * before or after it. `runs` are new runs for text added next to a mark (or into an empty paragraph), styled like the
 * nearest text. Changed text takes the look of the run where the change starts.
 */
export function planEdit(par, newCode) {
  const oldCode = par.code;
  newCode = String(newCode);
  if (par.lock) return { ok: false, error: par.lock };
  const lo = locksOf(oldCode), ln = locksOf(newCode);
  if (lo.length !== ln.length || lo.some((c, i) => c !== ln[i])) return { ok: false, error: MSG.noUnits };
  if ([...newCode].length > DOCX.textMax) return { ok: false, error: `A paragraph can be up to ${DOCX.textMax.toLocaleString('en')} characters.` };
  // Where each piece and mark sits in the code.
  const segs = [];
  for (let i = 0; i < par.pieces.length; i++) {
    const pc = par.pieces[i];
    if (pc.u >= 0) {
      if (i > 0 && par.pieces[i - 1].u === pc.u) continue;
      segs.push({ u: pc.u, c0: 0, c1: 0 });
    } else segs.push({ i, c0: 0, c1: 0 });
  }
  let c = 0;
  for (const sg of segs) { sg.c0 = c; c += sg.u !== undefined ? 2 : par.pieces[sg.i].t.length; sg.c1 = c; }
  const hunks = diffHunks(oldCode, newCode);
  const ins = new Map(); // piece i → [{off, text}]
  const dels = new Map(); // piece i → [[a, b]] in its own text
  const runs = [];
  const textPiece = (sg) => sg && sg.u === undefined;
  const styleNear = (pos) => {
    for (let k = segs.length - 1; k >= 0; k--) if (textPiece(segs[k]) && segs[k].c1 <= pos && par.pieces[segs[k].i].k === 't') return par.pieces[segs[k].i].s;
    for (const sg of segs) if (textPiece(sg) && sg.c0 >= pos && par.pieces[sg.i].k === 't') return par.pieces[sg.i].s;
    for (const sg of segs) if (textPiece(sg)) return par.pieces[sg.i].s;
    return par.mark;
  };
  const addIns = (i, off, text) => { if (!ins.has(i)) ins.set(i, []); ins.get(i).push({ off, text }); };
  for (const h of hunks) {
    for (const sg of segs) {
      if (sg.c1 <= h.a || sg.c0 >= h.b) continue;
      if (sg.u !== undefined) return { ok: false, error: MSG.noUnits };
      if (!dels.has(sg.i)) dels.set(sg.i, []);
      dels.get(sg.i).push([Math.max(h.a, sg.c0) - sg.c0, Math.min(h.b, sg.c1) - sg.c0]);
    }
    if (!h.ins) continue;
    if (h.a < h.b) {
      const sg = segs.find((x) => x.c0 <= h.a && h.a < x.c1);
      addIns(sg.i, h.a - sg.c0, h.ins);
      continue;
    }
    const prev = segs.find((x) => x.c0 < h.a && h.a <= x.c1);
    const next = segs.find((x) => x.c0 <= h.a && h.a < x.c1);
    const prevOk = textPiece(prev), nextOk = textPiece(next);
    const zero = segs.find((x) => textPiece(x) && x.c0 === h.a && x.c1 === h.a && par.pieces[x.i].k === 't');
    if (prevOk && !(par.pieces[prev.i].k === 'br' && nextOk)) addIns(prev.i, h.a - prev.c0, h.ins);
    else if (nextOk) addIns(next.i, 0, h.ins);
    else if (zero) addIns(zero.i, 0, h.ins);
    else if (prev && prev.u !== undefined && par.units[prev.u].after) runs.push({ at: 'after', u: prev.u, s: styleNear(h.a), text: h.ins });
    else if (next && next.u !== undefined && par.units[next.u].before) runs.push({ at: 'before', u: next.u, s: styleNear(h.a), text: h.ins });
    else if (!segs.length) runs.push({ at: 'end', u: -1, s: par.mark, text: h.ins });
    else return { ok: false, error: MSG.here };
  }
  const out = [];
  for (let i = 0; i < par.pieces.length; i++) {
    const pc = par.pieces[i];
    if (pc.u >= 0) continue;
    const d = dels.get(i) || [], n = ins.get(i) || [];
    if (!d.length && !n.length) continue;
    const gone = (o) => d.some(([x, y]) => o >= x && o < y);
    if (pc.k === 't') {
      let t = '';
      for (let o = 0; o <= pc.t.length; o++) {
        for (const x of n) if (x.off === o) t += x.text;
        if (o < pc.t.length && !gone(o)) t += pc.t[o];
      }
      out.push({ i, text: t });
    } else {
      out.push({ i, keep: !gone(0), before: n.filter((x) => x.off === 0).map((x) => x.text).join(''), after: n.filter((x) => x.off >= 1).map((x) => x.text).join('') });
    }
  }
  return { ok: true, out, runs };
}

/**
 * The paragraph as it will look after an edit, for the windows: [{t (text), s (style), u (mark, -1)}] in order, marks
 * as one entry each. Uses the same plan as the save.
 */
export function displayPieces(par, code = par.code) {
  if (code === par.code) return par.pieces.reduce((out, pc) => { if (pc.u >= 0) { if (!out.length || out[out.length - 1].u !== pc.u) out.push({ t: par.units[pc.u].t, s: pc.s, u: pc.u }); } else out.push({ t: pc.t, s: pc.s, u: -1 }); return out; }, []);
  const plan = planEdit(par, code);
  if (!plan.ok) return null;
  const byI = new Map(plan.out.map((o) => [o.i, o]));
  const out = [];
  const add = (t, s, u = -1) => { if (t || u >= 0) out.push({ t, s, u }); };
  for (let i = 0; i < par.pieces.length; i++) {
    const pc = par.pieces[i];
    if (pc.u >= 0) {
      if (i > 0 && par.pieces[i - 1].u === pc.u) continue;
      for (const r of plan.runs) if (r.at === 'before' && r.u === pc.u) add(r.text, r.s);
      add(par.units[pc.u].t, pc.s, pc.u);
      for (const r of plan.runs) if (r.at === 'after' && r.u === pc.u) add(r.text, r.s);
      continue;
    }
    const o = byI.get(i);
    if (!o) add(pc.t, pc.s);
    else if (pc.k === 't') add(o.text, pc.s);
    else { add(o.before, pc.s); if (o.keep) add(pc.t, pc.s); add(o.after, pc.s); }
  }
  for (const r of plan.runs) if (r.at === 'end') add(r.text, r.s);
  return out;
}

/**
 * A paragraph added after `after` (key "n<id>"), for the windows: the look of the paragraph it follows and of its last
 * text, as the save writes it.
 */
export function addedPar(model, after, id, text) {
  const a = model.paras[after];
  const last = a ? [...a.pieces].reverse().find((pc) => pc.k === 't' && pc.u < 0) : null;
  const s = last ? last.s : a ? a.mark : 0;
  const t = String(text || '');
  return { key: 'n' + id, code: t, text: t, lock: null, pieces: [{ k: 't', t, s, u: -1 }], units: [], mark: s, look: a ? { ...a.look, h: 0 } : { al: 'left', il: 0, ir: 0, fi: 0, sb: 0, sa: 8, lh: null },
    list: a && a.list && /^[•▪◦●■✓➢❖➔–-]$/.test(a.list.label) ? a.list : null, canAdd: true, story: a ? a.story : 's0', where: a ? a.where : '', added: true };
}

// ------------------------------------------------------------------ find and replace
/**
 * Matches of `query` in paragraphs ([{key, par, code}] in order): [{key, start, end, ok, why}] (offsets in the text
 * people see; `ok` false for a match in a paragraph that can't change or that runs into a mark).
 */
export function findAll(entries, query, opts = {}) {
  const re = findPattern(query, opts);
  if (!re) return [];
  const out = [];
  for (const e of entries) {
    const { text, map } = displayOf(e.par, e.code);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const start = m.index, end = start + m[0].length;
      let why = e.par.lock ? e.par.lock : '';
      if (!why && map.some((g) => g.u >= 0 && g.d0 < end && g.d1 > start)) why = 'This match is in a field or another marked part, so it can’t be replaced here.';
      out.push({ key: e.key, start, end, ok: !why, why });
      if (out.length >= DOCX.matchesMax) return out;
    }
  }
  return out;
}
/** A paragraph's code with some of its matches ([{start, end}] in display offsets, replaceable ones) replaced. */
export function replaceInCode(par, code, matches, repl) {
  const { map } = displayOf(par, code);
  const toCode = (d) => {
    for (const g of map) if (g.u < 0 && d >= g.d0 && d <= g.d1) return g.c0 + (d - g.d0);
    for (const g of map) if (g.u >= 0 && d === g.d1) return g.c1;
    for (const g of map) if (g.u >= 0 && d === g.d0) return g.c0;
    return null;
  };
  let out = String(code);
  const r = String(repl).replace(LOCKS_RE, '');
  for (const m of [...matches].sort((a, b) => b.start - a.start)) {
    const a = toCode(m.start), b = toCode(m.end);
    if (a == null || b == null || a > b) continue;
    out = out.slice(0, a) + r + out.slice(b);
  }
  return out;
}

/** Typed text for a paragraph: line breaks kept as \n, other control characters out. */
export function cleanCode(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '');
}
/** A label for a change in the Changes list. */
export function changeText(par, oldCode, newCode) { return changeLabel(displayText(par, oldCode).replace(/\s+/g, ' '), displayText(par, newCode).replace(/\s+/g, ' ')); }

// ------------------------------------------------------------------ writing
const preserve = (t) => /^\s|\s$|\s\s|\t/.test(t);
/** Run content for text: w:t, with tabs as w:tab and line breaks as w:br (pfx: the document's prefix for its namespace). */
function runContent(text, pfx) {
  if (!text) return '';
  return text.split(/(\t|\n)/).filter((x) => x !== '').map((x) => (x === '\t' ? `<${pfx}tab/>` : x === '\n' ? `<${pfx}br/>` : `<${pfx}t${preserve(x) ? ' xml:space="preserve"' : ''}>${escapeXml(x)}</${pfx}t>`)).join('');
}
/** A w:t's text as Word shows it: without xml:space="preserve" the spaces at its ends don't count; line ends are spaces. */
function tText(src, node) {
  let t = innerText(src, node).replace(/\r\n?|\n/g, ' ');
  if (attr(node, 'space') !== 'preserve') t = t.replace(/^[ \t]+|[ \t]+$/g, '');
  return t;
}
const pfxOf = (node) => (node.prefix ? node.prefix + ':' : '');
/** An element's source without some of its descendants (by node), e.g. an rPr without its revision marks. */
function sourceWithout(src, el, drop) {
  const cut = [...descend(el)].filter((x) => drop(x)).sort((a, b) => a.start - b.start);
  let out = '', at = el.start;
  for (const x of cut) { if (x.start < at) continue; out += src.slice(at, x.start); at = x.end; }
  return out + src.slice(at, el.end);
}
const REVISION = (x) => /^w:(ins|del|moveFrom|moveTo|rPrChange|pPrChange)$/.test(x.k);

/**
 * Apply the edits ({key, code}) and added paragraphs ({after: key, text}, in order) to the parts they are in. Only
 * those parts' text changes, by splicing: every byte outside the changed w:t (and the few elements around them)
 * stays as it was. Returns {parts: Map path → new source, edited, added}.
 */
export function writeEdits(S, edits, adds) {
  const splices = new Map(); // part path → [{at, end, text}]
  const add = (part, at, end, text) => { if (!splices.has(part.path)) splices.set(part.path, []); splices.get(part.path).push({ at, end, text }); };
  let edited = 0, added = 0;
  const editOne = (c, st, par, code) => {
    const plan = planEdit(par, code);
    if (!plan.ok) throw new DocxError(plan.error);
    const src = st.part.src;
    const pieces = st.pieces;
    const removedMarks = new Set();
    for (const o of plan.out) {
      const pc = pieces[o.i];
      const pfx = pfxOf(pc.node);
      if (pc.k === 't') add(st.part, pc.node.start, pc.node.end, runContent(o.text, pfx));
      else add(st.part, pc.node.start, pc.node.end, runContent(o.before, pfx) + (o.keep ? src.slice(pc.node.start, pc.node.end) : '') + runContent(o.after, pfx));
      // Typing over a content control's placeholder text: it is real text now (as when typing in Word).
      if (pc.sdt && pc.sdt.placeholder) {
        const mark = pc.sdt.placeholder.mark;
        if (!removedMarks.has(mark)) { removedMarks.add(mark); add(st.part, mark.start, mark.end, ''); }
        const rStyle = kid(pc.rPr, 'w:rStyle');
        if (rStyle && /placeholder/i.test(attr(rStyle, 'val') || '') && !removedMarks.has(rStyle)) { removedMarks.add(rStyle); add(st.part, rStyle.start, rStyle.end, ''); }
      }
    }
    for (const r of plan.runs) {
      const p = st.p;
      const pfx = pfxOf(p);
      const rPr = rPrFor(st, r.s, par);
      const xml = `<${pfx}r>${rPr}${runContent(r.text, pfx)}</${pfx}r>`;
      if (r.at === 'end') {
        if (p.self) add(st.part, p.start, p.end, src.slice(p.start, p.openEnd - 2).replace(/\s*$/, '') + '>' + xml + `</${p.name}>`);
        else add(st.part, p.closeStart, p.closeStart, xml);
      } else {
        const u = st.units[r.u];
        const pos = r.at === 'before' ? u.before : unitAfter(u, st);
        if (pos == null) throw new DocxError(MSG.here);
        add(st.part, pos, pos, xml);
      }
    }
  };
  for (const e of edits) {
    const c = S.ctxOf.get(e.key);
    if (!c) throw new DocxError(MSG.changed);
    if (e.old != null && e.old !== c.par.code) throw new DocxError(MSG.changed);
    if (e.code === c.par.code) continue;
    editOne(c, c.st, c.par, e.code);
    if (c.mirror) editOne(c, c.mirror.st, c.mirror.par, e.code);
    edited++;
  }
  // Added paragraphs: after their paragraph, with its paragraph properties (not its section break) and the look of
  // its last text.
  const groups = new Map();
  for (const a of adds) { if (!groups.has(a.after)) groups.set(a.after, []); groups.get(a.after).push(a); }
  for (const [after, list] of groups) {
    const c = S.ctxOf.get(after);
    if (!c) throw new DocxError(MSG.changed);
    if (!c.par.canAdd) throw new DocxError('A paragraph can’t be added after this one: it is inside a field.');
    const make = (st) => {
      const p = st.p, src = st.part.src, pfx = pfxOf(p);
      const pPr = kid(p, 'w:pPr');
      const ppr = pPr ? sourceWithout(src, pPr, (x) => x.k === 'w:sectPr' || REVISION(x)) : '';
      const lastT = [...st.pieces].reverse().find((pc) => pc.k === 't' && pc.u < 0);
      const rPr = lastT && lastT.rPr ? sourceWithout(src, lastT.rPr, REVISION) : markRPr(st);
      return list.map((a) => `<${pfx}p>${ppr}${a.text ? `<${pfx}r>${rPr}${runContent(a.text, pfx)}</${pfx}r>` : ''}</${pfx}p>`).join('');
    };
    add(c.st.part, c.st.p.end, c.st.p.end, make(c.st));
    if (c.mirror) add(c.mirror.st.part, c.mirror.st.p.end, c.mirror.st.p.end, make(c.mirror.st));
    added += list.length;
  }
  const parts = new Map();
  for (const [path, list] of splices) {
    const part = S.parts.find((p) => p.path === path);
    list.sort((a, b) => a.at - b.at || a.end - b.end);
    for (let k = 1; k < list.length; k++) if (list[k].at < list[k - 1].end) throw new Error('Overlapping changes in ' + path);
    let out = '', at = 0;
    for (const s of list) { out += part.src.slice(at, s.at) + s.text; at = s.end; }
    parts.set(path, out + part.src.slice(at));
  }
  return { parts, edited, added };
}
/** Where text after a mark goes: after its end run (a complex field's end must be in the same paragraph). */
function unitAfter(u, st) {
  if (u.after != null) return u.after;
  const f = u.field;
  if (f && f.end && f.endIn === st.key) return f.end.end;
  return null;
}
/** The rPr for a new run, copied from a piece with that look (or from the paragraph mark), without revision marks. */
function rPrFor(st, s, par) {
  const pc = st.pieces.find((x) => x.s === s && x.rPr && x.k === 't') || st.pieces.find((x) => x.s === s && x.rPr);
  if (pc) return sourceWithout(st.part.src, pc.rPr, REVISION);
  if (s === par.mark) return markRPr(st);
  const any = st.pieces.find((x) => x.rPr && x.u < 0);
  return any ? sourceWithout(st.part.src, any.rPr, REVISION) : markRPr(st);
}
/** The paragraph mark's run properties as a run's rPr. */
function markRPr(st) {
  const r = kid(kid(st.p, 'w:pPr'), 'w:rPr');
  return r ? sourceWithout(st.part.src, r, REVISION) : '';
}

/**
 * Save: the edits and added paragraphs written into a copy of the package. Every part that didn't change is copied
 * as it was (JSZip keeps its compressed bytes). Returns {bytes, edited, added}.
 */
export async function saveDocx(JSZip, bytes, edits, adds) {
  const zip = await loadZip(JSZip, bytes);
  const { ctx } = await scanDocx(zip, { images: false });
  const r = writeEdits(ctx, edits, adds);
  for (const [path, text] of r.parts) {
    const f = zip.file(path);
    zip.file(path, text, { date: f.date, createFolders: false, compression: 'DEFLATE', unixPermissions: f.unixPermissions, dosPermissions: f.dosPermissions });
  }
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  return { bytes: out, edited: r.edited, added: r.added, parts: [...r.parts.keys()] };
}

/** Open the package, or say why not (a password-protected file, an old .doc, not a Word document). */
export async function loadZip(JSZip, bytes) {
  if (!bytes || bytes.length < 4) throw new DocxError(MSG.damaged);
  if (bytes.length > DOCX.fileMax) throw new DocxError(MSG.tooLarge);
  const ole = oleKind(bytes);
  if (ole === 'encrypted') throw new DocxError(MSG.encrypted);
  if (ole === 'doc') throw new DocxError(MSG.oldDoc);
  if (ole) throw new DocxError(MSG.damaged);
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new DocxError(MSG.damaged); }
  return zip;
}

/**
 * After a save: read the result again and check every paragraph of the changed parts says what it should (the
 * edits in, the old text gone, added paragraphs where they were added). {ok, problems}.
 */
export async function verifySave(JSZip, before, after, edits, adds) {
  const problems = [];
  try {
    const a = (await scanDocx(await loadZip(JSZip, before), { images: false })).model;
    const b = (await scanDocx(await loadZip(JSZip, after), { images: false })).model;
    const want = new Map(edits.map((e) => [e.key, e.code]));
    const addsAfter = new Map();
    for (const x of adds) { if (!addsAfter.has(x.after)) addsAfter.set(x.after, []); addsAfter.get(x.after).push(x.text); }
    const byPart = (m) => { const g = new Map(); for (const k of Object.keys(m.paras)) { const p = k.split(':')[0]; if (!g.has(p)) g.set(p, []); g.get(p).push(k); } for (const v of g.values()) v.sort((x, y) => Number(x.split(':')[1]) - Number(y.split(':')[1])); return g; };
    const pa = byPart(a), pb = byPart(b);
    for (const [p, keys] of pa) {
      const expect = [];
      for (const k of keys) { expect.push(want.has(k) ? want.get(k) : a.paras[k].code); for (const t of addsAfter.get(k) || []) expect.push(t); }
      const got = (pb.get(p) || []).map((k) => b.paras[k].code);
      // Added paragraphs inside a text box come after its own paragraphs in reading order; compare as sets of lines too.
      if (got.length !== expect.length) { problems.push(`A part has ${got.length} paragraphs instead of ${expect.length}.`); continue; }
      const strip = (s) => s.replace(LOCKS_RE, '\u0001');
      for (let i = 0; i < got.length; i++) if (strip(got[i]) !== strip(expect[i])) { problems.push(`“${displayText({ units: [] }, expect[i]).slice(0, 40)}” didn’t come out as expected.`); break; }
    }
  } catch (e) {
    problems.push(e && e.user ? e.message : 'The saved document couldn’t be read back.');
  }
  return { ok: !problems.length, problems };
}

// ------------------------------------------------------------------ the look, as CSS (windows)
const safeFont = (f) => String(f || '').replace(/[^\p{L}\p{N} \-_.]/gu, '').slice(0, 60);
/** CSS for a style: font (with a matching bundled fallback), size in px at 96 dpi, weight, slant, lines, colour. */
export function styleCss(st, deva = false) {
  const f = safeFont(deva && st.csF ? st.csF : st.f);
  const fam = fontStyle({ name: f }).family;
  const size = (deva && st.csSz ? st.csSz : st.sz) * (st.va ? 0.65 : 1);
  const bold = deva && st.csB !== undefined ? st.csB : st.b;
  const ital = deva && st.csI !== undefined ? st.csI : st.i;
  let css = `font-family:"${f}",${CSS_FAMILY[fam] || CSS_FAMILY.sans};font-size:${Math.round(size * 4 / 3 * 100) / 100}px`;
  if (bold) css += ';font-weight:700';
  if (ital) css += ';font-style:italic';
  const lines = [st.u ? 'underline' : '', st.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (lines) css += `;text-decoration:${lines}${st.u === 'double' ? ' double' : /dot/.test(st.u || '') ? ' dotted' : /dash/.test(st.u || '') ? ' dashed' : /wave/.test(st.u || '') ? ' wavy' : ''}`;
  if (st.c) css += ';color:' + st.c;
  if (st.hl) css += ';background-color:' + st.hl;
  if (st.va) css += `;vertical-align:${st.va === 'sup' ? 'super' : 'sub'}`;
  if (st.caps) css += ';text-transform:uppercase';
  if (st.sc) css += ';font-variant:small-caps';
  return css;
}
export const hasDeva = (s) => Array.from(String(s)).some(isDeva);
