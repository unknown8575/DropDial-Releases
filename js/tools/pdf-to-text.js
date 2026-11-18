// PDF to text or Word: the app's PDF → TXT and PDF → DOCX routes (src/main/conversions.js), with the processor's
// pdf.text and pdf.toDocx (paragraphs and headings read from the page layout).
import { tool, engine, LIMITS, plural } from './ui.js';
import { PDF_ACCEPT, inspectPdf, paper } from './pdfkit.js';

tool({
  ...PDF_ACCEPT, multiple: true, max: 50,
  pick: 'Choose PDFs', drop: 'PDFs with text in them. Scanned pages have no text to copy.',
  verb: 'Reading',
  inspect: (f) => inspectPdf(f, { thumb: true }),
  metaLine: (f) => [f.locked ? 'Password-protected' : ''],
  options: [
    { id: 'to', type: 'seg', label: 'Save as', value: 'docx', choices: [{ value: 'docx', label: 'Word (.docx)' }, { value: 'txt', label: 'Text (.txt)' }],
      hint: (o) => (o.to === 'docx' ? 'Paragraphs and headings you can edit in Word, Pages or Google Docs.' : 'Just the words, in reading order.') },
  ],
  check: (files) => { const f = files.find((x) => x.locked); return f ? `${f.name} is password-protected. Remove its password first.` : ''; },
  action: (files, o) => `Save ${files.length === 1 ? 'as' : plural(files.length, 'PDF') + ' as'} ${o.to === 'docx' ? 'Word' : 'text'}`,
  zipName: (a) => (a.o.to === 'docx' ? 'Word documents.zip' : 'Text files.zip'),
  showSaving: false,
  async run(f, o, job) {
    if (o.to === 'txt') {
      const r = await engine.run('pdf.text', { bytes: await job.bytes(), limits: LIMITS }, job);
      return { outputs: [{ name: job.name(f.stem, 'txt'), bytes: new TextEncoder().encode(r.text), type: 'text/plain;charset=utf-8' }] };
    }
    const r = await engine.run('pdf.toDocx', { bytes: await job.bytes(), limits: LIMITS, paper: paper() }, job);
    return { outputs: [{ name: job.name(f.stem, 'docx'), bytes: r.bytes }] };
  },
});
