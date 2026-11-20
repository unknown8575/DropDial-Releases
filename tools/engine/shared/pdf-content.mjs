// PDF page content streams: read, follow and rewrite them (Edit PDF text). Pure code with no dependencies, shared by
// the processor (src/processor/pdf-edit.js, app and website) and the unit tests.
//
// - parseOps(bytes): the operators of a content stream with their operands and byte ranges.
// - walkContent(bytes, ctx): follows the graphics and text state (q/Q, cm, BT/ET, Tm, Td, TD, T*, Tf, Tc, Tw, Tz, TL,
//   Ts, Tr, Tj, TJ, ' and ") through the page and its Form XObjects, and reports every text-show operator with each
//   glyph's code bytes and its origin and advance in user space.
// - rewriteContent(bytes, edits): cuts chosen glyphs out of text-show operators. The glyphs after them keep their
//   exact place (the removed widths become TJ spacing), so only the removed characters disappear from the page; it also
//   renames Do operands (copied forms).
//
// Coordinates: user space is the page's own space (y up). "View" space is the page as seen after /Rotate, in points,
// with y down from the top-left corner of the crop box (as the windows draw it).

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const isReg = (c) => !WS[c] && !DELIM[c];

/** A content-stream syntax problem (never shown as is: the caller falls back to covering). */
export class ContentError extends Error { constructor(m) { super(m); this.content = true; } }

const latin1 = (b, s, e) => { let t = ''; for (let i = s; i < e; i++) t += String.fromCharCode(b[i]); return t; };

/** A literal string's bytes from b[at] = '(' → {bytes, end}. */
function readLiteral(b, at) {
  const out = [];
  let depth = 1, i = at + 1;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 0x5c) { // backslash
      const n = b[++i];
      if (n === undefined) break;
      const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 }[n];
      if (esc !== undefined) out.push(esc);
      else if (n >= 0x30 && n <= 0x37) {
        let v = n - 0x30, k = 1;
        while (k < 3 && b[i + 1] >= 0x30 && b[i + 1] <= 0x37) { v = v * 8 + (b[++i] - 0x30); k++; }
        out.push(v & 255);
      } else if (n === 13) { if (b[i + 1] === 10) i++; } // line continuation
      else if (n !== 10) out.push(n);
      continue;
    }
    if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return { bytes: Uint8Array.from(out), end: i + 1 };
    out.push(c);
  }
  throw new ContentError('unterminated string');
}

function readHex(b, at) {
  const out = [];
  let hi = -1, i = at + 1;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 0x3e) { if (hi >= 0) out.push(hi << 4); return { bytes: Uint8Array.from(out), end: i + 1 }; }
    let v = -1;
    if (c >= 48 && c <= 57) v = c - 48; else if (c >= 65 && c <= 70) v = c - 55; else if (c >= 97 && c <= 102) v = c - 87;
    if (v < 0) { if (WS[c]) continue; throw new ContentError('bad hex string'); }
    if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
  }
  throw new ContentError('unterminated hex string');
}

/** The end of an inline image's data: after "ID " up to whitespace + "EI" + whitespace/delimiter/end. */
function inlineImageEnd(b, from) {
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === from || WS[b[i - 1]]) && (i + 2 >= b.length || WS[b[i + 2]] || DELIM[b[i + 2]])) return i + 2;
  }
  throw new ContentError('unterminated inline image');
}

/**
 * The operators of a content stream: [{op, args, start, end}] (start = the first operand's first byte). Operand
 * values: numbers, {name}, {str: Uint8Array, hex}, arrays, {dict: {...}}, true/false/null. An inline image (BI … EI) is
 * one operator 'BI' with no operands. Comments are skipped.
 */
export function parseOps(b) {
  const ops = [];
  const stack = []; // open arrays / dicts: {kind, items, start}
  let args = [], argStart = -1;
  let i = 0;
  const n = b.length;
  const push = (v, s) => {
    if (stack.length) stack[stack.length - 1].items.push(v);
    else { if (argStart < 0) argStart = s; args.push(v); }
  };
  while (i < n) {
    const c = b[i];
    if (WS[c]) { i++; continue; }
    const s = i;
    if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // %
    if (c === 0x28) { const r = readLiteral(b, i); i = r.end; push({ str: r.bytes, hex: false }, s); continue; }
    if (c === 0x3c) {
      if (b[i + 1] === 0x3c) { stack.push({ kind: 'dict', items: [], start: s }); i += 2; continue; }
      const r = readHex(b, i); i = r.end; push({ str: r.bytes, hex: true }, s); continue;
    }
    if (c === 0x3e) {
      if (b[i + 1] !== 0x3e) throw new ContentError('stray >');
      i += 2;
      const top = stack.pop();
      if (!top || top.kind !== 'dict') throw new ContentError('unbalanced dictionary');
      const dict = {};
      for (let k = 0; k + 1 < top.items.length; k += 2) if (top.items[k] && top.items[k].name !== undefined) dict[top.items[k].name] = top.items[k + 1];
      push({ dict }, top.start);
      continue;
    }
    if (c === 0x5b) { stack.push({ kind: 'array', items: [], start: s }); i++; continue; }
    if (c === 0x5d) {
      i++;
      const top = stack.pop();
      if (!top || top.kind !== 'array') throw new ContentError('unbalanced array');
      push(top.items, top.start);
      continue;
    }
    if (c === 0x7b || c === 0x7d) { i++; continue; } // PostScript braces: not used in page content
    if (c === 0x2f) { // name
      i++;
      let name = '';
      while (i < n && isReg(b[i])) {
        if (b[i] === 0x23 && i + 2 < n) { const h = parseInt(latin1(b, i + 1, i + 3), 16); if (!Number.isNaN(h)) { name += String.fromCharCode(h); i += 3; continue; } }
        name += String.fromCharCode(b[i++]);
      }
      push({ name }, s);
      continue;
    }
    // number or keyword
    while (i < n && isReg(b[i])) i++;
    if (i === s) { i++; continue; } // a stray delimiter
    const word = latin1(b, s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push(parseFloat(word), s); continue; }
    if (/^[+-]?\.?$/.test(word)) { push(0, s); continue; } // "-" or "." alone
    if (word === 'true' || word === 'false') { push(word === 'true', s); continue; }
    if (word === 'null') { push(null, s); continue; }
    if (stack.length) { stack[stack.length - 1].items.push({ keyword: word }); continue; } // malformed: keep going
    if (word === 'BI') {
      const id = indexOfId(b, i);
      const end = inlineImageEnd(b, id);
      ops.push({ op: 'BI', args: [], start: s, end });
      i = end; args = []; argStart = -1;
      continue;
    }
    ops.push({ op: word, args, start: argStart >= 0 ? argStart : s, end: i });
    args = []; argStart = -1;
  }
  if (stack.length) throw new ContentError('unbalanced brackets');
  return ops;
}
function indexOfId(b, from) {
  for (let i = from; i < b.length - 1; i++) if (b[i] === 0x49 && b[i + 1] === 0x44 && WS[b[i - 1]] && (WS[b[i + 2]] || i + 2 >= b.length)) return i + 3;
  throw new ContentError('inline image without ID');
}

// ------------------------------------------------------------------ matrices (PDF row-vector convention)
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
/** m1 × m2: apply m1, then m2. */
export function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
export const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const isMatrix = (a) => Array.isArray(a) && a.length === 6 && a.every((v) => typeof v === 'number' && Number.isFinite(v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const SHOW = new Set(['Tj', 'TJ', "'", '"']);

/**
 * Follow a content stream. ctx:
 *   resources        passed back to the callbacks (the page's)
 *   font(name, res)  → {key, codes(bytes) → [code lengths] | null, width?(code) → glyph width in 1/1000 text units,
 *                       vertical?} or null for an unknown font
 *   form(name, res)  → {key, bytes, matrix, resources} for a Form XObject, or null (images and unknown names)
 *   width(k, i, code, font) → glyph width in 1/1000 text units (overrides font.width; k = show number on the page)
 *   onShow(ev)       every text-show operator, in page order (see below)
 *   onDo(ev)         every Do of a form: {stream, index, name, form, path, res (the resources the name was found in)}
 *   onOp(ev)         every operator: {stream, index, op, args, gs} (colour tracking etc.)
 *   maxDepth         nested forms followed (default 12)
 * ev for a show: {k, stream (key of the stream it is in), index (operator number in that stream), op, path (the forms
 *   it is inside, outermost first), font, fs, tc, tw, th, rise, render, fill, ctm, vertical, glyphs: [{i, part, off,
 *   len, code, w, space, tj (removal spacing in TJ units, null when fs is 0), x0, y0, x1, y1 (origin and end of the
 *   advance in user space)}]}. Unknown code lengths throw ContentError('codes').
 */
export function walkContent(bytes, ctx) {
  let k = 0;
  const maxDepth = ctx.maxDepth || 12;
  const run = (b, res, streamKey, path, gs0) => {
    const ops = parseOps(b);
    let gs = gs0;
    const stack = [];
    let tm = null, tlm = null;
    for (let index = 0; index < ops.length; index++) {
      const { op, args } = ops[index];
      if (ctx.onOp) ctx.onOp({ stream: streamKey, index, op, args, gs });
      switch (op) {
        case 'q': stack.push(gs); gs = { ...gs }; break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': if (args.length >= 6 && args.slice(-6).every((v) => typeof v === 'number')) gs = { ...gs, ctm: mul(args.slice(-6), gs.ctm) }; break;
        case 'BT': tm = [...IDENTITY]; tlm = [...IDENTITY]; break;
        case 'ET': tm = tlm = null; break;
        case 'Tf': {
          const name = args[args.length - 2], size = args[args.length - 1];
          gs = { ...gs, fontName: name && name.name, fs: num(size), font: name && name.name !== undefined ? ctx.font(name.name, res) : null };
          break;
        }
        case 'Tc': gs = { ...gs, tc: num(args[0]) }; break;
        case 'Tw': gs = { ...gs, tw: num(args[0]) }; break;
        case 'Tz': gs = { ...gs, th: num(args[0], 100) / 100 }; break;
        case 'TL': gs = { ...gs, tl: num(args[0]) }; break;
        case 'Ts': gs = { ...gs, rise: num(args[0]) }; break;
        case 'Tr': gs = { ...gs, render: num(args[0]) }; break;
        case 'Tm': if (tm && args.length >= 6 && isMatrix(args.slice(-6))) { tm = args.slice(-6); tlm = [...tm]; } break;
        case 'Td': case 'TD': if (tm) {
          const tx = num(args[0]), ty = num(args[1]);
          if (op === 'TD') gs = { ...gs, tl: -ty };
          tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = [...tlm];
        } break;
        case 'T*': if (tm) { tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = [...tlm]; } break;
        case 'Do': {
          const name = args[0] && args[0].name;
          if (name === undefined || path.length >= maxDepth) break;
          const form = ctx.form(name, res);
          if (!form) break;
          if (ctx.onDo) ctx.onDo({ stream: streamKey, index, name, form, path, res });
          if (path.some((p) => p.key === form.key)) break; // a form that draws itself
          const inner = { ...gs, ctm: mul(isMatrix(form.matrix) ? form.matrix : IDENTITY, gs.ctm) };
          run(form.bytes, form.resources || res, form.key, [...path, { key: form.key, stream: streamKey, index, name }], inner);
          break;
        }
        default:
          if (SHOW.has(op) && tm) {
            if (op === '"') gs = { ...gs, tw: num(args[0]), tc: num(args[1]) };
            if (op === "'" || op === '"') { tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = [...tlm]; }
            const ev = show(op, args, gs, tm, k, streamKey, index, path);
            tm = ev.tmAfter;
            delete ev.tmAfter;
            k++;
            if (ctx.onShow) ctx.onShow(ev);
          }
      }
    }
  };
  // One text-show operator: its glyphs, with the text matrix moved past each.
  const show = (op, args, gs, tm0, kk, stream, index, path) => {
    const parts = []; // strings and TJ numbers, in order
    if (op === 'TJ') { const a = args[args.length - 1]; if (Array.isArray(a)) for (const x of a) parts.push(x); }
    else { const s = args[args.length - 1]; if (s && s.str) parts.push(s); }
    const font = gs.font;
    const glyphs = [];
    let tm = tm0;
    const fs = gs.fs, th = gs.th;
    const vertical = !!(font && font.vertical);
    let i = 0;
    parts.forEach((p, part) => {
      if (typeof p === 'number') {
        const d = (-p / 1000) * fs;
        tm = vertical ? mul([1, 0, 0, 1, 0, d], tm) : mul([1, 0, 0, 1, d * th, 0], tm);
        return;
      }
      if (!p || !p.str) return;
      const lens = font && font.codes ? font.codes(p.str) : null;
      if (!lens) throw new ContentError('codes');
      let off = 0;
      for (const len of lens) {
        let code = 0;
        for (let j = 0; j < len; j++) code = code * 256 + p.str[off + j];
        const space = len === 1 && code === 32;
        let w = ctx.width ? ctx.width(kk, i, code, font) : null;
        if (w == null) w = font && font.width ? font.width(code) : 0;
        w = num(w);
        const full = m3(tm, gs, fs, th);
        const [x0, y0] = apply(full, 0, 0);
        if (vertical) tm = mul([1, 0, 0, 1, 0, -(w / 1000) * fs + gs.tc + (space ? gs.tw : 0)], tm);
        else tm = mul([1, 0, 0, 1, ((w / 1000) * fs + gs.tc + (space ? gs.tw : 0)) * th, 0], tm);
        const [x1, y1] = apply(m3(tm, gs, fs, th), 0, 0);
        glyphs.push({ i, part, off, len, code, w, space, tj: fs ? -(w + ((gs.tc + (space ? gs.tw : 0)) * 1000) / fs) : null, x0, y0, x1, y1 });
        off += len; i++;
      }
      if (off !== p.str.length) throw new ContentError('codes');
    });
    return { k: kk, stream, index, op, path, font, fontName: gs.fontName, fs, tc: gs.tc, tw: gs.tw, th, rise: gs.rise, render: gs.render, fill: gs.fill, ctm: gs.ctm, tm: tm0, vertical, glyphs, tmAfter: tm };
  };
  const gs0 = { ctm: ctx.ctm || [...IDENTITY], font: null, fontName: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, render: 0, fill: null };
  run(bytes, ctx.resources, ctx.streamKey || 'page', [], gs0);
  return k;
}
/** The glyph-space → user-space matrix for the current glyph: [fs·th, 0, 0, fs, 0, rise] × Tm × CTM. */
const m3 = (tm, gs, fs, th) => mul([fs * th, 0, 0, fs, 0, gs.rise], mul(tm, gs.ctm));
/** Text rendering matrix (for sizes and angles of a show operator's first glyph). */
export const textMatrix = (ev) => mul([ev.fs * ev.th, 0, 0, ev.fs, 0, ev.rise], mul(ev.tm, ev.ctm));

// ------------------------------------------------------------------ writing
const fmt = (v) => {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const hex = (bytes) => { let s = '<'; for (const x of bytes) s += (x < 16 ? '0' : '') + x.toString(16); return s + '>'; };

/**
 * The text of one rewritten show operator: `ev` is its walk event, `remove` a Set of glyph numbers (ev.glyphs[].i) to
 * cut. Kept glyphs keep their bytes; each run of removed glyphs becomes TJ spacing of the same width, so everything after
 * stays in place. ' and " keep their line move (and " its spacing). Returns null when a removed glyph's width can't be
 * expressed (font size 0).
 */
export function rewriteShow(ev, args, remove) {
  const items = []; // strings (byte arrays) and numbers
  const addNum = (v) => { if (typeof items[items.length - 1] === 'number') items[items.length - 1] += v; else items.push(v); };
  const addBytes = (b) => { if (items[items.length - 1] instanceof Array) items[items.length - 1].push(...b); else items.push([...b]); };
  const parts = ev.op === 'TJ' ? (Array.isArray(args[args.length - 1]) ? args[args.length - 1] : []) : [args[args.length - 1]];
  let gi = 0;
  for (let part = 0; part < parts.length; part++) {
    const p = parts[part];
    if (typeof p === 'number') { addNum(p); continue; }
    if (!p || !p.str) continue;
    while (gi < ev.glyphs.length && ev.glyphs[gi].part === part) {
      const g = ev.glyphs[gi++];
      if (remove.has(g.i)) { if (g.tj == null) return null; addNum(g.tj); }
      else addBytes(p.str.subarray(g.off, g.off + g.len));
    }
  }
  const body = '[' + items.filter((x) => typeof x !== 'number' || Math.abs(x) > 0.0005).map((x) => (typeof x === 'number' ? fmt(x) : hex(x))).join(' ') + '] TJ';
  if (ev.op === "'") return 'T* ' + body;
  if (ev.op === '"') return `${fmt(num(args[0]))} Tw ${fmt(num(args[1]))} Tc T* ${body}`;
  return body;
}

/**
 * Rewrite a content stream. edits: [{index (operator number), remove: Set of glyph numbers, ev (walk event)} |
 * {index, rename: new name for a Do}]. Untouched bytes are copied as they are. Returns Uint8Array, or null when one
 * of the removals can't be written (the caller covers the text instead).
 */
export function rewriteContent(bytes, edits) {
  const ops = parseOps(bytes);
  const byIndex = new Map(edits.map((e) => [e.index, e]));
  const chunks = [];
  let at = 0;
  const enc = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  for (let index = 0; index < ops.length; index++) {
    const e = byIndex.get(index);
    if (!e) continue;
    const o = ops[index];
    let text;
    if (e.rename) {
      if (o.op !== 'Do') return null;
      text = `/${escapeName(e.rename)} Do`;
    } else {
      if (!SHOW.has(o.op) || o.op !== e.ev.op) return null;
      text = rewriteShow(e.ev, o.args, e.remove);
      if (text == null) return null;
    }
    chunks.push(bytes.subarray(at, o.start), enc(text));
    at = o.end;
  }
  chunks.push(bytes.subarray(at));
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
const escapeName = (n) => n.replace(/[^!-~]|[()<>[\]{}/%#]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));

// ------------------------------------------------------------------ fonts
/** Code lengths for a CMap's codespace ranges ("begincodespacerange <00> <80> <8140> <9ffc> endcodespacerange"). */
export function parseCodespace(text) {
  const ranges = [];
  const re = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m;
  while ((m = re.exec(text))) {
    const hexes = [...m[1].matchAll(/<([0-9a-fA-F\s]*)>/g)].map((x) => x[1].replace(/\s+/g, ''));
    for (let i = 0; i + 1 < hexes.length; i += 2) {
      const len = hexes[i].length / 2;
      if (len < 1 || len > 4 || hexes[i + 1].length / 2 !== len) continue;
      const lo = [], hi = [];
      for (let j = 0; j < len; j++) { lo.push(parseInt(hexes[i].substr(j * 2, 2), 16)); hi.push(parseInt(hexes[i + 1].substr(j * 2, 2), 16)); }
      ranges.push({ len, lo, hi });
    }
  }
  return ranges;
}
/** Split bytes into codes by codespace ranges (shortest match first, as the PDF reference describes); null if a byte sequence matches no range. */
export function codesByRanges(ranges, bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let len = 0;
    for (let n = 1; n <= 4 && !len; n++) {
      if (i + n > bytes.length) break;
      for (const r of ranges) {
        if (r.len !== n) continue;
        let ok = true;
        for (let j = 0; j < n && ok; j++) ok = bytes[i + j] >= r.lo[j] && bytes[i + j] <= r.hi[j];
        if (ok) { len = n; break; }
      }
    }
    if (!len) return null;
    out.push(len); i += len;
  }
  return out;
}

// ------------------------------------------------------------------ page space ↔ view space
/**
 * A user-space point → view point (y down from the top of the crop box as seen after /Rotate). box: {x, y, width,
 * height} (the crop box), rot: 0/90/180/270.
 */
export function userToView(box, rot, x, y) {
  const r = ((Math.round(rot / 90) * 90) % 360 + 360) % 360, W = box.width, H = box.height;
  const ux = x - box.x, uy = y - box.y;
  let vx, vy;
  if (r === 0) { vx = ux; vy = uy; } else if (r === 90) { vx = uy; vy = W - ux; } else if (r === 180) { vx = W - ux; vy = H - uy; } else { vx = H - uy; vy = ux; }
  const vh = r % 180 ? W : H;
  return [vx, vh - vy];
}
/** A view point (y down) → user space. */
export function viewToUserPoint(box, rot, vx, vyDown) {
  const r = ((Math.round(rot / 90) * 90) % 360 + 360) % 360, W = box.width, H = box.height;
  const vh = r % 180 ? W : H;
  const vy = vh - vyDown;
  let x, y;
  if (r === 0) { x = vx; y = vy; } else if (r === 90) { x = W - vy; y = vx; } else if (r === 180) { x = W - vx; y = H - vy; } else { x = vy; y = H - vx; }
  return [box.x + x, box.y + y];
}
