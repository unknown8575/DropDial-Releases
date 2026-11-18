// Make image smaller: the app's Make smaller tool for pictures (src/main/tools/shrink.js with the plans in
// src/shared/shrink.mjs and the processor's shrink.image), plus the app's Resize "fit under a file size" for a target.
import { tool, engine, LIMITS, F, plural, fmtBytes, extFor } from './ui.js';
import { STRENGTHS, shrinkPlan, worthSaving, WORTH_SAVING } from '../../tools/engine/shared/shrink.mjs';
import { RESIZE_PRESETS } from '../../tools/engine/shared/photo.mjs';

const kbLabel = (kb) => (kb >= 1024 && kb % 1024 === 0 ? `${kb / 1024} MB` : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);

tool({
  kinds: ['jpg', 'png', 'webp', 'bmp', 'tiff', 'heic', 'avif', 'gif', 'ico', 'svg'], multiple: true, max: 200, compare: true,
  wrongKind: (f) => `${f.name} isn’t a picture.`,
  pick: 'Choose pictures', drop: 'JPEG, PNG, WebP, BMP or TIFF. Up to 200 at a time.',
  verb: 'Making smaller',
  options: [
    { id: 'how', type: 'seg', label: 'How small', value: 'balanced', choices: [...STRENGTHS.map((s) => ({ value: s.value, label: s.label, hint: s.hint })), { value: 'size', label: 'Under a size' }],
      hint: (o) => (o.how === 'size' ? 'Lowers the quality, and the size if needed, until the file fits.' : STRENGTHS.find((s) => s.value === o.how).hint) },
    { id: 'targetKB', type: 'preset', label: 'Fit under', boxLabel: 'File size in KB', unit: 'KB', min: 5, max: 102400, value: 200, when: (o) => o.how === 'size', choices: RESIZE_PRESETS.size },
    { id: 'sizeFormat', type: 'seg', label: 'Save as', value: 'jpg', more: true, when: (o) => o.how === 'size', choices: [{ value: 'jpg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }] },
    { id: 'allowJpeg', type: 'toggle', label: 'Turn PNGs without transparency into JPEG', value: false, more: true, when: (o) => o.how !== 'size',
      hint: 'Much smaller for photos and screenshots saved as PNG. Pictures with see-through parts stay PNG.' },
  ],
  check(files, o) { return o.how === 'size' && !(o.targetKB >= 5) ? 'Enter a file size of at least 5 KB.' : ''; },
  action: (files) => `Make ${files.length === 1 ? 'it' : plural(files.length, 'picture')} smaller`,
  zipName: () => 'Smaller pictures.zip',
  async run(f, o, job) {
    const before = f.size;
    if (o.how === 'size') {
      if (['jpg', 'png', 'webp'].includes(f.format) && before <= o.targetKB * 1024) return { skipped: `Already under ${kbLabel(o.targetKB)} (${fmtBytes(before)}), so it was kept as it is.` };
      const r = await engine.run('photo.resize', { bytes: await job.bytes(), o: { mode: 'size', targetBytes: o.targetKB * 1024 }, to: o.sizeFormat, limits: LIMITS }, job);
      const low = r.fit.quality < 40;
      const note = `quality ${r.fit.quality}%${r.fit.scale < 0.999 ? ', fewer pixels to fit' : ''}${low ? ' (low: try a larger size)' : ''}`;
      return { outputs: [{ name: job.name(f.stem, extFor(f, o.sizeFormat), 'smaller'), bytes: r.bytes, w: r.width, h: r.height }], note, warn: low };
    }
    const plan = shrinkPlan({ format: f.format, category: 'image' }, o.how, { allowJpeg: o.allowJpeg });
    if (plan.kind === 'skip') return { skipped: plan.reason };
    if (f.animated) return { skipped: 'Animated pictures can’t be made smaller here.' };
    const r = await engine.run('shrink.image', { bytes: await job.bytes(), plan, limits: LIMITS }, job);
    // The app's one rule for keeping a result: at least a little smaller than the file (src/shared/shrink.mjs).
    if (!worthSaving(before, r.bytes.length)) return { skipped: `Already as small as it gets (${fmtBytes(before)})${o.how !== 'strong' ? '. Strong may still help' : ''}.` };
    const little = r.bytes.length > before * (1 - WORTH_SAVING);
    const notes = [r.note, r.resized ? 'fewer pixels' : null, r.to !== f.format ? `saved as ${F.formatInfo(r.to).label}` : null, little ? 'only a little smaller' : null];
    return { outputs: [{ name: job.name(f.stem, extFor(f, r.to), 'smaller'), bytes: r.bytes, w: r.width, h: r.height }], note: notes.filter(Boolean).join(' · '), warn: little };
  },
});
