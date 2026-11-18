// Crop & rotate: the app's Crop & straighten and Rotate & flip tools in one page. The frame, shapes and turns use
// the app's own maths (src/shared/photo.mjs: CROP_SHAPES, dragHandle, moveRect, largestRect, drawTurned); the picture
// is made by the processor's photo.rotate and photo.crop, as in the app.
import { tool, engine, LIMITS, h, ic, announce, extFor } from './ui.js';
import * as P from '../../tools/engine/shared/photo.mjs';

const QUALITY = { jpg: 0.9, webp: 0.85 };
const st = { src: null, file: null, turn: { turns: 0, flipH: false, flipV: false }, rect: null, VW: 0, VH: 0, k: 1 };
let ui = null;

const aspectOf = (shape) => {
  const s = P.CROP_SHAPES.find((x) => x.value === shape);
  if (!s || s.ratio === null) return null;
  return s.ratio === 'original' ? st.VW / st.VH : s.ratio;
};
const whole = () => !st.rect || (st.rect.x < 0.5 && st.rect.y < 0.5 && st.rect.w > st.VW - 1 && st.rect.h > st.VH - 1);
const turned = () => !P.isIdentityTurn(st.turn);

function layoutView(app) {
  const [vw, vh] = P.turnedSize(st.src.width, st.src.height, st.turn);
  st.VW = vw; st.VH = vh;
  const a = aspectOf(app.o.shape);
  st.rect = a ? P.largestRect(a, 0, vw, vh) : { x: 0, y: 0, w: vw, h: vh };
}

function draw(app) {
  if (!ui || !st.src) return;
  P.drawTurned(ui.canvas, st.src, st.src.width, st.src.height, st.turn);
  place(app);
}
function place(app) {
  const r = st.rect;
  Object.assign(ui.rect.style, { left: (r.x / st.VW) * 100 + '%', top: (r.y / st.VH) * 100 + '%', width: (r.w / st.VW) * 100 + '%', height: (r.h / st.VH) * 100 + '%' });
  const f = app.files[0];
  const [TW, TH] = P.turnedSize(f.meta.w || st.src.width, f.meta.h || st.src.height, st.turn);
  const ow = Math.max(1, Math.round((r.w / st.VW) * TW)), oh = Math.max(1, Math.round((r.h / st.VH) * TH));
  ui.info.textContent = `${whole() ? 'Whole picture' : 'Crop'} ${ow} × ${oh} px · ${P.describeTurn(st.turn)}`;
}

function stage(app, el) {
  const f = app.files.find((x) => !x.error);
  if (!f) { el.replaceChildren(); ui = null; return; }
  if (ui && ui.file === f) { if (!el.contains(ui.panel)) el.replaceChildren(ui.panel); return; }
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const rect = h('div', { class: 'crop-rect', tabindex: '0', role: 'group', 'aria-label': 'Crop frame. Arrow keys move it; Shift and the arrow keys change its size.' },
    ...['tl', 'tr', 'bl', 'br'].map((k) => h('span', { class: 'hdl ' + k, 'data-h': k })));
  const box = h('div', { class: 'crop-box' }, canvas, rect);
  const info = h('p', { class: 'fine crop-size', 'aria-live': 'polite' }, 'Loading the picture…');
  const turn = (fn, say) => () => { st.turn = fn(st.turn); layoutView(app); draw(app); app.update(); announce(say + '. ' + P.describeTurn(st.turn)); };
  const bar = h('div', { class: 'panel-bar' }, info, h('div', { class: 'tbtns' },
    h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Turn left', title: 'Turn left', onclick: turn((t) => P.turnBy(t, -1), 'Turned left') }, ic('rotate-ccw')),
    h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Turn right', title: 'Turn right', onclick: turn((t) => P.turnBy(t, 1), 'Turned right') }, ic('rotate-cw')),
    h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Flip left to right', title: 'Flip left to right', onclick: turn((t) => P.flipBy(t, 'h'), 'Flipped') }, ic('flip-horizontal-2')),
    h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Flip top to bottom', title: 'Flip top to bottom', onclick: turn((t) => P.flipBy(t, 'v'), 'Flipped') }, ic('flip-vertical-2')),
    h('button', { type: 'button', class: 'tbtn', 'aria-label': 'Reset', title: 'Reset', onclick: () => { st.turn = { turns: 0, flipH: false, flipV: false }; layoutView(app); draw(app); app.update(); announce('Reset'); } }, ic('undo-2'))));
  const panel = h('div', { class: 'panel' }, h('div', { class: 'pv crop-pv' }, box), bar);
  ui = { file: f, canvas, rect, info, panel, box };
  el.replaceChildren(panel);

  // Dragging the frame or a corner (mouse, pen or finger).
  let drag = null;
  const toView = (e) => { const b = canvas.getBoundingClientRect(); return [((e.clientX - b.left) / b.width) * st.VW, ((e.clientY - b.top) / b.height) * st.VH]; };
  box.addEventListener('pointerdown', (e) => {
    if (!st.src || e.button > 0) return;
    const hd = e.target.closest('[data-h]');
    if (!hd && !e.target.closest('.crop-rect')) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, h: hd ? hd.dataset.h : null, start: toView(e), rect: { ...st.rect } };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const [px, py] = toView(e);
    const opts = { aspect: aspectOf(app.o.shape), deg: 0, W: st.VW, H: st.VH, min: Math.max(8, Math.min(st.VW, st.VH) * 0.04) };
    st.rect = drag.h ? P.dragHandle(drag.rect, drag.h, px, py, opts) : P.moveRect(drag.rect, px - drag.start[0], py - drag.start[1], 0, st.VW, st.VH);
    place(app);
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; app.update(); } };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  rect.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d || !st.src) return;
    e.preventDefault();
    const step = Math.max(1, Math.min(st.VW, st.VH) * 0.02);
    const r = st.rect;
    if (e.shiftKey) st.rect = P.dragHandle(r, 'br', r.x + r.w + d[0] * step, r.y + r.h + d[1] * step, { aspect: aspectOf(app.o.shape), deg: 0, W: st.VW, H: st.VH, min: 8 });
    else st.rect = P.moveRect(r, d[0] * step, d[1] * step, 0, st.VW, st.VH);
    place(app); app.update();
  });

  // The picture, made small enough to draw quickly (the result is made from the full picture).
  (async () => {
    try {
      const r = await engine.run('image.preview', { bytes: new Uint8Array(await f.file.arrayBuffer()), maxSide: 1600, limits: LIMITS });
      if (ui.file !== f) return;
      st.src = await createImageBitmap(new Blob([r.bytes], { type: r.mime }));
      if (!f.meta.w) { f.meta.w = r.width; f.meta.h = r.height; }
      st.turn = { turns: 0, flipH: false, flipV: false };
      layoutView(app); draw(app); app.update();
    } catch (e) { info.textContent = e.user ? e.message : 'This picture couldn’t be shown.'; }
  })();
}

tool({
  kinds: ['image'], multiple: false, hideList: false,
  pick: 'Choose a picture', drop: 'JPEG, PNG, HEIC, WebP, TIFF, BMP or SVG.',
  options: [
    { id: 'shape', type: 'chips', label: 'Shape', value: 'free', choices: P.CROP_SHAPES.map((s) => ({ value: s.value, label: s.label })),
      hint: (o) => (o.shape === 'passport' ? '35 × 45 mm, the usual passport photo shape.' : o.shape === '4:5' ? 'Instagram portrait posts.' : o.shape === '9:16' ? 'Stories, Reels and Shorts.' : o.shape === 'free' ? 'Drag the corners to any shape.' : '') },
    { id: 'format', type: 'select', label: 'Save as', value: 'same', more: true, choices: [{ value: 'same', label: 'Same as original' }, { value: 'jpg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }] },
  ],
  onSet(app, id) { if (id === 'shape' && st.src) { const a = aspectOf(app.o.shape); if (a) st.rect = P.largestRect(a, 0, st.VW, st.VH); place(app); } },
  stage,
  reset() { st.src = null; ui = null; },
  check() { return !st.src ? 'Loading the picture…' : whole() && !turned() ? 'Drag the frame, pick a shape, or turn the picture first.' : ''; },
  action: () => (!whole() && turned() ? 'Crop and turn' : turned() ? 'Turn the picture' : 'Crop the picture'),
  compare: false,
  async run(f, o, job) {
    const out = P.outputFormat(f.format, o.format);
    const crop = !whole();
    let bytes = await job.bytes(), r = null;
    if (turned()) {
      job.progress(crop ? 0.1 : null);
      r = await engine.run('photo.rotate', { bytes, turn: st.turn, to: crop ? 'png' : out.to, quality: QUALITY[out.to], limits: LIMITS }, job);
      bytes = r.bytes;
      job.progress(crop ? 0.5 : null);
    }
    if (crop) {
      const n = { x: st.rect.x / st.VW, y: st.rect.y / st.VH, w: st.rect.w / st.VW, h: st.rect.h / st.VH };
      r = await engine.run('photo.crop', { bytes, rect: n, angle: 0, to: out.to, quality: QUALITY[out.to], limits: LIMITS }, job);
    }
    const suffix = crop ? 'cropped' : st.turn.turns ? 'rotated' : 'flipped';
    return { outputs: [{ name: job.name(f.stem, extFor(f, out.to), suffix), bytes: r.bytes, w: r.width, h: r.height }], note: out.note || '' };
  },
});
