// Video to GIF: the app's GIF & sticker (src/renderer/tools/video-gif.js) in the browser. A part of the video (the
// first 5 s to start, up to 60 s), GIF or animated WebP, a width (320/480/640/original) and a frame rate (10/15/24);
// More options: a size limit (2, 8 or 15 MB: made again with fewer colours, frames or pixels until it fits, the
// app's own ladder, videotools.mjs gifLadder) and loop. GIFs use one palette for the whole clip and store only the
// pixels that change (gifenc, as the app's processor uses it); WebP frames come from the browser's own encoder.
import { tool, h, plural } from './ui.js';
import { GIF_WIDTHS, GIF_FPS, GIF_LIMITS, GIF_MAX_SECONDS, GIF_MIN_SECONDS, GIF_FIRST_SECONDS, gifSize, formatLength } from '../../tools/engine/shared/videotools.mjs';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, timeline, loadCaps, caps } from './media-kit.js';

const st = { start: 0, end: 0, file: null, ui: null, err: '' };
const FORMAT_HINT = { gif: 'Plays almost everywhere: chats, email and websites.', webp: 'Smaller files with smoother colour. Works in browsers and many chat apps.' };
const LONG = 15;

function stage(app, el) {
  const f = app.files.find((x) => !x.error && x.info);
  if (!f) { el.replaceChildren(app.files.some((x) => x.meta.loading) ? h('div', { class: 'panel' }, h('p', { class: 'pv-wait' }, 'Reading the video…')) : ''); return; }
  if (st.file === f && st.ui) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  st.file = f; st.start = 0; st.end = Math.round(Math.min(f.info.duration, GIF_FIRST_SECONDS) * 1000) / 1000; st.err = '';
  // A width that fits the video: 480 when it is that wide, else 320, else its own.
  const W = f.info.video.width;
  app.o.width = W >= 480 ? 480 : W >= 320 ? 320 : 'original';
  st.ui = timeline(f, st, { kind: 'video', min: GIF_MIN_SECONDS, max: GIF_MAX_SECONDS, muted: true, label: 'part to use', onChange: (e) => { st.err = e || ''; app.update(); } });
  el.replaceChildren(st.ui.panel);
  app.update();
}
const sizeOf = (f, o) => gifSize(o.width, f.info.video.width, f.info.video.height);

tool({
  kinds: VIDEO_KINDS, multiple: false, wrongKind: wrongVideo,
  pick: 'Choose a video', drop: 'MP4, MOV, MKV or WebM. You choose the part to use, up to a minute.',
  verb: 'Making',
  showSaving: false,
  options: [
    { id: 'format', type: 'seg', label: 'Format', value: 'gif', choices: () => [{ value: 'gif', label: 'GIF' }, ...(!caps || caps.webp ? [{ value: 'webp', label: 'Animated WebP' }] : [])],
      hint: (o) => (caps && !caps.webp ? 'This browser can’t make WebP pictures, so animated WebP isn’t offered here. GIF works everywhere.' : FORMAT_HINT[o.format]) },
    { id: 'width', type: 'chips', label: 'Width', value: 480,
      choices: (o, app) => { const f = st.file; const W = f ? f.info.video.width : 9999; return GIF_WIDTHS.filter((w) => w === 'original' ? !GIF_WIDTHS.includes(Math.floor(W / 2) * 2) : w <= W).map((w) => ({ value: w, label: w === 'original' ? `Original ${Math.floor(W / 2) * 2}` : String(w), hint: w === 'original' ? 'The video’s own width' : `${w} pixels wide` })); } },
    { id: 'fps', type: 'chips', label: 'Frame rate', value: 15, choices: GIF_FPS.map((v) => ({ value: v, label: `${v} fps` })),
      hint: (o) => { const f = st.file; if (!f) return 'More frames move more smoothly but make a bigger file.'; const s = sizeOf(f, o), n = Math.max(1, Math.round((st.end - st.start) * o.fps)); return `${s.w} × ${s.h} · ${formatLength(st.end - st.start)} · ${plural(n, 'frame')}${st.end - st.start > LONG ? '. Long GIFs get large: choose a shorter part or a size limit.' : ''}`; } },
    { id: 'limit', type: 'chips', label: 'Size limit', value: 0, more: true, choices: [{ value: 0, label: 'No limit' }, ...GIF_LIMITS],
      hint: (o) => (o.limit ? 'If it’s bigger, it’s made again with fewer colours, fewer frames or a smaller width until it fits.' : 'Keep the file under a size, for chat apps and email.') },
    { id: 'loop', type: 'toggle', label: 'Loop', value: true, more: true, hint: (o) => (o.loop ? 'Plays over and over.' : 'Plays once and stops on the last frame.') },
  ],
  init(app) { loadCaps().then(() => app.update()).catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['video', 'decode'] }),
  metaLine: mediaLine,
  stage,
  reset() { st.file = null; st.ui = null; },
  check(files) {
    const f = files[0];
    if (!f.info || st.file !== f) return 'Reading the video…';
    if (st.err) return 'Fix the start or end time.';
    const len = st.end - st.start;
    if (len > GIF_MAX_SECONDS + 1e-6) return `Choose a part up to ${GIF_MAX_SECONDS} seconds long (this one is ${formatLength(len)}).`;
    if (len < GIF_MIN_SECONDS - 1e-6) return `Choose a part at least ${GIF_MIN_SECONDS} seconds long.`;
    return '';
  },
  action: (files, o) => (o.format === 'webp' ? 'Make the animated WebP' : 'Make the GIF'),
  preview: 'picture',
  async run(f, o, job) {
    const s = sizeOf(f, o);
    const r = await runJob('gif', { file: f.file, start: st.start, end: st.end, w: s.w, h: s.h, fps: o.fps, format: o.format, loop: o.loop, limit: o.limit ? o.limit * 1000 * 1000 : 0 }, job, f, 'Making a GIF from');
    const notes = [plural(r.frames, 'frame'), `${r.fps} fps`, r.tries > 1 ? `made smaller to fit: ${r.used}` : '', !r.fits ? `still over ${o.limit} MB: choose a shorter part` : '', o.loop ? '' : 'plays once'];
    return { outputs: [{ name: job.name(f.stem, o.format), blob: r.blob, w: r.w, h: r.h }], note: notes.filter(Boolean).join(' · '), warn: !r.fits };
  },
});
