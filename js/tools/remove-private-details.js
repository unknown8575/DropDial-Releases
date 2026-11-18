// Remove location & private details: the removing part of the app's Info & privacy tool (src/main/tools/fileInfo.js)
// with the processor's meta.image / meta.imageClean (src/shared/imagemeta.mjs: JPEG, PNG and WebP keep every pixel)
// and meta.pdf / meta.pdfClean for PDFs. Results are named as the app names them: "photo clean.jpg", "photo no location.jpg".
import { tool, engine, LIMITS, plural, extFor, h, ic } from './ui.js';

const LOSSLESS = ['jpg', 'png', 'webp'];
const RESAVED = { heic: 'jpg', avif: 'jpg', tiff: 'tiff', bmp: 'bmp' };
const FOUND = [['location', 'Location', 'map-pin'], ['camera', 'Camera', 'camera'], ['dates', 'Dates', 'calendar'], ['people', 'Names', 'user'], ['software', 'App names', 'info'], ['thumbnail', 'Thumbnail', 'image'], ['xmp', 'XMP', 'file-text'], ['iptc', 'IPTC', 'file-text'], ['comment', 'Comment', 'file-text']];
const PDF_FIELDS = [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords'], ['creator', 'App'], ['producer', 'Producer'], ['created', 'Created'], ['modified', 'Modified'], ['xmp', 'XMP']];

tool({
  kinds: ['image', 'pdf'], multiple: true, max: 200,
  anySize: (f) => LOSSLESS.includes(f.format), // details come out without drawing the picture

  wrongKind: (f) => `${f.name} isn’t a picture or a PDF.`,
  pick: 'Choose photos or PDFs', drop: 'JPEG, PNG, WebP, HEIC, TIFF and PDF. Up to 200 at a time.',
  verb: 'Cleaning',
  options: [
    { id: 'clean', type: 'seg', label: 'Remove', value: 'all', choices: [{ value: 'all', label: 'All private details' }, { value: 'location', label: 'Only location' }],
      hint: (o) => (o.clean === 'all' ? 'Location, camera, dates, names, app names and other hidden notes. JPEG, PNG and WebP keep every pixel exactly.' : 'Only where it was taken. PDFs have no location, so all their details are removed.') },
  ],
  async inspect(f) {
    const bytes = new Uint8Array(await f.file.arrayBuffer());
    if (f.format === 'pdf') {
      const m = await engine.run('meta.pdf', { bytes, limits: LIMITS });
      f.meta.pages = m.pages;
      f.meta.found = PDF_FIELDS.filter(([k]) => m[k]).map(([, l]) => [l, false]);
      return;
    }
    if (['gif', 'svg', 'ico'].includes(f.format)) { f.error = `${f.label} pictures can’t be cleaned here.`; return; }
    if (!LOSSLESS.includes(f.format)) { f.meta.resave = true; return; }
    const m = await engine.run('meta.image', { bytes, limits: LIMITS });
    const fd = (m.meta && m.meta.found) || {};
    f.meta.found = FOUND.filter(([k]) => fd[k]).map(([k, l, i]) => [l, k === 'location', i]);
    f.meta.any = !!(m.meta && m.meta.any);
    f.meta.location = !!fd.location;
  },
  fileExtra(f) {
    if (f.error || f.status) return null;
    if (f.meta.resave) return h('p', { class: 'f-note' }, ic('info'), h('span', null, `${f.label} is saved again${RESAVED[f.format] === 'jpg' ? ' as JPEG' : ''}, which leaves every hidden detail behind.`));
    if (!f.meta.found) return null;
    if (!f.meta.found.length) return h('p', { class: 'f-note' }, ic('circle-check'), h('span', null, 'No private details found.'));
    return h('div', { class: 'found', 'aria-label': 'Found in this file' }, f.meta.found.map(([l, hot, i]) => h('span', { class: hot ? 'hot' : '' }, ic(i || 'info'), l)));
  },
  action: (files) => `Remove details from ${files.length === 1 ? 'it' : plural(files.length, 'file')}`,
  zipName: (a) => (a.o.clean === 'location' ? 'Without location.zip' : 'Without private details.zip'),
  showSaving: false,
  async run(f, o, job) {
    if (f.format === 'pdf') {
      if (f.meta.found && !f.meta.found.length) return { skipped: 'Nothing private found, so nothing was saved.' };
      const r = await engine.run('meta.pdfClean', { bytes: await job.bytes(), o: { clean: 'all' }, limits: LIMITS }, job);
      return { outputs: [{ name: job.name(f.stem, 'pdf', 'clean'), bytes: r.bytes }], note: 'all document details removed; pages unchanged' };
    }
    if (LOSSLESS.includes(f.format)) {
      if (o.clean === 'location' && f.meta.location === false) return { skipped: 'No location in this picture, so nothing was saved.' };
      if (f.meta.any === false) return { skipped: 'Nothing private found, so nothing was saved.' };
    }
    const r = await engine.run('meta.imageClean', { bytes: await job.bytes(), o: { clean: o.clean }, quality: 0.9, limits: LIMITS }, job);
    const suffix = o.clean === 'location' ? 'no location' : 'clean';
    return { outputs: [{ name: job.name(f.stem, extFor(f, r.to), suffix), bytes: r.bytes }], note: r.resaved ? `saved again as ${r.to.toUpperCase().replace('JPG', 'JPEG')}` : `${o.clean === 'location' ? 'location' : 'all private details'} removed; every pixel kept` };
  },
});
