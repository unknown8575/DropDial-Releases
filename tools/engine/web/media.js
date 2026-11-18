// The page's side of the video and audio tools' worker (media-worker.js). Two workers from the same script: one
// looks at files as they are added (details, a picture, the waveform), the other does the job, so Cancel can stop
// the job at once (the worker is ended) without losing what was read about the files.
import { Cancelled, OpError } from './client.js';

export { Cancelled };

function lane(name) {
  let worker = null, ready = null, seq = 0;
  const pending = new Map();
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      try { worker = new Worker(new URL('./media-worker.js', import.meta.url), { type: 'module', name }); } catch (e) {
        ready = null;
        reject(Object.assign(new OpError({ message: 'This browser can’t run the video and audio tools. Update it, or use Chrome, Edge, Firefox or Safari 16.4 or later.', user: true }), { code: 'worker' }));
        return;
      }
      const fail = (why) => {
        const err = new OpError({ message: why, user: true });
        for (const p of pending.values()) p.reject(err);
        pending.clear(); worker = null; ready = null;
        reject(err);
      };
      const t = setTimeout(() => fail('The video tools took too long to start. Reload the page and try again.'), 30000);
      worker.addEventListener('error', (e) => { e.preventDefault(); clearTimeout(t); fail('The video and audio tools couldn’t start in this browser. Update it, or try Chrome, Edge, Firefox or Safari 16.4 or later.'); });
      worker.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || m.dd !== 2) return;
        if (m.ready) { clearTimeout(t); resolve(); return; }
        const p = pending.get(m.id);
        if (!p) return;
        if ('progress' in m && !('ok' in m)) { if (p.onProgress) p.onProgress(m.progress, m.note || ''); return; }
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(Object.assign(new OpError(m.error), { code: m.error.code || '' }));
      });
    });
    return ready;
  }
  function stop() {
    if (worker) worker.terminate();
    worker = null; ready = null;
    for (const p of pending.values()) p.reject(new Cancelled());
    pending.clear();
  }
  async function run(op, args = {}, { signal, onProgress } = {}) {
    if (signal && signal.aborted) throw new Cancelled();
    await start();
    if (signal && signal.aborted) throw new Cancelled();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const onAbort = () => { pending.delete(id); stop(); reject(new Cancelled()); };
      const done = (fn) => (x) => { if (signal) signal.removeEventListener('abort', onAbort); fn(x); };
      pending.set(id, { resolve: done(resolve), reject: done(reject), onProgress });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ dd: 2, id, op, args });
    });
  }
  return { run, stop, warm: () => start().catch(() => {}) };
}

export function createMedia() {
  const look = lane('dropdial-media-look');
  const job = lane('dropdial-media');
  let caps = null;
  return {
    /** Details, a picture or the waveform of a file (never stopped by Cancel). */
    look: (op, args, opts) => look.run(op, args, opts),
    /** The job: convert, trim, GIF… `signal` (AbortSignal) stops it at once; onProgress(0–1, note). */
    run: (op, args, opts) => job.run(op, args, opts),
    stop: () => job.stop(),
    /** What this browser can make (encoders), asked once. */
    caps: () => (caps ||= look.run('caps').catch((e) => { caps = null; throw e; })),
    warm: () => { look.warm(); },
  };
}
