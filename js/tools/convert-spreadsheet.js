// Convert spreadsheet: the app's sheet routes (src/main/conversions.js ENGINES['csv-table'] and ['sheet-table']) —
// CSV → Excel/JSON with the processor's table.fromCsv; Excel (XLSX, XLS) and JSON → CSV/JSON/Excel with table.convert,
// one file per sheet for CSV and JSON. Formulas saved without results are worked out where simple, and said.
import { tool, engine, plural, F } from './ui.js';

const TO = [{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }];
const label = (id) => TO.find((t) => t.value === id).label;
const can = (f, to) => !!F.routeEngine(f.format, to);

tool({
  kinds: ['csv', 'xlsx', 'xls', 'json'], wrongKind: (f) => `${f.name} isn’t a CSV, Excel or JSON file.`, multiple: true, max: 50,
  pick: 'Choose spreadsheets', drop: 'CSV, Excel (.xlsx or .xls) or JSON files.',
  verb: 'Converting',
  options: [
    { id: 'to', type: 'seg', label: 'Convert to', value: 'xlsx', choices: TO,
      hint: (o) => (o.to === 'xlsx' ? 'Opens in Excel, Numbers and Google Sheets. Numbers and dates stay numbers and dates.' : o.to === 'csv' ? 'Plain rows and commas, for any app. Each sheet becomes its own file.' : 'For code and web apps: a list of rows, with the first row as names when it looks like a header.') },
  ],
  check(files, o) { return files.some((f) => can(f, o.to)) ? '' : `${files.length === 1 ? 'This file' : 'These files'} can’t become ${label(o.to)}.`; },
  action: (files, o) => `Convert ${files.length === 1 ? 'to' : plural(files.length, 'file') + ' to'} ${label(o.to).replace(/ \(.*/, '')}`,
  zipName: (a) => `Sheets as ${a.o.to.toUpperCase()}.zip`,
  showSaving: false,
  async run(f, o, job) {
    if (!can(f, o.to)) return { skipped: f.format === o.to ? `Already ${label(o.to)}, so it was left as it is.` : `${f.label} can’t become ${label(o.to)}.` };
    const ext = F.formatInfo(o.to).ext;
    if (f.format === 'csv') {
      const r = await engine.run('table.fromCsv', { bytes: await job.bytes(), to: o.to, name: f.stem }, job);
      return { outputs: [{ name: job.name(f.stem, ext), bytes: r.bytes }], note: plural(r.rows, 'row') };
    }
    const r = await engine.run('table.convert', { bytes: await job.bytes(), from: f.format, to: o.to, name: f.stem }, job);
    const fx = r.formulas || { computed: 0, missing: 0 };
    const fxNote = fx.missing ? `${fx.missing === 1 ? '1 formula cell has' : fx.missing.toLocaleString('en') + ' formula cells have'} no saved value and ${fx.missing === 1 ? 'is' : 'are'} empty (open and save the file in Excel to fill ${fx.missing === 1 ? 'it' : 'them'})`
      : fx.computed ? `${fx.computed === 1 ? '1 formula' : fx.computed.toLocaleString('en') + ' formulas'} worked out (the file had no saved results)` : '';
    const files = r.files || [];
    const outputs = files.length === 1
      ? [{ name: job.name(f.stem, ext), bytes: files[0].bytes }]
      : files.map((x, i) => ({ name: job.name(F.safeStem(`${f.stem} ${x.sheet || 'Sheet' + (i + 1)}`), ext), bytes: x.bytes }));
    const notes = [o.to === 'xlsx' && r.sheets > 1 ? plural(r.sheets, 'sheet') : files.length > 1 ? `${plural(files.length, 'sheet')}, one file each` : '', fxNote];
    return { outputs, before: files.length === 1 ? f.size : null, note: notes.filter(Boolean).join(' · '), warn: fx.missing > 0 };
  },
});
