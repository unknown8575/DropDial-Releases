// Read QR code (QA round 7): every code in a picture, not just one. jsQR reads one code at a time and gets confused
// when it sees the finder patterns (the three big squares) of two codes, so the picture is read whole, then in halves
// and overlapping tiles; each code found is painted over so the next read can't find it again. Finder patterns are
// counted on their own, so the search knows when every code it saw has been read, and the window can say "a code is
// there but couldn't be read" instead of blaming sharpness. Pure functions on RGBA pixels (unit-tested in Node).

/** Counts the QR finder patterns (dark 1:1:3:1:1 rings, across and down) in RGBA pixels: about 3 per code. */
export function countFinders(img) {
  const { data, width: W, height: H } = img;
  const gray = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) { const v = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8; gray[j] = v; hist[v]++; }
  // Otsu's threshold: dark modules vs light paper.
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0, sB = 0, best = 0, th = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = gray.length - wB; if (!wF) break;
    sB += v * hist[v];
    const d = sB / wB - (sum - sB) / wF, between = wB * wF * d * d;
    if (between > best) { best = between; th = v; }
  }
  const dark = (x, y) => gray[y * W + x] <= th;
  const ok = (runs) => {
    const total = runs.reduce((a, b) => a + b, 0);
    if (total < 7) return 0;
    const m = total / 7;
    const want = [1, 1, 3, 1, 1];
    return runs.every((r, i) => Math.abs(r - m * want[i]) <= m * want[i] * 0.5 + 0.5) ? m : 0;
  };
  // Runs along a column through (x, y): up and down from the centre of the middle square.
  const column = (x, y) => {
    if (!dark(x, y)) return null;
    const runs = [0, 0, 0, 0, 0];
    let yy = y;
    while (yy >= 0 && dark(x, yy)) { runs[2]++; yy--; }
    while (yy >= 0 && !dark(x, yy)) { runs[1]++; yy--; }
    while (yy >= 0 && dark(x, yy)) { runs[0]++; yy--; }
    const top = yy + 1;
    yy = y + 1;
    while (yy < H && dark(x, yy)) { runs[2]++; yy++; }
    while (yy < H && !dark(x, yy)) { runs[3]++; yy++; }
    while (yy < H && dark(x, yy)) { runs[4]++; yy++; }
    if (!runs[0] || !runs[1] || !runs[3] || !runs[4]) return null;
    const m = ok(runs);
    return m ? { cy: top + runs[0] + runs[1] + runs[2] / 2, m } : null;
  };
  const hits = [];
  const step = Math.max(1, Math.floor(H / 500));
  for (let y = 0; y < H; y += step) {
    let x = 0;
    while (x < W && !dark(x, y)) x++;
    // Alternating runs, starting with a dark one.
    const lens = [], starts = [];
    while (x < W) {
      const d = dark(x, y);
      let e = x;
      while (e < W && dark(e, y) === d) e++;
      lens.push(e - x); starts.push(x);
      x = e;
    }
    for (let i = 0; i + 4 < lens.length; i += 2) {
      const five = lens.slice(i, i + 5);
      const m = ok(five);
      if (!m) continue;
      const cx = Math.floor(starts[i + 2] + lens[i + 2] / 2);
      const v = column(cx, y);
      if (v && Math.abs(v.m - m) <= m * 0.6) hits.push({ x: cx, y: v.cy, m });
    }
  }
  // Hits of one pattern are close together; a real pattern is hit on several rows.
  const groups = [];
  for (const h of hits) {
    const g = groups.find((q) => Math.hypot(q.x - h.x, q.y - h.y) <= Math.max(q.m, h.m) * 2.5);
    if (g) { g.n++; g.x += (h.x - g.x) / g.n; g.y += (h.y - g.y) / g.n; } else groups.push({ x: h.x, y: h.y, m: h.m, n: 1 });
  }
  return groups.filter((g) => g.n >= 2).length;
}

function crop(img, x0, y0, w, h) {
  if (x0 === 0 && y0 === 0 && w === img.width && h === img.height) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { data: out, width: w, height: h };
}

const centre = (q) => ({ x: q.reduce((a, p) => a + p.x, 0) / 4, y: q.reduce((a, p) => a + p.y, 0) / 4 });
function inside(p, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
  }
  return true;
}
/** Paint a found code (its corners, grown a little to cover the quiet border) in plain white. */
function paint(img, quad) {
  const c = centre(quad);
  const q = quad.map((p) => ({ x: c.x + (p.x - c.x) * 1.25, y: c.y + (p.y - c.y) * 1.25 }));
  const x0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.x)))), x1 = Math.min(img.width - 1, Math.ceil(Math.max(...q.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y)))), y1 = Math.min(img.height - 1, Math.ceil(Math.max(...q.map((p) => p.y))));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside({ x, y }, q)) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = 255;
    }
  }
}

/** Overlapping windows: halves (side by side, then one above the other), quarters, ninths — as [x, y, w, h]. */
function windows(W, H) {
  const out = [];
  const grid = (nx, ny, size) => {
    const w = Math.min(W, Math.round(W * (nx === 1 ? 1 : size))), h = Math.min(H, Math.round(H * (ny === 1 ? 1 : size)));
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      out.push([nx === 1 ? 0 : Math.round((W - w) * i / (nx - 1)), ny === 1 ? 0 : Math.round((H - h) * j / (ny - 1)), w, h]);
    }
  };
  grid(2, 1, 0.6); grid(1, 2, 0.6); grid(2, 2, 0.6); grid(3, 3, 0.45);
  return out;
}

/**
 * Every QR code in RGBA pixels `img` ({data, width, height}; painted over where codes are found). `jsQR` is the
 * decoder. Returns {codes: [{text, quad}] in reading order (top to bottom, left to right), finders: patterns seen}.
 */
export function scanCodes(img, jsQR, { max = 12, budgetMs = 5000 } = {}) {
  const t0 = Date.now();
  const finders = countFinders(img);
  const found = [];
  const read = (x, y, w, h) => {
    for (let k = 0; k < 6 && found.length < max; k++) {
      const sub = crop(img, x, y, w, h);
      const c = jsQR(sub.data, w, h, { inversionAttempts: 'attemptBoth' });
      if (!c || typeof c.data !== 'string' || !c.location) return;
      const L = c.location;
      const quad = [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].map((p) => ({ x: p.x + x, y: p.y + y }));
      const mid = centre(quad);
      if (!found.some((f) => f.text === c.data && inside(mid, f.quad))) found.push({ text: c.data, quad });
      paint(img, quad);
    }
  };
  read(0, 0, img.width, img.height);
  // More codes than read so far? Each code has three finder patterns.
  const more = () => found.length < max && Date.now() - t0 < budgetMs && (finders >= 3 * (found.length + 1) || (!found.length && finders >= 2));
  if (more()) for (const [x, y, w, h] of windows(img.width, img.height)) { if (!more()) break; if (w >= 21 && h >= 21) read(x, y, w, h); }
  const rows = (q) => centre(q);
  found.sort((a, b) => {
    const p = rows(a.quad), q = rows(b.quad);
    const tall = Math.max(Math.abs(a.quad[3].y - a.quad[0].y), 1);
    return Math.abs(p.y - q.y) < tall / 2 ? p.x - q.x : p.y - q.y;
  });
  return { codes: found, finders };
}

// ------------------------------------------------------------------ small pictures (QA round 8)
// jsQR needs a few pixels per module and a quiet border: a sharp 33 × 33 px code (one pixel per module) is read
// once it is made larger pixel for pixel (no smoothing) with a white border round it.

/** How much to enlarge a w × h picture before reading it: ×2…×8 (to about 800 px) when it is under 400 px, else 1. */
export function smallScale(w, h) {
  const m = Math.max(w, h);
  return m >= 400 || m < 1 ? 1 : Math.min(8, Math.max(2, Math.floor(800 / m)));
}

/** RGBA pixels made `factor` times larger (nearest neighbour), with `border` white pixels (in the source's pixels) round them. */
export function enlarge(img, factor, border = 0) {
  const k = Math.max(1, Math.floor(factor)), b = Math.max(0, Math.floor(border));
  const W = (img.width + 2 * b) * k, H = (img.height + 2 * b) * k;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < img.height; y++) {
    const row = new Uint8ClampedArray(img.width * k * 4);
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      for (let j = 0; j < k; j++) row.set(img.data.subarray(i, i + 4), (x * k + j) * 4);
    }
    for (let j = 0; j < k; j++) out.set(row, (((y + b) * k + j) * W + b * k) * 4);
  }
  return { data: out, width: W, height: H };
}

/** Does dark ink touch the picture's edge (a code that may be cut off)? */
export function inkAtEdge(img) {
  const { data, width: W, height: H } = img;
  const dark = (x, y) => { const i = (y * W + x) * 4; return (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8 < 100; };
  let n = 0;
  for (let x = 0; x < W; x++) { if (dark(x, 0)) n++; if (dark(x, H - 1)) n++; }
  for (let y = 0; y < H; y++) { if (dark(0, y)) n++; if (dark(W - 1, y)) n++; }
  return n >= Math.max(3, Math.round((W + H) * 0.02));
}

/**
 * Read a picture's codes, enlarging small ones first (see smallScale). Returns scanCodes's answer plus `edge` (ink at
 * the picture's edge) for the "cut off" hint.
 */
export function scanPicture(img, jsQR, opts) {
  const edge = inkAtEdge(img);
  const k = smallScale(img.width, img.height);
  if (k > 1) {
    const b = Math.max(4, Math.round(Math.max(img.width, img.height) * 0.12));
    const r = scanCodes(enlarge(img, k, b), jsQR, opts);
    if (r.codes.length) return { ...r, codes: r.codes.map((c) => ({ ...c, quad: c.quad.map((p) => ({ x: p.x / k - b, y: p.y / k - b })) })), edge };
  }
  return { ...scanCodes(img, jsQR, opts), edge };
}
