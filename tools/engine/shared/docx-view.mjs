// Edit Word text: the page the windows show, and editing a paragraph in place. Shared by the app's window
// (src/renderer/tools/docx-edit.js) and the website's page (website/src/js/tools/edit-word-text.js), so both look and
// behave the same. Plain DOM: the document is drawn from the model (src/shared/docxedit.mjs scanDocx) as HTML, every
// paragraph in its own element; a click makes that element editable (contenteditable), with marked parts (fields,
// pictures, note numbers) as uneditable chips. What is typed is read back as the paragraph's code and handed to the
// host, which keeps the edits (Undo, Changes, Save). The page itself is white paper in light and dark mode.
import { displayPieces, styleCss, lockChar, cleanCode, hasDeva, addedPar } from './docxedit.mjs';
import { isDeva } from './pdfedit.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * A view of a document in `root` (a scrolling element). opts: {onCommit(key, code) → error text or '', onEditing(key |
 * null), onInput(key, code), onLocked(key, why), onError(text), onCursor(key), labels: {enter}, touch}.
 */
export function createDocView(root, opts = {}) {
  const view = new DocView(root, opts);
  return view;
}

class DocView {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.model = null;
    this.state = { codes: new Map(), adds: new Map(), hits: new Map() };
    this.cache = new Map();
    this.editing = null;
    this.cursor = null;
    this.zoom = 1;
    this.css = [];
    this.page = document.createElement('div');
    this.page.className = 'dw-page';
    this.canvas = document.createElement('div');
    this.canvas.className = 'dw-canvas';
    this.canvas.append(this.page);
    root.replaceChildren(this.canvas);
    root.classList.add('dw-root');
    this.on = [];
    const listen = (el, type, fn, o) => { el.addEventListener(type, fn, o); this.on.push(() => el.removeEventListener(type, fn, o)); };
    listen(root, 'pointerdown', (e) => this.down(e));
    listen(root, 'click', (e) => this.click(e));
    listen(root, 'keydown', (e) => this.key(e));
    listen(root, 'beforeinput', (e) => this.beforeInput(e));
    listen(root, 'input', (e) => { if (this.editing && this.editing.el.contains(e.target)) this.opts.onInput && this.opts.onInput(this.editing.key, this.read()); });
    listen(root, 'paste', (e) => this.paste(e));
    listen(root, 'drop', (e) => { if (this.editing) e.preventDefault(); });
    listen(root, 'dragstart', (e) => e.preventDefault());
    listen(root, 'focusout', (e) => this.blur(e));
    listen(root, 'focusin', (e) => { const p = e.target.closest && e.target.closest('.dw-p'); if (p && p.dataset.k !== this.cursor) this.setCursor(p.dataset.k); });
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(root);
  }
  destroy() { for (const off of this.on) off(); this.ro.disconnect(); }

  // ---------------------------------------------------------------- drawing
  setModel(model) {
    this.model = model;
    // Escaped for a style="…" attribute (font names are quoted).
    this.css = model.styles.map((s) => esc(styleCss(s)));
    this.cssDeva = model.styles.map((s) => esc(styleCss(s, true)));
    this.cache.clear();
    this.editing = null;
    const p = model.page;
    this.page.style.setProperty('--dw-w', p.w + 'px');
    this.page.style.setProperty('--dw-ml', p.ml + 'px');
    this.page.style.setProperty('--dw-mr', p.mr + 'px');
    this.page.style.setProperty('--dw-mt', Math.min(p.mt, 120) + 'px');
    this.page.style.setProperty('--dw-mb', Math.min(p.mb, 120) + 'px');
    this.page.innerHTML = model.stories.map((s) => this.storyHtml(s)).join('');
    this.cursor = model.order.find((k) => !model.paras[k].lock) || model.order[0] || null;
    this.syncTab();
    this.fit();
  }
  /** New edits, added paragraphs and find matches: only the paragraphs whose drawing changed are drawn again. */
  update(state) {
    this.state = { codes: state.codes || new Map(), adds: state.adds || new Map(), hits: state.hits || new Map() };
    if (!this.model) return;
    for (const key of this.model.order) this.refresh(key);
    // Added paragraphs: a list after the paragraph they follow.
    const seen = new Set();
    for (const [after, list] of this.state.adds) {
      seen.add(after);
      const anchor = this.el(after);
      if (!anchor) continue;
      let box = anchor.nextElementSibling;
      if (!box || !box.classList.contains('dw-adds') || box.dataset.after !== after) {
        box = document.createElement('div');
        box.className = 'dw-adds';
        box.dataset.after = after;
        anchor.after(box);
      }
      const keys = list.map((a) => 'n' + a.id);
      for (const el of [...box.children]) if (!keys.includes(el.dataset.k)) { if (this.editing && this.editing.el === el) this.editing = null; el.remove(); this.cache.delete(el.dataset.k); }
      let prev = null;
      for (const a of list) {
        const key = 'n' + a.id;
        let el = box.querySelector(`[data-k="${key}"]`);
        if (!el) { el = document.createElement('div'); el.dataset.k = key; if (prev) prev.after(el); else box.prepend(el); this.cache.delete(key); }
        else if (prev && prev.nextElementSibling !== el) prev.after(el);
        this.refresh(key);
        prev = this.el(key);
      }
    }
    for (const box of [...this.page.querySelectorAll('.dw-adds')]) if (!seen.has(box.dataset.after)) { for (const el of box.children) this.cache.delete(el.dataset.k); box.remove(); }
    this.syncTab();
  }
  /** Every paragraph key in reading order, added ones included. */
  keys() {
    const out = [];
    for (const k of this.model.order) { out.push(k); for (const a of this.state.adds.get(k) || []) out.push('n' + a.id); }
    return out;
  }
  par(key) {
    if (key[0] !== 'n') return this.model.paras[key];
    for (const [after, list] of this.state.adds) { const a = list.find((x) => 'n' + x.id === key); if (a) return addedPar(this.model, after, a.id, a.text); }
    return null;
  }
  el(key) { return this.page.querySelector(`.dw-p[data-k="${key}"]`); }
  codeOf(key) { const p = this.par(key); return key[0] === 'n' ? p.code : this.state.codes.has(key) ? this.state.codes.get(key) : p.code; }

  refresh(key, force = false) {
    if (this.editing && this.editing.key === key) return;
    const par = this.par(key);
    const el = this.page.querySelector(`[data-k="${key}"]`);
    if (!par || !el) return;
    const html = this.paraHtml(par, this.codeOf(key), this.state.hits.get(key));
    if (!force && this.cache.get(key) === html && el.classList.contains('dw-p')) return;
    this.cache.set(key, html);
    const t = document.createElement('template');
    t.innerHTML = html;
    const next = t.content.firstElementChild;
    if (key === this.cursor) next.tabIndex = 0;
    el.replaceWith(next);
  }

  storyHtml(s) {
    const label = s.kind === 'body' ? '' : `<div class="dw-label" aria-hidden="true">${esc(s.label)}</div>`;
    const role = s.kind === 'body' ? '' : ` role="region" aria-label="${esc(s.label)}"`;
    return `<section class="dw-story dw-${s.kind}" data-story="${s.id}"${role}>${label}${this.blocksHtml(s.blocks)}</section>`;
  }
  blocksHtml(blocks) {
    let out = '', prev = null;
    for (const b of blocks) {
      if (b.t === 'p') {
        const par = this.model.paras[b.key];
        const lk = par.look;
        const gap = prev && lk.ctx && prev.ctx && prev.sid === lk.sid ? 0 : (prev ? prev.sa : 0) + lk.sb;
        this.gaps = this.gaps || new Map();
        this.gaps.set(b.key, gap);
        out += this.paraHtml(par, this.codeOf(b.key), this.state.hits.get(b.key));
        prev = lk;
      } else if (b.t === 'table') { out += this.tableHtml(b); prev = null; }
      else if (b.t === 'note') { out += `<div class="dw-note"><span class="dw-nn" aria-hidden="true">${esc(b.n)}</span><div class="dw-nb">${this.blocksHtml(b.blocks)}</div></div>`; prev = null; }
    }
    return out;
  }
  tableHtml(t) {
    // Rows merged down (vMerge) become rowspans.
    const origin = [];
    const rows = t.rows.map((r) => {
      let col = 0;
      const cells = [];
      for (const c of r.cells) {
        if (c.vm === 'c' && origin[col]) { origin[col].rowspan++; col += c.span; continue; }
        const cell = { c, rowspan: 1 };
        for (let k = 0; k < c.span; k++) origin[col + k] = c.vm === 'r' ? cell : null;
        cells.push(cell);
        col += c.span;
      }
      return cells;
    });
    const w = t.width ? ` style="width:${esc(t.width)}"` : '';
    return `<table class="dw-tbl${t.borders ? ' dw-grid' : ''}"${w}><tbody>${rows.map((cells) => `<tr>${cells.map(({ c, rowspan }) => `<td${c.span > 1 ? ` colspan="${c.span}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''} style="${c.bg ? `background:${c.bg};` : ''}${c.w ? `width:${c.w}px` : ''}">${this.blocksHtml(c.blocks)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  /** One paragraph's element: its look, list label, text in its runs' looks, marks as chips, find matches marked. */
  paraHtml(par, code, hits) {
    const lk = par.look || {};
    const pieces = displayPieces(par, code) || displayPieces(par);
    const mark = this.model.styles[par.mark] || { sz: 11 };
    const gap = par.added ? (lk.sa || 0) + (lk.sb || 0) : this.gaps && this.gaps.has(par.key) ? this.gaps.get(par.key) : lk.sb || 0;
    let st = `font-size:${r2(mark.sz * 4 / 3)}px;margin-top:${r2(gap)}px`;
    if (lk.al && lk.al !== 'left') st += `;text-align:${lk.al}`;
    if (lk.il) st += `;margin-left:${r2(lk.il)}px`;
    if (lk.ir) st += `;margin-right:${r2(lk.ir)}px`;
    if (lk.fi) st += `;text-indent:${r2(lk.fi)}px`;
    if (lk.lh) st += `;line-height:${lk.lh.px ? r2(lk.lh.px) + 'px' : r2(1.2 * lk.lh.m)}`;
    if (lk.bg) st += `;background:${lk.bg}`;
    let inner = '';
    if (par.list) {
      const w = lk.fi < 0 ? -lk.fi : 0;
      inner += `<span class="dw-num" contenteditable="false" aria-hidden="true" style="${this.css[par.list.s]};text-decoration:none${w && par.list.tab === 'tab' ? `;min-width:${r2(w)}px` : ''}">${esc(par.list.label)}${par.list.tab === 'space' || !w ? ' ' : ''}</span>`;
    }
    const H = (hits || []).slice().sort((a, b) => a.start - b.start);
    let d = 0;
    for (const p of pieces) {
      if (p.u >= 0) { inner += this.unitHtml(par, p.u, p.s, H.filter((h) => h.start < d + p.t.length && h.end > d && p.t.length).length ? (H.some((h) => h.active && h.start < d + p.t.length && h.end > d) ? ' dw-hit dw-on' : ' dw-hit') : ''); d += p.t.length; continue; }
      inner += this.textHtml(p.t, p.s, d, H);
      d += p.t.length;
    }
    const empty = !pieces.some((p) => p.t || p.u >= 0);
    const cls = 'dw-p' + (par.lock ? ' dw-lock' : '') + (par.added ? ' dw-new' : code !== par.code ? ' dw-changed' : '') + (lk.h ? ' dw-h' : '') + (lk.pb ? ' dw-pb' : '') + (empty ? ' dw-empty' : '');
    const role = lk.h ? ` role="heading" aria-level="${Math.min(6, lk.h)}"` : '';
    const title = par.lock ? ` title="${esc(par.lock)}"` : '';
    return `<div class="${cls}" data-k="${par.key}" tabindex="-1" style="${st}"${role}${title}>${inner}</div>`;
  }
  /** Text in a look; Hindi (Devanagari) in the look's complex-script font and size; find matches as <mark>. */
  textHtml(t, s, d0, hits) {
    if (!t) return '';
    const parts = [];
    const cuts = new Set([0, t.length]);
    for (const h of hits) { if (h.end <= d0 || h.start >= d0 + t.length) continue; cuts.add(Math.max(0, h.start - d0)); cuts.add(Math.min(t.length, h.end - d0)); }
    const at = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < at.length - 1; i++) {
      const a = at[i], b = at[i + 1];
      const h = hits.find((x) => x.start < d0 + b && x.end > d0 + a);
      const chunk = t.slice(a, b);
      let html = '';
      if (hasDeva(chunk) && this.cssDeva[s] !== this.css[s]) {
        let run = '', deva = null;
        const flush = () => { if (run) html += `<span style="${deva ? this.cssDeva[s] : this.css[s]}">${esc(run)}</span>`; run = ''; };
        for (const ch of Array.from(chunk)) { const dv = isDeva(ch) || (deva && /[\s‌‍\p{M}]/u.test(ch)); if (deva !== null && dv !== deva) flush(); deva = dv; run += ch; }
        flush();
      } else html = `<span style="${this.css[s]}">${esc(chunk)}</span>`;
      parts.push(h ? `<mark class="dw-hit${h.active ? ' dw-on' : ''}">${html}</mark>` : html);
    }
    return parts.join('');
  }
  unitHtml(par, k, s, hit) {
    const u = par.units[k];
    const title = esc(u.title || '');
    const base = `contenteditable="false" data-u="${k}" title="${title}"`;
    if (u.k === 'pic' && u.img && u.img.src && /^data:image\/(png|jpeg|gif|bmp|webp);base64,[A-Za-z0-9+/=]+$/.test(u.img.src)) {
      const w = u.img.w || 0, h = u.img.h || 0;
      const size = w && h ? `width:${r2(w)}px;aspect-ratio:${r2(w)}/${r2(h)}` : '';
      return `<span class="dw-u dw-pic${hit}" ${base}><img src="${u.img.src}" alt="${esc(u.img.alt || 'Picture')}" draggable="false" style="${size}"></span>${u.box ? this.boxChips(u) : ''}`;
    }
    if (u.k === 'pic' || u.k === 'obj') {
      const w = u.img && u.img.w ? Math.min(600, u.img.w) : 120, h = u.img && u.img.h ? Math.min(400, u.img.h) : 60;
      return `<span class="dw-u dw-ph${hit}" ${base} style="width:${r2(w)}px;height:${r2(h)}px"><span>${esc((u.img && u.img.alt) || u.title || 'Picture')}</span></span>`;
    }
    if (u.k === 'box') return `<span class="dw-u dw-chip${hit}" ${base}>${this.boxChips(u, true)}</span>`;
    if (u.k === 'break') return `<span class="dw-u dw-break" ${base}><span>${esc(u.title)}</span></span>`;
    // Fields, controls, notes, symbols: their own text in their own looks, on a grey ground (Word's field shading).
    const inner = u.pieces ? u.pieces.map((p) => `<span style="${this.css[p.s]}">${esc(p.t)}</span>`).join('') : `<span style="${this.css[s]}">${esc(u.label || u.t)}</span>`;
    return `<span class="dw-u dw-field dw-k-${u.k}${hit}" ${base}>${inner}</span>`;
  }
  boxChips(u, bare = false) {
    const ids = u.box || [];
    const names = String(u.label || '').split(', ');
    return ids.map((id, i) => `<button type="button" class="dw-boxlink" data-box="${esc(id)}" contenteditable="false" tabindex="-1">${esc(names[i] || 'Text box')}</button>`).join(bare ? '' : '');
  }

  // ---------------------------------------------------------------- size
  /** Fit the page to the width; on a narrow screen the text is set at a readable size and wraps to the screen. */
  fit() {
    if (!this.model) return;
    const cs = getComputedStyle(this.canvas);
    const avail = Math.max(120, this.root.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - 2);
    const w = this.model.page.w;
    const fitZ = avail / w;
    const narrow = fitZ < 0.62;
    this.page.classList.toggle('dw-reflow', narrow);
    if (narrow) {
      const z = Math.min(1.6, 0.92 * this.zoom);
      this.page.style.zoom = z;
      this.page.style.width = r2(avail / z) + 'px';
    } else {
      const z = Math.min(fitZ, 1.25) * this.zoom;
      this.page.style.zoom = r2(z * 1000) / 1000;
      this.page.style.width = '';
    }
    this.scale = parseFloat(this.page.style.zoom) || 1;
  }
  setZoom(z) { this.zoom = Math.max(0.5, Math.min(3, z)); this.fit(); }

  // ---------------------------------------------------------------- editing
  /** Read an editable paragraph back as code: text, a mark's character for each chip, \n for line breaks. */
  read(el = this.editing && this.editing.el) {
    let out = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { out += c.data; continue; }
        if (c.nodeType !== 1) continue;
        if (c.dataset && c.dataset.u != null) { out += lockChar(Number(c.dataset.u)); continue; }
        if (c.classList.contains('dw-num') || c.classList.contains('dw-boxlink')) continue;
        if (c.tagName === 'BR') { out += '\n'; continue; }
        if (/^(DIV|P)$/.test(c.tagName) && out && !out.endsWith('\n')) out += '\n';
        walk(c);
      }
    };
    walk(el);
    // The browser keeps a last <br> so an empty last line shows: it isn't a line of its own.
    if (el.lastChild && el.lastChild.nodeName === 'BR' && out.endsWith('\n')) out = out.slice(0, -1);
    return cleanCode(out);
  }
  setCursor(key) {
    this.cursor = key;
    this.syncTab();
    if (this.opts.onCursor) this.opts.onCursor(key);
  }
  syncTab() {
    for (const el of this.page.querySelectorAll('.dw-p[tabindex="0"]')) if (el.dataset.k !== this.cursor) el.tabIndex = -1;
    const c = this.cursor && this.el(this.cursor);
    if (c) c.tabIndex = 0;
  }
  down(e) {
    if (e.button > 0) return;
    const box = e.target.closest && e.target.closest('.dw-boxlink');
    if (box) { e.preventDefault(); this.showStory(box.dataset.box); return; }
    const el = e.target.closest && e.target.closest('.dw-p');
    if (!el || !this.page.contains(el)) return;
    const key = el.dataset.k;
    if (this.editing && this.editing.key === key) return;
    if (el.classList.contains('dw-lock')) {
      e.preventDefault();
      if (this.editing && !this.commit()) return;
      this.setCursor(key);
      el.focus({ preventScroll: true });
      if (this.opts.onLocked) this.opts.onLocked(key, this.par(key).lock);
      return;
    }
    if (this.editing && !this.commit()) { e.preventDefault(); return; }
    // The browser puts the caret where the click is, in the element made editable here.
    this.begin(this.el(key) || el, key);
    if (e.pointerType === 'mouse' || !e.pointerType) setTimeout(() => { if (this.editing && this.editing.key === key && document.activeElement !== this.editing.el) this.placeCaret(e.clientX, e.clientY); }, 0);
  }
  click(e) {
    if (e.target.closest && e.target.closest('.dw-boxlink')) e.preventDefault();
  }
  placeCaret(x, y) {
    const ed = this.editing;
    if (!ed) return;
    ed.el.focus({ preventScroll: true });
    let r = null;
    if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); } }
    const sel = getSelection();
    if (r && ed.el.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); }
  }
  /** Start editing a paragraph (from the keyboard or the host: the caret at the end). */
  startEdit(key, { select = false } = {}) {
    if (this.editing && this.editing.key === key) return true;
    if (this.editing && !this.commit()) return false;
    const el = this.el(key);
    if (!el) return false;
    if (el.classList.contains('dw-lock')) { if (this.opts.onLocked) this.opts.onLocked(key, this.par(key).lock); return false; }
    this.begin(el, key);
    el.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    if (!select) r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    el.scrollIntoView({ block: 'nearest' });
    return true;
  }
  begin(el, key) {
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    el.setAttribute('aria-label', 'Paragraph text');
    el.classList.add('dw-editing');
    el.removeAttribute('title');
    this.editing = { key, el, code0: this.codeOf(key) };
    this.setCursor(key);
    if (this.opts.onEditing) this.opts.onEditing(key);
  }
  /** Keep what was typed. False (and still editing) when it can't be kept; the host says why (onCommit's answer). */
  commit({ blur = false } = {}) {
    const ed = this.editing;
    if (!ed) return true;
    const code = this.read(ed.el);
    if (code !== ed.code0) {
      const err = this.opts.onCommit ? this.opts.onCommit(ed.key, code) : '';
      if (err) {
        if (this.opts.onError) this.opts.onError(err);
        if (!blur) return false;
        this.end(); // leaving the paragraph: what can't be kept is put back
        return false;
      }
      if (ed.key[0] !== 'n') this.state.codes.set(ed.key, code);
      else for (const list of this.state.adds.values()) { const a = list.find((x) => 'n' + x.id === ed.key); if (a) a.text = code; }
    }
    this.end();
    return true;
  }
  cancel() { if (this.editing) this.end(); }
  end() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.el.removeAttribute('contenteditable');
    this.cache.delete(ed.key);
    this.refresh(ed.key, true);
    if (this.opts.onEditing) this.opts.onEditing(null);
  }
  focusPara(key) { const el = this.el(key); if (el) { this.setCursor(key); el.focus({ preventScroll: false }); } }
  key(e) {
    const ed = this.editing;
    if (ed && ed.el.contains(e.target)) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (e.shiftKey) { document.execCommand('insertLineBreak'); return; }
        const key = ed.key;
        if (this.commit()) this.focusPara(key);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const key = ed.key; this.cancel(); this.focusPara(key); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const keys = this.keys().filter((k) => !this.par(k).lock);
        const at = keys.indexOf(ed.key);
        const next = keys[at + (e.shiftKey ? -1 : 1)];
        if (this.commit() && next) this.startEdit(next);
        return;
      }
      if (mod && /^[biu]$/i.test(e.key)) { e.preventDefault(); return; }
      return;
    }
    const p = e.target.closest && e.target.closest('.dw-p');
    if (!p || e.target !== p) return;
    const keys = this.keys();
    const at = keys.indexOf(p.dataset.k);
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (move) { e.preventDefault(); this.focusPara(keys[Math.max(0, Math.min(keys.length - 1, at + move))]); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); this.focusPara(keys[e.key === 'Home' ? 0 : keys.length - 1]); return; }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      if (p.classList.contains('dw-lock')) { if (this.opts.onLocked) this.opts.onLocked(p.dataset.k, this.par(p.dataset.k).lock); }
      else this.startEdit(p.dataset.k);
    }
  }
  beforeInput(e) {
    const ed = this.editing;
    if (!ed || !ed.el.contains(e.target)) return;
    const t = e.inputType || '';
    if (/^format/.test(t) || t === 'insertFromDrop') { e.preventDefault(); return; }
    // A phone keyboard's Return: keep the paragraph (Shift+Return on a computer is a line break).
    if (t === 'insertParagraph') { e.preventDefault(); const key = ed.key; if (this.commit()) this.focusPara(key); }
  }
  paste(e) {
    const ed = this.editing;
    if (!ed || !ed.el.contains(e.target)) return;
    e.preventDefault();
    const text = cleanCode((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/[\u{10FC00}-\u{10FFFF}]/gu, '').replace(/\t/g, '\t');
    const lines = text.split('\n');
    lines.forEach((line, i) => { if (i) document.execCommand('insertLineBreak'); if (line) document.execCommand('insertText', false, line); });
  }
  blur(e) {
    const ed = this.editing;
    if (!ed || !ed.el.contains(e.target)) return;
    if (e.relatedTarget && ed.el.contains(e.relatedTarget)) return;
    // Leaving the paragraph keeps it (as clicking another one does).
    setTimeout(() => { if (this.editing === ed && !ed.el.contains(document.activeElement)) this.commit({ blur: true }); }, 0);
  }
  showStory(id) {
    const s = this.page.querySelector(`[data-story="${id}"]`);
    if (!s) return;
    s.scrollIntoView({ block: 'center', behavior: 'smooth' });
    s.classList.add('dw-flash');
    setTimeout(() => s.classList.remove('dw-flash'), 1200);
  }
  scrollTo(key) { const el = this.el(key); if (el) el.scrollIntoView({ block: 'center' }); }
}
