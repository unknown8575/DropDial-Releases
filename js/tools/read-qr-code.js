// Read QR code: the app's tool (src/main/tools/readQR.js) with the processor's qr.read (every code in a picture,
// src/processor/qr-scan.js) and the app's words for links and UPI payment requests (src/shared/qrtext.mjs).
import { tool, engine, LIMITS, plural, h, ic, announce } from './ui.js';
import { describeCode } from '../../tools/engine/shared/qrtext.mjs';

function codeView(text) {
  const d = describeCode(text);
  const copy = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: async (e) => {
    try { await navigator.clipboard.writeText(text); e.currentTarget.lastChild.textContent = 'Copied'; announce('Copied'); } catch { announce('Select the text to copy it.'); }
  } }, ic('copy'), h('span', null, 'Copy'));
  return h('div', { class: 'qr-out' },
    h('h3', null, d.title),
    d.summary ? h('p', null, d.summary) : null,
    d.note ? h('p', { class: 'fine' }, d.note) : null,
    h('p', { class: 'qr-text' }, text),
    h('div', { class: 'tbtns' }, copy),
    d.caution ? h('p', { class: 'fine' }, d.caution) : null);
}

tool({
  kinds: ['image'], multiple: true, max: 20,
  pick: 'Choose a picture', drop: 'A photo or screenshot with a QR code: JPEG, PNG, HEIC, WebP and more.',
  verb: 'Reading',
  action: (files) => (files.length === 1 ? 'Read the QR code' : `Read ${plural(files.length, 'picture')}`),
  doneTitle: () => 'Done',
  noOutput: (a) => { const n = a.results.reduce((k, r) => k + (r.codes || 0), 0); return n ? `Found ${plural(n, 'code')}` : 'No QR code found'; },
  async run(f, o, job) {
    const r = await engine.run('qr.read', { bytes: await job.bytes(), limits: LIMITS }, job);
    const codes = (Array.isArray(r.codes) ? r.codes : r.text ? [r.text] : []).filter((t) => typeof t === 'string').slice(0, 12);
    if (!codes.length) {
      const seen = Number(r.finders) >= 2, cut = seen && Number(r.finders) < 3 && !!r.edge;
      const why = seen ? `A QR code is there, but it couldn’t be read. ${cut ? 'Make sure the whole code is in the picture, not cut off or covered.' : 'Try a sharper or larger picture of the code.'}` : 'No QR code found. Try a sharper or larger picture of the code.';
      return { skipped: why };
    }
    const res = { outputs: [], short: plural(codes.length, 'code') + ' found', extra: h('div', { class: 'qr-list' }, h('p', { class: 'fine' }, f.name), codes.map(codeView)) };
    Object.defineProperty(res, 'codes', { value: codes.length });
    return res;
  },
});
