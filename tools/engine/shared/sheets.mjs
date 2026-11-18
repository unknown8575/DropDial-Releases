// Spreadsheet and JSON readers: XLSX, XLS (real Excel 97–2003 files, and the HTML tables or SpreadsheetML 2003
// XML that many banks save with an .xls name) and JSON tables. Shared by the sandboxed processor (conversions,
// bank statements) and the unit tests. Pure functions: no DOM, no Node. Untrusted input: every offset is
// checked, loops are refused, sizes are capped, and keyed data lives in Maps or null-prototype objects.
//
// A sheet is {name, hidden, rows}; rows are arrays of cells: a string, a number, a boolean or null (empty).
// Dates come out as text: "2026-09-03", "2026-09-03 14:30" or "14:30:05".

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;
export const MAX_CELLS = 5000000;
export const MAX_SHEETS = 256;
export const MAX_TEXT = 64 * 1024 * 1024; // characters of XML, HTML or JSON

export class SheetError extends Error {
  constructor(message) { super(message); this.user = true; this.permanent = true; }
}
const tooBig = () => new SheetError('This spreadsheet is too large to read (more than 5 million cells).');

// ------------------------------------------------------------------ cells
/** Counts cells as they are read so a huge or hostile file stops early. */
function budget() {
  let n = 0;
  return () => { if (++n > MAX_CELLS) throw tooBig(); };
}

/** rows[r][c] = v, within Excel's limits; gaps are null. */
function setCell(rows, r, c, v, count) {
  if (!(r >= 0 && r < MAX_ROWS && c >= 0 && c < MAX_COLS) || v == null || v === '') return;
  count();
  while (rows.length <= r) rows.push([]);
  const row = rows[r];
  while (row.length < c) row.push(null);
  row[c] = v;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * An Excel date serial as text. `kind`: 'date' (day only), 'datetime' or 'time'. 1900 dates follow Excel's own
 * count (it treats 1900 as a leap year, so serials before 1 March 1900 are one day off from the calendar).
 */
export function serialDate(serial, { kind = 'date', date1904 = false } = {}) {
  const v = Number(serial);
  if (!Number.isFinite(v) || v < 0 || v >= 2958466) return null; // up to 31 December 9999
  let days = Math.floor(v);
  let secs = Math.round((v - days) * 86400);
  if (secs >= 86400) { days++; secs -= 86400; }
  const time = `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor(secs / 60) % 60)}${secs % 60 ? ':' + pad2(secs % 60) : ''}`;
  if (kind === 'time' && days === 0) return time;
  if (!date1904 && days < 60) days++; // before Excel's 29 February 1900
  const d = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + days * 86400000);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return kind === 'date' || (kind === 'datetime' && !secs) ? date : `${date} ${time}`;
}

// Excel's built-in number formats that show dates or times.
const BUILTIN_DATES = new Map([[14, 'date'], [15, 'date'], [16, 'date'], [17, 'date'], [18, 'time'], [19, 'time'], [20, 'time'], [21, 'time'], [22, 'datetime'], [45, 'time'], [47, 'time'],
  ...[27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58].map((n) => [n, 'date']), [32, 'time'], [33, 'time'], [55, 'time'], [56, 'time']]);

/** What a number format shows: 'date', 'datetime', 'time', or null for numbers (and durations like [h]:mm). */
export function formatKind(code) {
  let s = String(code || '').split(';')[0];
  if (/\[(h+|m+|s+)\]/i.test(s)) return null; // elapsed time
  s = s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, '').replace(/\[[^\]]*\]/g, '');
  if (/general/i.test(s)) return null;
  const day = /[dy]/i.test(s) || /m/i.test(s.replace(/am\/pm|a\/p/gi, '')) && !/[hs]/i.test(s);
  const time = /[hs]/i.test(s) || /am\/pm|a\/p/i.test(s);
  return day && time ? 'datetime' : day ? 'date' : time ? 'time' : null;
}
const kindOfFormat = (id, custom) => (custom.has(id) ? formatKind(custom.get(id)) : BUILTIN_DATES.get(id) || null);

/** A number the way a spreadsheet shows it: 15 significant digits, no binary noise ("1299.1", not "1299.0999999999999"). */
export function numberText(n) {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(Number(n.toPrecision(15)));
}

/** A cell as text (for CSV, PDF and the bank statement reader). */
export const cellText = (v) => (v == null ? '' : typeof v === 'number' ? numberText(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

// ------------------------------------------------------------------ XML helpers (XLSX, SpreadsheetML)
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const fromCode = (n) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
/** Decode XML/HTML character references (named ones: the XML five and &nbsp;). */
export function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e) => {
    if (e[0] === '#') return fromCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
  });
}
/** OOXML writes some characters as _xHHHH_ (a line break inside a cell is often _x000D_). */
const unescapeOoxml = (s) => (s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h) => fromCode(parseInt(h, 16)) || ''));

/** Attributes of a start tag, by local name ("ss:Name" → "Name"; "r:id" → "id"). Null-prototype object. */
function attrs(s) {
  const o = Object.create(null);
  if (!s) return o;
  for (const m of s.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const local = m[1].includes(':') ? m[1].slice(m[1].lastIndexOf(':') + 1) : m[1];
    if (m[1].startsWith('xmlns')) continue;
    o[local] = unescapeXml(m[2] ?? m[3] ?? '');
  }
  return o;
}
/** Elements named `name` (any namespace prefix): [{a: attributes text, body}] (body '' for <x/>). */
function* elements(xml, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>)`, 'g');
  for (const m of xml.matchAll(re)) yield { a: m[1], body: m[2] || '' };
}
const first = (xml, name) => { for (const e of elements(xml, name)) return e; return null; };
/** Text of <t> runs (rich text), leaving out phonetic guides (<rPh>). */
function richText(body) {
  const clean = body.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>/g, '');
  let s = '';
  for (const t of elements(clean, 't')) s += t.body;
  return unescapeOoxml(unescapeXml(s));
}

/** "B12" → [11, 1] (row, column, 0-based) or null. */
function cellRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref || '');
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}

// ------------------------------------------------------------------ formulas (QA round 7)
// Files saved by scripts (openpyxl and the like) keep formulas without their results. Simple ones are worked out here:
// numbers, text, cell references and ranges on the same sheet, + - * / ^ & %, comparisons, and SUM, AVERAGE, MIN,
// MAX, COUNT, COUNTA, PRODUCT, ROUND(UP/DOWN), INT, ABS, N, IF, AND, OR, NOT, LEN, UPPER, LOWER, TRIM, CONCAT(ENATE).
// Anything else (other sheets, names, unknown functions, errors) gives null: the cell stays empty.

const FAIL = Symbol('formula error');
class Fail extends Error {}
const fail = () => { throw new Fail(); };
const colName = (c) => { let s = ''; for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };

/** Tokens of a formula: numbers, strings, refs ("A1", "A1:B3", "C:C"), names, operators and parentheses. */
function tokens(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+)|"((?:[^"]|"")*)"|(\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3})(?![\w(!])|([A-Za-z_][\w.]*)|(<>|<=|>=|[-+*/^&=<>%(),:!]))/y;
  let i = 0;
  const text = String(src).trim();
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m || m[0].length === 0) fail();
    i = re.lastIndex;
    if (m[1] != null) out.push({ t: 'n', v: Number(m[1]) });
    else if (m[2] != null) out.push({ t: 's', v: m[2].replace(/""/g, '"') });
    else if (m[3] != null) out.push({ t: 'ref', v: m[3].replace(/\$/g, '').toUpperCase() });
    else if (m[4] != null) out.push({ t: 'name', v: m[4].toUpperCase() });
    else out.push({ t: 'op', v: m[5] });
  }
  return out;
}

const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
const num = (v) => (v == null || v === '' ? 0 : typeof v === 'number' ? v : typeof v === 'boolean' ? +v : Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : fail());
const flat = (args) => args.flatMap((a) => (a && a.range ? a.values : [a]));
const numbersIn = (args) => args.flatMap((a) => (a && a.range ? a.values.filter((v) => typeof v === 'number') : [num(a)]));
const round = (x, d, how) => { const k = 10 ** (d | 0); const v = x * k; return (how === 'up' ? Math.sign(v) * Math.ceil(Math.abs(v) - 1e-9) : how === 'down' ? Math.trunc(v) : Math.sign(v) * Math.round(Math.abs(v) + 1e-9)) / k; };
const FUNCS = {
  SUM: (a) => numbersIn(a).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => numbersIn(a).reduce((x, y) => x * y, 1),
  AVERAGE: (a) => { const n = numbersIn(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : fail(); },
  MIN: (a) => { const n = numbersIn(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = numbersIn(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => flat(a).filter((v) => typeof v === 'number').length,
  COUNTA: (a) => flat(a).filter((v) => v != null && v !== '').length,
  ROUND: (a) => round(num(a[0]), num(a[1] ?? 0)), ROUNDUP: (a) => round(num(a[0]), num(a[1] ?? 0), 'up'), ROUNDDOWN: (a) => round(num(a[0]), num(a[1] ?? 0), 'down'),
  INT: (a) => Math.floor(num(a[0])), ABS: (a) => Math.abs(num(a[0])),
  N: (a) => (typeof a[0] === 'number' ? a[0] : typeof a[0] === 'boolean' ? +a[0] : 0),
  IF: (a) => (truthy(a[0]) ? (a.length > 1 ? a[1] : true) : (a.length > 2 ? a[2] : false)),
  AND: (a) => flat(a).every(truthy), OR: (a) => flat(a).some(truthy), NOT: (a) => !truthy(a[0]),
  LEN: (a) => text(a[0]).length, UPPER: (a) => text(a[0]).toUpperCase(), LOWER: (a) => text(a[0]).toLowerCase(), TRIM: (a) => text(a[0]).trim().replace(/ +/g, ' '),
  CONCAT: (a) => flat(a).map(text).join(''), CONCATENATE: (a) => a.map(text).join(''),
};
const truthy = (v) => (typeof v === 'string' ? (/^(true|false)$/i.test(v) ? /^true$/i.test(v) : fail()) : !!num(v));
const text = (v) => (v == null ? '' : typeof v === 'number' ? numberText(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

/**
 * Work out a formula (without "="). `get(r, c)` gives another cell's value (null when empty), `maxRow` bounds whole
 * columns. Returns the value, or null when it can't be worked out here.
 */
export function evaluateFormula(src, get, { maxRow = 0 } = {}) {
  let toks, i = 0;
  try { toks = tokens(String(src).replace(/^=/, '')); } catch { return null; }
  const peek = () => toks[i];
  const take = (v) => { const t = toks[i]; if (!t || (v && t.v !== v)) fail(); i++; return t; };
  const cell = (ref) => { const p = cellRef(ref); if (!p) fail(); const v = get(p[0], p[1]); if (v === FAIL) fail(); return v; };
  const range = (ref) => {
    const [a, b] = ref.split(':');
    const whole = !/\d/.test(a);
    const p = whole ? [0, cellRef(a + '1')[1]] : cellRef(a), q = whole ? [Math.max(0, maxRow - 1), cellRef(b + '1')[1]] : cellRef(b);
    if (!p || !q) fail();
    const [r0, r1] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])], [c0, c1] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 1e6) fail();
    const values = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const v = get(r, c); if (v === FAIL) fail(); values.push(v); }
    return { range: true, values };
  };
  const primary = () => {
    const t = take();
    if (t.t === 'n' || t.t === 's') return t.v;
    if (t.t === 'ref') return t.v.includes(':') ? range(t.v) : cell(t.v);
    if (t.t === 'name') {
      if (t.v === 'TRUE' || t.v === 'FALSE') { if (peek() && peek().v === '(') { take('('); take(')'); } return t.v === 'TRUE'; }
      const fn = FUNCS[t.v.replace(/^_XLFN\./, '')];
      if (!fn || !peek() || peek().v !== '(') fail();
      take('(');
      const args = [];
      if (peek() && peek().v !== ')') for (;;) { args.push(expr(0)); if (peek() && peek().v === ',') { take(','); continue; } break; }
      take(')');
      return fn(args);
    }
    if (t.v === '(') { const v = expr(0); take(')'); return v; }
    if (t.v === '-') return -num(scalar(unary()));
    if (t.v === '+') return num(scalar(unary()));
    return fail();
  };
  const scalar = (v) => (v && v.range ? (v.values.length === 1 ? v.values[0] : fail()) : v);
  const unary = () => { let v = primary(); while (peek() && peek().v === '%') { take('%'); v = num(scalar(v)) / 100; } return v; };
  const expr = (min) => {
    let left = unary();
    for (;;) {
      const t = peek();
      const p = t && t.t === 'op' ? PREC[t.v] : undefined;
      if (p === undefined || p < min) return left;
      take();
      const right = expr(t.v === '^' ? p : p + 1);
      const a = scalar(left), b = scalar(right);
      switch (t.v) {
        case '+': left = num(a) + num(b); break;
        case '-': left = num(a) - num(b); break;
        case '*': left = num(a) * num(b); break;
        case '/': if (num(b) === 0) fail(); left = num(a) / num(b); break;
        case '^': left = num(a) ** num(b); break;
        case '&': left = text(a) + text(b); break;
        default: {
          const x = typeof a === 'string' || typeof b === 'string' ? text(a).toLowerCase() : num(a), y = typeof a === 'string' || typeof b === 'string' ? text(b).toLowerCase() : num(b);
          left = { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[t.v];
        }
      }
    }
  };
  try {
    const v = scalar(expr(0));
    if (i !== toks.length) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e12) / 1e12 : null;
    return v ?? 0;
  } catch (e) { if (e instanceof Fail || e instanceof RangeError) return null; throw e; }
}

/** "D2*2" written at D2, shared to D5 → "D5*2": relative references move with the cell; $-anchored ones don't. */
function shiftFormula(src, dr, dc) {
  return String(src).replace(/("(?:[^"]|"")*")|(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w(!])/g, (m, str, cAbs, col, rAbs, row) => {
    if (str) return str;
    let c = 0;
    for (const ch of col.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    const nc = cAbs ? c - 1 : c - 1 + dc, nr = rAbs ? Number(row) : Number(row) + dr;
    if (nc < 0 || nr < 1) return m;
    return `${cAbs}${colName(nc)}${rAbs}${nr}`;
  });
}

/** Work out the formula cells that came without a saved result ([{r, c, f}]), in place. → {computed, missing}. */
function evaluatePending(rows, pending) {
  if (!pending.length) return { computed: 0, missing: 0 };
  const at = new Map(pending.map((p) => [p.r * MAX_COLS + p.c, p]));
  const state = new Map(); // key → 'busy' | value
  const maxRow = rows.length;
  const get = (r, c) => {
    const k = r * MAX_COLS + c;
    const p = at.get(k);
    if (!p) return (rows[r] && rows[r][c]) ?? null;
    if (state.has(k)) { const v = state.get(k); return v === 'busy' ? FAIL : v; }
    state.set(k, 'busy');
    const v = evaluateFormula(p.f, get, { maxRow });
    state.set(k, v == null ? FAIL : v);
    return v == null ? FAIL : v;
  };
  let computed = 0, missing = 0, n = 0;
  for (const p of pending) {
    if (++n > 200000) { missing++; continue; }
    let v;
    try { v = get(p.r, p.c); } catch { v = FAIL; } // a very deep chain: left empty
    if (v === FAIL || v == null) { missing++; continue; }
    computed++;
    while (rows.length <= p.r) rows.push([]);
    const row = rows[p.r];
    while (row.length < p.c) row.push(null);
    row[p.c] = v;
  }
  return { computed, missing };
}

// ------------------------------------------------------------------ XLSX
/** Resolve a relationship target against the folder of the part that points to it. */
function partPath(base, target) {
  if (!target) return null;
  if (/^[a-z]+:/i.test(target)) return null; // external
  const parts = (target.startsWith('/') ? target.slice(1) : base + target).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

/**
 * An XLSX workbook. `read(path)` resolves to a part's text or null (the processor unzips with JSZip and caps
 * sizes). → {sheets: [{name, hidden, rows}], date1904}. Merged cells are not filled in: the value stays in the
 * top-left cell.
 */
export async function readXlsx(read, { only = null, evaluate = false } = {}) {
  const wb = await read('xl/workbook.xml');
  if (wb == null) throw new SheetError('This isn’t an Excel workbook, or it is damaged.');
  const date1904 = /<(?:[\w.-]+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/i.test(wb);
  const rels = new Map();
  const relXml = await read('xl/_rels/workbook.xml.rels');
  if (relXml) for (const r of elements(relXml, 'Relationship')) { const a = attrs(r.a); if (a.Id) rels.set(a.Id, partPath('xl/', a.Target)); }
  const list = [];
  for (const s of elements(wb, 'sheet')) {
    const a = attrs(s.a);
    list.push({ name: a.name || `Sheet${list.length + 1}`, hidden: a.state === 'hidden' || a.state === 'veryHidden', path: rels.get(a.id) || `xl/worksheets/sheet${list.length + 1}.xml` });
    if (list.length > MAX_SHEETS) throw new SheetError('This workbook has too many sheets.');
  }
  const strings = [];
  const sst = await read('xl/sharedStrings.xml');
  if (sst) for (const si of elements(sst, 'si')) { strings.push(richText(si.body)); if (strings.length > MAX_CELLS) throw tooBig(); }
  // Styles: which cell formats (cellXfs, by index) show dates.
  const kinds = [];
  const styles = await read('xl/styles.xml');
  if (styles) {
    const custom = new Map();
    for (const f of elements(styles, 'numFmt')) { const a = attrs(f.a); if (a.numFmtId) custom.set(Number(a.numFmtId), a.formatCode || ''); }
    const xfs = first(styles, 'cellXfs');
    if (xfs) for (const x of xfs.body.matchAll(/<(?:[\w.-]+:)?xf\b([^>]*?)\/?>/g)) kinds.push(kindOfFormat(Number(attrs(x[1]).numFmtId || 0), custom));
  }
  const count = budget();
  const sheets = [];
  for (const [i, s] of list.entries()) {
    if (only != null && i !== only) continue;
    const xml = await read(s.path);
    const rows = [];
    const pending = []; // formulas without a saved result (worked out below when `evaluate`)
    const shared = new Map(); // si → {f, r, c}: shared formulas, written once
    if (xml) {
      const data = first(xml, 'sheetData');
      let r = -1;
      for (const row of elements(data ? data.body : '', 'row')) {
        const ra = attrs(row.a);
        r = ra.r ? Number(ra.r) - 1 : r + 1;
        if (!(r >= 0 && r < MAX_ROWS)) continue;
        let c = -1;
        for (const cell of elements(row.body, 'c')) {
          const a = attrs(cell.a);
          const ref = cellRef(a.r);
          c = ref ? ref[1] : c + 1;
          const v = first(cell.body, 'v');
          const raw = v ? unescapeXml(v.body) : null;
          if (evaluate && a.t !== 'inlineStr') {
            const fm = /<(?:[\w.-]+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?f\s*>)/.exec(cell.body);
            if (fm) {
              const fa = attrs(fm[1]);
              let f = fm[2] != null ? unescapeXml(fm[2]) : '';
              if (fa.t === 'shared' && fa.si != null) {
                if (f) shared.set(fa.si, { f, r, c });
                else { const base = shared.get(fa.si); f = base ? shiftFormula(base.f, r - base.r, c - base.c) : ''; }
              }
              if (f && (raw == null || raw.trim() === '') && fa.t !== 'array' && fa.t !== 'dataTable') { pending.push({ r, c, f }); continue; }
            }
          }
          let value = null;
          switch (a.t) {
            case 's': value = raw == null ? null : strings[Number(raw)] ?? null; break;
            case 'str': value = raw == null ? null : unescapeOoxml(raw); break;
            case 'inlineStr': { const is = first(cell.body, 'is'); value = is ? richText(is.body) : raw; break; }
            case 'b': value = raw == null ? null : raw.trim() === '1' || raw.trim() === 'true'; break;
            case 'e': value = raw; break;
            case 'd': value = raw ? raw.replace(/T00:00(:00(\.0+)?)?Z?$/, '').replace('T', ' ').replace(/(\d\d:\d\d)(:00)?(\.\d+)?Z?$/, '$1') : null; break;
            default: {
              if (raw == null || raw.trim() === '') break;
              const n = Number(raw);
              if (!Number.isFinite(n)) { value = raw; break; }
              const kind = kinds[Number(a.s || 0)];
              value = kind ? serialDate(n, { kind, date1904 }) ?? n : n;
            }
          }
          setCell(rows, r, c, value, count);
        }
      }
    }
    const formulas = evaluate ? evaluatePending(rows, pending) : null;
    sheets.push(formulas && (formulas.computed || formulas.missing) ? { name: s.name, hidden: s.hidden, rows, formulas } : { name: s.name, hidden: s.hidden, rows });
  }
  return { sheets, date1904 };
}

// ------------------------------------------------------------------ XLS: OLE compound file + BIFF8
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END = 0xfffffffe;

/** Root-level streams of an OLE compound file: Map(lower-case name → Uint8Array). */
export function readCfb(bytes) {
  const bad = () => new SheetError('This .xls file is damaged.');
  if (bytes.length < 512 || OLE_MAGIC.some((b, i) => bytes[i] !== b)) throw bad();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const shift = dv.getUint16(30, true), miniShift = dv.getUint16(32, true);
  if ((shift !== 9 && shift !== 12) || miniShift !== 6) throw bad();
  const ssz = 1 << shift, msz = 1 << miniShift;
  const count = Math.floor((bytes.length - ssz) / ssz) + ((bytes.length - ssz) % ssz ? 1 : 0); // a short last sector is allowed
  const sector = (n) => { if (!(n >= 0 && n < count)) throw bad(); const o = (n + 1) * ssz; return bytes.subarray(o, Math.min(o + ssz, bytes.length)); };
  const per = ssz / 4;
  // DIFAT → FAT sectors → the FAT.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = u32(76 + i * 4); if (s < END - 4) fatSectors.push(s); }
  let next = u32(68);
  for (let guard = 0; next < END - 4; guard++) {
    if (guard > count) throw bad();
    const s = sector(next), sd = new DataView(s.buffer, s.byteOffset, s.byteLength);
    for (let i = 0; i < per - 1 && (i + 1) * 4 <= s.length; i++) { const x = sd.getUint32(i * 4, true); if (x < END - 4) fatSectors.push(x); }
    next = s.length >= ssz ? sd.getUint32(ssz - 4, true) : END;
  }
  if (fatSectors.length > count) throw bad();
  const fat = new Uint32Array(fatSectors.length * per);
  fatSectors.forEach((n, k) => { const s = sector(n), sd = new DataView(s.buffer, s.byteOffset, s.byteLength); for (let i = 0; i < per; i++) fat[k * per + i] = i * 4 + 4 <= s.length ? sd.getUint32(i * 4, true) : END; });
  const chain = (start, table, limit) => {
    const out = [];
    const seen = new Set();
    for (let n = start; n < END - 4; n = table[n]) {
      if (seen.has(n) || n >= table.length || out.length > limit) throw bad();
      seen.add(n); out.push(n);
    }
    return out;
  };
  const readChain = (start, size) => {
    if (size > bytes.length) throw bad();
    const out = new Uint8Array(size);
    let o = 0;
    for (const n of chain(start, fat, count)) { if (o >= size) break; const s = sector(n).subarray(0, size - o); out.set(s, o); o += s.length; }
    if (o < size) throw bad();
    return out;
  };
  const dirBytes = (() => { const list = chain(u32(48), fat, count); const out = new Uint8Array(list.length * ssz); list.forEach((n, k) => out.set(sector(n), k * ssz)); return out; })();
  const ddv = new DataView(dirBytes.buffer);
  const entries = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const len = Math.min(64, ddv.getUint16(o + 64, true));
    let name = '';
    for (let i = 0; i + 1 < len - 1; i += 2) name += String.fromCharCode(ddv.getUint16(o + i, true));
    entries.push({ name, type: dirBytes[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw bad();
  const cutoff = u32(56) || 4096;
  let mini = null, miniFat = null;
  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2 || streams.has(e.name.toLowerCase())) continue;
    if (e.size >= cutoff) { streams.set(e.name.toLowerCase(), () => readChain(e.start, e.size)); continue; }
    streams.set(e.name.toLowerCase(), () => {
      if (!mini) {
        mini = readChain(root.start, root.size);
        const list = chain(u32(60), fat, count);
        miniFat = new Uint32Array(list.length * per);
        list.forEach((n, k) => { const s = sector(n); const sd = new DataView(s.buffer, s.byteOffset, s.byteLength); for (let i = 0; i < per && i * 4 + 4 <= s.length; i++) miniFat[k * per + i] = sd.getUint32(i * 4, true); });
      }
      const out = new Uint8Array(e.size);
      let o = 0;
      for (const n of chain(e.start, miniFat, mini.length / msz + 1)) {
        if (o >= e.size) break;
        const from = n * msz;
        if (from + Math.min(msz, e.size - o) > mini.length) throw bad();
        const part = mini.subarray(from, from + Math.min(msz, e.size - o));
        out.set(part, o); o += part.length;
      }
      if (o < e.size) throw bad();
      return out;
    });
  }
  return streams;
}

const ERRORS = new Map([[0x00, '#NULL!'], [0x07, '#DIV/0!'], [0x0f, '#VALUE!'], [0x17, '#REF!'], [0x1d, '#NAME?'], [0x24, '#NUM!'], [0x2a, '#N/A']]);
const latin1 = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };
const cp1252 = (b) => new TextDecoder('windows-1252').decode(b);

/** RK number: a 30-bit integer or the top of a double, maybe divided by 100. */
function rkValue(rk) {
  let v;
  if (rk & 2) v = rk >> 2;
  else { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, rk & 0xfffffffc, true); v = dv.getFloat64(0, true); }
  return rk & 1 ? v / 100 : v;
}

/** Reads strings that may run on into CONTINUE records (each continued run of characters starts with a flags byte). */
class Pieces {
  constructor(list) { this.list = list; this.i = 0; this.p = 0; }
  more() { if (this.p >= this.list[this.i].length) { if (++this.i >= this.list.length) throw new SheetError('This .xls file is damaged.'); this.p = 0; } }
  u8() { this.more(); return this.list[this.i][this.p++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) { while (n > 0) { this.more(); const k = Math.min(n, this.list[this.i].length - this.p); this.p += k; n -= k; } }
  chars(n, wide) {
    let s = '';
    while (n > 0) {
      if (this.p >= this.list[this.i].length) { this.more(); wide = this.u8() & 1; }
      const b = this.list[this.i];
      const k = Math.min(n, Math.floor((b.length - this.p) / (wide ? 2 : 1)));
      if (k <= 0) throw new SheetError('This .xls file is damaged.');
      for (let j = 0; j < k; j++) s += String.fromCharCode(wide ? b[this.p + 2 * j] | (b[this.p + 2 * j + 1] << 8) : b[this.p + j]);
      this.p += k * (wide ? 2 : 1); n -= k;
    }
    return s;
  }
  /** XLUnicodeRichExtendedString (SST entries). */
  richString() {
    const n = this.u16(), flags = this.u8();
    const runs = flags & 8 ? this.u16() : 0, ext = flags & 4 ? this.u32() : 0;
    const s = this.chars(n, flags & 1);
    this.skip(runs * 4 + ext);
    return s;
  }
}

/** XLUnicodeString inside one record at `o`: {text, end}. `lenBytes` 1 for short strings (sheet names). */
function biffString(b, o, lenBytes = 2, biff8 = true) {
  if (o + lenBytes > b.length) return { text: '', end: b.length };
  const n = lenBytes === 1 ? b[o] : b[o] | (b[o + 1] << 8);
  o += lenBytes;
  if (!biff8) return { text: cp1252(b.subarray(o, Math.min(b.length, o + n))), end: o + n };
  const flags = b[o++];
  if (flags & 8) o += 2;
  if (flags & 4) o += 4;
  const wide = flags & 1;
  const len = Math.min(n, Math.floor((b.length - o) / (wide ? 2 : 1)));
  let s = '';
  if (wide) for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + 2 * i] | (b[o + 2 * i + 1] << 8));
  else s = latin1(b, o, len);
  return { text: s, end: o + len * (wide ? 2 : 1) };
}

/**
 * A real Excel 97–2003 (.xls) workbook: BIFF8 (and BIFF5 text) in an OLE compound file. Reads shared strings,
 * text, numbers (RK, MULRK, NUMBER), booleans, errors and the cached results of formulas; numbers in date or
 * time formats become dates. → {sheets: [{name, hidden, rows}], date1904}
 */
export function readBiff(bytes, { only = null } = {}) {
  const streams = readCfb(bytes);
  const get = streams.get('workbook') || streams.get('book');
  if (!get) throw new SheetError('This .xls file has no workbook in it.');
  const wb = get();
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const rec = (o) => (o + 4 <= wb.length ? { type: dv.getUint16(o, true), len: dv.getUint16(o + 2, true), data: wb.subarray(o + 4, Math.min(wb.length, o + 4 + dv.getUint16(o + 2, true))) } : null);
  // Workbook globals.
  let o = 0;
  const bof = rec(0);
  if (!bof || (bof.type & 0xff) !== 0x09) throw new SheetError('This .xls file is damaged.');
  const biff8 = bof.data.length >= 2 && (bof.data[0] | (bof.data[1] << 8)) === 0x0600;
  const bounds = [], xfs = [], custom = new Map(), strings = [];
  let date1904 = false;
  for (let guard = 0; o < wb.length && guard < 2000000; guard++) {
    const r = rec(o);
    if (!r) break;
    o += 4 + r.len;
    const d = r.data, rd = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (r.type === 0x000a) break; // EOF
    if (r.type === 0x002f) throw new SheetError('This .xls file is protected with a password. Open it in Excel, remove the password, then try again.');
    if (r.type === 0x0022 && d.length >= 2) date1904 = rd.getUint16(0, true) === 1;
    else if (r.type === 0x0085 && d.length >= 8) {
      const name = biffString(d, 6, 1, biff8).text;
      bounds.push({ pos: rd.getUint32(0, true), hidden: (d[4] & 3) !== 0, kind: d[5], name });
      if (bounds.length > MAX_SHEETS) throw new SheetError('This workbook has too many sheets.');
    } else if ((r.type === 0x00e0 || r.type === 0x0043) && d.length >= 4) xfs.push(rd.getUint16(2, true));
    else if ((r.type === 0x041e || r.type === 0x001e) && d.length >= 3) custom.set(rd.getUint16(0, true), biffString(d, 2, biff8 ? 2 : 1, biff8).text);
    else if (r.type === 0x00fc && d.length >= 8) {
      const pieces = [d.subarray(8)];
      for (let n = rec(o); n && n.type === 0x003c; n = rec(o)) { pieces.push(n.data); o += 4 + n.len; }
      const unique = rd.getUint32(4, true);
      if (unique > MAX_CELLS) throw tooBig();
      const p = new Pieces(pieces);
      try { for (let i = 0; i < unique; i++) strings.push(p.richString()); } catch (e) { if (!strings.length) throw e; } // keep what was readable
    }
  }
  const kinds = xfs.map((f) => kindOfFormat(f, custom));
  const dateOf = (ixfe, n) => { const kind = kinds[ixfe]; return kind ? serialDate(n, { kind, date1904 }) ?? n : n; };
  const count = budget();
  const sheets = [];
  bounds.forEach((s, i) => {
    if (s.kind !== 0 || (only != null && i !== only)) return;
    const rows = [];
    let p = s.pos;
    const head = rec(p);
    if (!head || (head.type & 0xff) !== 0x09) { sheets.push({ name: s.name, hidden: s.hidden, rows }); return; }
    p += 4 + head.len;
    let pending = null; // a formula whose text result follows in a STRING record
    for (let guard = 0; p < wb.length && guard < MAX_CELLS * 2; guard++) {
      const r = rec(p);
      if (!r) break;
      p += 4 + r.len;
      const d = r.data, rd = new DataView(d.buffer, d.byteOffset, d.byteLength);
      if (r.type === 0x000a) break;
      if (r.type === 0x0207 && pending) { setCell(rows, pending[0], pending[1], biffString(d, 0, 2, biff8).text, count); pending = null; continue; }
      if (d.length < 6) continue;
      const row = rd.getUint16(0, true), col = rd.getUint16(2, true), ixfe = rd.getUint16(4, true);
      switch (r.type) {
        case 0x00fd: if (d.length >= 10) setCell(rows, row, col, strings[rd.getUint32(6, true)] ?? null, count); break; // LABELSST
        case 0x0204: case 0x00d6: setCell(rows, row, col, biffString(d, 6, 2, biff8).text, count); break; // LABEL, RSTRING
        case 0x0203: if (d.length >= 14) setCell(rows, row, col, dateOf(ixfe, rd.getFloat64(6, true)), count); break; // NUMBER
        case 0x027e: if (d.length >= 10) setCell(rows, row, col, dateOf(ixfe, rkValue(rd.getUint32(6, true))), count); break; // RK
        case 0x00bd: { // MULRK: ixfe + RK per column
          for (let k = 0, q = 4; q + 6 <= d.length - 2; k++, q += 6) setCell(rows, row, col + k, dateOf(rd.getUint16(q, true), rkValue(rd.getUint32(q + 2, true))), count);
          break;
        }
        case 0x0205: if (d.length >= 8) setCell(rows, row, col, d[7] ? ERRORS.get(d[6]) || '#ERROR' : !!d[6], count); break; // BOOLERR
        case 0x0006: { // FORMULA: the cached result
          if (d.length < 14) break;
          if (rd.getUint16(12, true) === 0xffff) {
            const t = d[6];
            if (t === 0) pending = [row, col];
            else if (t === 1) setCell(rows, row, col, !!d[8], count);
            else if (t === 2) setCell(rows, row, col, ERRORS.get(d[8]) || '#ERROR', count);
          } else setCell(rows, row, col, dateOf(ixfe, rd.getFloat64(6, true)), count);
          break;
        }
        default: break;
      }
    }
    sheets.push({ name: s.name, hidden: s.hidden, rows });
  });
  return { sheets, date1904 };
}

// ------------------------------------------------------------------ "XLS" files that are really HTML or XML
/** An HTML page's table rows (what many banks save as .xls): one sheet. Cells spanning columns keep their place. */
export function readHtmlTable(text) {
  if (text.length > MAX_TEXT) throw tooBig();
  const s = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '');
  const rows = [];
  const count = budget();
  let row = null, cell = null, span = 1;
  const endCell = () => { if (cell == null) return; row.push(cell.replace(/[ \t\r\n\u00a0]+/g, ' ').trim() || null); count(); for (let k = 1; k < span && row.length < MAX_COLS; k++) row.push(null); cell = null; };
  const endRow = () => { endCell(); if (row && rows.length < MAX_ROWS) rows.push(row); row = null; };
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g)) {
    if (m[4] != null) { if (cell != null) cell += unescapeXml(m[4]); continue; }
    const tag = m[2].toLowerCase(), close = m[1] === '/';
    if (tag === 'tr') { if (close) endRow(); else { endRow(); row = []; } }
    else if (tag === 'td' || tag === 'th') {
      if (close) endCell();
      else { if (!row) row = []; endCell(); cell = ''; const a = attrs(m[3]); span = Math.min(256, Math.max(1, parseInt(a.colspan, 10) || 1)); }
    } else if (tag === 'table' && close) endRow();
    else if ((tag === 'br' || tag === 'p' || tag === 'div') && cell != null) cell += ' ';
  }
  endRow();
  if (!rows.some((r) => r.some((c) => c != null))) throw new SheetError('No table was found in this file.');
  return { sheets: [{ name: 'Sheet1', hidden: false, rows: rows.map((r) => (r.some((c) => c != null) ? r : [])) }], date1904: false };
}

/** Excel 2003 XML Spreadsheet (SpreadsheetML). */
export function readSpreadsheetMl(text) {
  if (text.length > MAX_TEXT) throw tooBig();
  const count = budget();
  const sheets = [];
  for (const ws of elements(text, 'Worksheet')) {
    const a = attrs(ws.a);
    const rows = [];
    const table = first(ws.body, 'Table');
    let r = -1;
    for (const row of elements(table ? table.body : '', 'Row')) {
      const ra = attrs(row.a);
      r = ra.Index ? Number(ra.Index) - 1 : r + 1;
      let c = -1;
      for (const cell of elements(row.body, 'Cell')) {
        const ca = attrs(cell.a);
        c = ca.Index ? Number(ca.Index) - 1 : c + 1;
        const data = first(cell.body, 'Data');
        if (data) {
          const type = attrs(data.a).Type;
          const raw = unescapeXml(data.body.replace(/<[^>]*>/g, ''));
          let v = raw;
          if (type === 'Number') { const n = Number(raw); v = Number.isFinite(n) ? n : raw; }
          else if (type === 'Boolean') v = raw.trim() === '1';
          else if (type === 'DateTime') v = raw.replace(/T00:00:00(\.0+)?$/, '').replace('T', ' ').replace(/(\d\d:\d\d)(:00)?(\.\d+)?$/, '$1');
          setCell(rows, r, c, v, count);
        }
        c += Math.min(MAX_COLS, Math.max(0, parseInt(ca.MergeAcross, 10) || 0));
      }
    }
    sheets.push({ name: a.Name || `Sheet${sheets.length + 1}`, hidden: false, rows });
    if (sheets.length > MAX_SHEETS) throw new SheetError('This workbook has too many sheets.');
  }
  if (!sheets.length) throw new SheetError('This file has no sheets.');
  return { sheets, date1904: false };
}

/** What a spreadsheet file really holds, by its first bytes: 'xlsx' (a zip), 'biff' (an OLE file), 'xml', 'html' or 'text'. */
export function sniff(bytes, text = null) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if (OLE_MAGIC.every((b, i) => bytes[i] === b)) return 'biff';
  const head = (text ?? latin1(bytes, 0, Math.min(bytes.length, 4096))).slice(0, 4096).replace(/^\ufeff/, '').trimStart();
  if (/^<\?xml/i.test(head) && /urn:schemas-microsoft-com:office:spreadsheet|<(?:\w+:)?Workbook\b/.test(head)) return 'xml';
  if (/^<(?:!doctype html|html|table|meta|body|head|style|tr)\b/i.test(head) || /<table\b/i.test(head)) return 'html';
  return 'text';
}

// ------------------------------------------------------------------ JSON
/**
 * A JSON table → {header: string[] | null, rows}. An array of objects gives a header from the keys (all of them, in
 * the order first seen); an array of arrays gives rows. One array inside an object ({"data": [...]}) is used too.
 * Nested values become JSON text. Anything else is not a table.
 */
export function jsonTable(text) {
  if (text.length > MAX_TEXT) throw tooBig();
  let data;
  try { data = JSON.parse(text.replace(/^\ufeff/, '')); } catch { throw new SheetError('This JSON file isn’t valid JSON.'); }
  const notTable = () => new SheetError('This JSON isn’t a table. It needs a list of objects (one per row) or a list of rows.');
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(data)) {
    const arrays = Object.keys(data).filter((k) => Array.isArray(data[k]) && data[k].length && data[k].every((x) => isObj(x) || Array.isArray(x)));
    if (arrays.length !== 1) throw notTable();
    data = data[arrays[0]];
  }
  if (!Array.isArray(data) || !data.length) throw notTable();
  if (data.length > MAX_ROWS) throw new SheetError(`This JSON has too many rows (the limit is ${MAX_ROWS.toLocaleString('en')}).`);
  const plain = (v) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' && !Number.isFinite(v) ? null : v);
  const count = budget();
  if (data.every(isObj)) {
    const keys = new Map(); // first-seen order, no prototype lookups
    for (const o of data) for (const k of Object.keys(o)) if (!keys.has(k)) { if (keys.size >= MAX_COLS) throw new SheetError('This JSON has too many columns.'); keys.set(k, keys.size); }
    const header = [...keys.keys()];
    const rows = data.map((o) => header.map((k) => { count(); return Object.prototype.hasOwnProperty.call(o, k) ? plain(o[k]) : null; }));
    return { header, rows };
  }
  if (data.every(Array.isArray)) {
    if (data.some((r) => r.length > MAX_COLS)) throw new SheetError('This JSON has too many columns.');
    return { header: null, rows: data.map((r) => r.map((v) => { count(); return plain(v); })) };
  }
  throw notTable();
}

// ------------------------------------------------------------------ writing
/** Sheets with something in them; hidden sheets only when nothing else has data. Leading and trailing empty rows go. */
export function usableSheets(sheets) {
  const trim = (rows) => {
    const out = rows.map((r) => { const row = r.slice(); while (row.length && (row[row.length - 1] == null || row[row.length - 1] === '')) row.pop(); return row; });
    while (out.length && !out[out.length - 1].length) out.pop();
    let start = 0;
    while (start < out.length && !out[start].length) start++;
    return out.slice(start);
  };
  const full = sheets.map((s) => ({ ...s, rows: trim(s.rows) })).filter((s) => s.rows.length);
  const shown = full.filter((s) => !s.hidden);
  return shown.length ? shown : full;
}

/** Is the first row a header: every cell filled with distinct text, and more than one row? */
export function hasHeader(rows) {
  const first = rows[0] || [];
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.length > 1 && first.length === width && first.every((c) => typeof c === 'string' && c.trim() !== '')
    && new Set(first.map((c) => c.trim().toLowerCase())).size === first.length;
}

const csvQuote = (s) => (/[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
/** CSV text (comma, CRLF, quoted where needed). Callers add a UTF-8 BOM so Excel reads accents and ₹ correctly. */
export function rowsToCsv(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => { const cells = []; for (let k = 0; k < width; k++) cells.push(csvQuote(cellText(r[k]))); return cells.join(','); }).join('\r\n') + '\r\n';
}

/**
 * Compact JSON, one record per line: "[\n{…},\n{…}\n]\n". Objects keyed by the header row when there is one
 * (extra columns get "Column N"), otherwise arrays of rows. Keys are written as data, never looked up.
 */
export function rowsToJson(rows, header) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const val = (v) => JSON.stringify(v === undefined ? null : v);
  let lines;
  if (header) {
    const keys = rows[0].map((k) => String(k).trim());
    for (let k = keys.length; k < width; k++) keys.push('Column ' + (k + 1));
    const enc = keys.map((k) => JSON.stringify(k) + ':');
    lines = rows.slice(1).map((r) => '{' + enc.map((k, i) => k + val(i < r.length && r[i] != null ? r[i] : '')).join(',') + '}');
  } else lines = rows.map((r) => '[' + r.map((v) => val(v == null ? null : v)).join(',') + ']');
  return lines.length ? '[\n' + lines.join(',\n') + '\n]\n' : '[]\n';
}
