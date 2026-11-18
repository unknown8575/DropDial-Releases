// Text to Word: the app's TXT/Markdown → DOCX route (src/main/conversions.js ENGINES['text-docx']): Markdown is laid
// out by the app's own parser (src/main/engines/markdown.js toParagraphs) and written by the processor's
// docx.fromMarkdown; plain text by docx.fromText.
import { tool, engine, plural, UserError, decodeText } from './ui.js';
import MD from '../../tools/engine/web/markdown.js';
import { paper } from './pdfkit.js';

tool({
  kinds: ['txt'], wrongKind: (f) => `${f.name} isn’t a text or Markdown file.`, multiple: true, max: 50,
  pick: 'Choose text files', drop: 'Plain text (.txt) or Markdown (.md) files.',
  verb: 'Writing',
  action: (files) => `Save ${files.length === 1 ? 'as Word' : plural(files.length, 'file') + ' as Word'}`,
  zipName: () => 'Word documents.zip',
  showSaving: false,
  async run(f, o, job) {
    const text = decodeText(await job.bytes());
    if (!text.trim()) throw new UserError('This file is empty.');
    const r = MD.isMarkdownName(f.name)
      ? await engine.run('docx.fromMarkdown', { paragraphs: MD.toParagraphs(text), paper: paper() }, job)
      : await engine.run('docx.fromText', { text, paper: paper() }, job);
    return { outputs: [{ name: job.name(f.stem, 'docx'), bytes: r.bytes }], note: MD.isMarkdownName(f.name) ? 'headings, lists and tables laid out' : '' };
  },
});
