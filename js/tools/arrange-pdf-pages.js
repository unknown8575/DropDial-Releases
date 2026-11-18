// Arrange PDF pages: the app's Arrange pages tool (src/main/tools/pdfPages.js) — reorder, turn and delete pages with
// a picture of each — using the app's list edits (src/shared/pdftools.mjs initialPages, movePages, arrangeSpec,
// rotateBy) and the processor's pdf.render (pictures) and pdf.arrange (the new PDF; deleted pages are really gone).
import { tool, engine, LIMITS, plural, h, ic, announce, sortable, urlFor, bytesOf } from './ui.js';
import { initialPages, pagesChanged, arrangeSpec, rotateBy } from '../../tools/engine/shared/pdftools.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const st = { file: null, items: [], history: [], thumbs: new Map(), want: new Set(), busy: false, ui: null, io: null };
const CHUNK = 8;

function stage(app, el) {
  const f = app.files.find((x) => !x.error && !x.locked && x.meta.pages);
  if (!f) { el.replaceChildren(); return; }
  if (st.ui && st.file === f) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  st.file = f; st.items = initialPages(f.meta.pages); st.history = []; st.thumbs = new Map(); st.want = new Set();
  const grid = h('ul', { class: 'pages', 'aria-label': 'Pages' });
  const info = h('p', { class: 'fine', 'aria-live': 'polite' });
  const undo = h('button', { type: 'button', class: 'tbtn', onclick: () => { if (st.history.length) { st.items = st.history.pop(); draw(app); announce('Undone'); } } }, ic('undo-2'), 'Undo');
  const bar = h('div', { class: 'panel-bar' }, info, h('div', { class: 'tbtns' },
    h('button', { type: 'button', class: 'tbtn', onclick: () => edit(app, (items) => items.map((it) => ({ ...it, rotate: rotateBy(it.rotate, 90) })), 'All pages turned right') }, ic('rotate-cw'), 'Turn all'),
    undo,
    h('button', { type: 'button', class: 'tbtn', onclick: () => edit(app, () => initialPages(f.meta.pages), 'Back to the original order') }, ic('refresh-cw'), 'Reset')));
  const help = h('p', { class: 'fine' }, 'Drag a page by its handle to move it, or focus the handle and use the arrow keys.');
  st.ui = { panel: h('div', { class: 'panel' }, bar, help, grid), grid, info, undo };
  el.replaceChildren(st.ui.panel);
  sortable(grid, { item: '.pg', handle: '.grip', label: (i, n) => `Moved to place ${i} of ${n}`,
    onDone: (keys) => { st.history.push(st.items); st.items = keys.map((k) => st.items.find((it) => it.key === k)); draw(app, false); } });
  if (st.io) st.io.disconnect();
  st.io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { st.want.add(Number(e.target.dataset.src)); st.io.unobserve(e.target); } pump(); }, { rootMargin: '400px 0px' });
  draw(app);
}

function edit(app, fn, say) { st.history.push(st.items); st.items = fn(st.items); draw(app); announce(say); }

function draw(app, rebuild = true) {
  const { grid, info, undo } = st.ui;
  const n = st.file.meta.pages;
  const turned = st.items.filter((it) => it.rotate).length, gone = n - new Set(st.items.map((it) => it.src)).size;
  info.textContent = [plural(st.items.length, 'page'), turned ? `${turned} turned` : '', gone > 0 ? `${gone} deleted` : ''].filter(Boolean).join(' · ');
  undo.disabled = !st.history.length;
  if (rebuild) grid.replaceChildren(...st.items.map((it, i) => tile(app, it, i)));
  else st.items.forEach((it, i) => { const el = grid.querySelector(`[data-key="${it.key}"]`); if (el) el.querySelector('.pg-pos').textContent = String(i + 1); });
  app.update();
}

function tile(app, it, i) {
  const url = st.thumbs.get(it.src);
  const img = h('img', { alt: '', class: 'r' + it.rotate, style: `transform: rotate(${it.rotate}deg)`, src: url || null, hidden: !url });
  const name = `page ${it.src + 1}`;
  const el = h('li', { class: 'pg', 'data-key': it.key, 'data-src': String(it.src) },
    h('div', { class: 'pg-pic' }, img),
    h('p', { class: 'pg-num' }, h('span', { class: 'sr-only' }, 'Place '), h('span', { class: 'pg-pos' }, String(i + 1)), h('span', { 'aria-hidden': 'true' }, ' · '), `Page ${it.src + 1}${it.rotate ? `, turned ${it.rotate}°` : ''}`),
    h('div', { class: 'pg-tools' },
      h('button', { type: 'button', class: 'grip', 'aria-label': `Move ${name}. Drag, or use the arrow keys.`, title: 'Drag to move' }, ic('grip-vertical')),
      h('button', { type: 'button', class: 'turn-left', 'aria-label': `Turn ${name} left`, title: 'Turn left', onclick: () => edit(app, (items) => items.map((x) => (x.key === it.key ? { ...x, rotate: rotateBy(x.rotate, -90) } : x)), `${name} turned left`) }, ic('rotate-ccw')),
      h('button', { type: 'button', 'aria-label': `Turn ${name} right`, title: 'Turn right', onclick: () => edit(app, (items) => items.map((x) => (x.key === it.key ? { ...x, rotate: rotateBy(x.rotate, 90) } : x)), `${name} turned right`) }, ic('rotate-cw')),
      h('button', { type: 'button', 'aria-label': `Delete ${name}`, title: 'Delete', onclick: () => {
        if (st.items.length === 1) { announce('Keep at least one page.'); return; }
        edit(app, (items) => items.filter((x) => x.key !== it.key), `${name} deleted. Undo brings it back.`);
      } }, ic('trash-2'))));
  if (!url) st.io.observe(el);
  return el;
}

/** Draw the pages that came into view, a few at a time (each request opens the PDF once). */
async function pump() {
  if (st.busy || !st.want.size) return;
  st.busy = true;
  const f = st.file;
  try {
    while (st.want.size && st.file === f) {
      const first = Math.min(...st.want);
      const r = await engine.run('pdf.render', { bytes: await bytesOf(f), first: first + 1, last: Math.min(f.meta.pages, first + CHUNK), format: 'jpg', quality: 0.72, maxSide: 280, limits: LIMITS, password: f.password || undefined });
      for (const p of r.pages) {
        const src = p.page - 1;
        st.want.delete(src);
        if (st.file !== f || st.thumbs.has(src)) continue;
        const url = urlFor(new Blob([p.bytes], { type: 'image/jpeg' }));
        st.thumbs.set(src, url);
        for (const el of st.ui.grid.querySelectorAll(`[data-src="${src}"] img`)) { el.src = url; el.hidden = false; }
        for (const el of st.ui.grid.querySelectorAll(`[data-src="${src}"]`)) st.io.unobserve(el);
      }
      for (let s = first; s < first + CHUNK; s++) st.want.delete(s);
    }
  } catch (e) { console.error(e); }
  st.busy = false;
}

tool({
  againLabel: 'Back to the pages',
  ...PDF_ACCEPT, multiple: false,
  pick: 'Choose a PDF', drop: 'One PDF. You’ll see every page.',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  stage,
  reset() { st.file = null; st.ui = null; },
  check(files) {
    const locked = lockedReason(files);
    if (locked) return locked;
    if (!st.file || !st.file.meta.pages) return '';
    return pagesChanged(st.items, st.file.meta.pages) ? '' : 'Move, turn or delete pages first.';
  },
  action: () => (st.items.length ? `Save the PDF (${plural(st.items.length, 'page')})` : 'Save the PDF'),
  showSaving: false,
  async run(f, o, job) {
    const r = await engine.run('pdf.arrange', { bytes: await job.bytes(), pages: arrangeSpec(st.items), limits: LIMITS, password: f.password || undefined }, job);
    return { outputs: [{ name: job.name(f.stem, 'pdf', 'arranged'), bytes: r.bytes }], note: plural(r.pages, 'page') };
  },
});
