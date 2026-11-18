// Add page numbers: the app's tool (src/main/tools/pdfNumbers.js) with the processor's pdf.numbers; the preview is
// drawn with the same code as the app's window (src/shared/pdftools.mjs numberFor, numberLabel, drawNumber).
import { tool, engine, LIMITS, plural } from './ui.js';
import { NUMBER_POSITIONS, NUMBER_STYLES, NUMBER_SIZES, NUMBER_DEFAULTS, MAX_START, numberFor, numberLabel, lastNumber, drawNumber } from '../../tools/engine/shared/pdftools.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason, pagePreview } from './pdfkit.js';

const opts = (o) => ({ position: o.position, style: o.style, start: o.start || 1, size: o.size || NUMBER_SIZES.def, skipFirst: !!o.skipFirst });
const preview = pagePreview((ctx, vw, vh, k, n, app) => {
  const o = opts(app.o), count = app.files.find((f) => !f.error && f.meta.pages).meta.pages;
  const num = numberFor(n - 1, count, o);
  if (num != null) drawNumber(ctx, vw, vh, k, numberLabel(o.style, num, lastNumber(count, o)), o);
}, { start: (app) => (app.o.skipFirst ? 2 : 1), label: 'Preview' });

tool({
  ...PDF_ACCEPT, multiple: true, max: 50,
  pick: 'Choose PDFs', drop: 'One or more PDFs. The first one is shown in the preview.',
  verb: 'Numbering',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  stage: preview.stage,
  onOptions: (app) => preview.redraw(app),
  reset: () => preview.reset(),
  options: [
    { id: 'position', type: 'chips', label: 'Position', value: NUMBER_DEFAULTS.position, choices: NUMBER_POSITIONS },
    { id: 'style', type: 'seg', label: 'Style', value: NUMBER_DEFAULTS.style, choices: NUMBER_STYLES },
    { id: 'start', type: 'number', label: 'Start at', min: 1, max: MAX_START, value: NUMBER_DEFAULTS.start, more: true },
    { id: 'size', type: 'range', label: 'Text size', min: NUMBER_SIZES.min, max: NUMBER_SIZES.max, value: NUMBER_DEFAULTS.size, unit: ' pt', more: true },
    { id: 'skipFirst', type: 'toggle', label: 'No number on the first page', value: false, more: true, hint: (o) => (o.skipFirst ? `Numbering starts on page 2 with ${o.start || 1}.` : 'For a cover page.') },
  ],
  check(files, o) { return lockedReason(files) || (!(o.start >= 1) ? 'Enter the first number.' : ''); },
  action: (files) => `Number ${files.length === 1 ? 'the pages' : plural(files.length, 'PDF')}`,
  zipName: () => 'Numbered PDFs.zip',
  showSaving: false,
  async run(f, o, job) {
    const r = await engine.run('pdf.numbers', { bytes: await job.bytes(), o: opts(o), limits: LIMITS, password: f.password || undefined }, job);
    return { outputs: [{ name: job.name(f.stem, 'pdf', 'numbered'), bytes: r.bytes }], note: `${r.numbered} of ${plural(r.pages, 'page')} numbered` };
  },
});
