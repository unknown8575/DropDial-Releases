// main/engines/markdown.js from the app, as a module (the website's copy; built by website/build.mjs).
const module = { exports: {} };
const process = { platform: 'web' };
const Buffer = { byteLength: (s) => new TextEncoder().encode(String(s)).length, from(b, off, len) {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b, off || 0, len) : new Uint8Array(b);
  return Object.assign(u, { toString: () => new TextDecoder().decode(u), indexOf(s) { const t = new TextEncoder().encode(s); outer: for (let i = 0; i + t.length <= u.length; i++) { for (let k = 0; k < t.length; k++) if (u[i + k] !== t[k]) continue outer; return i; } return -1; } });
} };
'use strict';
// Markdown → document blocks → HTML (QA round 7: readme.md → PDF/DOCX shows headings, lists, tables and code instead
// of raw Markdown). A small parser of its own for the common syntax (CommonMark core plus GitHub tables, task lists and
// strikethrough). Raw HTML in the source is never passed through: it is shown as text, and every piece of text is
// escaped. Links keep only http(s) and mailto targets; pictures are shown as their description, or embedded when a
// resolver hands back a safe data: URL for a local picture.

// ------------------------------------------------------------------ blocks
// {type:'h', level, text} {type:'p', text} {type:'code', text, lang} {type:'quote', blocks} {type:'hr'}
// {type:'list', ordered, start, items: [{task: null|true|false, blocks}]} {type:'table', align: [], head: [text], rows: [[text]]}
// `text` is still Markdown inline source; inline() turns it into runs.

const MAX_DEPTH = 12; // nested quotes/lists beyond this are read as text
const RE = {
  fence: /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  item: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  tableSep: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  blank: /^[ \t]*$/,
};

const expandTabs = (line) => line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    '));
const indentOf = (line) => /^ */.exec(line)[0].length;

/** Split a table row into cells ("| a | b |" → ["a", "b"]); "\|" stays in the cell. */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (s[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

/** Does this line start a block other than a paragraph (so it ends a paragraph)? */
function startsBlock(line) {
  return RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line) || (RE.item.test(line) && !/^ {0,3}\d{1,9}[.)]/.test(line)) || /^ {0,3}1[.)]([ \t]|$)/.test(line);
}

function parseBlocks(lines, depth = 0) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) { i++; continue; }
    let m;
    // Fenced code: everything up to the closing fence, exactly.
    if ((m = RE.fence.exec(line)) && !(m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`'))) {
      const fence = m[1], ind = indentOf(line), body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${ind}}`), ''));
        i++;
      }
      i++; // the closing fence (or the end)
      blocks.push({ type: 'code', text: body.join('\n'), lang: m[2] || '' });
      continue;
    }
    if ((m = RE.atx.exec(line))) { blocks.push({ type: 'h', level: m[1].length, text: (m[2] || '').trim() }); i++; continue; }
    if (RE.hr.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    // Indented code (four spaces), when it doesn't continue a paragraph.
    if (indentOf(line) >= 4) {
      const body = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || RE.blank.test(lines[i]))) { body.push(lines[i].slice(4)); i++; }
      while (body.length && RE.blank.test(body[body.length - 1])) body.pop();
      blocks.push({ type: 'code', text: body.join('\n'), lang: '' });
      continue;
    }
    if (RE.quote.test(line) && depth < MAX_DEPTH) {
      const inner = [];
      while (i < lines.length && !RE.blank.test(lines[i])) {
        if (RE.quote.test(lines[i])) inner.push(lines[i].replace(RE.quote, ''));
        else if (inner.length && !startsBlock(lines[i])) inner.push(lines[i]); // a lazy continuation line
        else break;
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner, depth + 1) });
      continue;
    }
    if ((m = RE.item.exec(line)) && depth < MAX_DEPTH) {
      const ordered = /\d/.test(m[2]);
      const marker = ordered ? m[2].slice(-1) : m[2];
      const list = { type: 'list', ordered, start: ordered ? Number(m[2].slice(0, -1)) : 1, items: [] };
      let loose = false;
      while (i < lines.length) {
        const im = RE.item.exec(lines[i]);
        if (!im || /\d/.test(im[2]) !== ordered || (ordered ? im[2].slice(-1) : im[2]) !== marker) break;
        const content = im[1].length + im[2].length + Math.min(4, Math.max(1, im[3].length || 1));
        const body = [lines[i].slice(im[0].length)];
        i++;
        let blankBefore = false;
        while (i < lines.length) {
          const l = lines[i];
          if (RE.blank.test(l)) { blankBefore = true; body.push(''); i++; continue; }
          if (indentOf(l) >= content) { if (blankBefore) loose = true; body.push(l.slice(content)); blankBefore = false; i++; continue; }
          // A lazy paragraph continuation (no blank line, not a new block).
          if (!blankBefore && !startsBlock(l) && !RE.item.test(l) && !RE.blank.test(body[body.length - 1])) { body.push(l); i++; continue; }
          break;
        }
        while (body.length && RE.blank.test(body[body.length - 1])) body.pop();
        let task = null;
        const t = /^\[([ xX])\][ \t]+/.exec(body[0] || '');
        if (t) { task = t[1] !== ' '; body[0] = body[0].slice(t[0].length); }
        list.items.push({ task, blocks: parseBlocks(body, depth + 1) });
        const nx = i < lines.length && RE.item.exec(lines[i]);
        if (blankBefore && nx && /\d/.test(nx[2]) === ordered && (ordered ? nx[2].slice(-1) : nx[2]) === marker) loose = true;
      }
      list.loose = loose;
      blocks.push(list);
      continue;
    }
    // A table: a header row, then the separator row.
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
      if (head.length === align.length || align.length > 0) {
        const rows = [];
        i += 2;
        while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) { rows.push(cells(lines[i]).slice(0, Math.max(head.length, 1))); i++; }
        blocks.push({ type: 'table', align: align.slice(0, head.length), head, rows });
        continue;
      }
    }
    // A paragraph (maybe a setext heading).
    const para = [];
    while (i < lines.length && !RE.blank.test(lines[i])) {
      if (para.length && RE.setext.test(lines[i])) {
        blocks.push({ type: 'h', level: lines[i].trim()[0] === '=' ? 1 : 2, text: para.join('\n').trim() });
        para.length = 0;
        i++;
        break;
      }
      if (para.length && (startsBlock(lines[i]) || (lines[i].includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])))) break;
      para.push(lines[i].replace(/^ {1,3}/, ''));
      i++;
    }
    if (para.length) blocks.push({ type: 'p', text: para.join('\n') });
  }
  return blocks;
}

/** Markdown source → blocks. */
function parse(src) {
  const text = String(src || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');
  return parseBlocks(text.split('\n').map(expandTabs));
}

// ------------------------------------------------------------------ inline
// Runs: {text, b?, i?, s?, code?, href?} and pictures {img: {alt, src}}; '\n' in a run's text is a line break.

const PUNCT = /[!-/:-@[-`{-~]/;
const safeHref = (u) => (/^(https?:\/\/|mailto:)/i.test(u) ? u : null);

/** Find the ']' that closes the '[' at `at` (brackets nest; code spans and escapes are skipped). */
function closeBracket(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '`') { const m = /^`+/.exec(s.slice(i))[0]; const end = s.indexOf(m, i + m.length); if (end > 0) { i = end + m.length - 1; continue; } }
    if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/** "(url "title")" after a link's text: {url, end} or null. */
function linkTarget(s, at) {
  if (s[at] !== '(') return null;
  let i = at + 1;
  while (s[i] === ' ' || s[i] === '\n') i++;
  let url = '';
  if (s[i] === '<') { const end = s.indexOf('>', i); if (end < 0) return null; url = s.slice(i + 1, end); i = end + 1; }
  else {
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && PUNCT.test(s[i + 1] || '')) { url += s[++i]; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (!depth) break; depth--; }
      else if (/\s/.test(c)) break;
      url += c;
    }
  }
  while (s[i] === ' ' || s[i] === '\n') i++;
  if (s[i] === '"' || s[i] === '\'' || s[i] === '(') { const close = s[i] === '(' ? ')' : s[i]; const end = s.indexOf(close, i + 1); if (end < 0) return null; i = end + 1; }
  while (s[i] === ' ' || s[i] === '\n') i++;
  return s[i] === ')' ? { url, end: i + 1 } : null;
}

/** The closing delimiter run for an opening run of `ch` × n at `from`, or -1. */
function closeDelim(s, from, ch, n) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '`') { const m = /^`+/.exec(s.slice(i))[0]; const end = s.indexOf(m, i + m.length); if (end > 0) { i = end + m.length - 1; continue; } }
    if (s[i] === '[') { const e = closeBracket(s, i); if (e > 0) { i = e; continue; } }
    if (s[i] !== ch) continue;
    let k = i; while (s[k] === ch) k++;
    const run = k - i;
    const before = s[i - 1] || ' ', after = s[k] || ' ';
    // A closing run follows text (not a space) and, for "_", isn't inside a word.
    if (run >= n && !/\s/.test(before) && (ch !== '_' || !/[\p{L}\p{N}]/u.test(after))) return run === n ? i : (n === 1 && run >= 2 ? -1 : i);
    i = k - 1;
  }
  return -1;
}

function inline(src, style = {}, depth = 0) {
  const s = String(src);
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ ...style, text: buf }); buf = ''; } };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '\n') { buf += '\n'; i += 2; continue; }
    if (c === '\\' && PUNCT.test(s[i + 1] || '')) { buf += s[i + 1]; i += 2; continue; }
    if (c === '\n') { if (/ {2,}$/.test(buf)) buf = buf.replace(/ +$/, '') + '\n'; else buf = buf.replace(/ +$/, '') + ' '; i++; while (s[i] === ' ') i++; continue; }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0 && s[end + run.length] !== '`') {
        flush();
        let code = s.slice(i + run.length, end).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        out.push({ ...style, code: true, text: code });
        i = end + run.length;
        continue;
      }
      buf += run; i += run.length; continue;
    }
    if ((c === '[' || (c === '!' && s[i + 1] === '[')) && depth < 8) {
      const open = c === '!' ? i + 1 : i;
      const close = closeBracket(s, open);
      const target = close > 0 ? linkTarget(s, close + 1) : null;
      if (target) {
        flush();
        const label = s.slice(open + 1, close);
        if (c === '!') out.push({ ...style, img: { alt: plain(inline(label, {}, depth + 1)), src: target.url } });
        else { const href = safeHref(target.url); out.push(...inline(label, href ? { ...style, href } : style, depth + 1)); }
        i = target.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) { flush(); out.push({ ...style, text: m[1].replace(/^mailto:/i, ''), href: m[1] }); i += m[0].length; continue; }
    }
    if ((c === '*' || c === '_' || c === '~') && depth < 8) {
      let k = i; while (s[k] === c) k++;
      const run = k - i;
      const after = s[k] || ' ', before = s[i - 1] || ' ';
      const canOpen = !/\s/.test(after) && (c !== '_' || !/[\p{L}\p{N}]/u.test(before)) && (c !== '~' || run === 2);
      if (canOpen) {
        const n = c === '~' ? 2 : Math.min(run, 3);
        const end = closeDelim(s, k, c, n);
        if (end > k) {
          flush();
          const next = c === '~' ? { s: true } : n === 3 ? { b: true, i: true } : n === 2 ? { b: true } : { i: true };
          out.push(...inline(s.slice(k, end), { ...style, ...next }, depth + 1));
          i = end + n;
          if (run > n) buf += c.repeat(run - n);
          continue;
        }
      }
      buf += s.slice(i, k); i = k; continue;
    }
    buf += c; i++;
  }
  flush();
  return out;
}

const plain = (runs) => runs.map((r) => (r.img ? r.img.alt : r.text || '')).join('');

// ------------------------------------------------------------------ HTML
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function runsHtml(runs, picture) {
  return runs.map((r) => {
    if (r.img) {
      const src = picture ? picture(r.img.src) : null;
      return src && DATA_IMAGE.test(src) ? `<img src="${src}" alt="${esc(r.img.alt)}">` : `<span class="alt">[${esc(r.img.alt || 'picture')}]</span>`;
    }
    let h = esc(r.text).replace(/\n/g, '<br>');
    if (r.code) h = `<code>${h}</code>`;
    if (r.s) h = `<del>${h}</del>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.b) h = `<strong>${h}</strong>`;
    if (r.href && safeHref(r.href)) h = `<a href="${esc(r.href)}">${h}</a>`;
    return h;
  }).join('');
}

function blocksHtml(blocks, picture, tight = false) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'h': return `<h${b.level}>${runsHtml(inline(b.text), picture)}</h${b.level}>`;
      case 'p': return tight ? runsHtml(inline(b.text), picture) : `<p>${runsHtml(inline(b.text), picture)}</p>`;
      case 'code': return `<pre class="code"><code>${esc(b.text)}</code></pre>`;
      case 'hr': return '<hr>';
      case 'quote': return `<blockquote>${blocksHtml(b.blocks, picture)}</blockquote>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ` start="${Math.max(0, Math.min(1e9, b.start))}"` : '';
        const items = b.items.map((it) => `<li${it.task !== null ? ' class="task"' : ''}>${it.task !== null ? `<span class="box">${it.task ? '☑' : '☐'}</span> ` : ''}${blocksHtml(it.blocks, picture, !b.loose)}</li>`).join('');
        return `<${tag}${start}>${items}</${tag}>`;
      }
      case 'table': {
        const al = (k) => (b.align[k] ? ` style="text-align:${b.align[k]}"` : '');
        const head = `<thead><tr>${b.head.map((c, k) => `<th${al(k)}>${runsHtml(inline(c), picture)}</th>`).join('')}</tr></thead>`;
        const rows = b.rows.map((r) => `<tr>${b.head.map((_, k) => `<td${al(k)}>${runsHtml(inline(r[k] || ''), picture)}</td>`).join('')}</tr>`).join('');
        return `<table class="md">${head}<tbody>${rows}</tbody></table>`;
      }
      default: return '';
    }
  }).join('\n');
}

const MD_CSS = `
h1 { font-size: 20pt; border-bottom: 0.75pt solid #ddd; padding-bottom: 3pt; } h2 { font-size: 15pt; border-bottom: 0.5pt solid #e4e4e4; padding-bottom: 2pt; }
h3 { font-size: 12.5pt; } h4 { font-size: 11pt; } h5, h6 { font-size: 10pt; color: #444; } body > :first-child { margin-top: 0; }
li > p { margin: 0.2em 0; } li { margin: 0.15em 0; } ul ul, ol ol, ul ol, ol ul { margin: 0.1em 0; }
li.task { list-style: none; } li.task > .box { margin-left: -1.1em; display: inline-block; width: 1.1em; } .box { font-family: "Segoe UI Symbol", "Apple Symbols", sans-serif; }
code { font: 9.5pt/1.4 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; background: #f3f3f3; border-radius: 3pt; padding: 0 2pt; }
pre.code { background: #f6f6f6; border: 0.5pt solid #e2e2e2; border-radius: 4pt; padding: 7pt 9pt; margin: 0 0 0.8em; white-space: pre-wrap; break-inside: avoid; }
pre.code code { background: none; padding: 0; }
blockquote { margin: 0 0 0.8em; padding: 0 0 0 10pt; border-left: 2.5pt solid #d0d0d0; color: #444; }
hr { border: 0; border-top: 0.75pt solid #ccc; margin: 1em 0; }
table.md { width: auto; max-width: 100%; } table.md th, table.md td { border: 0.5pt solid #bbb; padding: 3pt 6pt; vertical-align: top; } table.md th { background: #f0f0f0; text-align: left; }
a { color: #0b57d0; text-decoration: none; } .alt { color: #666; font-style: italic; } del { color: #666; }`;

/** Markdown source as HTML body content and its CSS. `picture(src)` may return a data: URL for a local picture. */
function toHtml(src, { picture } = {}) {
  return { body: blocksHtml(parse(src), picture), css: MD_CSS };
}

/** Paths of the local pictures a document shows (relative paths only; links and absolute paths are left out). */
function localPictures(src) {
  const out = new Set();
  const walk = (blocks) => {
    for (const b of blocks) {
      const texts = b.type === 'table' ? [...b.head, ...b.rows.flat()] : b.text != null && b.type !== 'code' ? [b.text] : [];
      for (const t of texts) for (const r of inline(t)) if (r.img && r.img.src && !/^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(r.img.src) && !/^\\\\/.test(r.img.src)) out.add(r.img.src);
      if (b.blocks) walk(b.blocks);
      if (b.items) b.items.forEach((it) => walk(it.blocks));
    }
  };
  walk(parse(src));
  return [...out].slice(0, 50);
}

/**
 * Markdown as flat paragraphs for a Word document: [{kind: 'h'|'p'|'li'|'code'|'quote'|'hr'|'row', level, runs, ...}].
 * Lists carry their depth and number ("1." or "•"); tables come as {kind: 'table', head: [runs], rows: [[runs]], align}.
 */
function toParagraphs(src) {
  const out = [];
  const walk = (blocks, ctx) => {
    for (const b of blocks) {
      if (b.type === 'h') out.push({ kind: 'h', level: b.level, runs: inline(b.text), quote: ctx.quote });
      else if (b.type === 'p') out.push({ kind: 'p', runs: inline(b.text), depth: ctx.depth, quote: ctx.quote });
      else if (b.type === 'code') out.push({ kind: 'code', text: b.text, depth: ctx.depth, quote: ctx.quote });
      else if (b.type === 'hr') out.push({ kind: 'hr' });
      else if (b.type === 'quote') walk(b.blocks, { ...ctx, quote: true });
      else if (b.type === 'table') out.push({ kind: 'table', align: b.align, head: b.head.map((c) => inline(c)), rows: b.rows.map((r) => b.head.map((_, k) => inline(r[k] || ''))) });
      else if (b.type === 'list') {
        b.items.forEach((it, k) => {
          const mark = it.task !== null ? (it.task ? '☑' : '☐') : b.ordered ? `${b.start + k}.` : ['•', '◦', '▪'][ctx.depth % 3];
          let first = true;
          const head = (runs) => { out.push({ kind: 'li', runs, depth: ctx.depth, mark: first ? mark : '', quote: ctx.quote }); first = false; };
          for (const ib of it.blocks) {
            if (ib.type === 'p') head(inline(ib.text));
            else { if (first) head([]); walk([ib], { ...ctx, depth: ctx.depth + 1 }); }
          }
          if (first) head([]);
        });
      }
    }
  };
  walk(parse(src), { depth: 0, item: null, quote: false });
  return out;
}

const isMarkdownName = (name) => /\.(md|markdown|mdown|mkd)$/i.test(String(name || ''));

module.exports = { parse, inline, toHtml, toParagraphs, localPictures, isMarkdownName, esc, MD_CSS };

export default module.exports;
