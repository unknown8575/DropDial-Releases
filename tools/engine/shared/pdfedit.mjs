// Edit PDF text: the logic shared by the app's window, the website's page and the processor (src/processor/pdf-edit.js).
// Pure code: grouping glyphs into editable lines, what part of a line an edit redraws, find and replace, font styles,
// the bundled fonts and which characters they can write.

// ------------------------------------------------------------------ limits
export const EDIT = Object.freeze({
  textMax: 500, // characters in one line or added box
  edits: 2000, // changed lines in one save
  adds: 200, // added text boxes
  sizeMin: 4, sizeMax: 144, sizeDef: 14,
  findMax: 200, // characters in Find
  matchesMax: 5000,
});

// ------------------------------------------------------------------ fonts
/** The bundled fonts (SIL Open Font License; src/processor/vendor/fonts). Mono and Devanagari have no italic: it is slanted. */
export const FONT_FILES = Object.freeze({
  'sans': 'NotoSans-Regular.ttf', 'sans-b': 'NotoSans-Bold.ttf', 'sans-i': 'NotoSans-Italic.ttf', 'sans-bi': 'NotoSans-BoldItalic.ttf',
  'serif': 'NotoSerif-Regular.ttf', 'serif-b': 'NotoSerif-Bold.ttf', 'serif-i': 'NotoSerif-Italic.ttf', 'serif-bi': 'NotoSerif-BoldItalic.ttf',
  'mono': 'NotoSansMono-Regular.ttf', 'mono-b': 'NotoSansMono-Bold.ttf',
  'deva': 'NotoSansDevanagari-Regular.ttf', 'deva-b': 'NotoSansDevanagari-Bold.ttf',
});
export const FAMILIES = [{ value: 'sans', label: 'Sans' }, { value: 'serif', label: 'Serif' }, { value: 'mono', label: 'Mono' }];
/** CSS families for the windows' editors (the same files, loaded with @font-face as "DD Sans", …). */
export const CSS_FAMILY = { sans: '"DD Sans", "Noto Sans", Arial, sans-serif', serif: '"DD Serif", "Noto Serif", Georgia, serif', mono: '"DD Mono", "Noto Sans Mono", Menlo, Consolas, monospace' };
/** Line metrics of the bundled fonts (em): ascender, descender (positive), and the line height added boxes use. */
export const METRICS = Object.freeze({ asc: 1.069, desc: 0.293, line: 1.36 });
/** Slant (degrees) used for italic text in a font without an italic. */
export const SLANT = 12;
/** Where the first baseline of an added box sits below the box's top, in em (CSS puts it there too: line-height METRICS.line). */
export const firstBaseline = () => (METRICS.line - (METRICS.asc + METRICS.desc)) / 2 + METRICS.asc;

/** The key of a bundled font file for a style: family + bold/italic ("serif-bi"). */
export function fontKey(family, bold, italic, deva = false) {
  if (deva) return bold ? 'deva-b' : 'deva';
  const fam = FONT_FILES[family] ? family : 'sans';
  if (fam === 'mono') return bold ? 'mono-b' : 'mono';
  return fam + (bold || italic ? '-' + (bold ? 'b' : '') + (italic ? 'i' : '') : '');
}
/** Whether a style has to be slanted by hand (mono or Devanagari italic). */
export const needsSlant = (family, italic, deva = false) => !!italic && (deva || family === 'mono');

/**
 * A PDF font's style for the editor: {family: sans | serif | mono, bold, italic}, from its name ("ABCDEF+Calibri-Bold",
 * "TimesNewRomanPS-ItalicMT") and the flags pdf.js reads (bold, italic, isMonospace, isSerifFont).
 */
export function fontStyle({ name = '', bold, italic, black, mono, serif } = {}) {
  const n = String(name).replace(/^[A-Z]{6}\+/, '');
  const lower = n.toLowerCase();
  const isMono = !!mono || /courier|mono|consol|menlo|inconsolata|typewriter|lucida ?console|fixed|cousine/.test(lower);
  const sansWord = /sans|arial|helvetica|calibri|carlito|arimo|verdana|tahoma|segoe|roboto|inter\b|open ?sans|lato|gothic|futura|myriad|frutiger|univers|trebuchet|gill|aptos|montserrat|poppins/.test(lower);
  const isSerif = !isMono && !sansWord && (!!serif || /times|serif|georgia|garamond|cambria|caladea|tinos|book ?antiqua|palatino|minion|baskerville|bodoni|caslon|didot|century|roman|constantia|charter|merriweather|lora|gelasio/.test(lower));
  return {
    family: isMono ? 'mono' : isSerif ? 'serif' : 'sans',
    bold: !!bold || !!black || /bold|black|heavy|semibold|demi|,b\b|-b$/i.test(n),
    italic: !!italic || /italic|oblique|,i\b|-it$|-i$/i.test(n),
  };
}

// ------------------------------------------------------------------ scripts and characters
const DEVA = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/;
const JOINERS = /[‌‍]/;
/** Is the character Devanagari (Hindi, Marathi, Nepali…)? */
export const isDeva = (ch) => DEVA.test(ch);
/**
 * Text cut into runs of Devanagari and other characters: [{text, deva}]. Spaces, joiners and combining marks stay with
 * the run they are in (a space between two Hindi words stays Hindi).
 */
export function scriptRuns(text) {
  const runs = [];
  for (const ch of Array.from(String(text))) {
    let deva = isDeva(ch);
    const last = runs[runs.length - 1];
    if (last && (/\s/.test(ch) || JOINERS.test(ch) || /\p{M}/u.test(ch))) deva = last.deva;
    if (last && last.deva === deva) last.text += ch; else runs.push({ text: ch, deva });
  }
  return runs;
}
// What the bundled Latin fonts write: Latin (with Vietnamese), Greek, Cyrillic, common symbols and currency (₹ € £ ¥).
const COVERED = /^[\u0009\u000A -~ -ɏɐ-˿̀-ͯͰ-ϿЀ-ԯḀ-ỿ -⁯₠-⃀℀-⅏←-⇿−∕∙∞≈≠≤≥●○■▪✓•ﬁﬂऀ-ॿ꣠-ꣿ᳐-᳿‌‍﻿]$/u;
/** Characters the bundled fonts can't write (unique, in order), e.g. Chinese or emoji. */
export function unsupportedChars(text) {
  const out = [];
  for (const ch of Array.from(String(text))) if (!COVERED.test(ch) && !out.includes(ch)) out.push(ch);
  return out;
}
/** "These characters can't be written: 你, 好." for a list, or ''. */
export const unsupportedText = (chars) => (chars.length ? `${chars.length === 1 ? 'This character' : 'These characters'} can’t be written in the PDF: ${chars.slice(0, 8).join(' ')}${chars.length > 8 ? ' …' : ''}` : '');

// ------------------------------------------------------------------ lines
/**
 * Group glyphs (in page order) into lines that can be edited one at a time. A glyph: {u (its text), x0, y0, x1, y1
 * (origin and end of its advance, view points, y down), size (view points), invisible?}. Glyphs join the line before
 * them when they sit on its baseline (same direction) and start close after its end; a large gap (table cells,
 * columns) starts a new line. A space is added to the text where words are only separated by distance.
 * Returns [{glyphs: [index], chars: [{c, g}] (g = glyph index or -1 for an added space), text, x, y, x1, y1, size,
 * angle (degrees, counter-clockwise as seen)}].
 */
export function groupLines(glyphs, { gap = 0.9, space = 0.18 } = {}) {
  const lines = [];
  let cur = null;
  const dirOf = (g, fallback) => {
    const dx = g.x1 - g.x0, dy = g.y1 - g.y0, len = Math.hypot(dx, dy);
    return len > 1e-6 ? [dx / len, dy / len] : fallback || [1, 0];
  };
  glyphs.forEach((g, gi) => {
    if (g.invisible || (!g.u && !cur)) return;
    if (cur) {
      const [dx, dy] = cur.dir;
      const ex = g.x0 - cur.ex, ey = g.y0 - cur.ey;
      const along = ex * dx + ey * dy; // distance along the baseline from the line's end
      const across = -ex * dy + ey * dx;
      const d = dirOf(g, cur.dir);
      const sameDir = d[0] * dx + d[1] * dy > 0.999;
      const s = Math.max(cur.size, 0.01);
      const sizeOk = g.size / s > 0.55 && g.size / s < 1.8;
      if (sameDir && sizeOk && Math.abs(across) < 0.5 * s && along > -0.6 * s && along < gap * s) {
        const last = cur.chars[cur.chars.length - 1];
        if (along > space * s && last && !/\s/.test(last.c) && !/^\s/.test(g.u)) cur.chars.push({ c: ' ', g: -1 });
        for (const c of Array.from(g.u)) cur.chars.push({ c, g: gi });
        cur.glyphs.push(gi);
        cur.ex = g.x1; cur.ey = g.y1;
        return;
      }
    }
    if (!g.u) return; // a glyph with no text only joins a line
    cur = { glyphs: [gi], chars: Array.from(g.u).map((c) => ({ c, g: gi })), x: g.x0, y: g.y0, ex: g.x1, ey: g.y1, size: g.size, dir: dirOf(g) };
    lines.push(cur);
  });
  return lines.map((l) => {
    // Spaces at the ends (drawn space glyphs) are kept as glyphs but not shown as text.
    const text = l.chars.map((c) => c.c).join('');
    return { glyphs: l.glyphs, chars: l.chars, text, x: l.x, y: l.y, x1: l.ex, y1: l.ey, size: l.size, angle: Math.round((Math.atan2(-l.dir[1], l.dir[0]) * 180) / Math.PI * 100) / 100 };
  }).filter((l) => l.text.trim());
}

/**
 * Where an edit of a line starts: the number of characters at the start of `old` that stay as they are. The cut is
 * moved back to the start of a word, so a changed word is redrawn whole; text added at the very end keeps everything.
 */
export function keptPrefix(old, next) {
  const a = Array.from(String(old)), b = Array.from(String(next));
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p === a.length) return p; // only added at the end (or nothing changed)
  while (p > 0 && !/\s/.test(a[p - 1])) p--;
  return p;
}

// ------------------------------------------------------------------ find and replace
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A RegExp for Find (global), or null for an empty query. Whole words: not inside a longer word (letters, digits, marks). */
export function findPattern(query, { matchCase = false, wholeWord = false } = {}) {
  const q = String(query || '');
  if (!q.trim()) return null;
  const body = escapeRe(q).replace(/ /g, '\\s+');
  const src = wholeWord ? `(?<![\\p{L}\\p{N}\\p{M}_])${body}(?![\\p{L}\\p{N}\\p{M}_])` : body;
  return new RegExp(src, 'gu' + (matchCase ? '' : 'i'));
}
/** Matches of `query` in lines ([{page, line, text}]): [{page, line, start, end}] (character offsets; at most EDIT.matchesMax). */
export function findMatches(lines, query, opts = {}) {
  const re = findPattern(query, opts);
  if (!re) return [];
  const out = [];
  for (const l of lines) {
    const units = l.text;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(units))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({ page: l.page, line: l.line, start: m.index, end: m.index + m[0].length });
      if (out.length >= EDIT.matchesMax) return out;
    }
  }
  return out;
}
/** `text` with the given matches ([{start, end}] in this text, any order) replaced by `repl`. */
export function replaceMatches(text, matches, repl) {
  let out = text;
  for (const m of [...matches].sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + repl + out.slice(m.end);
  return out;
}

// ------------------------------------------------------------------ checks
/** One line of typed text: control characters out (tabs become spaces). Added boxes keep line breaks. */
export function cleanText(text, { multiline = false } = {}) {
  let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  if (!multiline) t = t.replace(/\n+/g, ' ');
  return t.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, '');
}
/** "#1a2b3c" for an [r, g, b] (0–255) colour; black for anything else. */
export function hexOf(rgb) {
  if (typeof rgb === 'string' && /^#[0-9a-f]{6}$/i.test(rgb)) return rgb.toLowerCase();
  if (!Array.isArray(rgb) || rgb.length < 3) return '#000000';
  return '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/**
 * Short words for a change in the Changes list: only the words that changed, "“1,250.00” → “1,500.00”" (long texts cut
 * in the middle); "Deleted “…”" when a line was emptied.
 */
export function changeLabel(old, next) {
  const cut = (s) => { const a = Array.from(s); return a.length > 28 ? a.slice(0, 13).join('') + '…' + a.slice(-12).join('') : s; };
  if (!String(next).trim()) return `Deleted “${cut(String(old).trim())}”`;
  const a = String(old).split(/(\s+)/), b = String(next).split(/(\s+)/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const from = a.slice(p, a.length - q).join('').trim(), to = b.slice(p, b.length - q).join('').trim();
  if (!from) return `Added “${cut(to)}”`;
  if (!to) return `Deleted “${cut(from)}”`;
  return `“${cut(from)}” → “${cut(to)}”`;
}

/** The result's name suffix ("report edited.pdf"). */
export const SUFFIX = 'edited';
/** The note shown for a page that is a picture of text. */
export const SCAN_NOTE = 'This page is a scan — change its words with Edit image text.';
/** The note shown for a line whose old text can only be covered. */
export const COVER_NOTE = 'This line can only be covered, not removed: the old text stays in the file underneath, so search and copy can still find it.';
