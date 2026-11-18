// Resize: the app's Resize tool (src/main/tools/photoResize.js) — by longest side, percentage, exact size or to fit
// under a file size — with the processor's photo.resize and the presets and checks in src/shared/photo.mjs.
import { tool, engine, LIMITS, F, plural, fmtBytes, extFor } from './ui.js';
import { RESIZE_PRESETS, defaultLongSide, resizeIssues, outputFormat } from '../../tools/engine/shared/photo.mjs';

const QUALITY = { jpg: 0.9, webp: 0.85 };
const KEEP_IF_SMALL = ['jpg', 'png', 'webp'];
const kbLabel = (kb) => (kb >= 1024 && kb % 1024 === 0 ? `${kb / 1024} MB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);
const sizes = (files) => files.filter((f) => f.meta.w).map((f) => ({ w: f.meta.w, h: f.meta.h, name: f.name }));
let touchedLong = false;

tool({
  kinds: ['image'], multiple: true, max: 200,
  pick: 'Choose pictures', drop: 'JPEG, PNG, HEIC, WebP, TIFF, BMP or SVG. Up to 200 at a time.',
  verb: 'Resizing',
  options: [
    { id: 'mode', type: 'seg', label: 'Resize by', value: 'long', choices: [{ value: 'long', label: 'Pixels' }, { value: 'percent', label: 'Percent' }, { value: 'exact', label: 'W × H' }, { value: 'size', label: 'File size' }] },
    { id: 'long', type: 'preset', label: 'Longest side', boxLabel: 'Longest side in pixels', unit: 'px', min: 1, max: 30000, value: 1600, when: (o) => o.mode === 'long',
      choices: RESIZE_PRESETS.long.map((p) => ({ value: p.value, label: p.label, hint: p.hint })), hint: 'The longer side becomes this many pixels; the shape stays the same.' },
    { id: 'percent', type: 'preset', label: 'Percentage', boxLabel: 'Percentage of the original size', unit: '%', min: 1, max: 1000, value: 50, when: (o) => o.mode === 'percent', choices: RESIZE_PRESETS.percent },
    { id: 'width', type: 'number', label: 'Width', unit: 'px', min: 1, max: 30000, value: null, placeholder: 'Any', when: (o) => o.mode === 'exact' },
    { id: 'height', type: 'number', label: 'Height', unit: 'px', min: 1, max: 30000, value: null, placeholder: 'Any', when: (o) => o.mode === 'exact', hint: 'Leave one box empty to keep the shape.' },
    { id: 'targetKB', type: 'preset', label: 'Fit under', boxLabel: 'File size in KB', unit: 'KB', min: 5, max: 102400, value: 500, when: (o) => o.mode === 'size', choices: RESIZE_PRESETS.size,
      hint: 'The quality is lowered, and the picture made smaller if needed, until the file fits. Good for forms with an upload limit.' },
    { id: 'sizeFormat', type: 'seg', label: 'Save as', value: 'jpg', more: true, when: (o) => o.mode === 'size', choices: [{ value: 'jpg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }] },
    { id: 'format', type: 'select', label: 'Save as', value: 'same', more: true, when: (o) => o.mode !== 'size', choices: [{ value: 'same', label: 'Same as original' }, { value: 'jpg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }] },
    { id: 'noEnlarge', type: 'toggle', label: 'Don’t make small pictures bigger', value: false, more: true, when: (o) => o.mode !== 'size' },
    { id: 'issues', type: 'custom', render: () => document.createElement('p'), when: () => true,
      hint: (o, a) => { const w = resizeIssues(sizes(a.files.filter((f) => !f.error)), opts(o)).warnings; return w ? w.join(' ') : ''; } },
  ],
  onSet(a, id) { if (id === 'long') touchedLong = true; },
  onFiles(a) {
    // Start from the largest preset that doesn't enlarge (QA round 7), until the person picks a size.
    if (touchedLong) return;
    const s = sizes(a.files);
    const want = defaultLongSide(s);
    if (s.length && want !== a.o.long) { a.o.long = want; a.update(); }
  },
  check(files, o) {
    if (o.mode === 'exact' && !o.width && !o.height) return 'Enter a width or a height.';
    if (o.mode === 'long' && !(o.long >= 1)) return 'Enter the longest side in pixels.';
    if (o.mode === 'percent' && !(o.percent > 0)) return 'Enter a percentage.';
    if (o.mode === 'size' && !(o.targetKB >= 5)) return 'Enter a file size of at least 5 KB.';
    const r = resizeIssues(sizes(files), opts(o));
    return r.error || '';
  },
  action: (files, o) => `Resize ${files.length === 1 ? 'picture' : plural(files.length, 'picture')}`,
  zipName: () => 'Resized pictures.zip',
  async run(f, o, job) {
    if (o.mode === 'size' && KEEP_IF_SMALL.includes(f.format) && f.size <= o.targetKB * 1024) {
      return { skipped: `Already under ${kbLabel(o.targetKB)} (${fmtBytes(f.size)}), so it was kept as it is.` };
    }
    const out = o.mode === 'size' ? { to: o.sizeFormat } : outputFormat(f.format, o.format);
    const r = await engine.run('photo.resize', { bytes: await job.bytes(), o: opts(o), to: out.to, quality: QUALITY[out.to], limits: LIMITS, keepSame: o.mode !== 'size' && out.to === f.format }, job);
    if (r.same) return { skipped: `Already ${r.width} × ${r.height} px, so it was kept as it is.` };
    const suffix = o.mode === 'long' ? `${o.long}px` : o.mode === 'percent' ? `${Math.round(o.percent * 100) / 100}%` : o.mode === 'exact' ? `${r.width}×${r.height}` : kbLabel(o.targetKB);
    const notes = [out.note];
    const low = r.fit && r.fit.quality < 40;
    if (r.fit) notes.push(`quality ${r.fit.quality}%${r.fit.scale < 0.999 ? ', made smaller to fit' : ''}${low ? ' (low: try a larger size)' : ''}`);
    return { outputs: [{ name: job.name(f.stem, extFor(f, out.to), suffix), bytes: r.bytes, w: r.width, h: r.height }], note: notes.filter(Boolean).join(' · '), warn: low };
  },
});

function opts(o) {
  return { mode: o.mode, long: o.long, percent: o.percent, width: o.width || null, height: o.height || null, noEnlarge: !!o.noEnlarge, targetBytes: (o.targetKB || 0) * 1024 };
}
