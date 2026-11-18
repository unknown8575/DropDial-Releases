// The web tools' page framework: choose or drop files, see them listed with pictures and sizes, pick options, run
// the tool with real progress and Cancel, then download, share or ZIP the results. Each tool page
// (js/tools/<slug>.js) describes its tool with tool({...}); the work itself is done by the app's own code through
// the engine (tools/engine/web/client.js). Nothing is uploaded: files are read here and handed to a Web Worker.
import { reduced } from '../site.js';
import { createEngine, Cancelled } from '../../tools/engine/web/client.js';
import F from '../../tools/engine/web/formats.js';
import S from '../../tools/engine/web/sniff.js';
import { sniff as pictureKind, headerSize, jpegOrientation } from '../../tools/engine/processor/image-header.js';

export { F, S };
export const engine = createEngine();
export const LIMITS = engine.limits;

// ------------------------------------------------------------------ small helpers
/** Sizes as the app shows them (src/renderer/lib.js formatBytes): 4.47 MB, 12.3 MB, 245 MB. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
}
export const plural = (n, one, many = one + 's') => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
export const MB = 1024 * 1024;

/** h('div', {class: 'x', onclick}, child, …): a tiny element builder. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string' && k !== 'style') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
/** Replace an element's children, skipping empty ones (replaceChildren would write "null"). */
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((x) => x != null && x !== false && x !== ''));
/** An icon from the page's sprite (the app's Lucide set, inlined by the build). */
export function ic(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'icon ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('viewBox', '0 0 24 24');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}
const live = () => document.getElementById('tool-live');
/** Say something to screen readers. */
export function announce(text) { const el = live(); if (!el) return; el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); }

export const touchy = matchMedia('(pointer: coarse)');
const phoneSized = () => touchy.matches && Math.min(screen.width, screen.height) < 820;

/** A file's bytes, read fresh (the engine takes ownership of the bytes it is given). */
export const bytesOf = async (f) => new Uint8Array(await (f.file || f).arrayBuffer());
const objectURLs = new Set();
export function urlFor(blob) { const u = URL.createObjectURL(blob); objectURLs.add(u); return u; }
function dropURLs() { for (const u of objectURLs) URL.revokeObjectURL(u); objectURLs.clear(); }

/** The extension for a result in `to`: the file's own spelling when the format is kept ("jpeg"), else the usual one. */
export function extFor(f, to) {
  const own = (f.name.split('.').pop() || '').toLowerCase();
  const info = F.formatInfo(to);
  return to === f.format && info.aliases.includes(own) ? own : info.ext;
}
/** Read a file as text the way the app does (UTF-8, UTF-16 with a BOM, else Windows-1252). */
export { decodeText } from '../../tools/engine/web/document.js';

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export const mimeOf = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
/** Pictures every browser shows in an <img> by itself. */
const NATIVE = new Set(['jpg', 'png', 'webp', 'gif', 'bmp', 'ico', 'svg', 'avif']);

/** The app's size limits for one file (src/main/files.js LIMITS.bytes). */
const MAX_BYTES = { image: 200 * MB, document: 500 * MB, text: 50 * MB };

/** A friendly message for an error: the app's own words for problems a person can fix, plain words otherwise. */
export function errorText(e) {
  if (!e) return 'Something went wrong.';
  if (e.user) return e.message;
  if (/memory|allocation|too large|Array buffer|RangeError/i.test(String(e.message) + String(e.name))) return 'This file is too large for this device’s memory. Try it on a computer, or with fewer pages or a smaller picture.';
  console.error(e);
  return 'Something went wrong with this file. It may be damaged, or too large for this device.';
}
export class UserError extends Error { constructor(m) { super(m); this.user = true; } }

// ------------------------------------------------------------------ files
let seq = 0;
async function describe(file) {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const byName = F.detect(file.name);
  const sniffed = S.sniffFormat(head);
  // Content wins over the name for the formats DropDial can recognise (a HEIC photo named .jpg is still HEIC).
  const format = sniffed || (byName && !['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'avif', 'ico', 'pdf', 'docx', 'xlsx'].includes(byName) ? byName : null) || byName;
  const info = format ? F.formatInfo(format) : null;
  const animated = format === 'gif' ? S.isAnimated(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()), 'gif') : S.isAnimated(head, format);
  return { format, category: info ? info.category : null, label: info ? info.label : (file.name.split('.').pop() || 'file').toUpperCase(), animated };
}

// ------------------------------------------------------------------ reordering (lists and page grids)
/**
 * Drag to reorder: the handle (a button) moves its item with a pointer (mouse, pen or finger) or with the arrow keys.
 * `onDone(keys)` gets the new order of data-key values.
 */
export function sortable(container, { item = '[data-key]', handle = '.grip', onDone, label = (i, n) => `Moved to place ${i} of ${n}` }) {
  let drag = null, raf = 0;
  const items = () => [...container.querySelectorAll(item)];
  const finish = () => onDone(items().map((el) => el.dataset.key));
  container.addEventListener('keydown', (e) => {
    const hd = e.target.closest(handle);
    if (!hd) return;
    const el = hd.closest(item);
    const list = items();
    const i = list.indexOf(el);
    const grid = getComputedStyle(container).display === 'grid';
    const back = e.key === 'ArrowUp' || (e.key === 'ArrowLeft'), fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    if (!back && !fwd) return;
    e.preventDefault();
    const j = back ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    if (back) list[j].before(el); else list[j].after(el);
    hd.focus();
    announce(label(j + 1, list.length));
    finish();
    void grid;
  });
  container.addEventListener('pointerdown', (e) => {
    const hd = e.target.closest(handle);
    if (!hd || e.button > 0) return;
    const el = hd.closest(item);
    e.preventDefault();
    hd.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    drag = { el, hd, id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, x: e.clientX, y: e.clientY, on: false };
  });
  const place = () => {
    const { el, x, y } = drag;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transform = `translate(${x - drag.ox - r.left}px, ${y - drag.oy - r.top}px)`;
  };
  const tick = () => {
    if (!drag || !drag.on) return;
    const edge = 72;
    const dy = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > innerHeight - edge ? (drag.y - innerHeight + edge) / 4 : 0;
    if (dy) { scrollBy(0, dy); place(); }
    raf = requestAnimationFrame(tick);
  };
  container.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      drag.on = true;
      drag.el.classList.add('dragging');
      container.classList.add('sorting');
      raf = requestAnimationFrame(tick);
    }
    const list = items();
    for (const other of list) {
      if (other === drag.el) continue;
      const r = other.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        const before = list.indexOf(other) < list.indexOf(drag.el);
        if (before) other.before(drag.el); else other.after(drag.el);
        break;
      }
    }
    place();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cancelAnimationFrame(raf);
    const { el, on } = drag;
    drag = null;
    el.style.transform = '';
    el.classList.remove('dragging');
    container.classList.remove('sorting');
    if (on) { const list = items(); announce(label(list.indexOf(el) + 1, list.length)); finish(); }
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ options
function field(spec, o, set) {
  const id = 'opt-' + spec.id;
  const hint = spec.hint ? h('p', { class: 'opt-hint', id: id + '-hint' }) : null;
  const label = (forId) => h('label', { class: 'opt-label', for: forId, id: id + '-label' }, spec.label);
  let control;
  const choices = typeof spec.choices === 'function' ? spec.choices(o) : spec.choices;
  if (spec.type === 'seg' || spec.type === 'chips') {
    const group = h('div', { class: spec.type === 'seg' ? 'segctl static opt-seg' : 'chips opt-chips', role: 'group', 'aria-labelledby': id + '-label' });
    for (const c of choices) {
      group.append(h('button', { type: 'button', class: spec.type === 'chips' ? 'chip' : '', 'aria-pressed': String(o[spec.id] === c.value), 'data-v': String(c.value), title: c.hint || null, onclick: () => set(spec.id, c.value) }, c.label));
    }
    control = h('div', { class: 'opt-field' }, h('span', { class: 'opt-label', id: id + '-label' }, spec.label), group);
  } else if (spec.type === 'select') {
    const sel = h('select', { id, onchange: (e) => set(spec.id, coerce(choices, e.target.value)) }, choices.map((c) => h('option', { value: String(c.value), selected: o[spec.id] === c.value }, c.label)));
    control = h('div', { class: 'opt-field' }, label(id), h('div', { class: 'select' }, sel, ic('chevron-down')));
  } else if (spec.type === 'number') {
    const inp = h('input', { id, type: 'number', inputmode: spec.step && spec.step < 1 ? 'decimal' : 'numeric', min: spec.min, max: spec.max, step: spec.step || 1, value: o[spec.id] ?? '', placeholder: spec.placeholder || '', 'aria-describedby': hint ? id + '-hint' : null,
      oninput: (e) => set(spec.id, e.target.value === '' ? null : Number(e.target.value), true) });
    control = h('div', { class: 'opt-field' }, label(id), h('div', { class: 'num' }, inp, spec.unit ? h('span', { class: 'unit', 'aria-hidden': 'true' }, spec.unit) : null));
  } else if (spec.type === 'text') {
    const inp = h('input', { id, type: 'text', value: o[spec.id] ?? '', maxlength: spec.max || 200, placeholder: spec.placeholder || '', autocomplete: 'off', enterkeyhint: 'done', spellcheck: false, 'aria-describedby': hint ? id + '-hint' : null,
      oninput: (e) => set(spec.id, e.target.value, true) });
    control = h('div', { class: 'opt-field' }, label(id), inp);
  } else if (spec.type === 'toggle') {
    const inp = h('input', { id, type: 'checkbox', role: 'switch', checked: !!o[spec.id], onchange: (e) => set(spec.id, e.target.checked) });
    control = h('div', { class: 'opt-field opt-toggle' }, h('label', { class: 'switch', for: id }, inp, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', { class: 'opt-label' }, spec.label)));
  } else if (spec.type === 'range') {
    const out = h('output', { for: id }, fmtRange(spec, o[spec.id]));
    const inp = h('input', { id, type: 'range', min: spec.min, max: spec.max, step: spec.step || 1, value: o[spec.id],
      oninput: (e) => { out.textContent = fmtRange(spec, Number(e.target.value)); set(spec.id, Number(e.target.value), true); } });
    control = h('div', { class: 'opt-field' }, h('div', { class: 'opt-row' }, label(id), out), inp);
  } else if (spec.type === 'color') {
    const group = h('div', { class: 'swatches', role: 'group', 'aria-labelledby': id + '-label' }, choices.map((c) => h('button', { type: 'button', class: 'swatch', style: `--c:${c.value}`, 'aria-pressed': String(o[spec.id] === c.value), 'aria-label': c.label, title: c.label, onclick: () => set(spec.id, c.value) })));
    control = h('div', { class: 'opt-field' }, h('span', { class: 'opt-label', id: id + '-label' }, spec.label), group);
  } else if (spec.type === 'preset') {
    // Preset chips plus a box for any other number; both edit the same value.
    const inp = h('input', { id, type: 'number', inputmode: 'numeric', min: spec.min, max: spec.max, step: spec.step || 1, value: o[spec.id] ?? '', placeholder: spec.placeholder || '', 'aria-label': spec.boxLabel || spec.label,
      oninput: (e) => { const v = e.target.value === '' ? null : Number(e.target.value); for (const b of group.children) b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); set(spec.id, v, true); } });
    const group = h('div', { class: 'chips opt-chips', role: 'group', 'aria-labelledby': id + '-label' }, choices.map((c) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(o[spec.id] === c.value), 'data-v': String(c.value), title: c.hint || null, onclick: () => set(spec.id, c.value) }, c.label)));
    control = h('div', { class: 'opt-field' }, h('span', { class: 'opt-label', id: id + '-label' }, spec.label), group, h('div', { class: 'num' }, inp, spec.unit ? h('span', { class: 'unit', 'aria-hidden': 'true' }, spec.unit) : null));
  } else if (spec.type === 'custom') {
    control = spec.render(o, set);
  }
  if (hint) control.append(hint);
  control.dataset.opt = spec.id;
  return control;
}
const coerce = (choices, v) => { const c = choices.find((x) => String(x.value) === v); return c ? c.value : v; };
const fmtRange = (spec, v) => (spec.format ? spec.format(v) : `${v}${spec.unit || ''}`);

// ------------------------------------------------------------------ the tool
/**
 * def: {
 *   kinds: format ids or categories the tool takes; multiple; min (files needed); max; order (files can be reordered),
 *   pick: 'Choose pictures', drop: 'JPEG, PNG, HEIC…' (what it takes, in words),
 *   options: [spec], defaults,
 *   anySize(f): true when the tool doesn't decode this picture, so the pixel limit doesn't apply,
 *   inspect(f): fills f.meta (pages, size…) after a file is added; may set f.thumb,
 *   check(files, o): a reason it can't run yet (shown by the button), or '',
 *   action(files, o): the button's words,
 *   mode: 'each' (one job per file) | 'all' (one job for every file),
 *   run(f | files, o, job): → {outputs: [{name, bytes | blob, w?, h?}], note?, warn?} or {skipped: 'reason'},
 *   stage(app): a custom panel (preview, crop, pages) shown above the options,
 *   zipName(files, o): the name of “Download all”,
 *   againLabel: the words of the button that goes back after a run, for a tool without options (“Back to the files”),
 *   compare: show a before/after for the first picture result,
 * }
 */
export function tool(def) {
  const root = document.getElementById('tool');
  if (!root) return;
  document.documentElement.classList.add('tool-js');
  const defaults = Object.fromEntries((def.options || []).map((s) => [s.id, s.value]));
  const app = {
    def, files: [], o: { ...defaults, ...(def.defaults || {}) }, phase: 'pick', results: [], ctl: null,
    refresh, update: () => { renderOptions(); renderAction(); if (def.onOptions) def.onOptions(app); },
    remove, set, inspect: (f) => inspect(f), renderFile: (f) => renderFile(f), refocus: () => lostFocus(),
  };
  const els = {
    drop: root.querySelector('.drop'), input: root.querySelector('#pick'), work: root.querySelector('.workspace'),
    list: root.querySelector('.file-list'), stage: root.querySelector('.stage'), opts: root.querySelector('.opts'),
    act: root.querySelector('.actbar'), results: root.querySelector('.results'), add: root.querySelector('.add-more'),
  };
  els.input.multiple = !!def.multiple;
  if (def.accept) els.input.accept = def.accept;
  root.querySelector('.pick-label').textContent = def.pick || (def.multiple ? 'Choose files' : 'Choose a file');
  root.querySelector('.drop-what').textContent = def.drop || '';
  els.add.querySelector('span').textContent = def.addLabel || 'Add more';

  // ---------------------------------------------------------------- choosing and dropping
  const choose = () => { els.input.value = ''; els.input.click(); };
  els.drop.addEventListener('click', (e) => { if (!e.target.closest('a')) choose(); });
  els.add.addEventListener('click', choose);
  els.input.addEventListener('change', () => { if (els.input.files.length) add([...els.input.files]); });
  let depth = 0;
  const dragged = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => { if (!dragged(e) || app.phase === 'running') return; depth++; root.classList.add('dropping'); });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) root.classList.remove('dropping'); });
  addEventListener('dragover', (e) => { if (dragged(e)) { e.preventDefault(); e.dataTransfer.dropEffect = app.phase === 'running' ? 'none' : 'copy'; } });
  addEventListener('drop', (e) => {
    if (!dragged(e)) return;
    e.preventDefault(); depth = 0; root.classList.remove('dropping');
    if (app.phase !== 'running' && e.dataTransfer.files.length) add([...e.dataTransfer.files]);
  });
  // Paste a screenshot or a copied file (computers).
  addEventListener('paste', (e) => {
    if (app.phase === 'running' || e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); add(files); }
  });

  async function add(list) {
    if (app.phase === 'done') clearResults();
    if (!def.multiple) { for (const f of app.files) dropThumb(f); app.files = []; list = list.slice(0, 1); }
    const max = def.max || 200;
    const room = max - app.files.length;
    if (list.length > room) announce(`Only ${max} files at a time: ${list.length - room} left out.`);
    const added = [];
    for (const file of list.slice(0, Math.max(0, room))) {
      const f = { id: 'f' + ++seq, file, name: file.name || 'pasted file', size: file.size, status: '', error: '', note: '', meta: {}, thumb: null };
      Object.assign(f, await describe(file));
      if (!f.name.includes('.') && f.format) f.name += '.' + F.formatInfo(f.format).ext; // a pasted screenshot
      const ok = (def.kinds || []).some((k) => k === f.format || k === f.category || (k === 'text' && ['txt'].includes(f.format)));
      if (!ok) f.error = def.wrongKind ? def.wrongKind(f) : `${f.name} isn’t a file this tool takes.`;
      else {
        const limit = f.category === 'image' ? MAX_BYTES.image : ['txt', 'csv', 'json'].includes(f.format) ? MAX_BYTES.text : MAX_BYTES.document;
        if (f.size > limit) f.error = `This file is ${fmtBytes(f.size)}. The limit is ${fmtBytes(limit)}.`;
        else if (f.size === 0) f.error = 'This file is empty.';
        else if (phoneSized() && f.size > 200 * MB) f.note = 'Large file: on a phone this may be slow, or need more memory than the browser allows.';
      }
      app.files.push(f); added.push(f);
    }
    app.phase = app.files.length ? 'ready' : 'pick';
    refresh();
    announce(`${plural(added.length, 'file')} added. ${plural(app.files.filter((f) => !f.error).length, 'file')} ready.`);
    // The Choose button is gone once files are in: keep keyboard and screen-reader users in the list (after the
    // files start loading, which redraws the main button).
    const lost = !document.activeElement || document.activeElement === document.body || document.activeElement === els.input || els.drop.contains(document.activeElement);
    for (const f of added) if (!f.error) inspect(f);
    if (lost) lostFocus();
  }

  async function inspect(f) {
    f.meta.loading = true;
    renderFile(f); renderAction();
    try {
      if (f.category === 'image' && !f.meta.w) {
        const head = new Uint8Array(await f.file.slice(0, 512 * 1024).arrayBuffer());
        const kind = pictureKind(head);
        const size = kind && kind !== 'svg' && headerSize(head, kind);
        if (size) { const turned = kind === 'jpg' && jpegOrientation(head) >= 5; f.meta.w = turned ? size.height : size.width; f.meta.h = turned ? size.width : size.height; }
        // Too many pixels: say so now (the app's words, src/processor/image.js checkSize) instead of after a run.
        if (size && !(def.anySize && def.anySize(f)) && (size.width * size.height > LIMITS.mp * 1e6 || Math.max(size.width, size.height) > LIMITS.side)) {
          throw new UserError(`This image is too large (${size.width} × ${size.height} pixels). The limit is ${LIMITS.mp} megapixels.`);
        }
      }
      if (!f.thumb && f.category === 'image') {
        if (NATIVE.has(f.format)) f.thumb = urlFor(f.file);
        else {
          const r = await engine.run('image.preview', { bytes: await bytesOf(f), maxSide: 900, limits: LIMITS });
          f.thumb = urlFor(new Blob([r.bytes], { type: r.mime }));
          f.meta.w = r.width; f.meta.h = r.height;
        }
      }
      if (def.inspect) await def.inspect(f, app);
    } catch (e) {
      if (!(e instanceof Cancelled)) f.error = errorText(e);
    }
    f.meta.loading = false;
    if (app.files.includes(f)) { renderFile(f); renderStage(); renderAction(); if (def.onFiles) def.onFiles(app); }
  }

  function remove(f) {
    dropThumb(f);
    const at = app.files.indexOf(f);
    app.files = app.files.filter((x) => x !== f);
    if (!app.files.length) app.phase = 'pick';
    refresh();
    announce(`${f.name} removed.`);
    // Focus stays where it was: the Remove button of the file that took its place (or the one before it).
    const rows = els.list.querySelectorAll('.file');
    const row = rows[Math.min(at, rows.length - 1)];
    ((row && row.querySelector('.file-x')) || els.drop.querySelector('.btn')).focus();
  }
  /** The focused control went away (files added, Cancel): move focus to the main button, or the file list. */
  function lostFocus() {
    const go = els.act.querySelector('.go:not(:disabled)');
    if (go) { go.focus({ preventScroll: true }); return; }
    if (!els.list.hidden) { els.list.tabIndex = -1; els.list.focus({ preventScroll: true }); }
  }
  const dropThumb = (f) => { if (f.thumb) { URL.revokeObjectURL(f.thumb); objectURLs.delete(f.thumb); } };

  function set(id, v, typing = false) {
    app.o[id] = v;
    if (def.onSet) def.onSet(app, id, v);
    if (typing) { renderAction(); syncVisibility(); if (def.onOptions) def.onOptions(app); }
    else app.update();
  }

  // ---------------------------------------------------------------- rendering
  function refresh() {
    root.dataset.phase = app.phase;
    document.body.dataset.phase = app.phase;
    els.drop.hidden = app.phase !== 'pick';
    els.work.hidden = app.phase === 'pick';
    els.add.hidden = !def.multiple || app.phase === 'running' || app.files.length >= (def.max || 200);
    els.list.hidden = def.hideList && !app.files.some((f) => f.error);
    renderList();
    renderStage();
    renderOptions();
    renderAction();
    if (def.onFiles) def.onFiles(app);
  }

  function renderStage() {
    if (def.stage && app.phase !== 'pick') def.stage(app, els.stage); else fill(els.stage);
    els.stage.hidden = !els.stage.childElementCount;
  }
  function renderList() {
    const many = def.order && app.files.length > 1 && app.phase !== 'running';
    els.list.classList.toggle('ordered', many);
    fill(els.list, ...app.files.map((f) => fileRow(f, many)));
  }
  function renderFile(f) {
    const old = els.list.querySelector(`[data-key="${f.id}"]`);
    if (old) old.replaceWith(fileRow(f, def.order && app.files.length > 1 && app.phase !== 'running'));
  }
  function fileRow(f, sortable) {
    const meta = [fmtBytes(f.size), f.label];
    if (f.meta.w) meta.push(`${f.meta.w} × ${f.meta.h}`);
    if (f.meta.pages) meta.push(plural(f.meta.pages, 'page'));
    if (def.metaLine) meta.push(...def.metaLine(f).filter(Boolean));
    const thumb = f.thumb ? h('img', { src: f.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : ic(f.category === 'image' ? 'image' : f.format === 'pdf' ? 'file-text' : ['csv', 'xlsx', 'xls', 'json'].includes(f.format) ? 'table' : 'file');
    const status = f.error ? h('p', { class: 'f-err', role: 'alert' }, ic('circle-alert'), h('span', null, f.error))
      : f.status === 'working' ? h('div', { class: 'f-prog' }, h('div', { class: 'bar' + (f.progress == null ? ' busy' : '') }, h('i', { style: f.progress != null ? `transform:scaleX(${f.progress})` : null })), h('span', { class: 'sr-only' }, 'Working on it'))
      : f.status === 'done' ? h('p', { class: 'f-ok' }, ic('circle-check'), h('span', null, f.done || 'Done'))
      : f.status === 'skipped' ? h('p', { class: 'f-note' }, ic('info'), h('span', null, f.done))
      : f.note ? h('p', { class: 'f-note' }, ic('triangle-alert'), h('span', null, f.note)) : null;
    const extra = def.fileExtra ? def.fileExtra(f, app) : null;
    const row = h('li', { class: 'file' + (f.error ? ' bad' : '') + (f.status ? ' ' + f.status : ''), 'data-key': f.id },
      sortable ? h('button', { type: 'button', class: 'grip', 'aria-label': `Move ${f.name}. Drag, or use the arrow keys.`, title: 'Drag to reorder' }, ic('grip-vertical')) : null,
      h('div', { class: 'f-thumb' + (f.category === 'image' ? '' : ' doc') + (f.meta.loading ? ' loading' : '') }, thumb),
      h('div', { class: 'f-main' }, h('p', { class: 'f-name' }, f.name), h('p', { class: 'f-meta' }, meta.join(' · ')), status, extra),
      app.phase !== 'running' ? h('button', { type: 'button', class: 'file-x', 'aria-label': `Remove ${f.name}`, title: 'Remove', onclick: () => remove(f) }, ic('x')) : null);
    return row;
  }
  if (def.order) sortable(els.list, { item: '.file', onDone: (keys) => { app.files.sort((a, b) => keys.indexOf(a.id) - keys.indexOf(b.id)); renderAction(); if (def.onFiles) def.onFiles(app); } });

  function renderOptions() {
    const specs = (def.options || []).filter((s) => !s.when || s.when(app.o, app));
    const main = specs.filter((s) => !s.more), more = specs.filter((s) => s.more);
    const wasOpen = els.opts.querySelector('details.more')?.open;
    const focusId = document.activeElement && els.opts.contains(document.activeElement) ? document.activeElement.id || document.activeElement.closest('[data-opt]')?.dataset.opt + ':' + document.activeElement.dataset.v : null;
    const kids = main.map((s) => field(s, app.o, set));
    if (more.length) kids.push(h('details', { class: 'more', open: !!wasOpen || !!def.moreOpen }, h('summary', null, def.moreLabel || 'More options', ic('chevron-down')), h('div', { class: 'more-body' }, more.map((s) => field(s, app.o, set)))));
    fill(els.opts, ...kids);
    els.opts.hidden = !kids.length;
    syncVisibility();
    if (focusId) {
      const [opt, v] = focusId.split(':');
      const el = document.getElementById(focusId) || els.opts.querySelector(`[data-opt="${opt}"] [data-v="${CSS.escape(v || '')}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }
  function syncVisibility() {
    for (const s of def.options || []) {
      const el = els.opts.querySelector(`[data-opt="${s.id}"]`);
      if (!el) continue;
      const hint = el.querySelector('.opt-hint');
      if (hint && s.hint) hint.textContent = typeof s.hint === 'function' ? s.hint(app.o, app) || '' : s.hint;
      if (hint) hint.hidden = !hint.textContent;
    }
  }

  function renderAction() {
    const good = app.files.filter((f) => !f.error);
    const busy = app.files.some((f) => f.meta.loading);
    const why = !good.length ? '' : def.check ? def.check(good, app.o, app) : '';
    const need = def.min && good.length < def.min ? def.minText || `Add at least ${def.min} files.` : '';
    const reason = need || why;
    if (app.phase === 'running') {
      fill(els.act, 
        h('div', { class: 'act-prog' }, h('p', { class: 'act-status', 'aria-live': 'polite' }, app.statusText || 'Working…'), h('div', { class: 'bar' + (app.overall == null ? ' busy' : '') }, h('i', { style: app.overall != null ? `transform:scaleX(${app.overall})` : null }))),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: cancel }, 'Cancel'));
      return;
    }
    const label = def.action ? def.action(good, app.o, app) : 'Start';
    fill(els.act, 
      h('button', { type: 'button', class: 'btn btn-primary go', disabled: !good.length || !!reason || busy, onclick: go }, label),
      reason || busy ? h('p', { class: 'act-why', 'aria-live': 'polite' }, busy ? 'Reading your files…' : reason) : null);
  }

  // ---------------------------------------------------------------- running
  let taken = new Set();
  /** A result's name, never the same as another result of this run: "photo edited.jpg", "photo edited 2.jpg". */
  function nameFor(stem, ext, suffix = '') {
    for (let n = 1; ; n++) {
      const name = F.candidateName(stem, ext, n, suffix);
      if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
    }
  }

  async function go() {
    const files = app.files.filter((f) => !f.error);
    if (!files.length) return;
    app.phase = 'running';
    app.results = [];
    taken = new Set();
    app.ctl = new AbortController();
    const signal = app.ctl.signal;
    for (const f of app.files) { f.status = f.error ? '' : 'waiting'; f.progress = null; f.done = ''; }
    // Results that would share a name are told apart by their format, as the app does (QA round 8).
    const stems = F.batchStems(files.map((f) => ({ stem: F.baseName(f.name), dir: '', label: f.label, ext: (f.name.split('.').pop() || '').toLowerCase() })));
    files.forEach((f, i) => { f.stem = def.mode === 'all' ? F.baseName(f.name) : stems[i]; });
    app.overall = 0;
    refresh();
    root.querySelector('.tool-side').scrollIntoView({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
    const job = (f, i, n) => ({
      engine, signal, o: app.o, app, name: nameFor, bytes: () => bytesOf(f),
      progress: (p) => { if (f) { f.progress = p; renderFile(f); } app.overall = (i + (p || 0)) / n; renderAction(); },
      status: (t) => { app.statusText = t; renderAction(); },
    });
    const collect = (src, r) => {
      if (!r) return;
      const outs = (r.outputs || []).map((x) => {
        const blob = x.blob || new Blob([x.bytes], { type: x.type || mimeOf(x.name) });
        return { name: x.name, blob, size: blob.size, w: x.w, h: x.h, note: x.note || '' };
      });
      app.results.push({ src, outputs: outs, note: r.note || '', warn: !!r.warn, skipped: r.skipped || '', title: r.title || '', extra: r.extra || null, codes: r.codes || 0, before: r.before !== undefined ? r.before : src && !Array.isArray(src) ? src.size : null });
    };
    try {
      if (def.mode === 'all') {
        app.statusText = def.working ? def.working(files, app.o) : 'Working…';
        files.forEach((f) => { f.status = 'working'; });
        renderList(); renderAction();
        try {
          collect(files, await def.run(files, app.o, job(null, 0, 1)));
          files.forEach((f) => { f.status = 'done'; f.done = 'Included'; });
        } catch (e) {
          if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
          const msg = errorText(e);
          const who = e.fileId ? files.find((f) => f.id === e.fileId) : null;
          files.forEach((f) => { f.status = ''; });
          if (who) who.error = msg; else app.error = msg;
        }
      } else {
        for (const [i, f] of files.entries()) {
          if (signal.aborted) throw new Cancelled();
          app.statusText = files.length > 1 ? `${def.verb || 'Working on'} ${i + 1} of ${files.length}: ${f.name}` : `${def.verb || 'Working on'} ${f.name}`;
          f.status = 'working'; f.progress = null; renderFile(f); app.overall = i / files.length; renderAction();
          try {
            const r = await def.run(f, app.o, job(f, i, files.length));
            collect(f, r);
            if (r && r.skipped) { f.status = 'skipped'; f.done = r.skipped; } else { f.status = 'done'; f.done = r && r.short ? r.short : 'Done'; }
          } catch (e) {
            if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
            f.status = ''; f.error = errorText(e);
          }
          renderFile(f);
        }
      }
      app.phase = 'done';
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      for (const f of app.files) if (f.status === 'working' || f.status === 'waiting') f.status = '';
      app.phase = 'ready';
      app.results = [];
      refresh();
      announce('Cancelled. Nothing was saved.');
      lostFocus();
      return;
    }
    app.ctl = null;
    renderResults();
  }
  function cancel() { if (app.ctl) { app.ctl.abort(); engine.stop(); } }

  // ---------------------------------------------------------------- results
  function clearResults() {
    for (const r of app.results) for (const o of r.outputs) if (o.url) { URL.revokeObjectURL(o.url); objectURLs.delete(o.url); }
    app.results = []; app.error = '';
    els.results.hidden = true; fill(els.results, );
    for (const f of app.files) { f.status = ''; f.done = ''; }
  }
  function startOver() {
    clearResults();
    for (const f of app.files) dropThumb(f);
    app.files = []; app.phase = 'pick';
    dropURLs();
    if (def.reset) def.reset(app);
    refresh();
    scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
    els.drop.querySelector('.btn').focus();
  }
  function again() {
    clearResults();
    app.phase = 'ready';
    refresh();
    root.querySelector('.tool-side').scrollIntoView({ block: 'nearest' });
    const first = els.opts.querySelector('button, input, select, summary');
    if (first) first.focus({ preventScroll: true }); else lostFocus();
  }

  function renderResults() {
    const outs = app.results.flatMap((r) => r.outputs);
    const failed = app.files.filter((f) => f.error).length + (app.error ? 1 : 0);
    const skipped = app.results.filter((r) => r.skipped).length;
    const head = outs.length
      ? (def.doneTitle ? def.doneTitle(outs, app) : outs.length === 1 ? 'Your file is ready' : `${outs.length} files are ready`)
      : def.noOutput ? def.noOutput(app) : skipped ? 'Nothing needed saving' : 'That didn’t work';
    const sub = [failed ? `${plural(failed, 'file')} couldn’t be done.` : '', skipped && !def.noOutput ? `${plural(skipped, 'file')} left as ${skipped === 1 ? 'it was' : 'they were'}.` : '', app.error || ''].filter(Boolean).join(' ');
    const zipName = def.zipName ? def.zipName(app) : 'DropDial files.zip';
    const allBtn = outs.length > 1 ? h('button', { type: 'button', class: 'btn btn-primary', onclick: (e) => zipAll(e.currentTarget, outs, zipName) }, ic('download'), 'Download all (ZIP)') : null;
    const shareAll = outs.length > 1 && canShare(outs) ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => share(outs) }, ic('share'), 'Share') : null;
    const rows = [];
    for (const r of app.results) {
      for (const [k, o] of r.outputs.entries()) rows.push(resultRow(r, o, k, outs.length === 1));
      if (r.skipped) rows.push(h('li', { class: 'res skipped' }, h('div', { class: 'r-thumb' }, ic('info')), h('div', { class: 'r-main' }, h('p', { class: 'r-name' }, r.src.name), h('p', { class: 'r-note' }, r.skipped))));
      if (r.extra) rows.push(h('li', { class: 'res extra' }, r.extra));
    }
    for (const f of app.files.filter((x) => x.error)) rows.push(h('li', { class: 'res failed' }, h('div', { class: 'r-thumb' }, ic('circle-alert')), h('div', { class: 'r-main' }, h('p', { class: 'r-name' }, f.name), h('p', { class: 'f-err' }, f.error))));
    const cmp = def.compare && app.results.find((r) => r.outputs.length === 1 && r.src && r.src.thumb && /^image\//.test(r.outputs[0].blob.type) && r.outputs[0].blob.type !== 'image/tiff' && r.outputs[0].blob.type !== 'image/x-icon');
    fill(els.results, 
      h('div', { class: 'res-head' },
        h('div', null, h('h2', { tabindex: '-1', id: 'res-title' }, outs.length ? ic('circle-check', 'ok') : null, head), sub ? h('p', { class: 'fine' }, sub) : null),
        h('div', { class: 'res-btns' }, allBtn, shareAll)),
      cmp ? compareView(cmp) : null,
      rows.length ? h('ul', { class: 'res-list' }, rows) : null,
      h('div', { class: 'res-foot' },
        (def.options || []).length ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: again }, ic('sliders-horizontal'), 'Change options')
          : h('button', { type: 'button', class: 'btn btn-quiet', onclick: again }, ic('chevron-left'), def.againLabel || 'Back to the files'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: startOver }, ic('refresh-cw'), 'Start over'),
        h('p', { class: 'fine' }, 'Made on this device. Downloads go to your browser’s downloads folder.')));
    els.results.hidden = false;
    refresh();
    els.results.hidden = false;
    els.results.scrollIntoView({ block: 'start', behavior: reduced.matches ? 'auto' : 'smooth' });
    els.results.querySelector('#res-title').focus({ preventScroll: true });
    announce(head);
  }

  function resultRow(r, o, k, only) {
    o.url = o.url || urlFor(o.blob);
    const isPic = /^image\/(jpeg|png|webp|gif|bmp|avif|svg)/.test(o.blob.type);
    const before = k === 0 && r.outputs.length === 1 && r.before ? `${fmtBytes(r.before)} → ${fmtBytes(o.size)}` : fmtBytes(o.size);
    const pct = k === 0 && r.outputs.length === 1 && r.before && o.size < r.before && def.showSaving !== false ? ` (−${Math.round((1 - o.size / r.before) * 100)}%)` : '';
    const notes = [o.w ? `${o.w} × ${o.h} px` : '', k === 0 ? r.note : '', o.note].filter(Boolean).join(' · ');
    return h('li', { class: 'res' + (r.warn && k === 0 ? ' warn' : '') },
      h('div', { class: 'r-thumb' }, isPic ? h('img', { src: o.url, alt: '', loading: 'lazy', decoding: 'async' }) : ic(o.name.endsWith('.pdf') ? 'file-text' : /\.(csv|xlsx|json)$/.test(o.name) ? 'table' : /\.zip$/.test(o.name) ? 'file-archive' : 'file')),
      h('div', { class: 'r-main' },
        h('p', { class: 'r-name' }, o.name),
        h('p', { class: 'r-size' }, before + pct),
        notes ? h('p', { class: 'r-note' + (r.warn && k === 0 ? ' warn' : '') }, r.warn && k === 0 ? ic('triangle-alert') : null, notes) : null),
      h('div', { class: 'r-btns' },
        h('a', { class: 'btn ' + (only ? 'btn-primary' : 'btn-quiet') + ' btn-sm dl', href: o.url, download: o.name, 'aria-label': `Download ${o.name}` }, ic('download'), h('span', { class: 'dl-word' }, 'Download')),
        canShare([o]) ? h('button', { type: 'button', class: 'btn btn-quiet btn-sm icon-only', 'aria-label': `Share ${o.name}`, title: 'Share', onclick: () => share([o]) }, ic('share')) : null));
  }

  async function zipAll(btn, outs, name) {
    btn.disabled = true;
    const was = btn.lastChild.textContent;
    btn.lastChild.textContent = 'Making the ZIP…';
    try {
      const files = [];
      for (const o of outs) files.push({ name: o.name, bytes: new Uint8Array(await o.blob.arrayBuffer()) });
      const r = await engine.run('web.zip', { files });
      const blob = new Blob([r.bytes], { type: 'application/zip' });
      const a = h('a', { href: urlFor(blob), download: name, hidden: true });
      document.body.append(a); a.click(); a.remove();
      announce(`${name} is downloading.`);
    } catch (e) { announce(errorText(e)); alertBox(errorText(e)); }
    btn.lastChild.textContent = was;
    btn.disabled = false;
  }
  function alertBox(text) { els.results.prepend(h('p', { class: 'f-err', role: 'alert' }, ic('circle-alert'), h('span', null, text))); }

  const asFiles = (outs) => outs.map((o) => new File([o.blob], o.name, { type: o.blob.type }));
  function canShare(outs) {
    if (!navigator.canShare || !touchy.matches) return false;
    try { return navigator.canShare({ files: asFiles(outs.slice(0, 1)) }) && outs.reduce((a, o) => a + o.size, 0) < 200 * MB; } catch { return false; }
  }
  async function share(outs) {
    try { await navigator.share({ files: asFiles(outs) }); } catch (e) { if (e && e.name !== 'AbortError') alertBox('This browser couldn’t share these files. Use Download instead.'); }
  }

  refresh();
  if (def.init) def.init(app, els);
  // Start the worker while the person is choosing files, so the first run doesn't wait for it.
  els.drop.addEventListener('pointerenter', () => engine.warm(), { once: true });
  els.input.addEventListener('change', () => engine.warm(), { once: true });
  return app;
}

/** Before / after: the result over the original, with a slider (keyboard and touch). */
export function compareView(r) {
  const o = r.outputs[0];
  const after = h('img', { src: o.url || urlFor(o.blob), alt: 'After', decoding: 'async' });
  const before = h('img', { src: r.src.thumb, alt: 'Before', decoding: 'async' });
  const wrap = h('div', { class: 'compare', style: '--at:50%' }, before, h('div', { class: 'cmp-after' }, after), h('span', { class: 'cmp-line', 'aria-hidden': 'true' }), h('span', { class: 'cmp-tag l' }, 'Before'), h('span', { class: 'cmp-tag r' }, 'After'));
  const range = h('input', { type: 'range', min: 0, max: 100, value: 50, 'aria-label': 'Compare before and after', oninput: (e) => wrap.style.setProperty('--at', e.target.value + '%') });
  wrap.append(range);
  return h('figure', { class: 'compare-fig' }, wrap, h('figcaption', { class: 'fine' }, `${r.src.name} → ${o.name}. Slide to compare.`));
}
