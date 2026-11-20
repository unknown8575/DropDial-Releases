// Edit Word text: the app's tool (src/main/tools/docxEditText.js) with the processor's own operations — docx.editScan
// (the document as a page) and docx.editSave (only the changed runs written; every other part of the file copied as
// it was). The page and in-place editing are src/shared/docx-view.mjs, the same code as the app's window; the logic
// (plans, find and replace) is src/shared/docxedit.mjs. Phones: tap a paragraph and type; a bar above the keyboard
// has Done and Cancel.
import { tool, engine, plural, h, ic, announce, bytesOf, touchy, UserError } from './ui.js';
import * as D from '../../tools/engine/shared/docxedit.mjs';
import { createDocView } from '../../tools/engine/shared/docx-view.mjs';

const st = { app: null, file: null, model: null, view: null, ui: null, edits: new Map(), adds: [], past: [], future: [], editing: null, cursor: null, hit: 0, seq: 0, note: null, zoom: 1 };
const ENTER = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Return' : 'Enter';

// ------------------------------------------------------------------ the document's state
const parOf = (key) => {
  if (!st.model) return null;
  if (key[0] !== 'n') return st.model.paras[key] || null;
  const a = st.adds.find((x) => 'n' + x.id === key);
  return a ? D.addedPar(st.model, a.after, a.id, a.text) : null;
};
const codeOf = (key) => (key[0] === 'n' ? (st.adds.find((x) => 'n' + x.id === key) || { text: '' }).text : st.edits.has(key) ? st.edits.get(key) : st.model.paras[key].code);
function setCode(key, code) {
  if (key[0] === 'n') { const a = st.adds.find((x) => 'n' + x.id === key); if (a) a.text = code; return; }
  if (code === st.model.paras[key].code) st.edits.delete(key); else st.edits.set(key, code);
}
const changes = () => (st.model ? [...st.edits].filter(([k, c]) => c !== st.model.paras[k].code).sort((a, b) => st.model.order.indexOf(a[0]) - st.model.order.indexOf(b[0])) : []);
const realAdds = () => st.adds.filter((a) => a.text.trim());
const snap = () => ({ edits: new Map(st.edits), adds: st.adds.map((a) => ({ ...a })) });
function record() { st.past.push(snap()); if (st.past.length > 100) st.past.shift(); st.future = []; }
function restore(s) { if (st.view) st.view.cancel(); st.edits = s.edits; st.adds = s.adds; refresh(); }
const undo = () => { if (st.past.length) { st.future.push(snap()); restore(st.past.pop()); announce('Undone'); } };
const redo = () => { if (st.future.length) { st.past.push(snap()); restore(st.future.pop()); announce('Redone'); } };
const byAnchor = () => { const m = new Map(); for (const a of st.adds) { if (!m.has(a.after)) m.set(a.after, []); m.get(a.after).push({ ...a }); } return m; };
const keys = () => { const out = [], m = byAnchor(); for (const k of st.model.order) { out.push(k); for (const a of m.get(k) || []) out.push('n' + a.id); } return out; };

// ------------------------------------------------------------------ the page
function stage(app, el) {
  st.app = app;
  const f = app.files.find((x) => !x.error && x.meta.model);
  if (!f) { st.ui = null; el.replaceChildren(); return; }
  if (st.ui && st.file === f) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  if (st.view) st.view.destroy();
  Object.assign(st, { file: f, model: f.meta.model, edits: new Map(), adds: [], past: [], future: [], editing: null, cursor: null, hit: 0, note: null, zoom: 1 });
  const add = h('button', { type: 'button', class: 'btn btn-quiet btn-sm we-add', onclick: () => addAfter() }, ic('list-plus'), 'Add paragraph after');
  const zout = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Smaller', onclick: () => zoom(st.zoom / 1.2) }, ic('zoom-out'));
  const zin = h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Bigger', onclick: () => zoom(st.zoom * 1.2) }, ic('zoom-in'));
  const view = h('div', { class: 'we-view', 'aria-label': `Document: ${f.name}` });
  const status = h('p', { class: 'pe-status we-status', role: 'status' });
  const panel = h('div', { class: 'panel pe-panel we-panel' },
    h('div', { class: 'panel-bar' }, add, h('div', { class: 'tbtns' }, zout, zin)),
    h('div', { class: 'pe-frame' }, view),
    status);
  st.ui = { panel, view, status, add, zin, zout, bar: null };
  el.replaceChildren(panel);
  st.view = createDocView(view, {
    labels: { enter: ENTER },
    onCommit: (key, code) => {
      const par = parOf(key);
      if (!par) return '';
      if (key[0] !== 'n') { const plan = D.planEdit(par, code); if (!plan.ok) return plan.error; }
      if (code === codeOf(key)) return '';
      record();
      setCode(key, code);
      st.note = null;
      announce('Changed');
      setTimeout(refresh, 0);
      return '';
    },
    onEditing: (key) => { st.editing = key; if (key) st.note = null; else dropEmpty(); editBar(); paint(); },
    onInput: (key, code) => { const par = parOf(key); const plan = par && key[0] !== 'n' ? D.planEdit(par, code) : { ok: true }; st.note = plan.ok ? null : { kind: 'error', text: plan.error }; paint(); },
    onLocked: (_k, why) => { st.note = { kind: 'lock', text: why }; paint(); },
    onError: (text) => { st.note = { kind: 'error', text }; paint(); },
    onCursor: (key) => { st.cursor = key; paint(); },
  });
  st.view.setModel(st.model);
  refresh();
}
function zoom(z) { st.zoom = Math.max(0.6, Math.min(2.5, z)); st.view.setZoom(st.zoom); paint(); }
/** Status line, buttons and the side panel. */
function paint() {
  const ui = st.ui;
  if (!ui) return;
  const tap = touchy.matches ? 'Tap' : 'Click';
  ui.status.textContent = st.note ? st.note.text : st.editing ? (touchy.matches ? 'Type the new text, then tap Done.' : `${ENTER} keeps it · Shift+${ENTER} new line · Esc cancels · Tab next paragraph`) : `${tap} a paragraph to change it. Grey parts (fields, pictures) stay as they are.`;
  ui.status.classList.toggle('scan', !!st.note);
  ui.status.classList.toggle('err', !!(st.note && st.note.kind === 'error'));
  const par = st.cursor && parOf(st.cursor);
  ui.add.disabled = !(par && (st.cursor[0] === 'n' || par.canAdd));
  ui.zin.disabled = st.zoom >= 2.5; ui.zout.disabled = st.zoom <= 0.6;
  if (ui.bar) { const m = ui.bar.querySelector('.pe-msg'); m.textContent = st.note ? st.note.text : ''; m.hidden = !st.note; }
}
/** The view follows the edits, added paragraphs and find matches. */
function refresh() {
  if (!st.view || !st.model) return;
  const ms = findMatches();
  st.hit = Math.min(st.hit, Math.max(0, ms.length - 1));
  const hits = new Map();
  ms.slice(0, 2000).forEach((m, i) => { if (!hits.has(m.key)) hits.set(m.key, []); hits.get(m.key).push({ start: m.start, end: m.end, active: i === st.hit }); });
  st.view.update({ codes: new Map(st.edits), adds: byAnchor(), hits });
  paint();
  if (findBox) renderFind();
  if (changeBox) renderChanges();
  st.app.update();
}
function dropEmpty() {
  const empty = st.adds.filter((a) => !a.text.trim() && !(st.view.editing && st.view.editing.key === 'n' + a.id) && a.id !== st.pending);
  if (empty.length) { st.adds = st.adds.filter((a) => !empty.includes(a)); setTimeout(refresh, 0); }
}
function addAfter() {
  const c = st.cursor;
  const par = c && parOf(c);
  if (!par || !(c[0] === 'n' || par.canAdd)) return;
  if (st.view.editing && !st.view.commit()) return;
  record();
  const id = ++st.seq;
  if (c[0] === 'n') { const at = st.adds.findIndex((a) => 'n' + a.id === c); st.adds.splice(at + 1, 0, { id, after: st.adds[at].after, text: '' }); }
  else { const last = st.adds.map((a) => a.after).lastIndexOf(c); st.adds.splice(last < 0 ? st.adds.length : last + 1, 0, { id, after: c, text: '' }); }
  st.pending = id;
  refresh();
  setTimeout(() => { st.view.startEdit('n' + id); st.pending = 0; }, 0);
}
/** Phones: Done and Cancel above the keyboard while a paragraph is being typed in. */
function editBar() {
  const ui = st.ui;
  if (!ui || !touchy.matches) return;
  if (!st.editing) { if (ui.bar) { ui.bar.off(); ui.bar.remove(); ui.bar = null; } return; }
  if (ui.bar) return;
  const msg = h('p', { class: 'pe-msg', 'aria-live': 'polite', hidden: true });
  const bar = h('div', { class: 'pe-bar we-bar', role: 'toolbar', 'aria-label': 'Editing a paragraph' }, msg,
    h('div', { class: 'pe-bar-btns' },
      h('button', { type: 'button', class: 'btn btn-quiet', onpointerdown: (e) => e.preventDefault(), onclick: () => st.view.cancel() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn-primary', onpointerdown: (e) => e.preventDefault(), onclick: () => st.view.commit() }, 'Done')));
  const place = () => { const vv = window.visualViewport; if (vv) bar.style.bottom = Math.max(0, innerHeight - (vv.height + vv.offsetTop)) + 'px'; };
  bar.off = () => { if (window.visualViewport) { visualViewport.removeEventListener('resize', place); visualViewport.removeEventListener('scroll', place); } };
  if (window.visualViewport) { visualViewport.addEventListener('resize', place); visualViewport.addEventListener('scroll', place); }
  document.body.append(bar);
  place();
  ui.bar = bar;
}

// ------------------------------------------------------------------ find and replace
const findMatches = () => (st.app && st.model ? D.findAll(keys().map((k) => ({ key: k, par: parOf(k), code: codeOf(k) })), st.app.o.find, { matchCase: st.app.o.matchCase, wholeWord: st.app.o.whole }) : []);
function replace(list) {
  const use = list.filter((m) => m && m.ok);
  if (!use.length) return;
  st.view.cancel();
  record();
  const by = new Map();
  for (const m of use) { if (!by.has(m.key)) by.set(m.key, []); by.get(m.key).push(m); }
  let n = 0;
  for (const [key, ms] of by) {
    const par = parOf(key);
    const next = D.replaceInCode(par, codeOf(key), ms, D.cleanCode(st.app.o.repl || '').replace(/\n/g, ' '));
    if (key[0] !== 'n' && !D.planEdit(par, next).ok) continue;
    setCode(key, next);
    n += ms.length;
  }
  announce(`${plural(n, 'match', 'matches')} replaced`);
  st.hit = 0;
  refresh();
}
let findBox = null, changeBox = null;
function renderFind() {
  findBox ||= h('div', { class: 'opt-field pe-findinfo' });
  if (!st.app || !st.model) return findBox;
  const o = st.app.o;
  const ms = findMatches();
  const ok = ms.filter((m) => m.ok);
  st.hit = Math.min(st.hit, Math.max(0, ms.length - 1));
  const cur = ms[st.hit];
  const goTo = (i) => { st.hit = (i + ms.length) % ms.length; refresh(); st.view.scrollTo(ms[st.hit].key); };
  findBox.replaceChildren(
    h('p', { class: 'fine pe-count', 'aria-live': 'polite' }, !o.find || !o.find.trim() ? 'Searches the text, headers, footers, notes and text boxes.' : ms.length ? `${st.hit + 1} of ${plural(ms.length, 'match', 'matches')}${ok.length < ms.length ? ` · ${ms.length - ok.length} can’t be replaced` : ''}` : 'No matches'),
    cur && !cur.ok ? h('p', { class: 'f-note' }, ic('lock'), h('span', null, cur.why)) : '',
    h('div', { class: 'pe-row' },
      h('button', { type: 'button', class: 'btn btn-quiet btn-sm', disabled: !cur || !cur.ok, onclick: () => replace([cur]) }, 'Replace'),
      h('button', { type: 'button', class: 'btn btn-quiet btn-sm', disabled: !ok.length, onclick: () => replace(ok) }, 'Replace all'),
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Previous match', disabled: !ms.length, onclick: () => goTo(st.hit - 1) }, ic('chevron-left')),
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Next match', disabled: !ms.length, onclick: () => goTo(st.hit + 1) }, ic('chevron-right'))));
  return findBox;
}
function renderChanges() {
  changeBox ||= h('div', { class: 'opt-field pe-changes' });
  if (!st.model) return changeBox;
  const list = changes(), adds = realAdds();
  const go = (key) => { st.view.scrollTo(key); st.view.focusPara(key); };
  changeBox.replaceChildren(
    h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, 'Changes'), h('div', { class: 'tbtns' },
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Undo', disabled: !st.past.length, onclick: undo }, ic('undo-2')),
      h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Redo', disabled: !st.future.length, onclick: redo }, ic('redo-2')))),
    !list.length && !adds.length ? h('p', { class: 'fine' }, 'Nothing changed yet.') : h('ul', { class: 'pe-list' },
      ...list.map(([key, code]) => {
        const par = st.model.paras[key];
        const label = D.changeText(par, par.code, code);
        return h('li', null, par.where ? h('span', { class: 'pe-pg' }, par.where) : '', h('button', { type: 'button', class: 'pe-what we-go', onclick: () => go(key) }, label),
          h('button', { type: 'button', class: 'tbtn', 'aria-label': `Put back the old text: ${label}`, onclick: () => { st.view.cancel(); record(); st.edits.delete(key); refresh(); } }, ic('x')));
      }),
      ...adds.map((a) => h('li', null, h('button', { type: 'button', class: 'pe-what we-go', onclick: () => go('n' + a.id) }, `Added “${a.text.length > 34 ? a.text.slice(0, 33) + '…' : a.text}”`),
        h('button', { type: 'button', class: 'tbtn', 'aria-label': `Remove the added paragraph “${a.text}”`, onclick: () => { st.view.cancel(); record(); st.adds = st.adds.filter((x) => x !== a); refresh(); } }, ic('x'))))),
    st.model.counts.locked ? h('p', { class: 'f-note' }, ic('lock'), h('span', null, `${st.model.counts.locked === 1 ? 'One paragraph' : plural(st.model.counts.locked, 'paragraph')} can’t be changed here (tracked changes, or made by Word, like a table of contents).`)) : '',
    st.model.info.track ? h('p', { class: 'f-note' }, ic('info'), h('span', null, 'Track Changes is on in this document. Your edits are saved as plain changes, not as tracked ones.')) : '');
  return changeBox;
}

const DOCX_ACCEPT = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
tool({
  kinds: ['docx'],
  wrongKind: (f) => { const note = D.otherFormatNote((f.name.split('.').pop() || '')); return note ? `${f.name} isn’t a .docx file. ${note}` : `${f.name} isn’t a Word document (.docx).`; },
  accept: DOCX_ACCEPT, multiple: false,
  pick: 'Choose a Word document', drop: 'One Word document (.docx). Change its words, replace them everywhere, or add a paragraph.',
  againLabel: 'Back to the document',
  async inspect(f) {
    const model = await engine.run('docx.editScan', { bytes: await bytesOf(f) });
    if (!model || !model.order || !model.order.length) throw new UserError('This document has no text to change.');
    f.meta.model = model;
  },
  metaLine: (f) => [f.meta.model ? plural(f.meta.model.counts.paras, 'paragraph') : ''],
  stage,
  reset() { if (st.view) st.view.destroy(); Object.assign(st, { file: null, model: null, view: null, ui: null }); for (const b of document.querySelectorAll('.we-bar')) b.remove(); },
  defaults: { find: '', repl: '', matchCase: false, whole: false },
  options: [
    { id: 'find', type: 'text', label: 'Find', value: '', max: D.DOCX.findMax, placeholder: 'A word or name' },
    { id: 'repl', type: 'text', label: 'Replace with', value: '', max: D.DOCX.findMax, placeholder: 'The new word' },
    { id: 'matchCase', type: 'toggle', label: 'Match case', value: false },
    { id: 'whole', type: 'toggle', label: 'Whole words', value: false },
    { id: 'findInfo', type: 'custom', render: () => renderFind() },
    { id: 'changes', type: 'custom', render: () => renderChanges() },
  ],
  onSet(app, id) { if (['find', 'matchCase', 'whole'].includes(id)) { st.hit = 0; refresh(); } },
  onOptions: () => { if (findBox) renderFind(); if (changeBox) renderChanges(); },
  check() {
    if (!st.model) return 'Reading the document…';
    if (st.editing && st.note && st.note.kind === 'error') return st.note.text;
    return changes().length || realAdds().length || st.editing ? '' : 'Change some text first.';
  },
  action: () => 'Save the document',
  showSaving: false,
  async run(f, o, job) {
    if (st.view && st.view.editing) st.view.commit({ blur: true }); // the paragraph still being typed is kept as it is
    const edits = changes().map(([key, code]) => ({ key, old: st.model.paras[key].code, code }));
    const adds = realAdds().map((a) => ({ after: a.after, text: a.text }));
    if (!edits.length && !adds.length) throw new UserError('Change some text first.');
    const r = await engine.run('docx.editSave', { bytes: await job.bytes(), edits, adds }, job);
    const note = [r.edited ? plural(r.edited, 'paragraph') + ' changed' : '', r.added ? plural(r.added, 'paragraph') + ' added' : '', r.verify && !r.verify.ok ? 'couldn’t confirm every change' : ''].filter(Boolean).join(' · ');
    return { outputs: [{ name: job.name(f.stem, 'docx', D.SUFFIX), bytes: r.bytes, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }], note, warn: !(r.verify && r.verify.ok) };
  },
});

addEventListener('keydown', (e) => {
  if (!st.ui || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); }
});
