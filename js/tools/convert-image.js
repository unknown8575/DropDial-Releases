// Convert image: the app's image route (src/main/conversions.js ENGINES.image) with the processor's image.convert,
// image.animate for animated WebP/PNG → GIF, and AVIF only where this browser can write it.
import { tool, engine, LIMITS, F, plural } from './ui.js';

const QUALITY = { jpg: 0.9, webp: 0.85, avif: 0.6 }; // the app's default settings (jpegQuality, webpQuality, avifQuality)
const OUT = ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico'];
const FIRST_FRAME = 'only the first frame is kept (this format can’t move)';
const label = (id) => F.formatInfo(id).label;
// AVIF is offered only where the browser's own encoder really writes AVIF (the app uses FFmpeg for it).
const avif = (() => { try { const c = document.createElement('canvas'); c.width = c.height = 2; return c.toDataURL('image/avif').startsWith('data:image/avif'); } catch { return false; } })();

tool({
  kinds: ['image'], multiple: true, max: 200, compare: true,
  pick: 'Choose pictures', drop: 'JPEG, PNG, HEIC, WebP, AVIF, GIF, TIFF, BMP, ICO or SVG. Up to 200 at a time.',
  verb: 'Converting',
  options: [
    { id: 'to', type: 'chips', label: 'Convert to', value: 'jpg', choices: () => [...OUT, ...(avif ? ['avif'] : [])].map((v) => ({ value: v, label: label(v) })),
      hint: (o) => ({ jpg: 'Works everywhere. Best for photos.', png: 'Sharp, keeps transparency. Bigger files.', webp: 'Small files for the web, keeps transparency.', gif: 'Up to 256 colours. Animated WebP and PNG stay animated.', bmp: 'Uncompressed, for older programs.', tiff: 'For print and scanning.', ico: 'A Windows icon with sizes from 16 to 256 pixels.', avif: 'Very small files, made by this browser.' })[o.to] },
    { id: 'quality', type: 'range', label: 'Quality', min: 40, max: 100, value: 90, unit: '%', more: true, when: (o) => ['jpg', 'webp', 'avif'].includes(o.to),
      hint: 'Lower is smaller. 85 to 92 looks the same as the original for most photos.' },
  ],
  onSet(a, id, v) { if (id === 'to' && QUALITY[v]) a.o.quality = Math.round(QUALITY[v] * 100); },
  check(files, o) { return files.every((f) => f.format === o.to) ? `${files.length === 1 ? 'This picture is' : 'These pictures are'} already ${label(o.to)}.` : ''; },
  action: (files, o) => `Convert ${files.length === 1 ? 'to' : plural(files.length, 'picture') + ' to'} ${label(o.to)}`,
  zipName: (a) => `Pictures as ${label(a.o.to)}.zip`,
  async run(f, o, job) {
    const to = o.to, ext = F.formatInfo(to).ext;
    if (f.format === to) return { skipped: `Already ${label(to)}, so it was left as it is.` };
    if (!F.routeEngine(f.format, to) && to !== 'avif') return { skipped: `${label(f.format)} can’t become ${label(to)}.` };
    const q = (o.quality || 90) / 100;
    let r, note = '', warn = false;
    if (to === 'avif') r = await engine.run('web.avif', { bytes: await job.bytes(), quality: q, limits: LIMITS }, job);
    else if (f.animated && to === 'gif' && f.format !== 'gif') {
      try { r = await engine.run('image.animate', { bytes: await job.bytes(), to: 'gif', limits: LIMITS }, job); note = `${r.frames} frames`; }
      catch (e) { if (e.cancelled) throw e; r = null; } // no WebCodecs here: the first frame, said below
    }
    if (!r) {
      const svg = f.format === 'svg';
      r = await engine.run('image.convert', { bytes: await job.bytes(), to, quality: q, limits: LIMITS, ...(svg ? { scale: 2, fitMP: 64 } : {}) }, job);
      if (svg && r.scale > 1.01) note = `${+r.scale.toFixed(2)}× its size, for sharp screens`;
      if (f.animated) { note = FIRST_FRAME; warn = true; }
    }
    return { outputs: [{ name: job.name(f.stem, ext), bytes: r.bytes, w: r.width, h: r.height }], note, warn };
  },
});

