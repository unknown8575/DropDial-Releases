// The page's side of the web tools' engine. Operations run in a module Web Worker (worker.js), one at a time, with
// file bytes handed over instead of copied. A few run on the page itself (host.js loaded here): those that draw PDF
// pages with pdf.js (pdf.js reads the file in its own worker, the page only paints) and pictures that are SVG
// drawings, which only an <img> can draw safely. If this browser can't start a module worker, everything runs here.
import { sniff } from '../processor/image-header.js';

/** The app's processor limits (src/main/files.js LIMITS → src/main/conversions.js PROC_LIMITS). */
export const LIMITS = Object.freeze({ mp: 250, side: 30000, pages: 2000 });

// pdf.js drawing and text; docx.read needs DOMParser, which workers don't have.
const PDFJS = new Set(['pdf.info', 'pdf.render', 'pdf.text', 'pdf.toDocx', 'pdf.layout', 'docx.read']);
function onPage(op, a) {
  if (PDFJS.has(op)) return true;
  if (op === 'pdf.shrink') return !!(a.o && (a.o.level === 'strong' || a.o.targetBytes > 0 || a.o.keepText));
  const pics = [a.bytes, ...(Array.isArray(a.images) ? a.images : [])];
  return pics.some((b) => b instanceof Uint8Array && b.length >= 12 && sniff(b) === 'svg');
}

/** A cancelled operation (the person pressed Cancel). */
export class Cancelled extends Error { constructor() { super('Cancelled'); this.cancelled = true; } }

/** An error from an operation: `user` errors are written for people and shown as they are. */
export class OpError extends Error {
  constructor(e) { super(e.message); this.user = !!e.user; this.locked = !!e.locked; }
}

const url = (p) => new URL(p, import.meta.url);

export function createEngine() {
  let worker = null, ready = null, broken = false, seq = 0;
  const pending = new Map();
  let pageHost = null;
  const page = () => (pageHost ||= import('./host.js'));

  function start() {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      try {
        worker = new Worker(url('./worker.js'), { type: 'module', name: 'dropdial-tools' });
      } catch { broken = true; resolve(false); return; }
      const fail = () => { broken = true; for (const p of pending.values()) p.retry(); pending.clear(); resolve(false); };
      const t = setTimeout(fail, 20000);
      worker.addEventListener('error', (e) => { e.preventDefault(); clearTimeout(t); if (!broken) fail(); });
      worker.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || m.dd !== 1) return;
        if (m.ready) { clearTimeout(t); resolve(true); return; }
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result); else p.reject(new OpError(m.error));
      });
    });
    return ready;
  }

  async function onThisPage(op, args, signal) {
    const host = await page();
    if (signal && signal.aborted) throw new Cancelled();
    const res = await host.run(op, args);
    if (signal && signal.aborted) throw new Cancelled();
    if (!res.ok) throw new OpError(res.error);
    return res.result;
  }

  /**
   * Run one of the app's operations. `args` as the app's processor takes them (Uint8Arrays for files; they are
   * handed to the worker, so read the file again for another operation). `signal` (AbortSignal) cancels it.
   */
  async function run(op, args = {}, { signal } = {}) {
    if (signal && signal.aborted) throw new Cancelled();
    if (onPage(op, args) || !(await start()) || broken) return onThisPage(op, args, signal);
    const id = ++seq;
    const transfer = [];
    const walk = (v, d = 0) => {
      if (!v || typeof v !== 'object' || d > 4) return;
      if (ArrayBuffer.isView(v)) { if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && !transfer.includes(v.buffer)) transfer.push(v.buffer); return; }
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, d + 1);
    };
    walk(args);
    return new Promise((resolve, reject) => {
      const onAbort = () => { pending.delete(id); stop(); reject(new Cancelled()); };
      pending.set(id, {
        resolve: (r) => { signal && signal.removeEventListener('abort', onAbort); resolve(r); },
        reject: (e) => { signal && signal.removeEventListener('abort', onAbort); reject(e); },
        retry: () => { onThisPage(op, args, signal).then(resolve, reject); },
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ dd: 1, id, op, args }, transfer);
    });
  }

  /** Stop the worker now (Cancel); the next operation starts a fresh one. */
  function stop() {
    if (worker) worker.terminate();
    worker = null; ready = null;
    for (const p of pending.values()) p.reject(new Cancelled());
    pending.clear();
  }

  return { run, stop, warm: () => start(), limits: LIMITS };
}
