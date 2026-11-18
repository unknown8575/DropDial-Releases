// Shared parts of the PDF web tools: page count, sizes and first-page picture (the processor's pdf.layout and
// pdf.render), and asking for the password of a protected PDF, which is kept only in this page's memory.
import { engine, LIMITS, h, ic, urlFor, bytesOf, announce, plural } from './ui.js';

export const PDF_ACCEPT = { kinds: ['pdf'], wrongKind: (f) => `${f.name} isn’t a PDF.` };

/** Pages, page sizes and a small picture of the first page; a protected PDF waits for its password. */
export async function inspectPdf(f, { thumb = true } = {}) {
  const r = await engine.run('pdf.layout', { bytes: await bytesOf(f), limits: LIMITS, password: f.password || undefined });
  if (r.needPassword) { f.locked = true; f.wrong = !!r.wrongPassword && !!f.password; f.meta.pages = 0; return; }
  f.locked = false; f.wrong = false;
  f.meta.pages = r.pages; f.meta.sizes = r.sizes; f.meta.encrypted = r.encrypted; f.meta.restricted = r.restricted || [];
  if (thumb && !f.thumb) {
    try {
      const p = await engine.run('pdf.render', { bytes: await bytesOf(f), first: 1, last: 1, format: 'jpg', quality: 0.75, maxSide: 200, limits: LIMITS, password: f.password || undefined });
      if (p.pages[0]) f.thumb = urlFor(new Blob([p.pages[0].bytes], { type: 'image/jpeg' }));
    } catch { /* a page that can't be drawn: the PDF icon stays */ }
  }
}

/** The password box shown under a protected PDF. */
export function passwordBox(f, app) {
  if (!f.locked || f.status) return null;
  const id = 'pw-' + f.id;
  const inp = h('input', { id, type: 'password', autocomplete: 'off', enterkeyhint: 'go', placeholder: 'Password', 'aria-label': `Password for ${f.name}` });
  const unlock = async () => {
    if (!inp.value) { inp.focus(); return; }
    f.password = inp.value;
    await app.inspect(f);
    if (f.locked) { announce('That password didn’t work.'); const el = document.getElementById(id); if (el) el.focus(); }
    else { announce(`${f.name} unlocked. ${plural(f.meta.pages, 'page')}.`); app.refocus(); } // the box is gone
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } });
  return h('div', { class: 'f-lock' },
    h('p', { class: f.wrong ? 'f-err' : 'f-note' }, ic('lock'), h('span', null, f.wrong ? 'That password didn’t work. Try again.' : 'This PDF is password-protected. Type its password to use it.')),
    h('div', { class: 'f-extra' }, inp, h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: unlock }, 'Unlock')));
}

/** "Type the password for report.pdf" when a chosen PDF is still locked. */
export function lockedReason(files) {
  const f = files.find((x) => x.locked);
  return f ? `Type the password for ${f.name}.` : '';
}

/** The paper size the app uses for Word documents: Letter in the US and Canada, A4 elsewhere (by the browser's language). */
export const paper = () => (/-(US|CA)\b/i.test(navigator.language || '') ? 'Letter' : 'A4');

/** A first-page preview for tools that draw on pages (page numbers, watermark): the page as a picture, k px per point. */
export async function pagePicture(f, n, maxSide = 900) {
  const r = await engine.run('pdf.render', { bytes: await bytesOf(f), first: n, last: n, format: 'png', maxSide, limits: LIMITS, password: f.password || undefined });
  return createImageBitmap(new Blob([r.pages[0].bytes], { type: 'image/png' }));
}

/**
 * A live page preview drawn with the app's own preview code (src/shared/pdftools.mjs drawPage): the page as a picture
 * with `overlay(ctx, vw, vh, k, n, app)` on top, where n is the 1-based page shown. Returns {stage, redraw}.
 */
export function pagePreview(overlay, { start = () => 1, label = 'Preview' } = {}) {
  let ui = null;
  const cache = new Map();
  async function show(app) {
    if (!ui) return;
    const f = ui.file, n = ui.n, total = f.meta.pages;
    ui.where.textContent = `Page ${n} of ${total}`;
    ui.prev.disabled = n <= 1; ui.next.disabled = n >= total;
    const key = f.id + ':' + n;
    try {
      if (!cache.has(key)) cache.set(key, pagePicture(f, n));
      const bmp = await cache.get(key);
      if (!ui || ui.file !== f || ui.n !== n) return;
      const [vw, vh] = f.meta.sizes[n - 1];
      const { drawPage } = await import('../../tools/engine/shared/pdftools.mjs');
      drawPage(ui.canvas, bmp, vw, vh, bmp.width / vw, (ctx) => overlay(ctx, vw, vh, bmp.width / vw, n, app));
      ui.wait.hidden = true; ui.canvas.hidden = false;
    } catch (e) { cache.delete(key); ui.wait.textContent = e.user ? e.message : 'This page couldn’t be shown.'; }
  }
  function stage(app, el) {
    const f = app.files.find((x) => !x.error && !x.locked && x.meta.pages);
    if (!f) { ui = null; el.replaceChildren(); return; }
    if (ui && ui.file === f) { if (!el.contains(ui.panel)) el.replaceChildren(ui.panel); return; }
    const canvas = h('canvas', { hidden: true, role: 'img', 'aria-label': `${label} of the page with the current options` });
    const wait = h('p', { class: 'pv-wait' }, 'Drawing the page…');
    const where = h('p', { class: 'fine', 'aria-live': 'polite' });
    const go = (d) => () => { ui.n = Math.min(Math.max(1, ui.n + d), f.meta.pages); show(app); };
    const prev = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Previous page', onclick: go(-1) }, ic('chevron-left'));
    const next = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Next page', onclick: go(1) }, ic('chevron-right'));
    const panel = h('div', { class: 'panel' }, h('div', { class: 'pv' }, wait, canvas), h('div', { class: 'panel-bar' }, where, h('div', { class: 'tbtns' }, prev, next)));
    ui = { file: f, n: Math.min(start(app), f.meta.pages), canvas, wait, where, prev, next, panel };
    el.replaceChildren(panel);
    show(app);
  }
  return { stage, redraw: (app) => show(app), reset: () => { ui = null; cache.clear(); } };
}
