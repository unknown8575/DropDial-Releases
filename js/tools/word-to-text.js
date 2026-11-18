// Word to text: the app's DOCX → TXT route (src/main/conversions.js ENGINES['docx-text']): the processor's docx.read
// and the document engine's blocksToText (copied from src/main/engines/document.js by the site build).
import { tool, engine, plural, UserError } from './ui.js';
import { blocksToText } from '../../tools/engine/web/document.js';

tool({
  kinds: ['docx'], wrongKind: (f) => `${f.name} isn’t a Word document (.docx).`, multiple: true, max: 50,
  pick: 'Choose Word documents', drop: 'Word documents (.docx). Older .doc files aren’t supported.',
  verb: 'Reading',
  action: (files) => `Save ${files.length === 1 ? 'as text' : plural(files.length, 'document') + ' as text'}`,
  zipName: () => 'Text files.zip',
  showSaving: false,
  async run(f, o, job) {
    const { blocks } = await engine.run('docx.read', { bytes: await job.bytes(), images: false }, job);
    const text = blocksToText(Array.isArray(blocks) ? blocks : []);
    if (!text.trim()) throw new UserError('This document has no text.');
    return { outputs: [{ name: job.name(f.stem, 'txt'), bytes: new TextEncoder().encode(text), type: 'text/plain;charset=utf-8' }] };
  },
});
