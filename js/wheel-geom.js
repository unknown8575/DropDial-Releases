// The DropDial wheel's geometry, the same numbers as the app's wheel (src/renderer/components/wheel.js):
// a 440-unit ring of rounded panes, outer radius 206, inner radius 98, 9-unit corners and a small gap.
// Shared by the page script (the live hero wheel) and build.mjs (the pre-drawn wheel in the HTML).
export const SIZE = 440, C = SIZE / 2, R = 206, r = 98, CORNER = 9, GAP = 0.024;

const polar = (rad, a) => [C + rad * Math.sin(a), C - rad * Math.cos(a)];
const pt = (p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2);

export function segmentPath(index, count) {
  const step = (Math.PI * 2) / count;
  const s = index * step - step / 2 + GAP, e = index * step + step / 2 - GAP;
  const ro = CORNER / R, ri = CORNER / r;
  const large = e - s - 2 * ro > Math.PI ? 1 : 0;
  return [
    'M', pt(polar(R, s + ro)),
    'A', R, R, 0, large, 1, pt(polar(R, e - ro)),
    'Q', pt(polar(R, e)), pt(polar(R - CORNER, e)),
    'L', pt(polar(r + CORNER, e)),
    'Q', pt(polar(r, e)), pt(polar(r, e - ri)),
    'A', r, r, 0, large, 0, pt(polar(r, s + ri)),
    'Q', pt(polar(r, s)), pt(polar(r + CORNER, s)),
    'L', pt(polar(R - CORNER, s)),
    'Q', pt(polar(R, s)), pt(polar(R, s + ro)), 'Z',
  ].join(' ');
}

export function labelPoint(index, count) {
  const step = (Math.PI * 2) / count;
  return polar((R + r) / 2 + 2, index * step);
}

/** Unit vector pointing out through the middle of a pane (for the 7-unit lift). */
export function outward(index, count) {
  const a = index * ((Math.PI * 2) / count);
  return [Math.sin(a), -Math.cos(a)];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * SVG markup for a ring of labels. `hot` is the lit pane's index (or -1). Each pane is
 * <g.seg> (lifts outward when lit) > <g.pop> (springs in) > path + label.
 */
export function ringMarkup(labels, hot = -1, { interactive = true } = {}) {
  const n = labels.length;
  const font = n > 10 ? ' tiny' : n > 7 ? ' small' : '';
  let out = '';
  labels.forEach((label, i) => {
    const [lx, ly] = labelPoint(i, n);
    const [ox, oy] = outward(i, n);
    const a11y = interactive ? ` role="option" aria-selected="${i === hot}" aria-label="${esc(label)}" id="seg-${i}"` : '';
    out += `<g class="seg${i === hot ? ' on' : ''}" data-i="${i}" style="--ox:${(ox * 7).toFixed(2)}px;--oy:${(oy * 7).toFixed(2)}px;--d:${i * 22}ms"${a11y}>`
      + `<g class="pop"><path class="pane" d="${segmentPath(i, n)}"/>`
      + `<g transform="translate(${lx.toFixed(2)} ${ly.toFixed(2)})"><text class="lbl${font}" x="0" y="0">${esc(label)}</text></g></g></g>`;
  });
  return out;
}
