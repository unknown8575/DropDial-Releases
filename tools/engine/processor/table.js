// Spreadsheet conversions: CSV → XLSX / JSON, XLSX / XLS → CSV / JSON / XLSX (and the rows for a PDF table),
// JSON → CSV / XLSX. Parsing lives in ../shared/table.mjs (CSV, XLSX writer) and ../shared/sheets.mjs (readers).
import * as T from '../shared/table.mjs';
import * as S from '../shared/sheets.mjs';
import { UserError } from './errors.js';

const MAX_PART = 256 * 1024 * 1024; // unpacked bytes of one XML part
const MAX_UNPACKED = 512 * 1024 * 1024; // all parts read from one workbook
const PDF_ROWS = 5000; // rows printed per sheet

const asUser = (e) => (e && e.user ? new UserError(e.message) : e);

/** A reader of an XLSX's parts that caps what is unpacked. */
async function zipped(bytes) {
  const zip = await self.JSZip.loadAsync(bytes, { checkCRC32: false }).catch(() => { throw new UserError('This Excel file is damaged.'); });
  const entries = zip.files;
  let total = 0;
  return {
    async read(path) {
      const f = Object.prototype.hasOwnProperty.call(entries, path) ? entries[path] : null;
      if (!f || f.dir) return null;
      const declared = f._data && f._data.uncompressedSize;
      if (typeof declared === 'number' && (declared > MAX_PART || total + declared > MAX_UNPACKED)) throw new UserError('This spreadsheet is too large to read.');
      // Read in pieces and stop as soon as the real size goes over the limit (a zip can lie about sizes).
      const parts = [];
      let size = 0;
      await new Promise((resolve, reject) => {
        const s = f.internalStream('uint8array');
        s.on('data', (chunk) => { size += chunk.length; total += chunk.length; if (size > MAX_PART || total > MAX_UNPACKED) { s.pause(); reject(new UserError('This spreadsheet is too large to read.')); } else parts.push(chunk); })
          .on('error', () => reject(new UserError('This Excel file is damaged.'))).on('end', resolve).resume();
      });
      const all = new Uint8Array(size);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      return new TextDecoder('utf-8').decode(all);
    },
  };
}

/** A workbook from file bytes, whatever is really inside an .xls/.xlsx name. → {sheets, kind} */
export async function readBook(bytes, format, { evaluate = false } = {}) {
  const kind = S.sniff(bytes);
  try {
    if (kind === 'xlsx') return { ...(await S.readXlsx((await zipped(bytes)).read, { evaluate })), kind };
    if (kind === 'biff') return { ...S.readBiff(bytes), kind };
    if (format === 'xlsx') throw new UserError('This isn’t an Excel workbook, or it is damaged.');
    const text = T.decodeText(bytes);
    if (kind === 'xml') return { ...S.readSpreadsheetMl(text), kind };
    if (kind === 'html') return { ...S.readHtmlTable(text), kind };
    // Some banks save tab- or comma-separated text with an .xls name.
    if (/\u0000/.test(text.slice(0, 2000))) throw new UserError('This .xls file is damaged or in a format DropDial can’t read.');
    const { rows } = T.typedTable(text);
    return { sheets: [{ name: 'Sheet1', hidden: false, rows }], kind: 'text' };
  } catch (e) { throw asUser(e); }
}

const encode = (s) => new TextEncoder().encode(s);
const BOM = '﻿';

async function xlsxBytes(sheets) {
  let parts;
  try { parts = T.xlsxBookParts(sheets); } catch (e) { throw new UserError(e.message); }
  const zip = new self.JSZip();
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** {bytes, to: 'xlsx'|'json', name} → {bytes, rows} */
export async function fromCsv({ bytes, to, name }) {
  const text = T.decodeText(bytes);
  const table = T.typedTable(text);
  if (!table.rows.length) throw new UserError('This CSV file is empty.');
  if (to === 'json') return { bytes: encode(T.csvToJson(text)), rows: table.rows.length };
  if (to !== 'xlsx') throw new UserError('This conversion isn’t supported.');
  return { bytes: await xlsxBytes([{ name: String(name || 'Sheet1'), rows: table.rows, header: table.header }]), rows: table.rows.length };
}

/**
 * XLSX / XLS / JSON → {files: [{sheet, bytes}], sheets, skipped} for CSV, JSON and XLSX, or {tables: [{name, rows,
 * header, more}]} for a PDF (printed by the main process). CSV and JSON make one file per sheet that has data;
 * XLSX keeps every sheet in one workbook.
 */
export async function convert({ bytes, from, to, name }) {
  let sheets;
  if (from === 'json') {
    let t;
    try { t = S.jsonTable(T.decodeText(bytes)); } catch (e) { throw asUser(e); }
    sheets = [{ name: String(name || 'Sheet1'), rows: t.header ? [t.header, ...t.rows] : t.rows, header: !!t.header }];
  } else {
    // Formulas saved without their results (files made by scripts) are worked out where they are simple.
    const book = await readBook(bytes, from, { evaluate: true });
    sheets = S.usableSheets(book.sheets).map((s) => ({ ...s, header: S.hasHeader(s.rows) }));
  }
  const formulas = sheets.reduce((t, s) => ({ computed: t.computed + ((s.formulas && s.formulas.computed) || 0), missing: t.missing + ((s.formulas && s.formulas.missing) || 0) }), { computed: 0, missing: 0 });
  const done = (r) => ({ ...r, formulas });
  if (!sheets.length) throw new UserError(from === 'json' ? 'This JSON file has no rows.' : 'This spreadsheet is empty.');
  if (to === 'pdf') {
    return done({ tables: sheets.map((s) => ({ name: s.name, header: s.header, rows: s.rows.slice(0, PDF_ROWS + (s.header ? 1 : 0)).map((r) => r.map(S.cellText)), more: Math.max(0, s.rows.length - PDF_ROWS - (s.header ? 1 : 0)) })) });
  }
  if (to === 'xlsx') return done({ files: [{ sheet: null, bytes: await xlsxBytes(sheets) }], sheets: sheets.length });
  if (to === 'csv') return done({ files: sheets.map((s) => ({ sheet: s.name, bytes: encode(BOM + S.rowsToCsv(s.rows)) })), sheets: sheets.length });
  if (to === 'json') return done({ files: sheets.map((s) => ({ sheet: s.name, bytes: encode(S.rowsToJson(s.rows, s.header)) })), sheets: sheets.length });
  throw new UserError('This conversion isn’t supported.');
}
