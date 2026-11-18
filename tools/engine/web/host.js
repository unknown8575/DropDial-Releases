// Runs DropDial's processor operations in the browser, in a Web Worker (worker.js) or, for the few that need the
// page (pdf.js drawing, SVG pictures), on the page itself (client.js decides). The operations are the app's own:
// src/processor/ops.js and everything it imports, copied next to this file by website/build.mjs.
//
// The app's processor page loads pdf-lib, JSZip, pako, UTIF and jsQR as classic scripts; here each one is a small
// module the build makes from the same file (lib/*.js), loaded only when an operation needs it.
import { OPS } from '../processor/ops.js';
import { decode, blobBytes } from '../processor/image.js';

const libs = new Map();
const load = (name) => { if (!libs.has(name)) libs.set(name, import(`./lib/${name}.js`)); return libs.get(name); };

async function need(op) {
  await load('pako'); // UTIF reads self.pako when it loads, so pako comes first
  await load('utif');
  if (/^(pdf\.|image\.toPdf|meta\.pdf)/.test(op)) await load('pdf-lib');
  if (/^(docx\.|table\.|image\.toDocx|pdf\.toDocx|web\.zip)/.test(op)) await load('jszip');
  if (op === 'qr.read') await load('jsqr');
}

// Already-compressed results are stored as they are in a ZIP; text is compressed.
const PACKED = /\.(jpe?g|png|webp|gif|avif|heic|pdf|zip|docx|xlsx|ico)$/i;
let avif = null;

/** Operations only the website needs (the desktop app has its own ways to do these). */
const WEB_OPS = {
  /** {files: [{name, bytes}]} → {bytes} a ZIP of them. */
  async 'web.zip'({ files }) {
    const zip = new self.JSZip();
    for (const f of files) zip.file(f.name, f.bytes, { binary: true, compression: PACKED.test(f.name) ? 'STORE' : 'DEFLATE' });
    return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }) };
  },
  /** What this browser can write: AVIF only where the canvas really makes AVIF (the app uses FFmpeg for it). */
  async 'web.caps'() {
    if (avif === null) {
      try { const b = await new OffscreenCanvas(4, 4).convertToBlob({ type: 'image/avif', quality: 0.6 }); avif = b.type === 'image/avif'; } catch { avif = false; }
    }
    return { avif };
  },
  /** A picture as AVIF through the browser's own encoder (only offered when web.caps says it can). */
  async 'web.avif'({ bytes, quality = 0.6, limits }) {
    const { canvas } = await decode(bytes, limits);
    const out = await blobBytes(canvas, 'image/avif', quality);
    return { bytes: out, width: canvas.width, height: canvas.height };
  },
};

/** Run one operation: {ok, result} or {ok: false, error: {message, user}} — the same shape as the app's processor. */
export async function run(op, args) {
  const fn = WEB_OPS[op] || OPS[op];
  if (!fn) return { ok: false, error: { message: 'Unknown operation', user: false } };
  try {
    await need(op);
    return { ok: true, result: await fn(args || {}) };
  } catch (e) {
    return { ok: false, error: { message: String((e && e.message) || e).slice(0, 500), user: !!(e && e.user), locked: !!(e && e.locked) } };
  }
}

/** Every ArrayBuffer in a result, so it can be handed over instead of copied. */
export function buffers(v, out = new Set(), depth = 0) {
  if (!v || typeof v !== 'object' || depth > 5) return out;
  if (ArrayBuffer.isView(v)) { if (v.buffer.byteLength) out.add(v.buffer); return out; }
  for (const x of Array.isArray(v) ? v : Object.values(v)) buffers(x, out, depth + 1);
  return out;
}
