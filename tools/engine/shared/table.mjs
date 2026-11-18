// CSV → spreadsheet (XLSX) and JSON, shared by the processor (conversions) and the unit tests.
// Pure functions: no DOM, no Node. The processor zips the XLSX parts with its vendored JSZip.
import { rowsToJson } from './sheets.mjs';

export const MAX_ROWS = 1048576; // Excel's limits
export const MAX_COLS = 16384;
export const MAX_CELL = 32767;

/** Text from file bytes: UTF-8 (with or without a BOM), UTF-16 with a BOM, or Windows-1252 for older files. */
export function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}

const DELIMS = [',', ';', '\t', '|'];

/** The delimiter used by most of the first lines (outside quotes): comma, semicolon, tab or bar. */
export function detectDelimiter(text) {
  const counts = DELIMS.map(() => []);
  let line = DELIMS.map(() => 0), quoted = false, lines = 0;
  for (let i = 0; i < text.length && lines < 20; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (line.some((n) => n)) { line.forEach((n, k) => counts[k].push(n)); lines++; }
      line = DELIMS.map(() => 0);
    } else if (!quoted) { const k = DELIMS.indexOf(ch); if (k >= 0) line[k]++; }
  }
  if (line.some((n) => n)) line.forEach((n, k) => counts[k].push(n));
  // Score: lines that use the delimiter, then how steadily (the same count on each line).
  let best = ',', score = -1;
  DELIMS.forEach((d, k) => {
    const c = counts[k];
    if (!c.length) return;
    const used = c.filter((n) => n > 0).length;
    const mode = c.slice().sort((a, b) => c.filter((x) => x === b).length - c.filter((x) => x === a).length)[0];
    const steady = c.filter((n) => n === mode && n > 0).length;
    const s = used * 2 + steady;
    if (s > score) { score = s; best = d; }
  });
  return best;
}

/**
 * Rows of cells from CSV text: quotes ("a, b" and "" for a quote), line breaks inside quotes, CRLF/LF/CR,
 * a UTF-8 BOM, and comma, semicolon, tab or bar delimiters (found by detectDelimiter unless given).
 * Fully empty lines are left out. → {rows: string[][], delimiter}
 */
export function parseCsv(text, delimiter) {
  text = String(text || '').replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', quoted = false, wasQuoted = false;
  const endCell = () => { row.push(cell); cell = ''; wasQuoted = false; };
  const endRow = () => { endCell(); if (row.length > 1 || row[0] !== '' ) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"' && (cell === '' || wasQuoted)) { quoted = true; wasQuoted = true; }
    else if (ch === d) endCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return { rows, delimiter: d };
}

/**
 * A cell as a number when it clearly is one ("12", "-3.5", "1e3", "1,299.00"; "12,5" in semicolon files), else
 * the text itself. Codes stay text: a leading zero ("007"), or 12+ digits (account and phone numbers, which a
 * spreadsheet would round or show as 5.01E+13).
 */
export function cellValue(raw, delimiter = ',') {
  const s = String(raw).trim();
  if (!s || s.length > 40) return raw;
  let t = s;
  if (delimiter === ';' && /^[-+]?\d+,\d+$/.test(t)) t = t.replace(',', '.'); // European decimal comma
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, ''); // thousands separators
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return raw;
  const digits = t.replace(/^[-+]/, '').split(/[.eE]/)[0];
  if (digits.length > 1 && digits[0] === '0') return raw; // "007", "0000000000000001"
  if (digits.length >= 12 && !/[.eE]/.test(t)) return raw;
  const n = Number(t);
  return Number.isFinite(n) ? n : raw;
}

/** Typed rows (numbers as numbers) and whether the first row is a header (all filled in, distinct, not numbers). */
export function typedTable(text) {
  const { rows, delimiter } = parseCsv(text);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const first = rows[0] || [];
  const header = rows.length > 1 && first.length === width && first.every((c) => c.trim() !== '' && typeof cellValue(c, delimiter) === 'string')
    && new Set(first.map((c) => c.trim().toLowerCase())).size === first.length;
  const typed = rows.map((r, i) => (header && i === 0 ? r.map((c) => c.trim()) : r.map((c) => cellValue(c, delimiter))));
  return { rows: typed, header, width, delimiter };
}

/**
 * JSON text: an array of objects keyed by the header row, or an array of rows when there is no header. Compact,
 * one record per line, so the file stays close to the CSV's size.
 */
export function csvToJson(text) {
  const { rows, header } = typedTable(text);
  if (!rows.length) throw new Error('empty');
  return rowsToJson(rows, header);
}

// ------------------------------------------------------------------ XLSX
const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "A", "B", … "Z", "AA" for a 0-based column. */
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** The files inside an .xlsx for these typed rows (one sheet; a header row is bold and stays in view). → {path: xml} */
export function xlsxParts(rows, { header = false, sheetName = 'Sheet1' } = {}) {
  return xlsxBookParts([{ name: sheetName, rows, header }]);
}

/** One worksheet's XML. Cells: numbers, booleans and text (null or '' is empty). */
function sheetXml(rows, header) {
  if (rows.length > MAX_ROWS) throw new Error(`Too many rows for a spreadsheet (the limit is ${MAX_ROWS.toLocaleString('en')}).`);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (width > MAX_COLS) throw new Error(`Too many columns for a spreadsheet (the limit is ${MAX_COLS.toLocaleString('en')}).`);
  const out = [];
  rows.forEach((r, i) => {
    const cells = [];
    r.forEach((v, k) => {
      if (v === '' || v == null) return;
      const ref = colName(k) + (i + 1);
      const bold = header && i === 0 ? ' s="1"' : '';
      if (typeof v === 'number') { if (Number.isFinite(v)) cells.push(`<c r="${ref}"${bold}><v>${v}</v></c>`); }
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${bold} t="b"><v>${v ? 1 : 0}</v></c>`);
      else {
        const text = String(v).length > MAX_CELL ? String(v).slice(0, MAX_CELL) : String(v);
        const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
        cells.push(`<c r="${ref}"${bold} t="inlineStr"><is><t${space}>${xmlEsc(text)}</t></is></c>`);
      }
    });
    out.push(`<row r="${i + 1}">${cells.join('')}</row>`);
  });
  const widths = Array.from({ length: Math.min(width, 200) }, (_, k) => {
    const longest = rows.slice(0, 500).reduce((m, r) => Math.max(m, r[k] == null ? 0 : String(r[k]).length), 0);
    return `<col min="${k + 1}" max="${k + 1}" width="${Math.max(8, Math.min(60, longest + 2))}" customWidth="1"/>`;
  });
  const pane = header && rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  const dim = width && rows.length ? `<dimension ref="A1:${colName(width - 1)}${rows.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}>${dim}${pane}${widths.length ? `<cols>${widths.join('')}</cols>` : ''}<sheetData>${out.join('')}</sheetData></worksheet>`;
}
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** An .xlsx with one worksheet per {name, rows, header}. Sheet names are made valid and unique. → {path: xml} */
export function xlsxBookParts(sheets) {
  const used = new Set();
  const names = sheets.map((s, i) => {
    const base = String(s.name ?? '').replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = base.slice(0, 31 - String(n).length - 3) + ` (${n})`;
    used.add(name.toLowerCase());
    return xmlEsc(name);
  });
  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS} xmlns:r="${REL}"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet ${NS}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  sheets.forEach((s, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, !!s.header); });
  return parts;
}
