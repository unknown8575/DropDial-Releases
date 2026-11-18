// shared/sniff.js from the app, as a module (the website's copy; built by website/build.mjs).
const module = { exports: {} };
const process = { platform: 'web' };
const Buffer = { byteLength: (s) => new TextEncoder().encode(String(s)).length, from(b, off, len) {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b, off || 0, len) : new Uint8Array(b);
  return Object.assign(u, { toString: () => new TextDecoder().decode(u), indexOf(s) { const t = new TextEncoder().encode(s); outer: for (let i = 0; i + t.length <= u.length; i++) { for (let k = 0; k < t.length; k++) if (u[i + k] !== t[k]) continue outer; return i; } return -1; } });
} };
'use strict';
// What a file really is, from its first bytes (QA round 7): files without an extension (or with one DropDial doesn't
// know) are recognised by content, and still vs animated pictures are told apart for conversions. Only headers are
// read; every offset is bounds-checked. CommonJS, used by the main process and the unit tests.

const ascii = (b, at, n) => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');
const u32be = (b, i) => (i + 4 <= b.length ? ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3] : 0);
const u32le = (b, i) => (i + 4 <= b.length ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000 : 0);

/** Bytes DropDial reads from the start of a file to recognise it. */
const SNIFF_BYTES = 64 * 1024;

/** ISO media (MP4, MOV, HEIC, AVIF, M4A) by its 'ftyp' brands. */
function ftyp(b) {
  const size = Math.min(u32be(b, 0), 256, b.length);
  const brands = [];
  for (let i = 8; i + 4 <= size; i += 4) if (i !== 12) brands.push(ascii(b, i, 4));
  const has = (re) => brands.some((x) => re.test(x));
  if (has(/^(avif|avis)$/)) return 'avif';
  if (has(/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/)) return 'heic';
  if (has(/^(M4A |M4B |M4P )$/)) return 'm4a';
  if (has(/^qt {2}$/)) return 'mov';
  return 'mp4';
}

/** A Matroska file: WebM when its DocType says so. */
function ebml(b) {
  const head = ascii(b, 0, Math.min(b.length, 64));
  return /webm/.test(head) ? 'webm' : 'mkv';
}

/** The first entry names of a ZIP (local headers): an Office file's parts say what it is. */
function zipKind(b) {
  for (let i = 0, n = 0; i + 30 <= b.length && n < 40; n++) {
    if (u32le(b, i) !== 0x04034b50) break;
    const nameLen = b[i + 26] | (b[i + 27] << 8), extra = b[i + 28] | (b[i + 29] << 8);
    const name = ascii(b, i + 30, nameLen);
    if (name.startsWith('word/')) return 'docx';
    if (name.startsWith('xl/')) return 'xlsx';
    const csize = u32le(b, i + 18);
    if (b[i + 6] & 0x08 && !csize) break; // sizes come after the data: can't walk on
    i += 30 + nameLen + extra + csize;
  }
  return null;
}

function mp3Frame(b) {
  if (ascii(b, 0, 3) === 'ID3') return true;
  // An MPEG audio frame header (sync, layer III, valid bitrate and rate), twice in a row.
  const frame = (i) => b[i] === 0xff && (b[i + 1] & 0xe6) === 0xe2 && (b[i + 2] & 0xf0) !== 0xf0 && (b[i + 2] & 0x0c) !== 0x0c;
  return b.length > 4 && frame(0);
}

/**
 * The format id (as in formats.js) of some bytes from the start of a file, or null. Recognises pictures, PDF,
 * DOCX/XLSX, common video and audio containers.
 */
function sniffFormat(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF') {
    const t = ascii(b, 8, 4);
    if (t === 'WEBP') return 'webp';
    if (t === 'WAVE') return 'wav';
    if (t === 'AVI ') return 'avi';
    return null;
  }
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26 && u32le(b, 2) > 26) return 'bmp';
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4] | (b[5] << 8)) > 0) return 'ico';
  if ((ascii(b, 0, 2) === 'II' && b[2] === 42 && b[3] === 0) || (ascii(b, 0, 2) === 'MM' && b[2] === 0 && b[3] === 42)) return 'tiff';
  if (ascii(b, 4, 4) === 'ftyp') return ftyp(b);
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ebml(b);
  if (ascii(b, 0, 4) === 'fLaC') return 'flac';
  if (ascii(b, 0, 4) === 'OggS') return /OpusHead/.test(ascii(b, 0, Math.min(b.length, 128))) ? 'opus' : 'ogg';
  if (ascii(b, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 4))) return 'aiff';
  if (ascii(b, 0, 4) === 'PK\u0003\u0004') return zipKind(b);
  if (mp3Frame(b)) return 'mp3';
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 4096))).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

/** Frames in a GIF's bytes, counting up to `stop` (the blocks are walked; no pixels are decoded). */
function gifFrameCount(b, stop = Infinity) {
  if (ascii(b, 0, 4) !== 'GIF8' || b.length < 13) return 0;
  let i = 13, frames = 0;
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 7));
  const skip = () => { while (i < b.length && b[i] !== 0) i += b[i] + 1; i++; };
  while (i < b.length && frames < stop) {
    const t = b[i];
    if (t === 0x3b) break;
    if (t === 0x21) { i += 2; skip(); continue; }
    if (t !== 0x2c) break;
    frames++;
    const flags = b[i + 9];
    i += 10;
    if (flags & 0x80) i += 3 * (2 << (flags & 7));
    i++;
    skip();
  }
  return frames;
}

/** A GIF's loop count from its NETSCAPE2.0 block: 0 = forever, n = n times more, null = plays once. */
function gifLoops(b) {
  const at = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 1 << 20)).indexOf('NETSCAPE2.0');
  if (at < 0 || at + 15 > b.length || b[at + 11] !== 3 || b[at + 12] !== 1) return null;
  return b[at + 13] | (b[at + 14] << 8);
}

/** Is this picture animated? GIF (two frames or more), APNG (an acTL chunk) or animated WebP (VP8X flag + ANIM). */
function isAnimated(b, format) {
  if (!b) return false;
  if (format === 'gif') return gifFrameCount(b, 2) >= 2;
  if (format === 'png') {
    for (let i = 8; i + 8 <= b.length;) {
      const len = u32be(b, i), type = ascii(b, i + 4, 4);
      if (type === 'acTL') return u32be(b, i + 8) > 1;
      if (type === 'IDAT' || type === 'IEND') return false;
      i += 12 + len;
    }
    return false;
  }
  if (format === 'webp') return ascii(b, 12, 4) === 'VP8X' && !!(b[20] & 0x02);
  return false;
}

module.exports = { sniffFormat, isAnimated, gifFrameCount, gifLoops, SNIFF_BYTES };

export default module.exports;
