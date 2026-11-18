// Shrink PDF: the app's tool (src/main/tools/pdfShrink.js) — Light (text stays sharp) or Strong (pages become
// pictures at 100, 150 or 200 dpi), with an optional target size — using the processor's pdf.shrink and the steps
// and verdicts in src/shared/pdftools.mjs. Nothing is kept when the result isn't smaller.
import { tool, engine, LIMITS, plural, fmtBytes } from './ui.js';
import { SHRINK_LEVELS, SHRINK_DPI, SHRINK_TARGET, shrinkVerdict } from '../../tools/engine/shared/pdftools.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const MB = 1024 * 1024;
const mbLabel = (mb) => (mb >= 1 ? `${Math.round(mb * 100) / 100} MB` : `${Math.round(mb * 1024)} KB`);

tool({
  ...PDF_ACCEPT, multiple: true, max: 50,
  pick: 'Choose PDFs', drop: 'One or more PDFs to make smaller.',
  verb: 'Shrinking',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  options: [
    { id: 'level', type: 'seg', label: 'Level', value: 'light', choices: SHRINK_LEVELS.map((l) => ({ value: l.value, label: l.label })),
      hint: (o) => { const l = SHRINK_LEVELS.find((x) => x.value === o.level); return `${l.sub}. ${l.hint}`; } },
    { id: 'dpi', type: 'seg', label: 'Sharpness', value: 150, when: (o) => o.level === 'strong' || o.target, choices: SHRINK_DPI.map((d) => ({ value: d.value, label: d.label, hint: d.hint })),
      hint: (o) => SHRINK_DPI.find((d) => d.value === o.dpi).hint },
    { id: 'target', type: 'toggle', label: 'Aim for a size', value: false, more: true, hint: (o) => (o.target ? 'Light is tried first, then pages as pictures, until the file fits.' : '') },
    { id: 'targetMB', type: 'number', label: 'Target size', unit: 'MB', step: 0.1, min: SHRINK_TARGET.min, max: SHRINK_TARGET.max, value: 2, more: true, when: (o) => o.target },
    { id: 'soft', type: 'toggle', label: 'Allow blurry pages', value: false, more: true, when: (o) => o.target, hint: 'Lets pages go below 150 dpi to reach the size. Small text may become hard to read.' },
  ],
  check(files, o) { return lockedReason(files) || (o.target && !(o.targetMB >= SHRINK_TARGET.min) ? 'Enter a target size.' : ''); },
  action: (files) => `Shrink ${files.length === 1 ? 'the PDF' : plural(files.length, 'PDF')}`,
  zipName: () => 'Smaller PDFs.zip',
  async run(f, o, job) {
    const before = f.size;
    const targetBytes = o.target && o.targetMB ? Math.round(o.targetMB * MB) : 0;
    const r = await engine.run('pdf.shrink', { bytes: await job.bytes(), o: { level: o.level, dpi: o.dpi, targetBytes, soft: !!(targetBytes && o.soft) }, limits: LIMITS, password: f.password || undefined }, job);
    const aim = targetBytes ? mbLabel(o.targetMB) : '';
    const pictures = r.smallest ? `pages as pictures at ${r.smallest.dpi} dpi would still be ${fmtBytes(r.smallest.bytes)}` : '';
    const missed = targetBytes && !r.fit;
    if (r.bytes.length >= before) {
      if (missed) return { skipped: `Couldn’t get under ${aim} and stay readable${pictures ? ` (${pictures})` : ''}. Nothing was saved.` };
      return { skipped: `Already as small as it can get (${fmtBytes(before)}${o.level === 'light' && !targetBytes ? '; Strong may still help' : ''}). Nothing was saved.` };
    }
    const verdict = shrinkVerdict(before, r.bytes.length, { target: targetBytes, fit: r.fit });
    const notes = [r.method === 'strong' ? `pages as pictures at ${r.dpi} dpi` : 'text kept'];
    if (missed) notes.push(r.method === 'light' ? `couldn’t get under ${aim} and keep the text readable` : `this is the smallest it got at ${r.dpi} dpi`);
    else if (verdict.why === 'little') notes.push('only a little smaller');
    return { outputs: [{ name: job.name(f.stem, 'pdf', 'smaller'), bytes: r.bytes }], note: notes.join(' · '), warn: verdict.warn };
  },
});
