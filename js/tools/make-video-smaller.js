// Make video smaller: the app's Make smaller for videos (src/shared/shrink.mjs: Light, Balanced and Strong; the
// container kept, H.264 + AAC, WebM as VP9 + Opus; Strong fits the picture in 1920 × 1920), plus the app's size
// limits for parts (src/shared/videotools.mjs: 16 MB for WhatsApp, 25 MB for email) and picture sizes (1080p, 720p,
// 480p). The browser's encoders work by bitrate, so each strength's quality level becomes the bitrate the app's own
// size estimate gives it (shrink.mjs estimateBytes), never above the source's. A result that isn't smaller is not kept.
import { tool, plural, fmtBytes, F } from './ui.js';
import { STRENGTHS, shrinkPlan, estimateBytes, worthSaving, WORTH_SAVING } from '../../tools/engine/shared/shrink.mjs';
import { SIZE_PRESETS, MB as DMB } from '../../tools/engine/shared/videotools.mjs';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, outNote, appInfo, sourceBps, loadCaps, caps } from './media-kit.js';

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
/** The picture's size with its short side at most `short` (and its long side at most `box`), even pixels. */
function fitSize(w, h, short, box) {
  let k = 1;
  if (short && Math.min(w, h) > short) k = Math.min(k, short / Math.min(w, h));
  if (box && Math.max(w, h) * k > box) k = Math.min(k, box / Math.max(w, h));
  return k < 1 ? { w: even(w * k), h: even(h * k), scaled: true } : { w: even(w), h: even(h), scaled: false };
}
const CUT = { light: 0.85, balanced: 0.6, strong: 0.42 }; // never more than this share of the source's bitrate
const sizeLabel = (mb) => `${Math.round(mb * 10) / 10} MB`;

/** The plan for one video: {to, video: {codec, bitrate, width, height}, audio, note} or {skip}. */
function plan(f, o, shrink = 1) {
  const info = f.info, v = info.video, a = info.audio, d = info.duration;
  const app = shrinkPlan({ format: f.format, category: 'video' }, o.how === 'size' ? 'balanced' : o.how, { info: appInfo(info) });
  let to = app.container, webm = to === 'webm', notes = [];
  const vp = caps && !caps.video.vp9 && caps.video.vp8 ? 'vp8' : 'vp9';
  if (webm && caps && !(caps.video.vp9 || caps.video.vp8) || webm && caps && !caps.audio.opus && a) { to = 'mp4'; webm = false; notes.push('saved as MP4 (this browser can’t make WebM)'); }
  else if (app.note) notes.push(app.note);
  const codec = webm ? vp : 'avc', acodec = webm ? 'opus' : 'aac';
  const fps = Math.min(60, v.fps || 30);
  const src = sourceBps(info);
  let short = o.res === 'original' ? 0 : Number(o.res), video, audioKbps;
  if (o.how === 'size') {
    const limit = o.sizeMB * DMB;
    if (f.size <= limit) return { skip: `Already under ${sizeLabel(o.sizeMB)} (${fmtBytes(f.size)}), so it was kept as it is.` };
    // The app's plan for a size limit (videotools.mjs sizePlan): room for the file's overhead, then sound, then picture.
    const totalKbps = (limit * 0.92 * 8) / 1000 / d;
    audioKbps = a ? (totalKbps > 900 ? 96 : totalKbps > 300 ? 64 : 48) : 0;
    const videoKbps = Math.floor((totalKbps - audioKbps) * shrink);
    if (videoKbps < 100) return { skip: `This video is too long to fit in ${sizeLabel(o.sizeMB)}. Choose a bigger size, or trim it first.` };
    const auto = videoKbps >= 2500 ? 1080 : videoKbps >= 1200 ? 720 : videoKbps >= 600 ? 480 : 360;
    short = short ? Math.min(short, auto) : auto;
    const s = fitSize(v.width, v.height, short, 0);
    video = { codec, bitrate: Math.min(videoKbps * 1000, src || Infinity), width: s.w, height: s.h, transcode: true };
    if (s.scaled) notes.push(`${Math.min(s.w, s.h)}p to fit`);
  } else {
    const s = fitSize(v.width, v.height, short, app.box);
    // The app's size estimate for this strength at this picture size, less the sound: the picture's bitrate.
    const est = estimateBytes({ ...app, box: 0 }, { duration: d, width: s.w, height: s.h, fps, hasAudio: false });
    const fromModel = est ? ((est - 4096) * 8) / d : (s.w * s.h * fps * 0.045);
    const scaledSrc = src ? src * ((s.w * s.h) / (v.width * v.height)) : 0;
    video = { codec, bitrate: Math.round(Math.min(fromModel, scaledSrc ? scaledSrc * CUT[o.how] : Infinity) * shrink), width: s.w, height: s.h, transcode: true };
    audioKbps = a ? app.audioKbps : 0;
    if (s.scaled) notes.push(`${Math.min(s.w, s.h)}p`);
  }
  let audio = null;
  if (a) {
    const have = Math.round((a.bitrate || 0) / 1000);
    // Sound already this small (and in the right codec) is copied as it is.
    audio = a.codec === acodec && have && have <= audioKbps * 1.1 ? { codec: acodec } : { codec: acodec, bitrate: audioKbps * 1000, transcode: true };
  }
  return { to, video, audio, notes };
}

tool({
  kinds: VIDEO_KINDS, multiple: true, max: 20, wrongKind: wrongVideo,
  pick: 'Choose videos', drop: 'MP4, MOV, MKV or WebM. Up to 20 at a time.',
  verb: 'Making smaller',
  options: [
    { id: 'how', type: 'seg', label: 'How small', value: 'balanced', choices: [...STRENGTHS.map((s) => ({ value: s.value, label: s.label, hint: s.hint })), { value: 'size', label: 'Under a size' }],
      hint: (o) => (o.how === 'size' ? 'Made to fit the size, with fewer pixels when it needs them.' : STRENGTHS.find((s) => s.value === o.how).hint) },
    { id: 'sizeMB', type: 'preset', label: 'Fit under', boxLabel: 'Size in MB', unit: 'MB', min: 1, max: 4000, value: 16, when: (o) => o.how === 'size',
      choices: SIZE_PRESETS.map((p) => ({ value: p.value, label: `${p.hint} ${p.label}`, hint: `${p.label}, for ${p.hint}` })) },
    { id: 'res', type: 'chips', label: 'Picture size', value: 'original',
      choices: [{ value: 'original', label: 'Same' }, { value: 1080, label: '1080p' }, { value: 720, label: '720p' }, { value: 480, label: '480p' }],
      hint: (o) => (o.res === 'original' ? (o.how === 'size' ? 'Made smaller only when it has to be, to fit.' : 'Keeps the number of pixels (Strong fits very large videos in 1920 px).') : o.res === 480 ? 'Small and quick to send. Fine on a phone screen.' : o.res === 720 ? 'Sharp on phones and laptops, and much smaller.' : 'Full HD: sharp on any screen.') },
  ],
  init(app) { loadCaps().then(() => app.update()).catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['video', 'decode'] }),
  metaLine: mediaLine,
  check(files, o) { return o.how === 'size' && !(o.sizeMB >= 1) ? 'Enter a size of at least 1 MB.' : ''; },
  action: (files) => `Make ${files.length === 1 ? 'it' : plural(files.length, 'video')} smaller`,
  zipName: () => 'Smaller videos.zip',
  async run(f, o, job) {
    let p = plan(f, o);
    if (p.skip) return { skipped: p.skip };
    const go = (pl) => runJob('convert', { file: f.file, to: pl.to, video: pl.video, audio: pl.audio }, job, f, 'Making smaller');
    let r = await go(p);
    // A size limit: one more try a little smaller if the first came out over (the encoder's bitrate is an average).
    if (o.how === 'size' && r.blob.size > o.sizeMB * DMB) {
      const again = plan(f, o, Math.max(0.5, ((o.sizeMB * DMB) / r.blob.size) * 0.93));
      if (!again.skip) { p = again; r = await go(p); }
    }
    const before = f.size, after = r.blob.size;
    if (!worthSaving(before, after)) return { skipped: `Already as small as it gets (${fmtBytes(before)})${o.how !== 'strong' && o.how !== 'size' ? '. Strong or a smaller picture size may still help' : ''}.` };
    const over = o.how === 'size' && after > o.sizeMB * DMB;
    const little = after > before * (1 - WORTH_SAVING);
    const notes = [...p.notes, over ? `a little over ${sizeLabel(o.sizeMB)}: try a smaller size` : '', little ? 'only a little smaller' : ''];
    return { outputs: [{ name: job.name(f.stem, p.to === f.format ? (f.name.split('.').pop() || p.to).toLowerCase() : F.formatInfo(p.to).ext, 'smaller'), blob: r.blob }], note: outNote(r.out, notes), warn: over || little };
  },
});
