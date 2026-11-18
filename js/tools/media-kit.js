// What the video and audio tools share: the media worker (tools/engine/web/media.js), reading a file's details and
// a picture when it is added, progress with the time left, plain words for what a browser can't do, and the
// timeline used by Trim video, Video to GIF and Trim audio (a preview, a filmstrip or waveform, start and end
// handles, exact times, "Start here" / "End here" at the playhead, and play the part).
// Times, lengths and limits are the app's (src/shared/videotools.mjs and audiotools.mjs, copied by the build).
import { h, ic, announce, UserError, urlFor, touchy } from './ui.js';
import { createMedia, Cancelled } from '../../tools/engine/web/media.js';
import { formatLength, formatClock, checkClock, frameStep } from '../../tools/engine/shared/videotools.mjs';
import { envelope, loudest, fitFades, fadeGain, audioEncode } from '../../tools/engine/shared/audiotools.mjs';

export const media = createMedia();
export { formatLength, formatClock, Cancelled };

/** Video files the tools open (AVI and WMV can't be read in a browser). */
export const VIDEO_KINDS = ['mp4', 'mov', 'mkv', 'webm'];
export const AUDIO_KINDS = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];
const OLD_VIDEO = { avi: 'AVI', wmv: 'WMV' };

export function wrongVideo(f) {
  if (OLD_VIDEO[f.format]) return `${OLD_VIDEO[f.format]} videos can’t be opened in a browser. The DropDial app converts them.`;
  if (f.category === 'audio') return `${f.name} is a sound file. Choose a video.`;
  return `${f.name} isn’t a video this tool takes.`;
}
export function wrongAudio(f) {
  if (f.format === 'aiff' || f.format === 'wma') return `${f.label} files can’t be opened in a browser. The DropDial app converts them.`;
  if (f.category === 'video') return `${f.name} is a video. To take its sound out, use Extract audio.`;
  return `${f.name} isn’t a sound file this tool takes.`;
}

/** For browsers without WebCodecs (the video and audio tools' engine). */
export const NEWER = 'Changing videos needs a newer browser: Safari 16.4 or later, Chrome or Edge 94 or later, or Firefox 130 or later. Update it, or use the DropDial app.';

/** The browser's encoders, asked once (null while unknown). */
export let caps = null;
export const loadCaps = () => media.caps().then((c) => (caps = c));

/**
 * Read a file's details (and, for a video, a small picture) when it is added: f.info is the worker's probe
 * ({duration, video: {codec, name, width, height, fps, bitrate, canDecode}, audio: {…}}).
 * need: 'video' (a picture to change), 'audio' (sound to change), 'decode' (the picture must be readable here).
 */
export async function inspectMedia(f, { need = [], thumb = true } = {}) {
  let info;
  try { info = await media.look('probe', { file: f.file }); } catch (e) {
    if (e.user) throw e;
    throw new UserError('This file can’t be read here. It may be damaged, or a kind of file this browser can’t open.');
  }
  f.info = info;
  f.meta.duration = info.duration;
  if (info.video) { f.meta.w = info.video.width; f.meta.h = info.video.height; }
  if (need.includes('video') && !info.video) throw new UserError('This file has no picture, only sound. Choose a video.');
  if (need.includes('audio') && !info.audio) throw new UserError(info.video ? 'This video has no sound.' : 'This file has no sound.');
  if (need.includes('decode') && info.video && !info.video.canDecode && typeof VideoDecoder === 'undefined') throw new UserError(NEWER);
  if (need.includes('decode') && info.video && !info.video.canDecode) throw new UserError(`This browser can’t play ${info.video.name} video, so it can’t change this file. Try Chrome or Edge, or the DropDial app.`);
  if (need.includes('decode-audio') && info.audio && !info.audio.canDecode) throw new UserError(`This browser can’t read ${info.audio.name} sound${typeof AudioDecoder === 'undefined' ? '; it needs Safari 26 or later, Chrome, Edge or Firefox' : ''}. Try another browser, or the DropDial app.`);
  if (!(info.duration > 0)) throw new UserError('This file’s length can’t be read. It may be damaged.');
  if (thumb && info.video && info.video.canDecode) {
    try {
      const r = await media.look('frame', { file: f.file, t: Math.min(1, info.duration * 0.1), width: 240 });
      if (r.blob) f.thumb = urlFor(r.blob);
    } catch { /* no picture: the film icon stays */ }
  }
}

/** "0:10.0 · H.264 · AAC" for the file list. */
export function mediaLine(f) {
  const i = f.info;
  if (!i) return [];
  // A sound file's codec is said only when it isn't its format's name already ("M4A · AAC", not "MP3 · MP3").
  const codecs = [i.video && i.video.name, i.audio && (i.video || i.audio.name !== f.label) && i.audio.name].filter(Boolean).join(' + ');
  return [formatLength(i.duration), i.video && i.video.fps ? `${Math.round(i.video.fps * 100) / 100} fps` : '', codecs, i.video && !i.audio ? 'no sound' : ''];
}

const ago = (s) => (s < 60 ? `${Math.max(5, Math.ceil(s / 5) * 5)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
/** Progress for a job: the bar, and "Converting clip.mov · 42% · about 20 s left" (from the speed so far). */
export function progress(job, f, verb) {
  const t0 = performance.now();
  let said = 0;
  return (p, note = '') => {
    job.progress(Math.max(0, Math.min(1, p)));
    const now = performance.now();
    if (now - said < 350 && p < 1) return;
    said = now;
    const spent = (now - t0) / 1000;
    const left = p > 0.02 && spent > 1.5 ? (p > 0.98 ? 'almost done' : `about ${ago((spent * (1 - p)) / p)} left`) : '';
    job.status([`${verb} ${f.name}`, `${Math.round(p * 100)}%`, left, note].filter(Boolean).join(' · '));
  };
}

/** Run a job in the media worker with progress and Cancel; memory errors in plain words. */
export async function runJob(op, args, job, f, verb) {
  try {
    return await media.run(op, args, { signal: job.signal, onProgress: progress(job, f, verb) });
  } catch (e) {
    if (e instanceof Cancelled || job.signal.aborted) throw new Cancelled();
    if (e.code === 'memory') throw new UserError('This file is too large for this device’s memory. Try a shorter part, or a computer.');
    throw e;
  }
}

// ------------------------------------------------------------------ plans
/** The app's probe shape (src/main media:info) from the worker's, for the app's planning code (shrink.mjs, audiotools). */
const FF_AUDIO = { 'pcm-s16': 'pcm_s16le', 'pcm-s16be': 'pcm_s16be', 'pcm-s24': 'pcm_s24le', 'pcm-s24be': 'pcm_s24be', 'pcm-s32': 'pcm_s32le', 'pcm-f32': 'pcm_f32le', 'pcm-f64': 'pcm_f64le', 'pcm-u8': 'pcm_u8' };
export function appInfo(info) {
  const a = info.audio, v = info.video;
  const streams = [];
  if (v) streams.push({ type: 'video', codec: { avc: 'h264' }[v.codec] || v.codec, width: v.width, height: v.height, fps: v.fps, bitrate: Math.round((v.bitrate || 0) / 1000) });
  if (a) streams.push({ type: 'audio', codec: FF_AUDIO[a.codec] || a.codec, bitrate: Math.round((a.bitrate || 0) / 1000), sampleRate: a.sampleRate, channels: a.channels });
  return { streams, duration: info.duration, width: v ? v.width : 0, height: v ? v.height : 0, fps: v ? v.fps : 0, hasAudio: !!a, bitrate: info.duration > 0 ? Math.round((info.size * 8) / info.duration / 1000) : 0 };
}

/** The source picture's bitrate in bits per second (its own, or the file's less the sound). */
export function sourceBps(info) {
  const v = info.video;
  if (!v) return 0;
  if (v.bitrate > 0) return v.bitrate;
  const all = info.duration > 0 ? (info.size * 8) / info.duration : 0;
  return Math.max(0, all - ((info.audio && info.audio.bitrate) || 128000));
}
/**
 * A bitrate for a picture made again in `codec` at about the source's quality (the app caps re-made pictures near the
 * source's bitrate, src/shared/videotools.mjs matchCap): H.264 needs more bits than HEVC, VP9 or AV1 for the same
 * picture, and less than old codecs. Kept within sensible bits per pixel for the size and frame rate.
 */
export function matchBps(info, codec = 'avc', w = info.video.width, h = info.video.height) {
  const v = info.video, fps = Math.min(60, v.fps || 30);
  const scale = (w * h) / Math.max(1, v.width * v.height);
  const eff = { avc: 1, hevc: 0.65, vp9: 0.7, av1: 0.55, vp8: 1.05, prores: 4 };
  let bps = sourceBps(info) * scale * ((eff[codec] || 1) / (eff[v.codec] || 1));
  const px = w * h * fps;
  if (!(bps > 0)) bps = px * 0.08;
  return Math.round(Math.min(px * 0.25, Math.max(px * 0.03, bps)));
}

/**
 * How to save sound as `format` (mp3, m4a, ogg, opus, flac, wav), staying close to the source the app's way
 * (src/shared/audiotools.mjs audioEncode: the same bitrate snapped to what the encoder takes, the same bit depth):
 * {codec (Mediabunny's), bitrate (bps), sampleRate, label}.
 */
export function audioFor(format, info) {
  const a = info.audio || {};
  const stream = { codec: FF_AUDIO[a.codec] || a.codec || '', bitrate: Math.round((a.bitrate || 0) / 1000), sampleRate: a.sampleRate, channels: a.channels };
  // The web saves OGG as Opus (the browser's encoder); the app uses Vorbis unless the source is Opus.
  const app = audioEncode(format === 'ogg' ? 'opus' : format, stream, { channels: a.channels || 2 });
  const kbps = Number((app.args[app.args.indexOf('-b:a') + 1] || '').replace(/k$/, '')) || 0;
  if (format === 'wav') {
    const enc = app.encoder.replace(/^pcm_/, '').replace(/le$|be$/, '');
    const codec = { s16: 'pcm-s16', s24: 'pcm-s24', s32: 'pcm-s32', f32: 'pcm-f32', u8: 'pcm-u8' }[enc] || 'pcm-s16';
    return { codec, sampleRate: app.rate, label: app.label };
  }
  if (format === 'flac') return { codec: 'flac', sampleRate: app.rate, label: 'FLAC (lossless)' };
  if (format === 'm4a' && app.encoder === 'alac') return { codec: 'aac', bitrate: 256000, sampleRate: Math.min(48000, app.rate), label: 'AAC 256 kbps' };
  const codec = { mp3: 'mp3', m4a: 'aac', ogg: 'opus', opus: 'opus' }[format];
  return { codec, bitrate: kbps * 1000, sampleRate: codec === 'opus' ? 48000 : app.rate, label: app.label.replace(/^Vorbis/, 'Opus') };
}

/** The output's details for the results: "1280 × 720 · 0:10.0". */
export function outNote(out, extra = []) {
  if (!out) return extra.filter(Boolean).join(' · ');
  return [out.video ? `${out.video.width} × ${out.video.height}` : '', formatLength(out.duration), ...extra].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ the timeline
const r3 = (t) => Math.round(t * 1000) / 1000;

/**
 * A timeline panel for one file: preview (video or sound), a filmstrip or waveform with start and end handles, the
 * exact times, and buttons. st: {start, end} (seconds; changed here). opts: {kind: 'video' | 'audio', min, max
 * (longest part, or Infinity), fades: () => ({in, out}) (drawn on the waveform), label, onChange()}.
 */
export function timeline(f, st, opts) {
  const D = f.info.duration;
  const min = opts.min || 0.1, max = opts.max || Infinity;
  const url = urlFor(f.file);
  const isVideo = opts.kind === 'video';
  const player = h(isVideo ? 'video' : 'audio', { src: url, preload: 'metadata', controls: true, playsinline: true, 'aria-label': isVideo ? 'Preview of the video' : 'Preview of the sound' });
  if (isVideo) { player.setAttribute('playsinline', ''); player.muted = !!opts.muted; }
  const still = h('img', { class: 'mt-still', alt: '', hidden: true });
  const view = isVideo ? h('div', { class: 'mt-view' }, player, still) : null;
  const strip = h('div', { class: 'mt-strip', 'aria-hidden': 'true' });
  const wave = isVideo ? null : h('canvas', { class: 'mt-wave', 'aria-hidden': 'true' });
  const sel = h('div', { class: 'mt-sel', 'aria-hidden': 'true' });
  const head = h('div', { class: 'mt-head', 'aria-hidden': 'true' });
  const fmt = (t) => formatClock(t, 2);
  // Arrow keys move a handle one frame (video) or a hundredth of a second (sound); Page Up / Down move further.
  const step = isVideo ? Math.round(frameStep(f.info.video && f.info.video.fps) * 1e6) / 1e6 : 0.01;
  const handle = (which) => h('input', { type: 'range', class: 'mt-h ' + which, min: 0, max: r3(D), step, value: st[which],
    'aria-label': which === 'start' ? `Start of the ${opts.label || 'part'}` : `End of the ${opts.label || 'part'}`,
    oninput: (e) => move(which, Number(e.target.value), true), onchange: () => seekTo(which === 'start' ? st.start : Math.max(st.start, st.end - 0.05)) });
  const hStart = handle('start'), hEnd = handle('end');
  const track = h('div', { class: 'mt-track' + (isVideo ? '' : ' audio') }, strip, wave, sel, head, hStart, hEnd);
  const box = (which) => {
    const id = 'mt-' + which;
    const inp = h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: false, enterkeyhint: 'done', value: fmt(st[which]),
      onchange: (e) => typed(which, e.target), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); typed(which, e.target); } } });
    return h('div', { class: 'mt-time' }, h('label', { for: id, class: 'opt-label' }, which === 'start' ? 'Start' : 'End'), inp);
  };
  const bStart = box('start'), bEnd = box('end');
  const err = h('p', { class: 'f-err mt-err', role: 'alert', hidden: true });
  const len = h('p', { class: 'mt-len' });
  const btn = (icon, text, title, fn) => h('button', { type: 'button', class: 'tbtn', title, onclick: fn }, ic(icon), h('span', null, text));
  const atStart = btn('arrow-left-to-line', 'Start here', 'Set the start at the playhead (I)', () => move('start', player.currentTime));
  const atEnd = btn('arrow-right-to-line', 'End here', 'Set the end at the playhead (O)', () => move('end', player.currentTime));
  const playPart = btn('play', 'Play the part', 'Play from the start to the end', () => playRange());
  const panel = h('div', { class: 'panel mt' + (isVideo ? ' is-video' : ' is-audio') },
    view, isVideo ? null : player, track,
    h('div', { class: 'mt-row' }, bStart, bEnd, len),
    err,
    h('div', { class: 'tbtns mt-btns' }, atStart, atEnd, playPart),
    h('p', { class: 'fine mt-keys' }, touchy.matches ? 'Drag the handles, or play to a moment and tap Start here or End here.' : 'Drag the handles, type the times, or play to a moment and press I for the start and O for the end.'));

  // ---- drawing
  function draw() {
    const a = (st.start / D) * 100, b = (st.end / D) * 100;
    sel.style.left = a + '%'; sel.style.width = Math.max(0, b - a) + '%';
    hStart.value = st.start; hEnd.value = st.end;
    hStart.setAttribute('aria-valuetext', fmt(st.start)); hEnd.setAttribute('aria-valuetext', fmt(st.end));
    for (const [which, b2] of [['start', bStart], ['end', bEnd]]) { const inp = b2.querySelector('input'); if (document.activeElement !== inp) inp.value = fmt(st[which]); }
    len.textContent = `${formatLength(st.end - st.start)} of ${formatLength(D)}`;
    if (wave) drawWave();
  }
  let peaks = null;
  function drawWave() {
    const w = Math.max(1, Math.round(wave.clientWidth)), hh = Math.max(1, Math.round(wave.clientHeight));
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(hh * dpr); }
    const ctx = wave.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    if (!peaks) return;
    const cols = Math.min(w, 1200), env = envelope(peaks, 0, D, cols), top = Math.max(1e-4, loudest(peaks));
    const cs = getComputedStyle(panel);
    const on = cs.getPropertyValue('--wave-on').trim() || '#ff6a12', off = cs.getPropertyValue('--wave-off').trim() || '#999';
    const fades = opts.fades ? fitFades(opts.fades().in, opts.fades().out, st.end - st.start) : null;
    const cw = w / cols, mid = hh / 2;
    for (let i = 0; i < cols; i++) {
      const t = ((i + 0.5) / cols) * D;
      const inside = t >= st.start && t <= st.end;
      const g = inside && fades ? fadeGain(t - st.start, st.end - st.start, fades) : 1;
      const a = Math.min(1, Math.sqrt(env.peak[i] / top)) * g;
      const hgt = Math.max(1, a * hh * 0.84);
      ctx.fillStyle = inside ? on : off;
      ctx.fillRect(i * cw, mid - hgt / 2, Math.max(1, cw - (cw > 2 ? 1 : 0)), hgt);
    }
  }

  // ---- changing the part
  function move(which, t, dragging = false) {
    t = Math.max(0, Math.min(D, t));
    let { start, end } = st;
    if (which === 'start') {
      start = Math.min(t, D - min);
      if (end - start < min) end = Math.min(D, start + min);
      if (end - start > max) end = start + max;
    } else {
      end = Math.max(t, min);
      if (end - start < min) start = Math.max(0, end - min);
      if (end - start > max) start = end - max;
    }
    st.start = r3(start); st.end = r3(end);
    err.hidden = true;
    draw();
    if (dragging) preview(which === 'start' ? st.start : st.end);
    opts.onChange();
  }
  function typed(which, inp) {
    const r = checkClock(inp.value, { min: 0, max: D });
    if (r.error) { err.hidden = false; err.replaceChildren(ic('circle-alert'), h('span', null, r.error)); inp.setAttribute('aria-invalid', 'true'); opts.onChange(r.error); return; }
    inp.removeAttribute('aria-invalid');
    if (Math.abs(r.value - st[which]) < 0.0005 && err.hidden) { inp.value = fmt(st[which]); return; } // already this time (Enter, then blur)
    move(which, r.value);
    inp.value = fmt(st[which]);
    seekTo(which === 'start' ? st.start : Math.max(st.start, st.end - 0.05));
  }
  let playable = true, tm = 0;
  function seekTo(t) { if (playable) { try { player.currentTime = t; } catch { /* not ready */ } } else preview(t); }
  function preview(t) {
    if (playable && isVideo) { player.pause(); seekTo(t); return; }
    if (!isVideo) return;
    clearTimeout(tm);
    tm = setTimeout(async () => { try { const r = await media.look('frame', { file: f.file, t, width: 640 }); if (r.blob) { still.src = urlFor(r.blob); still.hidden = false; } } catch { /* stays */ } }, 120);
  }
  let stopAt = null;
  function playRange() {
    stopAt = st.end;
    player.currentTime = st.start;
    const p = player.play(); if (p && p.catch) p.catch(() => {});
  }
  player.addEventListener('timeupdate', () => {
    head.style.left = (player.currentTime / D) * 100 + '%';
    if (stopAt != null && player.currentTime >= stopAt - 0.03) { player.pause(); stopAt = null; }
  });
  player.addEventListener('pause', () => { stopAt = null; });
  // A file this browser can't play (HEVC in some browsers, MKV in Safari): pictures come from the worker instead.
  player.addEventListener('error', () => {
    playable = false;
    if (isVideo) { player.hidden = true; still.hidden = false; preview(st.start); }
    else player.hidden = true;
    atStart.hidden = atEnd.hidden = playPart.hidden = true;
    panel.querySelector('.mt-keys').textContent = 'This browser can’t play this file here, but it can still cut it. Drag the handles or type the times.';
  });
  panel.addEventListener('keydown', (e) => {
    if (e.target.closest('input[type=text]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); move('start', player.currentTime); announce('Start ' + fmt(st.start)); }
    if (e.key === 'o' || e.key === 'O') { e.preventDefault(); move('end', player.currentTime); announce('End ' + fmt(st.end)); }
  });

  // ---- filmstrip or waveform
  (async () => {
    if (isVideo) {
      try {
        const n = Math.max(4, Math.min(12, Math.round((track.clientWidth || 600) / 90)));
        const r = await media.look('strip', { file: f.file, count: n, height: 64 });
        strip.replaceChildren(...r.blobs.map((b) => (b ? h('img', { src: urlFor(b), alt: '' }) : h('span'))));
      } catch { /* a plain track */ }
    } else {
      track.classList.add('loading');
      try { peaks = await media.look('peaks', { file: f.file }); } catch { peaks = null; }
      track.classList.remove('loading');
      drawWave();
    }
  })();
  if (wave) new ResizeObserver(() => drawWave()).observe(wave);
  draw();
  return { panel, draw, player };
}
