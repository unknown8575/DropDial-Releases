// Edit PDF text: the app's tool (src/main/tools/pdfEditText.js) with the processor's own operations — pdf.editScan
// (the text lines of each page), pdf.editPreview (a page drawn with the edits, by the same code as the save) and
// pdf.editSave (the old characters cut out of the page, the new ones written in embedded fonts). Shared logic (lines,
// find and replace, fonts) is src/shared/pdfedit.mjs. Phones: tap a line and type in a bar that stays above the
// keyboard; pinch or the zoom buttons to zoom. Computers: click a line and type in place.
import { tool, engine, LIMITS, plural, h, ic, announce, urlFor, bytesOf, touchy } from './ui.js';
import * as E from '../../tools/engine/shared/pdfedit.mjs';
import { PDF_ACCEPT, inspectPdf, passwordBox, lockedReason } from './pdfkit.js';

const BATCH = 10, SIDE = 1600, ZMAX = 4;
const key = (p, l) => `${p}:${l}`;
const st = { app: null, file: null, n: 1, scans: new Map(), asked: new Set(), pics: new Map(), shown: new Map(), edits: new Map(), adds: [], past: [], future: [], editing: null, draft: '', sel: null, mode: 'edit', zoom: 1, ui: null, hit: 0, seq: 0 };
const pw = () => (st.file && st.file.password) || undefined;
const sizeOf = (n) => (st.file.meta.sizes && st.file.meta.sizes[n - 1]) || [612, 792];
const changes = () => [...st.edits.values()].filter((e) => e.text !== e.old).sort((a, b) => a.page - b.page || a.line - b.line);
const realAdds = () => st.adds.filter((t) => t.text.trim());
const textOf = (p, l) => { const e = st.edits.get(key(p, l.i)); return e ? e.text : l.text; };

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

// ------------------------------------------------------------------ reading pages
async function want(n) {
  const f = st.file, total = f.meta.pages;
  if (n < 1 || n > total) return;
  const first = Math.floor((n - 1) / BATCH) * BATCH + 1;
  if (st.asked.has(first)) return;
  st.asked.add(first);
  try {
    const r = await engine.run('pdf.editScan', { bytes: await bytesOf(f), first, last: Math.min(total, first + BATCH - 1), limits: LIMITS, password: pw() });
    if (st.file !== f) return;
    for (const p of r.results) st.scans.set(p.n, p);
  } catch (e) {
    for (let p = first; p < first + BATCH; p++) st.scans.set(p, { error: e.user ? e.message : 'This page couldn’t be read.', lines: [] });
  }
  if (st.file === f) { draw(); refreshSide(); }
}
async function picture(n) {
  const f = st.file;
  const edits = changes().filter((e) => e.page === n);
  const k = JSON.stringify(edits.map((e) => [e.line, e.text]));
  try {
    if (!edits.length) {
      if (!st.pics.has(n)) {
        const r = await engine.run('pdf.render', { bytes: await bytesOf(f), first: n, last: n, format: 'jpg', quality: 0.85, maxSide: SIDE, limits: LIMITS, password: pw() });
        st.pics.set(n, urlFor(new Blob([r.pages[0].bytes], { type: 'image/jpeg' })));
      }
      return st.pics.get(n);
    }
    const had = st.shown.get(n);
    if (had && had.k === k) return had.url;
    st.ui.busy.hidden = false;
    const r = await engine.run('pdf.editPreview', { bytes: await bytesOf(f), page: n, edits, adds: [], maxSide: SIDE, limits: LIMITS, password: pw() });
    const url = urlFor(new Blob([r.bytes], { type: 'image/jpeg' }));
    st.shown.set(n, { k, url });
    return url;
  } catch (e) { console.error(e); return st.pics.get(n) || null; }
  finally { if (st.ui) st.ui.busy.hidden = true; }
}

// ------------------------------------------------------------------ the page
function stage(app, el) {
  st.app = app;
  const f = app.files.find((x) => !x.error && !x.locked && x.meta.pages);
  if (!f) { st.ui = null; el.replaceChildren(); return; }
  if (st.ui && st.file === f) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  Object.assign(st, { file: f, n: 1, scans: new Map(), asked: new Set(), pics: new Map(), shown: new Map(), edits: new Map(), adds: [], past: [], future: [], editing: null, sel: null, mode: 'edit', zoom: 1, hit: 0 });
  const seg = (v, label, icon) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(st.mode === v), onclick: () => setMode(v) }, ic(icon), label);
  const modes = h('div', { class: 'segctl static pe-modes', role: 'group', 'aria-label': 'What a tap does' }, seg('edit', 'Change text', 'type'), seg('add', 'Add text', 'plus'));
  const where = h('p', { class: 'fine pe-where', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Previous page', onclick: () => go(st.n - 1) }, ic('chevron-left'));
  const next = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Next page', onclick: () => go(st.n + 1) }, ic('chevron-right'));
  const zout = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Zoom out', onclick: () => zoom(st.zoom / 1.4) }, ic('zoom-out'));
  const zin = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Zoom in', onclick: () => zoom(st.zoom * 1.4) }, ic('zoom-in'));
  const img = h('img', { class: 'pe-img', alt: '', draggable: 'false' });
  const layer = h('div', { class: 'pe-layer' });
  const sheet = h('div', { class: 'pe-sheet' }, img, layer);
  const view = h('div', { class: 'pe-view', tabindex: '-1' }, sheet);
  const busy = h('p', { class: 'pv-tag pe-busy', hidden: true, role: 'status' }, 'Updating…');
  const status = h('p', { class: 'pe-status', role: 'status' });
  const panel = h('div', { class: 'panel pe-panel' },
    h('div', { class: 'panel-bar' }, modes, h('div', { class: 'tbtns' }, zout, zin)),
    h('div', { class: 'pe-frame' }, view, busy),
    status,
    h('div', { class: 'panel-bar' }, where, h('div', { class: 'tbtns' }, prev, next)));
  st.ui = { panel, img, layer, sheet, view, where, prev, next, status, busy, modes, zin, zout };
  layer.addEventListener('pointerdown', placeBox);
  pinch(view);
  el.replaceChildren(panel);
  new ResizeObserver(() => size()).observe(panel);
  draw();
}

function go(n) { closeEditor(true); st.n = Math.max(1, Math.min(st.file.meta.pages, n)); st.sel = null; st.ui.view.scrollTo(0, 0); draw(); }
function setMode(m) { closeEditor(true); st.mode = m; if (m === 'edit') st.sel = null; draw(); st.app.update(); }
function zoom(z) { st.zoom = Math.max(1, Math.min(ZMAX, z)); size(); }
/** Fit the page to the panel's width (and, on a computer, its height), times the zoom. */
function size() {
  if (!st.ui) return;
  const [vw, vh] = sizeOf(st.n);
  // The panel's own width (the view would grow with the page it holds).
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
/** Two fingers on the page zoom it. */
function pinch(el) {
  const pts = new Map();
  let d0 = 0, z0 = 1;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { d0 = dist(); z0 = st.zoom; } });
  el.addEventListener('pointermove', (e) => { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2 && d0 > 10) zoom(z0 * (dist() / d0)); });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) d0 = 0; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}

async function draw() {
  const ui = st.ui;
  if (!ui) return;
  const f = st.file, n = st.n, total = f.meta.pages;
  const [vw, vh] = sizeOf(n);
  ui.where.textContent = `Page ${n} of ${total}`;
  ui.prev.disabled = n <= 1; ui.next.disabled = n >= total;
  for (const b of ui.modes.children) b.setAttribute('aria-pressed', String(b.dataset.v === st.mode));
  ui.panel.classList.toggle('adding', st.mode === 'add');
  size();
  const scan = st.scans.get(n);
  if (!scan) want(n); else if (n % BATCH === 0) want(n + 1);
  const lines = scan && scan.lines ? scan.lines : [];
  const status = !scan ? 'Finding the text on this page…' : scan.error ? scan.error : scan.scan ? E.SCAN_NOTE : !lines.length ? 'No text to change on this page. Use Add text to write on it.'
    : st.mode === 'add' ? (touchy.matches ? 'Tap where the new text should go.' : 'Click where the new text should go.') : touchy.matches ? 'Tap a line to change it.' : 'Click a line to change it.';
  ui.status.textContent = status;
  ui.status.classList.toggle('scan', !!(scan && scan.scan));
  // Lines: one button each (the keyboard moves between them with the arrow keys).
  const pct = (v, of) => (v / of) * 100 + '%';
  const matches = findMatches().filter((m) => m.page === n);
  const cur = findMatches()[st.hit];
  const kids = lines.map((l) => {
    const changed = st.edits.has(key(n, l.i)) && st.edits.get(key(n, l.i)).text !== l.text;
    const cls = 'pe-line' + (changed ? ' changed' : '') + (matches.some((m) => m.line === l.i) ? ' found' : '') + (cur && cur.page === n && cur.line === l.i ? ' active' : '');
    return h('button', { type: 'button', class: cls, 'data-line': String(l.i), 'aria-label': `Line: ${textOf(n, l)}${changed ? ' (changed)' : ''}`,
      style: `left:${pct(l.box[0], vw)};top:${pct(l.box[1], vh)};width:${pct(l.box[2], vw)};height:${pct(l.box[3], vh)}`,
      onclick: () => { if (st.mode === 'edit') openEditor(l); },
      onkeydown: (e) => {
        const j = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (j) { e.preventDefault(); const b = ui.layer.querySelector(`[data-line="${l.i + j}"]`); if (b) b.focus(); }
      } });
  });
  if (scan && scan.scan) kids.push(h('div', { class: 'pe-scan', role: 'note' }, ic('info'), h('div', null, h('b', null, 'This page is a scan'), h('span', null, 'Its words are a picture. Edit text in an image reads them in this browser and lets you change them. You can also add text on top here.'),
    h('a', { class: 'btn btn-quiet btn-sm pe-toimg', href: '../edit-image-text/' }, 'Open Edit text in an image'))));
  for (const t of st.adds.filter((x) => x.page === n)) kids.push(addBox(t));
  ui.layer.replaceChildren(...kids);
  if (st.editing && st.editing.inline && st.editing.page === n) ui.layer.append(st.editing.el);
  const url = await picture(n);
  if (st.ui === ui && st.n === n && url && ui.img.getAttribute('src') !== url) ui.img.src = url;
}

// ------------------------------------------------------------------ editing a line
function openEditor(l) {
  closeEditor(true);
  const n = st.n;
  const value = textOf(n, l);
  st.draft = value;
  const done = () => { closeEditor(true); };
  const cancel = () => { closeEditor(false); };
  if (touchy.matches) {
    // A bar at the bottom that stays above the on-screen keyboard; the line is scrolled into view above it.
    const input = h('input', { type: 'text', value, enterkeyhint: 'done', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'New text for the line', oninput: (e) => { st.draft = e.target.value; warn(); st.app.update(); } });
    const msg = h('p', { class: 'pe-msg', 'aria-live': 'polite' });
    const warn = () => { const w = E.unsupportedText(E.unsupportedChars(st.draft)) || (l.mode === 'cover' ? E.COVER_NOTE : ''); msg.textContent = w; msg.hidden = !w; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') cancel(); });
    const bar = h('div', { class: 'pe-bar', role: 'dialog', 'aria-label': `Change the line on page ${n}` },
      h('p', { class: 'pe-bar-t' }, `Page ${n} · ${l.text.length > 40 ? l.text.slice(0, 39) + '…' : l.text}`), input, msg,
      h('div', { class: 'pe-bar-btns' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: cancel }, 'Cancel'), h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done')));
    warn();
    document.body.append(bar);
    const place = () => { const vv = window.visualViewport; if (vv) bar.style.bottom = Math.max(0, innerHeight - (vv.height + vv.offsetTop)) + 'px'; };
    place();
    if (window.visualViewport) { visualViewport.addEventListener('resize', place); visualViewport.addEventListener('scroll', place); }
    st.editing = { page: n, line: l, el: bar, inline: false, off: () => { if (window.visualViewport) { visualViewport.removeEventListener('resize', place); visualViewport.removeEventListener('scroll', place); } } };
    st.ui.layer.querySelector(`[data-line="${l.i}"]`)?.classList.add('editing');
    input.focus();
    const keepInView = () => { const b = st.ui.layer.querySelector(`[data-line="${l.i}"]`); if (!b) return; const r = b.getBoundingClientRect(), br = bar.getBoundingClientRect(); if (r.bottom > br.top - 12 || r.top < 60) scrollBy({ top: r.top - Math.max(70, (br.top - r.height) / 2), behavior: 'auto' }); };
    setTimeout(keepInView, 60); setTimeout(keepInView, 450);
  } else {
    const input = h('input', { type: 'text', class: 'pe-input', value, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Edit line: ${l.text}`, oninput: (e) => { st.draft = e.target.value; input.setAttribute('aria-invalid', String(!!E.unsupportedChars(st.draft).length)); st.app.update(); } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Tab') { e.preventDefault(); const lines = st.scans.get(n).lines; const nx = lines[l.i + (e.shiftKey ? -1 : 1)]; done(); if (nx) openEditor(nx); }
    });
    input.addEventListener('blur', () => { if (st.editing && st.editing.input === input) done(); });
    const text = h('div', { class: 'pe-text' }, input);
    const el = h('div', { class: 'pe-base' }, text);
    st.editing = { page: n, line: l, el, input, text, inline: true };
    placeInline();
    st.ui.layer.append(el);
    st.ui.layer.querySelector(`[data-line="${l.i}"]`)?.setAttribute('hidden', '');
    input.focus();
    input.setSelectionRange(value.length, value.length);
  }
  st.app.update();
}
/** Put the in-place editor on its line: the line's baseline, size, angle, font and colour. */
function placeInline() {
  const { line: l, el, text } = st.editing;
  const [vw, vh] = sizeOf(st.n);
  const k = kNow(), fs = l.size * k, lh = fs * 1.4;
  el.style.cssText = `left:${(l.x / vw) * 100}%;top:${(l.y / vh) * 100}%;transform:rotate(${-l.angle}deg) scaleX(${l.hs || 1})`;
  text.style.cssText = `font-family:${E.CSS_FAMILY[l.font.family]};font-weight:${l.font.bold ? 700 : 400};font-style:${l.font.italic ? 'italic' : 'normal'};font-size:${fs}px;color:${l.color};top:${-(lh / 2 + 0.388 * fs)}px;height:${lh}px;line-height:${lh}px;min-width:${Math.max(10, (l.w * k) / (l.hs || 1))}px`;
}
function closeEditor(save) {
  const ed = st.editing;
  if (!ed) return;
  st.editing = null;
  if (ed.off) ed.off();
  ed.el.remove();
  if (save) {
    const text = E.cleanText(st.draft).slice(0, E.EDIT.textMax * 2);
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
  const t = { id: 'a' + ++st.seq, page: st.n, x: ((e.clientX - r.left) / r.width) * vw, y: Math.max(0, ((e.clientY - r.top) / r.height) * vh - o.size * 0.7), text: '', size: o.size, family: o.family, bold: o.bold, italic: o.italic, color: o.color, align: o.align };
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
  // Typed text is kept as it is typed (one Undo step per visit), so Save always has it.
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
  Object.assign(st.app.o, { family: t.family, size: t.size, color: t.color, bold: t.bold, italic: t.italic, align: t.align });
  draw(); st.app.update();
}
/** Phones: an added box's text is typed in the bar above the keyboard. Computers: in the box. */
function editBox(t) {
  if (!touchy.matches) { const a = st.ui.layer.querySelector(`[data-add="${t.id}"] .pe-area`); if (a) a.focus(); return; }
  closeEditor(true);
  const area = h('textarea', { rows: 2, 'aria-label': 'Text to add', placeholder: 'Type the text to add' });
  area.value = t.text;
  const done = () => { bar.remove(); off(); if (area.value !== t.text) { record(); t.text = area.value; } if (!t.text.trim()) st.adds = st.adds.filter((x) => x !== t); draw(); refreshSide(); st.app.update(); };
  const bar = h('div', { class: 'pe-bar', role: 'dialog', 'aria-label': 'Add text' }, h('p', { class: 'pe-bar-t' }, `Page ${t.page} · new text`), area,
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
const scannedAll = () => st.file && Array.from({ length: st.file.meta.pages }, (_, i) => st.scans.has(i + 1)).every(Boolean);
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
  if (o.find && o.find.trim() && !scannedAll()) for (let n = 1; n <= st.file.meta.pages; n++) if (!st.scans.has(n)) { want(n); break; }
  const pages = new Set(ms.map((m) => m.page)).size;
  st.hit = Math.min(st.hit, Math.max(0, ms.length - 1));
  const bad = E.unsupportedText(E.unsupportedChars(o.repl || ''));
  const goTo = (i) => { st.hit = (i + ms.length) % ms.length; const m = ms[st.hit]; if (m.page !== st.n) go(m.page); else draw(); refreshSide(); };
  const all = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', disabled: !ms.length || !!bad || !scannedAll(), onclick: () => replace(ms) }, 'Replace all');
  const one = h('button', { type: 'button', class: 'btn btn-quiet btn-sm', disabled: !ms.length || !!bad, onclick: () => replace([ms[st.hit]]) }, 'Replace');
  findBox.replaceChildren(
    h('p', { class: 'fine pe-count', 'aria-live': 'polite' }, !o.find || !o.find.trim() ? 'Searches every page.' : `${ms.length ? `${st.hit + 1} of ${plural(ms.length, 'match', 'matches')} on ${plural(pages, 'page')}` : 'No matches'}${scannedAll() ? '' : ' so far — searching…'}`),
    bad ? h('p', { class: 'f-err' }, ic('circle-alert'), h('span', null, bad)) : '',
    h('div', { class: 'pe-row' }, one, all, h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Previous match', disabled: !ms.length, onclick: () => goTo(st.hit - 1) }, ic('chevron-left')), h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Next match', disabled: !ms.length, onclick: () => goTo(st.hit + 1) }, ic('chevron-right'))));
  return findBox;
}
function renderChanges() {
  changeBox ||= h('div', { class: 'opt-field pe-changes' });
  const list = changes(), adds = realAdds();
  const covered = list.filter((e) => { const s = st.scans.get(e.page); return s && s.lines[e.line] && s.lines[e.line].mode === 'cover'; }).length;
  changeBox.replaceChildren(
    h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Changes'), h('div', { class: 'tbtns' },
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Undo', disabled: !st.past.length, onclick: undo }, ic('undo-2')),
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Redo', disabled: !st.future.length, onclick: redo }, ic('redo-2')))),
    !list.length && !adds.length ? h('p', { class: 'fine' }, 'Nothing changed yet.') : h('ul', { class: 'pe-list' },
      ...list.map((e) => h('li', null, h('span', { class: 'pe-pg' }, `p. ${e.page}`), h('span', { class: 'pe-what' }, E.changeLabel(e.old, e.text)),
        h('button', { type: 'button', class: 'tbtn', 'aria-label': `Put back “${e.old}”`, onclick: () => { record(); st.edits.delete(key(e.page, e.line)); draw(); refreshSide(); st.app.update(); } }, ic('x')))),
      ...adds.map((t) => h('li', null, h('span', { class: 'pe-pg' }, `p. ${t.page}`), h('span', { class: 'pe-what' }, `Added “${t.text.length > 30 ? t.text.slice(0, 29) + '…' : t.text}”`),
        h('button', { type: 'button', class: 'tbtn', 'aria-label': `Delete the added text “${t.text}”`, onclick: () => { record(); st.adds = st.adds.filter((x) => x !== t); draw(); refreshSide(); st.app.update(); } }, ic('x'))))),
    covered ? h('p', { class: 'f-note' }, ic('triangle-alert'), h('span', null, `${plural(covered, 'changed line')} can only be covered: the old text stays in the file underneath.`)) : '');
  return changeBox;
}
function refreshSide() { if (findBox) renderFind(); if (changeBox) renderChanges(); }

const styleOpt = (o) => st.mode === 'add' || !!st.sel;
tool({
  againLabel: 'Back to the page',
  ...PDF_ACCEPT, multiple: false,
  pick: 'Choose a PDF', drop: 'One PDF. You can change its text, replace words and add text.',
  inspect: (f) => inspectPdf(f),
  metaLine: (f) => [f.locked ? 'Locked' : ''],
  fileExtra: (f, app) => passwordBox(f, app),
  stage,
  reset() { st.file = null; st.ui = null; for (const b of document.querySelectorAll('.pe-bar')) b.remove(); },
  defaults: { family: 'sans', size: E.EDIT.sizeDef, color: '#1d1d1f', bold: false, italic: false, align: 'left', find: '', repl: '', matchCase: false, whole: false },
  options: [
    { id: 'family', type: 'seg', label: 'Font', value: 'sans', choices: E.FAMILIES, when: styleOpt },
    { id: 'size', type: 'range', label: 'Size', min: 6, max: 72, value: E.EDIT.sizeDef, unit: ' pt', when: styleOpt },
    { id: 'bold', type: 'toggle', label: 'Bold', value: false, when: styleOpt },
    { id: 'italic', type: 'toggle', label: 'Italic', value: false, when: styleOpt },
    { id: 'color', type: 'color', label: 'Colour', value: '#1d1d1f', choices: [{ value: '#1d1d1f', label: 'Black' }, { value: '#0a5ad6', label: 'Blue' }, { value: '#d70015', label: 'Red' }, { value: '#1f8a32', label: 'Green' }, { value: '#6e6e73', label: 'Grey' }], when: styleOpt },
    { id: 'align', type: 'seg', label: 'Alignment', value: 'left', choices: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }], when: styleOpt },
    { id: 'find', type: 'text', label: 'Find', value: '', max: E.EDIT.findMax, placeholder: 'A word or name' },
    { id: 'repl', type: 'text', label: 'Replace with', value: '', max: E.EDIT.findMax, placeholder: 'The new word' },
    { id: 'matchCase', type: 'toggle', label: 'Match case', value: false },
    { id: 'whole', type: 'toggle', label: 'Whole words', value: false },
    { id: 'findInfo', type: 'custom', render: () => renderFind() },
    { id: 'changes', type: 'custom', render: () => renderChanges() },
  ],
  onSet(app, id, v) {
    const sel = st.adds.find((t) => t.id === st.sel);
    if (sel && ['family', 'size', 'bold', 'italic', 'color', 'align'].includes(id)) { record(); sel[id] = v; draw(); }
    if (['find', 'matchCase', 'whole'].includes(id)) { st.hit = 0; draw(); }
  },
  onOptions: () => refreshSide(),
  check(files) {
    const locked = lockedReason(files);
    if (locked) return locked;
    const open = st.editing && st.editing.line && E.cleanText(st.draft) !== textOf(st.editing.page, st.editing.line) ? [E.cleanText(st.draft)] : [];
    const bad = [...open, ...changes().map((e) => e.text), ...realAdds().map((t) => t.text)].flatMap((t) => E.unsupportedChars(t));
    if (bad.length) return E.unsupportedText([...new Set(bad)]);
    return open.length || changes().length || realAdds().length ? '' : 'Change or add some text first.';
  },
  action: () => 'Save the PDF',
  showSaving: false,
  async run(f, o, job) {
    if (st.editing) closeEditor(true); // the line still being typed is saved as it is
    const edits = changes().map(({ page, line, old, text }) => ({ page, line, old, text }));
    const adds = realAdds().map(({ page, x, y, size, text, family, bold, italic, color, align }) => ({ page, x, y, size, text, family, bold, italic, color, align }));
    const r = await engine.run('pdf.editSave', { bytes: await job.bytes(), edits, adds, limits: LIMITS, password: f.password || undefined }, job);
    const note = [r.edited ? plural(r.edited, 'line') + ' changed' : '', r.added ? plural(r.added, 'text') + ' added' : '', r.covered ? `${plural(r.covered, 'line')} covered (the old text is still underneath)` : '',
      r.verify && !r.verify.ok ? 'couldn’t confirm every change' : ''].filter(Boolean).join(' · ');
    return { outputs: [{ name: job.name(f.stem, 'pdf', E.SUFFIX), bytes: r.bytes }], note, warn: !!r.covered || !(r.verify && r.verify.ok) };
  },
});

addEventListener('keydown', (e) => {
  if (!st.ui || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); refreshSide(); st.app.update(); }
  else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); refreshSide(); st.app.update(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel) { e.preventDefault(); record(); st.adds = st.adds.filter((t) => t.id !== st.sel); st.sel = null; draw(); refreshSide(); st.app.update(); }
});
