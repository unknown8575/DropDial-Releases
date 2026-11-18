// The web tools' worker: one operation at a time, file bytes handed over (not copied) both ways.
import { run, buffers } from './host.js';

self.addEventListener('message', async (ev) => {
  const m = ev.data;
  if (!m || m.dd !== 1) return; // pdf.js, if it is ever loaded here, talks on the same channel
  const res = await run(m.op, m.args);
  let transfer = [];
  if (res.ok) transfer = [...buffers(res.result)];
  try { self.postMessage({ dd: 1, id: m.id, ...res }, transfer); } catch (e) {
    self.postMessage({ dd: 1, id: m.id, ok: false, error: { message: 'The result could not be returned: ' + e.message, user: false } });
  }
});
self.postMessage({ dd: 1, ready: true });
