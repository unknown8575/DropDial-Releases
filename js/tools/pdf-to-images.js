// PDF to images: the app's PDF → JPEG/PNG route (src/main/conversions.js ENGINES['pdf-image']) — pages drawn by the
// processor's pdf.render, 8 at a time — named "report page 01.jpg" like the app's folder of pages.
import { tool, engine, LIMITS, plural, F } from './ui.js';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const PER_REQUEST = 8;
const pad = (n, total) => String(n).padStart(String(total).length, '0');

tool({
  ...PDF_ACCEPT, multiple: true, max: 20,
  pick: 'Choose PDFs', drop: 'Every page becomes a picture.',
  verb: 'Drawing pages of',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  options: [
    { id: 'format', type: 'seg', label: 'Save as', value: 'jpg', choices: [{ value: 'jpg', label: 'JPEG' }, { value: 'png', label: 'PNG' }],
      hint: (o) => (o.format === 'jpg' ? 'Smaller files. Best for scans and photos.' : 'Sharpest text and lines. Bigger files.') },
    { id: 'scale', type: 'seg', label: 'Sharpness', value: 2, choices: [{ value: 1.5, label: 'Screen' }, { value: 2, label: 'Standard' }, { value: 3, label: 'Print' }],
      hint: (o) => `${Math.round(o.scale * 72)} dpi: ${o.scale <= 1.5 ? 'fine on phones and screens' : o.scale <= 2 ? 'clear on any screen (as the app makes them)' : 'crisp when printed; big files'}.` },
  ],
  check: (files) => lockedReason(files),
  action: (files) => { const n = files.reduce((k, f) => k + (f.meta.pages || 0), 0); return n ? `Save ${plural(n, 'page')} as pictures` : 'Save pages as pictures'; },
  zipName: (a) => (a.files.filter((f) => !f.error).length === 1 ? `${a.files.find((f) => !f.error).stem} pages.zip` : 'PDF pages.zip'),
  showSaving: false,
  async run(f, o, job) {
    const ext = F.formatInfo(o.format).ext, total = f.meta.pages;
    const outputs = [];
    for (let first = 1; first <= total; first += PER_REQUEST) {
      const r = await engine.run('pdf.render', { bytes: await job.bytes(), first, last: first + PER_REQUEST - 1, format: o.format, quality: 0.9, scale: o.scale, limits: LIMITS, password: f.password || undefined }, job);
      for (const p of r.pages) outputs.push({ name: job.name(total > 1 ? `${f.stem} page ${pad(p.page, total)}` : f.stem, ext), bytes: p.bytes, w: p.width, h: p.height });
      job.progress(Math.min(1, (first + PER_REQUEST - 1) / total));
    }
    return { outputs, before: null, short: plural(outputs.length, 'picture') };
  },
});
