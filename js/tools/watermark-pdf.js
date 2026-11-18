// Watermark PDF: the app's tool (src/main/tools/pdfWatermark.js) with the processor's pdf.watermark; the preview is
// drawn with the app's own preview code (src/shared/pdftools.mjs drawWatermark), so what you see is what you get.
import { tool, engine, LIMITS, plural } from './ui.js';
import { WATERMARK, WATERMARK_DEFAULTS, WATERMARK_TEXTS, drawWatermark, watermarkFaint } from '../../tools/engine/shared/pdftools.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason, pagePreview } from './pdfkit.js';

const COLORS = [{ value: '#d70015', label: 'Red' }, { value: '#1d1d1f', label: 'Black' }, { value: '#6e6e73', label: 'Grey' }, { value: '#0a5ad6', label: 'Blue' }, { value: '#ff5c00', label: 'Orange' }, { value: '#1f8a32', label: 'Green' }];
const opts = (o) => ({ text: String(o.text || '').trim(), size: o.size, opacity: o.opacity, angle: o.angle, color: o.color, layout: o.layout });
const textError = (t) => (!t ? 'Type the watermark text.' : [...t].length > WATERMARK.textMax ? `Watermark text can be up to ${WATERMARK.textMax} characters.` : '');
const preview = pagePreview((ctx, vw, vh, k, n, app) => { const o = opts(app.o); if (!textError(o.text)) drawWatermark(ctx, vw, vh, k, o); });

tool({
  ...PDF_ACCEPT, multiple: true, max: 50,
  pick: 'Choose PDFs', drop: 'One or more PDFs. The first one is shown in the preview.',
  verb: 'Watermarking',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  stage: preview.stage,
  onOptions: (app) => preview.redraw(app),
  reset: () => preview.reset(),
  options: [
    { id: 'text', type: 'text', label: 'Text', value: WATERMARK_DEFAULTS.text, max: 200, placeholder: 'CONFIDENTIAL' },
    { id: 'preset', type: 'chips', label: 'Quick text', value: null, choices: WATERMARK_TEXTS.map((t) => ({ value: t, label: t })) },
    { id: 'angle', type: 'seg', label: 'Angle', value: WATERMARK_DEFAULTS.angle, choices: [{ value: 'diagonal', label: 'Diagonal' }, { value: 'straight', label: 'Level' }] },
    { id: 'layout', type: 'seg', label: 'Layout', value: WATERMARK_DEFAULTS.layout, choices: [{ value: 'center', label: 'Once' }, { value: 'tile', label: 'Tiled' }] },
    { id: 'color', type: 'color', label: 'Colour', value: WATERMARK_DEFAULTS.color, choices: COLORS, more: true, hint: (o) => (watermarkFaint(o.color) ? 'This colour is hard to see on white pages.' : '') },
    { id: 'size', type: 'range', label: 'Text size', min: WATERMARK.sizeMin, max: WATERMARK.sizeMax, value: WATERMARK_DEFAULTS.size, unit: ' pt', more: true },
    { id: 'opacity', type: 'range', label: 'Opacity', min: WATERMARK.opacityMin, max: WATERMARK.opacityMax, value: WATERMARK_DEFAULTS.opacity, unit: '%', more: true },
  ],
  onSet(app, id, v) {
    if (id === 'preset' && v) { app.o.text = v; app.o.preset = null; app.update(); }
    if (id === 'text') app.o.preset = null;
  },
  check(files, o) {
    const t = String(o.text || '').trim();
    return lockedReason(files) || textError(t) || (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(t) ? 'Watermark text must be one line.' : '');
  },
  action: (files) => `Watermark ${files.length === 1 ? 'the PDF' : plural(files.length, 'PDF')}`,
  zipName: () => 'Watermarked PDFs.zip',
  showSaving: false,
  async run(f, o, job) {
    const r = await engine.run('pdf.watermark', { bytes: await job.bytes(), o: opts(o), limits: LIMITS, password: f.password || undefined }, job);
    return { outputs: [{ name: job.name(f.stem, 'pdf', 'watermarked'), bytes: r.bytes }], note: [plural(r.pages, 'page'), r.fitted ? `text made smaller to fit the page (${r.fitted} pt)` : ''].filter(Boolean).join(' · ') };
  },
});
