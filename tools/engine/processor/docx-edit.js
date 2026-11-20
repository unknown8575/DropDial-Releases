// Edit Word text, in the processor: read a .docx into the model the window shows, and save edits into a copy of it.
// The work is done by src/shared/docxedit.mjs (the same code runs on the website and in the unit tests); this file
// opens the package with JSZip (loaded as a classic script, self.JSZip) and checks the save by reading it back.
import { scanDocx, saveDocx, verifySave, loadZip, DOCX, DocxError } from '../shared/docxedit.mjs';

const strings = (v, n, what) => {
  if (typeof v !== 'string' || v.length > n) throw new DocxError(`${what} is not valid.`);
  return v;
};
const KEY = /^\d{1,4}:\d{1,7}$/;

/** {bytes} → the model: {page, styles, stories, paras, order, info, counts}. */
export async function scan({ bytes }) {
  const zip = await loadZip(self.JSZip, bytes);
  const { model } = await scanDocx(zip, { images: true });
  return model;
}

/**
 * {bytes, edits: [{key, old, code}], adds: [{after, text}]} → {bytes, edited, added, verify: {ok, problems}}. `old` is
 * the paragraph's code when the window read it: a file that changed since then is refused.
 */
export async function save({ bytes, edits = [], adds = [] }) {
  if (!Array.isArray(edits) || edits.length > DOCX.edits || !Array.isArray(adds) || adds.length > DOCX.adds) throw new DocxError('Too many changes at once.');
  const e = edits.map((x) => ({ key: strings(x && x.key, 20, 'A change'), old: x.old == null ? null : strings(x.old, DOCX.textMax * 4, 'A change'), code: strings(x && x.code, DOCX.textMax * 4, 'A change') }));
  const a = adds.map((x) => ({ after: strings(x && x.after, 20, 'An added paragraph'), text: strings(x && x.text, DOCX.textMax * 4, 'An added paragraph') }));
  if ([...e.map((x) => x.key), ...a.map((x) => x.after)].some((k) => !KEY.test(k))) throw new DocxError('A change is not valid.');
  const r = await saveDocx(self.JSZip, bytes, e, a);
  const verify = await verifySave(self.JSZip, bytes, r.bytes, e, a);
  return { bytes: r.bytes, edited: r.edited, added: r.added, verify };
}
