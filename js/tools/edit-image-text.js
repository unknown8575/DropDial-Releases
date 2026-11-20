// Edit image text: the app's tool (src/main/tools/imageEditText.js) with the processor's own operations —
// imageText.scan (the text of a picture or of a scanned PDF page, read in this browser by Tesseract.js),
// imageText.preview (the picture drawn with the edits, by the same code as the save) and imageText.save. Shared
// logic (lines, the look of a line, find and replace) is src/shared/imagetext.mjs. The reader (its worker,
// WebAssembly core and language data) loads only on this page, only when a file is added, from this site.
// Phones: tap a line and type in a bar that stays above the keyboard; pinch or the zoom buttons to zoom.
import { tool, engine, LIMITS, plural, h, ic, announce, urlFor, bytesOf, touchy } from './ui.js';
import * as T from '../../tools/engine/shared/imagetext.mjs';
import * as E from '../../tools/engine/shared/pdfedit.mjs';
import { inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const SIDE = 2000, ZMAX = 5;
const key = (p, l) => `${p}:${l}`;
const st = { app: null, file: null, n: 1, scans: new Map(), asked: new Set(), queue: [], reading: 0, pics: new Map(), shown: new Map(), edits: new Map(), adds: [], past: [], future: [], editing: null, draft: '', sel: null, mode: 'edit', zoom: 1, ui: null, hit: 0, seq: 0, langs: 'eng', gen: 0 };
const pw = () => (st.file && st.file.password) || undefined;
const isPdf = () => st.file && st.file.format === 'pdf';
const pages = () => (isPdf() ? st.file.meta.pages || 0 : 1);
/** The picture's size in pixels (lines are in these); before it is read, from the file. */
function sizeOf(n) {
  const s = st.scans.get(n);
  if (s && s.w) return [s.w, s.h];
  if (isPdf()) { const z = (st.file.meta.sizes && st.file.meta.sizes[n - 1]) || [612, 792]; return [z[0] * 2, z[1] * 2]; }
  return [st.file.meta.w || 1000, st.file.meta.h || 750];
}
const changes = () => [...st.edits.values()].filter((e) => e.text !== e.old).sort((a, b) => a.page - b.page || a.line - b.line);
const realAdds = () => st.adds.filter((t) => t.text.trim());
const textOf = (p, l) => { const e = st.edits.get(key(p, l.i)); return e ? e.text : l.text; };
const noHere = (s) => s.replace('in the PDF', 'here');

// ------------------------------------------------------------------ history
const snap = () => ({ edits: new Map(st.edits), adds: st.adds.map((t) => ({ ...t })) });
function record() { st.past.push(snap()); if (st.past.length > 100) st.past.shift(); st.future = []; }
function restore(s) { st.edits = s.edits; st.adds = s.adds; st.sel = null; closeEditor(false); draw(); }
const undo = () => { if (st.past.length) { st.future.push(snap()); restore(st.past.pop()); announce('Undone'); } };
const redo = () => { if (st.future.length) { st.past.push(snap()); restore(st.future.pop()); announce('Redone'); } };
function setLine(p, l, text) {
  const k = key(p, l.i);
  if (text === l.text) st.edits.delete(k); else st.edits.set(k, { page: p, line: l.i, old: l.text, text });
}

// ------------------------------------------------------------------ reading pages (one at a time)
function want(n, first = false) {
  if (!st.file || n < 1 || n > pages() || st.asked.has(n)) return;
  st.asked.add(n);
  if (first) st.queue.unshift(n); else st.queue.push(n);
  pump();
}
async function pump() {
  if (st.reading || !st.queue.length) return;
  const f = st.file, g = st.gen, n = st.queue.shift();
  st.reading = n;
  if (st.n === n) draw();
  try {
    const r = await engine.run('imageText.scan', { bytes: await bytesOf(f), page: n, langs: st.langs, limits: LIMITS, password: pw() });
    if (st.file !== f || st.gen !== g) return;
    st.scans.set(n, r.results[0]);
  } catch (e) {
    if (st.file !== f || st.gen !== g) return;
    st.scans.set(n, { error: e.user ? e.message : 'The text on this page couldn’t be read.', lines: [] });
  } finally {
    if (st.file === f && st.gen === g) { st.reading = 0; draw(); refreshSide(); st.app.update(); pump(); }
  }
}
async function picture(n) {
  const f = st.file;
  const edits = changes().filter((e) => e.page === n);
  const k = JSON.stringify(edits.map((e) => [e.line, e.text]));
  try {
    if (!edits.length) {
      if (!st.pics.has(n)) {
        if (isPdf()) {
          const r = await engine.run('pdf.render', { bytes: await bytesOf(f), first: n, last: n, format: 'jpg', quality: 0.85, maxSide: 1600, limits: LIMITS, password: pw() });
          st.pics.set(n, urlFor(new Blob([r.pages[0].bytes], { type: 'image/jpeg' })));
        } else if (f.format === 'heic') {
          const r = await engine.run('image.preview', { bytes: await bytesOf(f), maxSide: SIDE, limits: LIMITS });
          st.pics.set(n, urlFor(new Blob([r.bytes], { type: r.mime })));
        } else st.pics.set(n, urlFor(f.file));
      }
      return st.pics.get(n);
    }
    const had = st.shown.get(n);
    if (had && had.k === k) return had.url;
    st.ui.busy.hidden = false;
    const scan = st.scans.get(n);
    const r = await engine.run('imageText.preview', { bytes: await bytesOf(f), page: n, edits, adds: [], lines: scan && scan.lines, maxSide: SIDE, langs: st.langs, limits: LIMITS, password: pw() });
    const url = urlFor(new Blob([r.bytes], { type: 'image/jpeg' }));
    st.shown.set(n, { k, url });
    return url;
  } catch (e) { console.error(e); return st.pics.get(n) || null; }
  finally { if (st.ui) st.ui.busy.hidden = true; }
}

// ------------------------------------------------------------------ the picture
function stage(app, el) {
  st.app = app;
  const f = app.files.find((x) => !x.error && !x.locked && (x.format !== 'pdf' || x.meta.pages));
  if (!f) { st.ui = null; el.replaceChildren(); return; }
  if (st.ui && st.file === f) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  Object.assign(st, { file: f, n: 1, scans: new Map(), asked: new Set(), queue: [], reading: 0, pics: new Map(), shown: new Map(), edits: new Map(), adds: [], past: [], future: [], editing: null, sel: null, mode: 'edit', zoom: 1, hit: 0, gen: st.gen + 1, langs: app.o.langs || 'eng' });
  const seg = (v, label, icon) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(st.mode === v), onclick: () => setMode(v) }, ic(icon), label);
  const modes = h('div', { class: 'segctl static pe-modes', role: 'group', 'aria-label': 'What a tap does' }, seg('edit', 'Change text', 'type'), seg('add', 'Add text', 'plus'));
  const where = h('p', { class: 'fine pe-where', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Previous page', onclick: () => go(st.n - 1) }, ic('chevron-left'));
  const next = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Next page', onclick: () => go(st.n + 1) }, ic('chevron-right'));
  const zout = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Zoom out', onclick: () => zoom(st.zoom / 1.4) }, ic('zoom-out'));
  const zin = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Zoom in', onclick: () => zoom(st.zoom * 1.4) }, ic('zoom-in'));
  const img = h('img', { class: 'pe-img', alt: '', draggable: 'false' });
  const layer = h('div', { class: 'pe-layer' });
  const sheet = h('div', { class: 'pe-sheet ie-sheet' }, img, layer);
  const view = h('div', { class: 'pe-view', tabindex: '-1' }, sheet);
  const busy = h('p', { class: 'pv-tag pe-busy', hidden: true, role: 'status' }, 'Updating…');
  const status = h('p', { class: 'pe-status', role: 'status' });
  const nav = h('div', { class: 'panel-bar' }, where, h('div', { class: 'tbtns' }, prev, next));
  const panel = h('div', { class: 'panel pe-panel ie-panel' },
    h('div', { class: 'panel-bar' }, modes, h('div', { class: 'tbtns' }, zout, zin)),
    h('div', { class: 'pe-frame' }, view, busy),
    status, nav);
  st.ui = { panel, img, layer, sheet, view, where, prev, next, status, busy, modes, zin, zout, nav };
  layer.addEventListener('pointerdown', placeBox);
  pinch(view);
  el.replaceChildren(panel);
  new ResizeObserver(() => size()).observe(panel);
  want(1, true);
  draw();
}

function go(n) { closeEditor(true); st.n = Math.max(1, Math.min(pages(), n)); st.sel = null; st.ui.view.scrollTo(0, 0); want(st.n, true); draw(); }
function setMode(m) { closeEditor(true); st.mode = m; if (m === 'edit') st.sel = null; draw(); st.app.update(); }
function zoom(z) { st.zoom = Math.max(1, Math.min(ZMAX, z)); size(); }
/** Fit the picture to the panel's width (and, on a computer, its height), times the zoom. */
function size() {
  if (!st.ui) return;
  const [vw, vh] = sizeOf(st.n);
  const ps = getComputedStyle(st.ui.panel);
  const avail = st.ui.panel.clientWidth - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight) - 26;
  const tall = touchy.matches ? Infinity : Math.max(320, innerHeight * 0.72) * (vw / vh);
  const w = Math.max(120, Math.min(avail, tall)) * st.zoom;
  st.ui.sheet.style.width = w + 'px';
  st.ui.sheet.style.height = (w * vh) / vw + 'px';
  st.ui.zin.disabled = st.zoom >= ZMAX; st.ui.zout.disabled = st.zoom <= 1;
  if (st.editing && st.editing.inline) placeInline();
  for (const t of st.adds) { const b = st.ui.layer.querySelector(`[data-add="${t.id}"] .pe-area`); if (b) b.style.fontSize = t.size * kNow() + 'px'; }
}
const kNow = () => (st.ui ? st.ui.sheet.getBoundingClientRect().width / sizeOf(st.n)[0] : 1);
function pinch(el) {
  const pts = new Map();
  let d0 = 0, z0 = 1;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { d0 = dist(); z0 = st.zoom; } });
  el.addEventListener('pointermove', (e) => { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2 && d0 > 10) zoom(z0 * (dist() / d0)); });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) d0 = 0; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}

function card(icon, title, text, extra) {
  return h('div', { class: 'pe-scan ie-card', role: 'note' }, ic(icon), h('div', null, h('b', null, title), h('span', null, text), extra || null));
}
async function draw() {
  const ui = st.ui;
  if (!ui) return;
  const n = st.n, total = pages();
  const [vw, vh] = sizeOf(n);
  ui.where.textContent = `Page ${n} of ${total}`;
  ui.nav.hidden = total < 2;
  ui.prev.disabled = n <= 1; ui.next.disabled = n >= total;
  for (const b of ui.modes.children) b.setAttribute('aria-pressed', String(b.dataset.v === st.mode));
  ui.panel.classList.toggle('adding', st.mode === 'add');
  size();
  const scan = st.scans.get(n);
  const lines = scan && scan.lines ? scan.lines : [];
  const tap = touchy.matches ? 'Tap' : 'Click';
  const status = !scan ? (st.reading === n ? 'Reading the text in this browser…' : 'Waiting to read this page…') : scan.error ? scan.error : scan.kind === 'text' ? 'This page has real text — use Edit PDF text.'
    : scan.kind === 'blank' ? 'This page is blank. Use Add text to write on it.' : !lines.length ? 'No text found. You can still add text.'
      : st.mode === 'add' ? `${tap} where the new text should go.` : `${tap} a line or a word to change it.`;
  ui.status.textContent = status;
  ui.status.classList.toggle('scan', !!(scan && (scan.kind === 'text' || scan.error)));
  const pct = (v, of) => (v / of) * 100 + '%';
  const matches = findMatches().filter((m) => m.page === n);
  const cur = findMatches()[st.hit];
  const kids = lines.map((l) => {
    const changed = st.edits.has(key(n, l.i)) && st.edits.get(key(n, l.i)).text !== l.text;
    const cls = 'pe-line ie-line' + (changed ? ' changed' : '') + (matches.some((m) => m.line === l.i) ? ' found' : '') + (cur && cur.page === n && cur.line === l.i ? ' active' : '') + (l.level === 'busy' ? ' busy' : '');
    return h('button', { type: 'button', class: cls, 'data-line': String(l.i), 'aria-label': `Line: ${textOf(n, l)}${changed ? ' (changed)' : ''}`,
      style: `left:${pct(l.box[0], vw)};top:${pct(l.box[1], vh)};width:${pct(l.box[2], vw)};height:${pct(l.box[3], vh)}`,
      onclick: (e) => { if (st.mode === 'edit') openEditor(l, changed ? null : wordAt(l, e)); },
      onkeydown: (e) => {
        const j = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (j) { e.preventDefault(); const b = ui.layer.querySelector(`[data-line="${l.i + j}"]`); if (b) b.focus(); }
      } });
  });
  if (!scan) kids.push(card('refresh-cw', 'Reading the text…', 'In this browser: nothing is uploaded. The first time takes a few seconds while the reader loads.'));
  else if (scan.kind === 'text') kids.push(card('file-text', 'This page has real text', T.TEXT_PAGE_NOTE, h('a', { class: 'btn btn-quiet btn-sm', href: '../edit-pdf-text/' }, 'Open Edit PDF text')));
  else if (!scan.error && (scan.kind === 'image' || scan.kind === 'scan') && !lines.length && !st.adds.some((t) => t.page === n)) kids.push(card('info', 'No text found', T.NONE_NOTE));
  for (const t of st.adds.filter((x) => x.page === n)) kids.push(addBox(t));
  ui.layer.replaceChildren(...kids);
  if (st.editing && st.editing.inline && st.editing.page === n) ui.layer.append(st.editing.el);
  const url = await picture(n);
  if (st.ui === ui && st.n === n && url && ui.img.getAttribute('src') !== url) ui.img.src = url;
}
/** The word of a line under a tap or click, for word-by-word editing. */
function wordAt(l, e) {
  const r = st.ui.layer.getBoundingClientRect();
  const [vw, vh] = sizeOf(st.n);
  const hit = T.hit([l], ((e.clientX - r.left) / r.width) * vw, ((e.clientY - r.top) / r.height) * vh);
  return hit ? hit.word : null;
}

// ------------------------------------------------------------------ editing a line
function openEditor(l, word = null) {
  closeEditor(true);
  const n = st.n;
  const value = textOf(n, l);
  st.draft = value;
  const done = () => { closeEditor(true); };
  const cancel = () => { closeEditor(false); };
  const w = word != null && value === l.text ? l.words[word] : null;
  const warnText = () => noHere(E.unsupportedText(E.unsupportedChars(st.draft))) || (l.level === 'busy' ? T.BUSY_NOTE : '');
  if (touchy.matches) {
    const input = h('input', { type: 'text', value, enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'New text for the line', oninput: (e) => { st.draft = e.target.value; warn(); st.app.update(); } });
    const msg = h('p', { class: 'pe-msg', 'aria-live': 'polite' });
    const warn = () => { const t = warnText(); msg.textContent = t; msg.hidden = !t; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') cancel(); });
    const bar = h('div', { class: 'pe-bar', role: 'dialog', 'aria-label': `Change the line${pages() > 1 ? ' on page ' + n : ''}` },
      h('p', { class: 'pe-bar-t' }, `${pages() > 1 ? `Page ${n} · ` : ''}${l.text.length > 40 ? l.text.slice(0, 39) + '…' : l.text}`), input, msg,
      h('div', { class: 'pe-bar-btns' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: cancel }, 'Cancel'), h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done')));
    warn();
    document.body.append(bar);
    const place = () => { const vv = window.visualViewport; if (vv) bar.style.bottom = Math.max(0, innerHeight - (vv.height + vv.offsetTop)) + 'px'; };
    place();
    if (window.visualViewport) { visualViewport.addEventListener('resize', place); visualViewport.addEventListener('scroll', place); }
    st.editing = { page: n, line: l, el: bar, inline: false, off: () => { if (window.visualViewport) { visualViewport.removeEventListener('resize', place); visualViewport.removeEventListener('scroll', place); } } };
    st.ui.layer.querySelector(`[data-line="${l.i}"]`)?.classList.add('editing');
    input.focus();
    if (w) input.setSelectionRange(w.start, w.end);
    const keepInView = () => { const b = st.ui.layer.querySelector(`[data-line="${l.i}"]`); if (!b) return; const r = b.getBoundingClientRect(), br = bar.getBoundingClientRect(); if (r.bottom > br.top - 12 || r.top < 60) scrollBy({ top: r.top - Math.max(70, (br.top - r.height) / 2), behavior: 'auto' }); };
    setTimeout(keepInView, 60); setTimeout(keepInView, 450);
  } else {
    const msg = h('p', { class: 'pe-inmsg', hidden: true });
    const input = h('input', { type: 'text', class: 'pe-input', value, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Edit line: ${l.text}`, oninput: (e) => { st.draft = e.target.value; input.setAttribute('aria-invalid', String(!!E.unsupportedChars(st.draft).length)); showMsg(); st.app.update(); } });
    const showMsg = () => { const t = warnText(); msg.textContent = t; msg.hidden = !t; };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Tab') { e.preventDefault(); const lines = st.scans.get(n).lines; const nx = lines[l.i + (e.shiftKey ? -1 : 1)]; done(); if (nx) openEditor(nx); }
    });
    input.addEventListener('blur', () => { if (st.editing && st.editing.input === input) done(); });
    const text = h('div', { class: 'pe-text' }, input);
    const el = h('div', { class: 'pe-base' }, text);
    st.editing = { page: n, line: l, el, input, text, inline: true, msg };
    placeInline();
    st.ui.layer.append(el);
    st.ui.status.after(msg);
    showMsg();
    st.ui.layer.querySelector(`[data-line="${l.i}"]`)?.setAttribute('hidden', '');
    input.focus();
    if (w) input.setSelectionRange(w.start, w.end); else input.setSelectionRange(value.length, value.length);
  }
  st.app.update();
}
/** Put the in-place editor on its line: its baseline, size, angle, matched font, colour and background. */
function placeInline() {
  const { line: l, el, text } = st.editing;
  const [vw, vh] = sizeOf(st.n);
  const k = kNow(), fs = l.size * k, lh = fs * 1.4;
  const th = (l.angle * Math.PI) / 180, u = (l.pens && l.pens[0]) || 0, v = l.v0 || 0;
  const x = l.base.x0 + u * Math.cos(th) + v * Math.sin(th), y = l.base.y0 - u * Math.sin(th) + v * Math.cos(th);
  el.style.cssText = `left:${(x / vw) * 100}%;top:${(y / vh) * 100}%;transform:rotate(${-l.angle}deg) scaleX(${l.hs || 1})`;
  text.style.cssText = `font-family:${E.CSS_FAMILY[l.font.family]};font-weight:${l.font.bold ? 700 : 400};font-size:${fs}px;color:${l.color};background:${l.bg};top:${-(lh / 2 + 0.388 * fs)}px;height:${lh}px;line-height:${lh}px;min-width:${Math.max(10, ((l.box[0] + l.box[2] - x) * k) / (l.hs || 1))}px`;
}
function closeEditor(save) {
  const ed = st.editing;
  if (!ed) return;
  st.editing = null;
  if (ed.off) ed.off();
  ed.el.remove();
  if (ed.msg) ed.msg.remove();
  if (save) {
    const text = E.cleanText(st.draft).slice(0, T.IMG.textMax * 2);
    if (text !== textOf(ed.page, ed.line)) { record(); setLine(ed.page, ed.line, text); announce(`Changed to “${text}”`); }
  }
  draw();
  refreshSide();
  st.app.update();
  if (!touchy.matches) setTimeout(() => { const b = st.ui && st.ui.layer.querySelector(`[data-line="${ed.line.i}"]`); if (b && !st.editing) b.focus({ preventScroll: true }); }, 0);
}

// ------------------------------------------------------------------ added text
function placeBox(e) {
  if (st.mode !== 'add' || e.target.closest('.pe-add, .pe-base') || e.button > 0) return;
  if (e.pointerType === 'touch' && !e.isPrimary) return;
  const r = st.ui.layer.getBoundingClientRect();
  const [vw, vh] = sizeOf(st.n);
  const o = st.app.o;
  const s = Math.round((o.size * vw) / 1000); // the size option is for a picture 1000 px wide
  const t = { id: 'a' + ++st.seq, page: st.n, x: ((e.clientX - r.left) / r.width) * vw, y: Math.max(0, ((e.clientY - r.top) / r.height) * vh - s * 0.7), text: '', size: s, family: o.family, bold: o.bold, italic: o.italic, color: o.color, align: o.align };
  record();
  st.adds.push(t);
  st.sel = t.id;
  draw();
  setTimeout(() => editBox(t), 0);
}
function addBox(t) {
  const [vw, vh] = sizeOf(st.n);
  const k = kNow();
  const area = h('textarea', { class: 'pe-area', rows: 1, spellcheck: 'false', 'aria-label': 'Added text', placeholder: 'Type here', readonly: touchy.matches ? '' : null,
    style: `font-family:${E.CSS_FAMILY[t.family]};font-weight:${t.bold ? 700 : 400};font-style:${t.italic ? 'italic' : 'normal'};font-size:${t.size * k}px;color:${t.color};line-height:${E.METRICS.line};text-align:${t.align}` });
  area.value = t.text;
  area.addEventListener('focus', () => select(t));
  let typed = false;
  area.addEventListener('input', () => { if (touchy.matches) return; if (!typed) { record(); typed = true; } t.text = area.value; refreshSide(); st.app.update(); });
  area.addEventListener('blur', () => { typed = false; });
  area.addEventListener('click', () => { if (touchy.matches) editBox(t); });
  const sel = st.sel === t.id;
  const grip = h('button', { type: 'button', class: 'pe-grip', 'aria-label': 'Move this text', title: 'Drag to move' }, ic('move'));
  grip.addEventListener('pointerdown', (e) => drag(e, t));
  const del = h('button', { type: 'button', class: 'pe-x', 'aria-label': 'Delete this text', onclick: () => { record(); st.adds = st.adds.filter((x) => x !== t); st.sel = null; draw(); refreshSide(); st.app.update(); } }, ic('x'));
  return h('div', { class: 'pe-add' + (sel ? ' sel' : ''), 'data-add': t.id, style: `left:${(t.x / vw) * 100}%;top:${(t.y / vh) * 100}%`, onpointerdown: (e) => { e.stopPropagation(); if (st.sel !== t.id) select(t); } }, area, sel ? grip : null, sel ? del : null);
}
function select(t) {
  if (st.sel === t.id) return;
  st.sel = t.id;
  const vw = sizeOf(st.n)[0];
  Object.assign(st.app.o, { family: t.family, size: Math.round((t.size * 1000) / vw), color: t.color, bold: t.bold, italic: t.italic, align: t.align });
  draw(); st.app.update();
}
function editBox(t) {
  if (!touchy.matches) { const a = st.ui.layer.querySelector(`[data-add="${t.id}"] .pe-area`); if (a) a.focus(); return; }
  closeEditor(true);
  const area = h('textarea', { rows: 2, 'aria-label': 'Text to add', placeholder: 'Type the text to add' });
  area.value = t.text;
  const done = () => { bar.remove(); off(); if (area.value !== t.text) { record(); t.text = area.value; } if (!t.text.trim()) st.adds = st.adds.filter((x) => x !== t); draw(); refreshSide(); st.app.update(); };
  const bar = h('div', { class: 'pe-bar', role: 'dialog', 'aria-label': 'Add text' }, h('p', { class: 'pe-bar-t' }, 'New text'), area,
    h('div', { class: 'pe-bar-btns' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done')));
  document.body.append(bar);
  const place = () => { const vv = window.visualViewport; if (vv) bar.style.bottom = Math.max(0, innerHeight - (vv.height + vv.offsetTop)) + 'px'; };
  const off = () => { if (window.visualViewport) { visualViewport.removeEventListener('resize', place); visualViewport.removeEventListener('scroll', place); } };
  if (window.visualViewport) { visualViewport.addEventListener('resize', place); visualViewport.addEventListener('scroll', place); }
  place();
  area.focus();
}
function drag(e, t) {
  e.preventDefault(); e.stopPropagation();
  const r = st.ui.layer.getBoundingClientRect();
  const [vw, vh] = sizeOf(st.n);
  const x0 = e.clientX, y0 = e.clientY, sx = t.x, sy = t.y;
  const box = e.currentTarget.parentElement;
  let moved = false;
  const move = (ev) => {
    if (!moved) { record(); moved = true; }
    t.x = Math.max(-10, Math.min(vw - 4, sx + ((ev.clientX - x0) / r.width) * vw));
    t.y = Math.max(-10, Math.min(vh - 4, sy + ((ev.clientY - y0) / r.height) * vh));
    box.style.left = (t.x / vw) * 100 + '%'; box.style.top = (t.y / vh) * 100 + '%';
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ find and replace
function allLines() {
  const out = [];
  for (const [n, s] of st.scans) for (const l of s.lines || []) out.push({ page: n, line: l.i, text: textOf(n, l), l });
  return out.sort((a, b) => a.page - b.page || a.line - b.line);
}
const findMatches = () => (st.app ? E.findMatches(allLines(), st.app.o.find, { matchCase: st.app.o.matchCase, wholeWord: st.app.o.whole }) : []);
const scannedAll = () => st.file && Array.from({ length: pages() }, (_, i) => st.scans.has(i + 1)).every(Boolean);
function replace(list) {
  if (!list.length) return;
  record();
  const all = allLines();
  const by = new Map();
  for (const m of list) { const k = key(m.page, m.line); if (!by.has(k)) by.set(k, []); by.get(k).push(m); }
  for (const ms of by.values()) {
    const x = all.find((y) => y.page === ms[0].page && y.line === ms[0].line);
    setLine(x.page, x.l, E.replaceMatches(x.text, ms, E.cleanText(st.app.o.repl || '')));
  }
  announce(`${plural(list.length, 'match', 'matches')} replaced`);
  st.hit = 0;
  draw(); refreshSide(); st.app.update();
}
let findBox = null, changeBox = null;
function renderFind() {
  findBox ||= h('div', { class: 'opt-field pe-findinfo' });
  if (!st.app || !st.file) return findBox;
  const o = st.app.o;
  const ms = findMatches();
  if (o.find && o.find.trim() && !scannedAll()) for (let n = 1; n <= pages(); n++) want(n);
  const many = pages() > 1;
  const pg = new Set(ms.map((m) => m.page)).size;
  st.hit = Math.min(st.hit, Math.max(0, ms.length - 1));
  const bad = noHere(E.unsupportedText(E.unsupportedChars(o.repl || '')));
  const goTo = (i) => { st.hit = (i + ms.length) % ms.length; const m = ms[st.hit]; if (m.page !== st.n) go(m.page); else draw(); refreshSide(); };
  const all = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', disabled: !ms.length || !!bad || !scannedAll(), onclick: () => replace(ms) }, 'Replace all');
  const one = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', disabled: !ms.length || !!bad, onclick: () => replace([ms[st.hit]]) }, 'Replace');
  findBox.replaceChildren(
    h('p', { class: 'fine pe-count', 'aria-live': 'polite' }, !o.find || !o.find.trim() ? (many ? 'Searches every page (each is read first).' : 'Searches the text that was read.')
      : `${ms.length ? `${st.hit + 1} of ${plural(ms.length, 'match', 'matches')}${many ? ` on ${plural(pg, 'page')}` : ''}` : 'No matches'}${scannedAll() ? '' : ' so far — reading…'}`),
    bad ? h('p', { class: 'f-err' }, ic('circle-alert'), h('span', null, bad)) : '',
    h('div', { class: 'pe-row' }, one, all, h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Previous match', disabled: !ms.length, onclick: () => goTo(st.hit - 1) }, ic('chevron-left')), h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Next match', disabled: !ms.length, onclick: () => goTo(st.hit + 1) }, ic('chevron-right'))));
  return findBox;
}
function renderChanges() {
  changeBox ||= h('div', { class: 'opt-field pe-changes' });
  const list = changes(), adds = realAdds();
  const many = pages() > 1;
  const busy = list.filter((e) => { const s = st.scans.get(e.page); return s && s.lines[e.line] && s.lines[e.line].level === 'busy'; }).length;
  changeBox.replaceChildren(
    h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Changes'), h('div', { class: 'tbtns' },
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Undo', disabled: !st.past.length, onclick: undo }, ic('undo-2')),
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Redo', disabled: !st.future.length, onclick: redo }, ic('redo-2')))),
    !list.length && !adds.length ? h('p', { class: 'fine' }, 'Nothing changed yet.') : h('ul', { class: 'pe-list' },
      ...list.map((e) => h('li', null, many ? h('span', { class: 'pe-pg' }, `p. ${e.page}`) : null, h('span', { class: 'pe-what' }, E.changeLabel(e.old, e.text)),
        h('button', { type: 'button', class: 'tbtn', 'aria-label': `Put back “${e.old}”`, onclick: () => { record(); st.edits.delete(key(e.page, e.line)); draw(); refreshSide(); st.app.update(); } }, ic('x')))),
      ...adds.map((t) => h('li', null, many ? h('span', { class: 'pe-pg' }, `p. ${t.page}`) : null, h('span', { class: 'pe-what' }, `Added “${t.text.length > 30 ? t.text.slice(0, 29) + '…' : t.text}”`),
        h('button', { type: 'button', class: 'tbtn', 'aria-label': `Delete the added text “${t.text}”`, onclick: () => { record(); st.adds = st.adds.filter((x) => x !== t); draw(); refreshSide(); st.app.update(); } }, ic('x'))))),
    busy ? h('p', { class: 'f-note' }, ic('triangle-alert'), h('span', null, `${busy === 1 ? 'One change is' : plural(busy, 'change') + ' are'} on a busy background, so the patch may show. Check the picture before saving.`)) : '',
    h('p', { class: 'fine ie-honest' }, T.LIMIT_NOTE));
  return changeBox;
}
function refreshSide() { if (findBox) renderFind(); if (changeBox) renderChanges(); }

/** The result's extension: the picture's own (jpg/jpeg, png, webp); HEIC pictures are saved as JPEG. */
function outOf(f) {
  if (f.format === 'pdf') return { to: 'pdf', ext: 'pdf' };
  const own = (f.name.split('.').pop() || '').toLowerCase();
  if (f.format === 'jpg') return { to: 'jpg', ext: own === 'jpeg' ? 'jpeg' : 'jpg' };
  if (f.format === 'png' || f.format === 'webp') return { to: f.format, ext: f.format };
  return { to: 'jpg', ext: 'jpg' };
}

const styleOpt = () => st.mode === 'add' || !!st.sel;
tool({
  againLabel: 'Back to the picture',
  kinds: ['jpg', 'png', 'webp', 'heic', 'pdf'], multiple: false,
  wrongKind: (f) => `${f.name} isn’t a picture or PDF this tool reads. Use a PNG, JPEG, WebP or HEIC picture, or a scanned PDF.`,
  pick: 'Choose a picture or PDF', drop: 'A photo, screenshot or scanned PDF: PNG, JPEG, WebP, HEIC or PDF. Its text is read in this browser.',
  inspect: (f) => (f.format === 'pdf' ? inspectPdf(f) : null),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  stage,
  reset() { st.file = null; st.ui = null; st.gen++; for (const b of document.querySelectorAll('.pe-bar')) b.remove(); },
  defaults: { langs: 'eng', family: 'sans', size: T.IMG.sizeDef, color: '#1d1d1f', bold: false, italic: false, align: 'left', find: '', repl: '', matchCase: false, whole: false, searchable: true },
  options: [
    { id: 'langs', type: 'seg', label: 'Language of the text', value: 'eng', choices: T.LANGS, hint: 'Changing it reads the text again and clears your changes.' },
    { id: 'family', type: 'seg', label: 'Font', value: 'sans', choices: E.FAMILIES, when: styleOpt },
    { id: 'size', type: 'range', label: 'Size', min: 8, max: 160, value: T.IMG.sizeDef, unit: '', format: (v) => (v < 24 ? 'Small' : v < 48 ? 'Medium' : v < 90 ? 'Large' : 'Very large') + ` (${v})`, when: styleOpt },
    { id: 'bold', type: 'toggle', label: 'Bold', value: false, when: styleOpt },
    { id: 'italic', type: 'toggle', label: 'Italic', value: false, when: styleOpt },
    { id: 'color', type: 'color', label: 'Colour', value: '#1d1d1f', choices: [{ value: '#1d1d1f', label: 'Black' }, { value: '#0a5ad6', label: 'Blue' }, { value: '#d70015', label: 'Red' }, { value: '#1f8a32', label: 'Green' }, { value: '#ffffff', label: 'White' }], when: styleOpt },
    { id: 'align', type: 'seg', label: 'Alignment', value: 'left', choices: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }], when: styleOpt },
    { id: 'find', type: 'text', label: 'Find', value: '', max: T.IMG.findMax, placeholder: 'A word or name' },
    { id: 'repl', type: 'text', label: 'Replace with', value: '', max: T.IMG.findMax, placeholder: 'The new word' },
    { id: 'matchCase', type: 'toggle', label: 'Match case', value: false },
    { id: 'whole', type: 'toggle', label: 'Whole words', value: false },
    { id: 'findInfo', type: 'custom', render: () => renderFind() },
    { id: 'changes', type: 'custom', render: () => renderChanges() },
    { id: 'searchable', type: 'toggle', label: 'Make the PDF searchable', value: true, when: () => isPdf(), hint: 'Adds the text read on each scanned page, invisibly, so it can be searched and copied. Saving reads every page, so it takes longer.' },
  ],
  onSet(app, id, v) {
    const sel = st.adds.find((t) => t.id === st.sel);
    if (sel && ['family', 'bold', 'italic', 'color', 'align'].includes(id)) { record(); sel[id] = v; draw(); }
    if (sel && id === 'size') { record(); sel.size = Math.round((v * sizeOf(st.n)[0]) / 1000); draw(); }
    if (['find', 'matchCase', 'whole'].includes(id)) { st.hit = 0; draw(); }
    if (id === 'langs' && st.file && v !== st.langs) {
      closeEditor(false);
      Object.assign(st, { langs: v, scans: new Map(), asked: new Set(), queue: [], reading: 0, shown: new Map(), edits: new Map(), adds: [], past: [], future: [], sel: null, gen: st.gen + 1 });
      want(st.n, true); draw(); refreshSide();
      announce(v === 'eng' ? 'Reading the text again in English' : 'Reading the text again in English and Hindi');
    }
  },
  onOptions: () => refreshSide(),
  check(files) {
    const locked = lockedReason(files);
    if (locked) return locked;
    const open = st.editing && st.editing.line && E.cleanText(st.draft) !== textOf(st.editing.page, st.editing.line) ? [E.cleanText(st.draft)] : [];
    const bad = [...open, ...changes().map((e) => e.text), ...realAdds().map((t) => t.text)].flatMap((t) => E.unsupportedChars(t));
    if (bad.length) return noHere(E.unsupportedText([...new Set(bad)]));
    return open.length || changes().length || realAdds().length ? '' : 'Change or add some text first.';
  },
  action: (files) => (files[0] && files[0].format === 'pdf' ? 'Save the PDF' : 'Save the picture'),
  showSaving: false,
  async run(f, o, job) {
    if (st.editing) closeEditor(true);
    const out = outOf(f);
    const edits = changes().map(({ page, line, old, text }) => ({ page, line, old, text }));
    const adds = realAdds().map(({ page, x, y, size, text, family, bold, italic, color, align }) => ({ page, x, y, size, text, family, bold, italic, color, align }));
    job.status(isPdf() && o.searchable && pages() > 1 ? 'Reading every page and saving…' : 'Saving…');
    const r = await engine.run('imageText.save', { bytes: await job.bytes(), edits, adds, langs: st.langs, to: out.to, quality: out.to === 'webp' ? 0.9 : 0.92, searchable: !!o.searchable, limits: LIMITS, password: f.password || undefined }, job);
    const note = [f.format === 'heic' ? 'saved as JPEG' : '', r.edited ? plural(r.edited, 'line') + ' changed' : '', r.added ? plural(r.added, 'text') + ' added' : '',
      r.busy ? `${plural(r.busy, 'line')} on a busy background — check the patch` : '', r.verify && !r.verify.ok ? 'couldn’t read back every change' : ''].filter(Boolean).join(' · ');
    return { outputs: [{ name: job.name(f.stem, out.ext, T.SUFFIX), bytes: r.bytes }], note, warn: !!r.busy || !(r.verify && r.verify.ok) };
  },
});

addEventListener('keydown', (e) => {
  if (!st.ui || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); refreshSide(); st.app.update(); }
  else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); refreshSide(); st.app.update(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel) { e.preventDefault(); record(); st.adds = st.adds.filter((t) => t.id !== st.sel); st.sel = null; draw(); refreshSide(); st.app.update(); }
});
