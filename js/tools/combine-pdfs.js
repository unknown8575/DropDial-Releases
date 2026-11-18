// Combine PDFs: the app's tool (src/main/tools/pdfMerge.js) — PDFs in the chosen order, each whole or only the pages
// typed for it — with the processor's pdf.merge and the range rules in src/shared/pdftools.mjs.
import { tool, engine, LIMITS, plural, h, UserError, fmtBytes } from './ui.js';
import { parseRanges, pageList, RANGE_EXAMPLE } from '../../tools/engine/shared/pdftools.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const rangeOf = (f) => (f.range || '').trim();
const rangeCheck = (f) => (rangeOf(f) && f.meta.pages ? parseRanges(rangeOf(f), f.meta.pages, { allowEmpty: true, reverse: true }) : null);

tool({
  ...PDF_ACCEPT, multiple: true, min: 2, minText: 'Add at least two PDFs.', max: 200, order: true, mode: 'all',
  pick: 'Choose PDFs', drop: 'Two or more PDFs. Drag them into order after adding.', addLabel: 'Add more PDFs',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : '', rangeOf(f) && rangeCheck(f) && !rangeCheck(f).error ? `using ${plural(pageList(rangeCheck(f).ranges).length, 'page')}` : ''],
  fileExtra(f, app) {
    const lock = passwordBox(f, app);
    if (lock || !app.o.ranges || !f.meta.pages || f.status) return lock;
    const c = rangeCheck(f);
    const id = 'rg-' + f.id;
    return h('div', { class: 'f-range' },
      h('div', { class: 'f-extra' }, h('label', { for: id, class: 'sr-only' }, `Pages of ${f.name} to use`),
        h('input', { id, type: 'text', value: f.range || '', placeholder: `All ${f.meta.pages} pages, or like ${RANGE_EXAMPLE}`, autocomplete: 'off', spellcheck: false, enterkeyhint: 'done',
          onchange: (e) => { f.range = e.target.value; app.renderFile(f); app.update(); } })),
      c && c.error ? h('p', { class: 'f-err' }, c.error) : null);
  },
  options: [
    { id: 'ranges', type: 'toggle', label: 'Choose pages from each PDF', value: false, hint: (o) => (o.ranges ? `Type the pages under each PDF, like ${RANGE_EXAMPLE}. Leave it empty for every page.` : '') },
  ],
  onSet(app, id) { if (id === 'ranges') app.refresh(); },
  check(files, o) {
    const locked = lockedReason(files);
    if (locked) return locked;
    if (o.ranges) { const bad = files.find((f) => rangeCheck(f) && rangeCheck(f).error); if (bad) return `Check the pages for ${bad.name}.`; }
    return '';
  },
  action: (files) => `Combine ${plural(files.length, 'PDF')}`,
  working: (files) => `Combining ${plural(files.length, 'PDF')}…`,
  async run(files, o, job) {
    const bytes = [];
    for (const f of files) bytes.push(new Uint8Array(await f.file.arrayBuffer()));
    const r = await engine.run('pdf.merge', { files: bytes, ranges: files.map((f) => (o.ranges ? rangeOf(f) : '')), names: files.map((f) => f.name), passwords: files.map((f) => f.password || null), limits: LIMITS, skipBad: true }, job);
    const skipped = (r.skipped || []).filter((x) => files[x.index]);
    const named = skipped.slice(0, 3).map((x) => `${files[x.index].name} ${x.reason}`).join('; ');
    if (!r.bytes) throw new UserError(`None of these PDFs could be read (${named}).`);
    for (const x of skipped) files[x.index].error = `Left out: it ${x.reason}.`;
    const used = files.filter((_, i) => !skipped.some((x) => x.index === i));
    const name = job.name(used[0].stem, 'pdf', `(${used.length} PDFs)`);
    return { outputs: [{ name, bytes: r.bytes }], note: [plural(r.pages, 'page'), skipped.length ? `${skipped.length} skipped: ${named}` : ''].filter(Boolean).join(' · '), warn: skipped.length > 0, short: fmtBytes(r.bytes.length) };
  },
});
