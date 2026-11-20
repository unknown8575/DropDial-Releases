// Reading text in pictures (Edit image text), in the sandbox: Tesseract.js (Apache-2.0) runs in its own Web Worker,
// with its WebAssembly core and the English and Hindi data loaded from this app's own files (vendor/tesseract,
// copied by scripts/vendor.js; the website serves the same files). Nothing is fetched from anywhere else: every path
// is given, the library's CDN fallbacks were removed when it was copied, the app's processor session refuses web
// requests and the website's Content-Security-Policy only allows its own address.
import { UserError } from './errors.js';

const BASE = () => new URL('./vendor/tesseract/', import.meta.url).href;
const IDLE_MS = 90000; // the reader (about 100 MB) is closed when unused for this long

// A tiny module that uses a SIMD instruction (as wasm-feature-detect checks it): the core is the SIMD build.
const SIMD = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11);
/** Can this browser run the reader? */
export function canRead() {
  try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD) && typeof Worker === 'function'; } catch { return false; }
}

let current = null; // {langs, worker: Promise, timer}
let queue = Promise.resolve();

async function start(langs) {
  if (!canRead()) throw new UserError('This browser can’t run the text reader (it needs WebAssembly SIMD). Update it and try again.');
  const T = (await import('./vendor/tesseract/tesseract.esm.min.js')).default;
  const base = BASE();
  let worker;
  try {
    worker = await T.createWorker(langs.split('+'), 1, {
      workerPath: base + 'worker.min.js', corePath: base + 'tesseract-core-simd-lstm.wasm.js', langPath: base + 'lang',
      workerBlobURL: false, cacheMethod: 'none', gzip: true, logger: () => {}, errorHandler: () => {},
    });
  } catch (e) {
    throw new UserError('The text reader could not start. ' + String((e && e.message) || e).slice(0, 160));
  }
  // Automatic page layout (columns, tables, scattered labels); spaces inside a line as they are; pictures taken as
  // 300 dpi (photos and screenshots say nothing useful; it reads as well as Tesseract's own estimate, without its log).
  await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', user_defined_dpi: '300' });
  return worker;
}

function idle() {
  const me = current;
  clearTimeout(me.timer);
  me.timer = setTimeout(() => { if (current === me) { current = null; me.worker.then((w) => w.terminate()).catch(() => {}); } }, IDLE_MS);
}

/**
 * Read the text of an encoded picture (BMP or PNG bytes): Tesseract's blocks (blocks → paragraphs → lines → words →
 * symbols, with boxes, baselines and confidences). `langs`: 'eng' or 'eng+hin'. One picture at a time.
 */
export function read(bytes, langs = 'eng') {
  const job = queue.then(async () => {
    if (!current || current.langs !== langs) {
      if (current) { const old = current; current = null; clearTimeout(old.timer); old.worker.then((w) => w.terminate()).catch(() => {}); }
      current = { langs, worker: start(langs), timer: null };
      current.worker.catch(() => { current = null; });
    }
    const me = current;
    const w = await me.worker;
    clearTimeout(me.timer);
    try {
      const r = await w.recognize(bytes, {}, { blocks: true, text: false });
      return (r && r.data && r.data.blocks) || [];
    } finally { if (current === me) idle(); }
  });
  queue = job.catch(() => {});
  return job;
}

/** Close the reader now (tests; the processor page closes with it anyway). */
export async function stop() {
  const me = current;
  current = null;
  if (me) { clearTimeout(me.timer); try { await (await me.worker).terminate(); } catch { /* gone */ } }
}
