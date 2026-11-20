// Text drawn into pixels without a canvas, so the app's processor, the website and the unit tests (Node) draw exactly
// the same thing: glyph outlines from fontkit (the bundled Noto fonts, shaped by fontkit, Hindi included) are turned
// into polygons and filled by a small scanline rasteriser (5 sub-rows per pixel, exact coverage across each row).
// Pure code; used by src/shared/imagetext.mjs.

const SUB = 5;

/**
 * Glyph outlines as closed polygons in pixels. `cmds`: fontkit path commands ({command, args}, font units, y up);
 * `map(x, y)` → [px, py] (pixels, y down). Curves are flattened finely enough for a smooth edge at any size.
 */
export function polygons(cmds, map, out = []) {
  let cur = null, sx = 0, sy = 0, lx = 0, ly = 0;
  const start = (x, y) => { if (cur && cur.length > 2) out.push(cur); cur = [map(x, y)]; sx = lx = x; sy = ly = y; };
  const line = (x, y) => { if (!cur) start(lx, ly); cur.push(map(x, y)); lx = x; ly = y; };
  const steps = (x0, y0, x1, y1) => { const a = map(x0, y0), b = map(x1, y1); return Math.max(2, Math.min(24, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2))); };
  for (const c of cmds) {
    const a = c.args;
    switch (c.command) {
      case 'moveTo': start(a[0], a[1]); break;
      case 'lineTo': line(a[0], a[1]); break;
      case 'quadraticCurveTo': {
        const n = steps(lx, ly, a[2], a[3]);
        const x0 = lx, y0 = ly;
        for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; line(u * u * x0 + 2 * u * t * a[0] + t * t * a[2], u * u * y0 + 2 * u * t * a[1] + t * t * a[3]); }
        break;
      }
      case 'bezierCurveTo': {
        const n = steps(lx, ly, a[4], a[5]) + 2;
        const x0 = lx, y0 = ly;
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          line(u * u * u * x0 + 3 * u * u * t * a[0] + 3 * u * t * t * a[2] + t * t * t * a[4], u * u * u * y0 + 3 * u * u * t * a[1] + 3 * u * t * t * a[3] + t * t * t * a[5]);
        }
        break;
      }
      case 'closePath': if (cur) { line(sx, sy); } break;
      default: break;
    }
  }
  if (cur && cur.length > 2) out.push(cur);
  return out;
}

/** The bounds of polygons: [x0, y0, x1, y1] (or null). */
export function bounds(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/**
 * Coverage (0–1) of polygons (non-zero winding) over the rectangle [rx, ry, rw, rh] of pixels: a Float32Array of
 * rw × rh. Pixel (i, j) covers [rx + i, rx + i + 1) × [ry + j, ry + j + 1).
 */
export function coverage(polys, rx, ry, rw, rh) {
  const cov = new Float32Array(rw * rh);
  if (rw <= 0 || rh <= 0) return cov;
  // Edges, top to bottom: [yTop, yBottom, x at yTop, dx/dy, winding].
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
      if (ay === by) continue;
      const down = by > ay;
      const [tx, ty, ex, ey] = down ? [ax, ay, bx, by] : [bx, by, ax, ay];
      edges.push([ty - ry, ey - ry, tx - rx, (ex - tx) / (ey - ty), down ? 1 : -1]);
    }
  }
  edges.sort((a, b) => a[0] - b[0]);
  const xs = [];
  let next = 0;
  let active = [];
  const w = 1 / SUB;
  for (let j = 0; j < rh; j++) {
    for (let k = 0; k < SUB; k++) {
      const y = j + (k + 0.5) / SUB;
      while (next < edges.length && edges[next][0] <= y) active.push(edges[next++]);
      active = active.filter((e) => e[1] > y);
      xs.length = 0;
      for (const e of active) if (e[0] <= y) xs.push([e[2] + (y - e[0]) * e[3], e[4]]);
      if (xs.length < 2) continue;
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i][1];
        if (!wind) continue;
        let a = Math.max(0, xs[i][0]), b = Math.min(rw, xs[i + 1][0]);
        if (b <= a) continue;
        const row = j * rw;
        const ia = Math.floor(a), ib = Math.floor(b);
        if (ia === ib) { cov[row + ia] += (b - a) * w; continue; }
        cov[row + ia] += (ia + 1 - a) * w;
        for (let q = ia + 1; q < ib; q++) cov[row + q] += w;
        if (ib < rw) cov[row + ib] += (b - ib) * w;
      }
    }
  }
  for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1;
  return cov;
}
