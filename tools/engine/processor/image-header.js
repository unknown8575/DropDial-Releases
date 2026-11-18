// What kind of image some bytes are, and their pixel size, read from headers before anything is decoded,
// so that decompression bombs (a tiny file claiming a huge picture) are refused before using memory.

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

/** The image kind from its first bytes (not its name): 'jpg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'heic', 'avif', 'svg' or null. */
export function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 2) === 'BM') return 'bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  if ((ascii(b, 0, 2) === 'II' && b[2] === 42 && b[3] === 0) || (ascii(b, 0, 2) === 'MM' && b[2] === 0 && b[3] === 42)) return 'tiff';
  if (ascii(b, 4, 4) === 'ftyp') {
    const size = Math.min(u32be(b, 0), 256, b.length);
    const brands = [];
    for (let i = 8; i + 4 <= size; i += 4) brands.push(ascii(b, i, 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some((x) => /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(x))) return 'heic';
    return null;
  }
  const head = new TextDecoder().decode(b.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function pngSize(b, at = 0) {
  if (b.length < at + 24 || ascii(b, at + 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, at + 16), height: u32be(b, at + 20) };
}

function jpegSize(b) {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(b, i + 5), width: u16be(b, i + 7), components: b[i + 9] };
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) return { width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  return null;
}

function bmpSize(b) {
  if (b.length < 26) return null;
  return u32le(b, 14) === 12 ? { width: u16le(b, 18), height: u16le(b, 20) } : { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
}

/** An icon's largest picture. Embedded PNGs are measured themselves, as the directory can claim any size. */
function icoSize(b) {
  const n = u16le(b, 4);
  if (!n || b.length < 6 + n * 16) return null;
  let best = null;
  for (let k = 0; k < n; k++) {
    const e = 6 + k * 16;
    const off = u32le(b, e + 12);
    let s = { width: b[e] || 256, height: b[e + 1] || 256 };
    if (off + 8 <= b.length && b[off] === 0x89 && ascii(b, off + 1, 3) === 'PNG') s = pngSize(b, off);
    else if (off + 12 <= b.length) s = { width: Math.max(s.width, Math.abs(i32le(b, off + 4))), height: Math.max(s.height, Math.abs(i32le(b, off + 8)) / 2) };
    if (!s) return null;
    if (!best || s.width * s.height > best.width * best.height) best = s;
  }
  return best;
}

/** HEIF/AVIF: the largest 'ispe' (image spatial extent) property in the top-level 'meta' box. */
function heifSize(b) {
  for (let i = 0; i + 8 <= b.length;) {
    let size = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (size === 1) size = Number(new DataView(b.buffer, b.byteOffset + i + 8, 8).getBigUint64(0));
    else if (size === 0) size = b.length - i;
    if (size < 8) return null;
    if (type === 'meta') {
      let best = null;
      const end = Math.min(b.length, i + size);
      for (let j = i + 8; j + 20 <= end; j++) {
        if (b[j] !== 0x69 || ascii(b, j, 4) !== 'ispe') continue; // 'i'
        const s = { width: u32be(b, j + 8), height: u32be(b, j + 12) };
        if (!best || s.width * s.height > best.width * best.height) best = s;
      }
      return best;
    }
    i += size;
  }
  return null;
}

/** Pixel size {width, height} from the header, or null when the header can't be read. */
export function headerSize(b, kind) {
  switch (kind) {
    case 'png': return pngSize(b);
    case 'jpg': return jpegSize(b);
    case 'gif': return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
    case 'webp': return webpSize(b);
    case 'bmp': return bmpSize(b);
    case 'ico': return icoSize(b);
    case 'heic': case 'avif': return heifSize(b);
    default: return null;
  }
}

/** Number of frames in a GIF (1 for a still GIF). Walks the blocks without decoding pixels. */
export function gifFrames(b) {
  let i = 13, frames = 0;
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7));
  const skipSubBlocks = () => { while (i < b.length && b[i] !== 0) i += b[i] + 1; i++; };
  while (i < b.length) {
    const t = b[i];
    if (t === 0x3b) break;
    if (t === 0x21) { i += 2; skipSubBlocks(); continue; }
    if (t !== 0x2c) break;
    frames++;
    const flags = b[i + 9];
    i += 10;
    if (flags & 0x80) i += 3 * (2 << (flags & 7));
    i++; // LZW minimum code size
    skipSubBlocks();
  }
  return Math.max(1, frames);
}

/** JPEG EXIF orientation (1–8; 1 when absent). */
export function jpegOrientation(b) {
  for (let i = 2; i + 4 < b.length;) {
    if (b[i] !== 0xff) return 1;
    const m = b[i + 1], len = u16be(b, i + 2);
    if (m === 0xda) return 1;
    if (m === 0xe1 && ascii(b, i + 4, 4) === 'Exif') {
      const t = i + 10, le = ascii(b, t, 2) === 'II';
      const r16 = (k) => (le ? u16le(b, k) : u16be(b, k));
      const r32 = (k) => (le ? u32le(b, k) : u32be(b, k));
      const ifd = t + r32(t + 4);
      const n = r16(ifd);
      for (let k = 0; k < n && ifd + 2 + k * 12 + 10 <= b.length; k++) {
        const e = ifd + 2 + k * 12;
        if (r16(e) === 0x0112) return r16(e + 8) || 1;
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

export const jpegComponents = (b) => (jpegSize(b) || {}).components || 0;

/** A JPEG without its EXIF, XMP, IPTC and comment segments (location and camera details stay private). */
export function stripJpegMetadata(b) {
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda) break;
    const end = i + 2 + u16be(b, i + 2);
    if (!(m === 0xe1 || m === 0xed || m === 0xfe || (m >= 0xe3 && m <= 0xef && m !== 0xee))) parts.push(b.subarray(i, end));
    i = end;
  }
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
