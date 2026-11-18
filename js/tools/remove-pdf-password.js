// Remove PDF password: an unlocked copy of a protected PDF, made with the app's own decryption
// (src/processor/pdf-crypt.js, through pdf.layout and pdf.arrange with every page kept in order). The password is
// typed here, used once on this device and never stored. Adding a password isn't offered: the app can open
// protected PDFs but doesn't write them.
import { tool, engine, LIMITS, plural } from './ui.js';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

tool({
  ...PDF_ACCEPT, multiple: true, max: 50,
  pick: 'Choose protected PDFs', drop: 'PDFs that ask for a password when they open. You’ll type the password next.',
  verb: 'Unlocking',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : f.meta.encrypted ? (f.password ? 'Unlocked with your password' : 'Has restrictions') : f.meta.pages ? 'No password' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  check(files) {
    if (files.every((f) => f.meta.pages && !f.meta.encrypted)) return files.length === 1 ? 'This PDF has no password.' : 'These PDFs have no password.';
    return lockedReason(files);
  },
  action: (files) => { const n = files.filter((f) => f.locked || f.meta.encrypted).length || files.length; return `Unlock ${n === 1 ? 'the PDF' : plural(n, 'PDF')}`; },
  zipName: () => 'Unlocked PDFs.zip',
  showSaving: false,
  async run(f, o, job) {
    if (!f.meta.encrypted) return { skipped: 'This PDF has no password, so it was left as it is.' };
    const pages = Array.from({ length: f.meta.pages }, (_, i) => ({ src: i, rotate: 0 }));
    const r = await engine.run('pdf.arrange', { bytes: await job.bytes(), pages, limits: LIMITS, password: f.password || '' }, job);
    const restricted = f.meta.restricted && f.meta.restricted.length ? ` and its limits on ${f.meta.restricted.join(', ')}` : '';
    return { outputs: [{ name: job.name(f.stem, 'pdf', 'unlocked'), bytes: r.bytes }], note: `${plural(r.pages, 'page')} · opens without a password${restricted ? ' · restrictions removed' : ''}` };
  },
});
