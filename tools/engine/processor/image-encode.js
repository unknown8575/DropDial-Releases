// Writers for the image formats the browser can't encode itself: BMP, TIFF, GIF and ICO.
import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc.esm.js';

/** 24-bit BMP (pixels already flattened onto a background). */
export function encodeBmp({ data, width, height }) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  v.setUint32(2, size, true); v.setUint32(10, 54, true);
  v.setUint32(14, 40, true); v.setInt32(18, width, true); v.setInt32(22, height, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * height, true);
  v.setInt32(38, 2835, true); v.setInt32(42, 2835, true); // 72 dpi
  for (let y = 0; y < height; y++) {
    let o = 54 + (height - 1 - y) * row, s = y * width * 4;
    for (let x = 0; x < width; x++, s += 4) { out[o++] = data[s + 2]; out[o++] = data[s + 1]; out[o++] = data[s]; }
  }
  return out;
}

/** Uncompressed TIFF: RGBA (unassociated alpha, as canvas pixels are) when the picture has transparency, else RGB. */
export function encodeTiff({ data, width, height }, alpha = true) {
  if (alpha) return new Uint8Array(self.UTIF.encodeImage(data, width, height, { t305: ['DropDial'], t338: [2] }));
  // Baseline RGB TIFF, written here: header, the pixels as one strip, then the directory.
  const strip = width * height * 3;
  const tags = [[256, 4, width], [257, 4, height], [258, 3, 3], [259, 3, 1], [262, 3, 2], [273, 4, 8], [277, 3, 3], [278, 4, height], [279, 4, strip], [284, 3, 1], [305, 2, 0]];
  const soft = new TextEncoder().encode('DropDial\0');
  const ifd = 8 + strip + (strip % 2), bps = ifd + 2 + tags.length * 12 + 4, sw = bps + 6;
  const out = new Uint8Array(sw + soft.length);
  const v = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; v.setUint16(2, 42, true); v.setUint32(4, ifd, true);
  for (let i = 0, o = 8; i < width * height * 4; i += 4) { out[o++] = data[i]; out[o++] = data[i + 1]; out[o++] = data[i + 2]; }
  v.setUint16(ifd, tags.length, true);
  tags.forEach(([tag, type, val], k) => {
    const e = ifd + 2 + k * 12;
    v.setUint16(e, tag, true); v.setUint16(e + 2, type, true);
    if (tag === 258) { v.setUint32(e + 4, 3, true); v.setUint32(e + 8, bps, true); }
    else if (tag === 305) { v.setUint32(e + 4, soft.length, true); v.setUint32(e + 8, sw, true); }
    else { v.setUint32(e + 4, 1, true); if (type === 3) v.setUint16(e + 8, val, true); else v.setUint32(e + 8, val, true); }
  });
  v.setUint32(ifd + 2 + tags.length * 12, 0, true);
  v.setUint16(bps, 8, true); v.setUint16(bps + 2, 8, true); v.setUint16(bps + 4, 8, true);
  out.set(soft, sw);
  return out;
}

/** Single-frame GIF with an optimised 256-colour palette; fully transparent pixels stay transparent. */
export function encodeGif({ data, width, height }, alpha) {
  const format = alpha ? 'rgba4444' : 'rgb565';
  const palette = quantize(data, 256, alpha ? { format, oneBitAlpha: true } : { format });
  const index = applyPalette(data, palette, format);
  const clear = alpha ? palette.findIndex((c) => c[3] === 0) : -1;
  const gif = GIFEncoder();
  gif.writeFrame(index, width, height, { palette, transparent: clear >= 0, transparentIndex: Math.max(0, clear) });
  gif.finish();
  return gif.bytes();
}

/** ICO holding PNG pictures of each given size (square; the picture is fitted and centred). */
export async function encodeIco(source, sizes) {
  const images = [];
  for (const s of sizes) {
    const c = new OffscreenCanvas(s, s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const k = s / Math.max(source.width, source.height);
    const w = Math.max(1, Math.round(source.width * k)), h = Math.max(1, Math.round(source.height * k));
    ctx.drawImage(source, (s - w) / 2, (s - h) / 2, w, h);
    images.push(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  const head = 6 + 16 * sizes.length;
  const out = new Uint8Array(head + images.reduce((n, b) => n + b.length, 0));
  const v = new DataView(out.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, sizes.length, true);
  let off = head;
  sizes.forEach((s, k) => {
    const e = 6 + k * 16;
    out[e] = s >= 256 ? 0 : s; out[e + 1] = s >= 256 ? 0 : s;
    v.setUint16(e + 4, 1, true); v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, images[k].length, true); v.setUint32(e + 12, off, true);
    out.set(images[k], off);
    off += images[k].length;
  });
  return out;
}
