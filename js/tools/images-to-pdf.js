// Images to PDF: the app's tool (src/main/tools/imagesToPdf.js) — one page per picture in the chosen order, page size,
// orientation, margin and Scan look — with the processor's pdf.fromImages and the page maths in src/shared/compose.mjs.
import { tool, engine, LIMITS, plural, fmtBytes, UserError } from './ui.js';
import { PDF_PAGES, PDF_MARGINS, MAX_PDF_IMAGES } from '../../tools/engine/shared/compose.mjs';

tool({
  kinds: ['image'], multiple: true, max: MAX_PDF_IMAGES, order: true, mode: 'all',
  pick: 'Choose pictures', drop: 'Photos, scans or screenshots: JPEG, PNG, HEIC, WebP and more. Drag them into order after adding.',
  options: [
    { id: 'page', type: 'seg', label: 'Page size', value: 'a4', choices: PDF_PAGES.map((p) => ({ value: p.value, label: p.value === 'fit' ? 'Picture size' : p.label, hint: p.hint })),
      hint: (o) => PDF_PAGES.find((p) => p.value === o.page).hint },
    { id: 'orientation', type: 'seg', label: 'Orientation', value: 'auto', when: (o) => o.page !== 'fit', choices: [{ value: 'auto', label: 'Auto' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }],
      hint: (o) => (o.orientation === 'auto' ? 'Each page turns to suit its picture.' : '') },
    { id: 'margin', type: 'seg', label: 'Margin', value: 0, choices: PDF_MARGINS.map((m) => ({ value: m.value, label: m.label })) },
    { id: 'scan', type: 'toggle', label: 'Scan look', value: false, more: true, hint: 'Clean black on white, like a scanner. Good for photos of documents and notes.' },
  ],
  action: (files) => (files.length === 1 ? 'Make a PDF' : `Make a PDF of ${plural(files.length, 'picture')}`),
  working: (files) => `Making a PDF of ${plural(files.length, 'picture')}…`,
  async run(files, o, job) {
    const images = [];
    for (const f of files) images.push(new Uint8Array(await f.file.arrayBuffer()));
    const r = await engine.run('pdf.fromImages', { images, o: { page: o.page, orientation: o.orientation, margin: o.margin, scan: o.scan }, quality: 0.9, limits: LIMITS, skipBad: files.length > 1 }, job);
    const skipped = (r.skipped || []).filter((x) => files[x.index]);
    const named = skipped.slice(0, 3).map((x) => `${files[x.index].name} ${x.reason}`).join('; ') + (skipped.length > 3 ? ` and ${skipped.length - 3} more` : '');
    if (!r.bytes) throw new UserError(`None of these pictures could be read (${named}).`);
    for (const x of skipped) files[x.index].error = `Left out: it ${x.reason}.`;
    const pages = files.length - skipped.length;
    const name = job.name(files[0].stem, 'pdf', files.length > 1 ? `(${pages} images)` : '');
    return { outputs: [{ name, bytes: r.bytes }], note: [plural(pages, 'page'), o.scan ? 'scan look' : '', skipped.length ? `${skipped.length} skipped: ${named}` : ''].filter(Boolean).join(' · '), warn: skipped.length > 0, short: fmtBytes(r.bytes.length) };
  },
});
