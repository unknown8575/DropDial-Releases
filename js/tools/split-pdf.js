// Split PDF: the app's tool (src/main/tools/pdfSplit.js) — every page, every N pages or typed ranges, each part
// named by its pages ("report pages 1-3.pdf") — with the processor's pdf.split, made in batches like the app.
import { tool, engine, LIMITS, plural } from './ui.js';
import { planSplit, SPLIT_MODES, RANGE_EXAMPLE } from '../../tools/engine/shared/pdftools.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const plan = (f, o) => planSplit(f.meta.pages, { mode: o.mode, every: o.every, ranges: o.ranges || '' });

tool({
  ...PDF_ACCEPT, multiple: false,
  pick: 'Choose a PDF', drop: 'One PDF to split into parts.',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  options: [
    { id: 'mode', type: 'seg', label: 'Split into', value: 'pages', choices: SPLIT_MODES.map((m) => ({ value: m.value, label: m.value === 'pages' ? 'Single pages' : m.value === 'every' ? 'Every N pages' : 'Ranges' })) },
    { id: 'every', type: 'number', label: 'Pages in each part', min: 1, max: 2000, value: 2, when: (o) => o.mode === 'every' },
    { id: 'ranges', type: 'text', label: 'Page ranges', value: '', placeholder: RANGE_EXAMPLE, when: (o) => o.mode === 'ranges', hint: 'Each range becomes its own PDF. “end” is the last page.' },
    { id: 'plan', type: 'custom', render: () => document.createElement('p'),
      hint: (o, a) => { const f = a.files.find((x) => !x.error && x.meta.pages); if (!f) return ''; const p = plan(f, o); return p.error ? '' : `Makes ${plural(p.parts.length, 'PDF')}${p.parts.length <= 4 ? ': ' + p.parts.map((x) => x.label).join(', ') : ''}.`; } },
  ],
  check(files, o) {
    const locked = lockedReason(files);
    if (locked) return locked;
    const f = files[0];
    if (!f.meta.pages) return '';
    const p = plan(f, o);
    return p.error || '';
  },
  action: (files, o) => { const f = files[0]; const p = f && f.meta.pages ? plan(f, o) : null; return p && !p.error ? `Split into ${plural(p.parts.length, 'PDF')}` : 'Split the PDF'; },
  zipName: (a) => `${a.files[0].stem} parts.zip`,
  async run(f, o, job) {
    const outputs = [];
    let total = 1;
    for (let from = 0; from < total;) {
      const r = await engine.run('pdf.split', { bytes: await job.bytes(), o: { mode: o.mode, every: o.every, ranges: (o.ranges || '').trim() }, from, limits: LIMITS, password: f.password || undefined }, job);
      total = r.total;
      for (const p of r.parts) {
        const label = String(r.labels[p.index] || `part ${p.index + 1}`).replace(/[^a-z0-9 -]/gi, '').slice(0, 40);
        outputs.push({ name: job.name(`${f.stem} ${label}`, 'pdf'), bytes: p.bytes });
      }
      if (r.next <= from) break;
      from = r.next;
      job.progress(from / total);
    }
    return { outputs, before: null, short: plural(outputs.length, 'part') };
  },
});
