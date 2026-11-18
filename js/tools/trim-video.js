// Trim video: the app's Trim video (src/renderer/tools/video-trim.js) with one part kept: a player, a filmstrip with
// start and end handles, exact times (typed the app's way, videotools.mjs parseClock), I and O at the playhead, and
// Exact or Fast cut. Exact makes the picture again from the chosen frame at about the source's quality; Fast copies
// it as it is, so the cut starts at the keyframe at or before the start (as the app's fast cut does). The container
// is kept (MP4, MOV, MKV, WebM). Saved as “name trimmed.ext”.
import { tool, announce, h } from './ui.js';
import { MIN_SEGMENT, formatLength, formatClock } from '../../tools/engine/shared/videotools.mjs';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, outNote, timeline, matchBps, audioFor, loadCaps, caps } from './media-kit.js';

const CUT_HINT = {
  exact: 'Cuts on the exact frame you chose. Takes a little longer, because the video is made again.',
  fast: 'Instant, and keeps the original quality. Cuts can only land on keyframes, so the start may move back by a second or so.',
};
const st = { start: 0, end: 0, file: null, ui: null, err: '' };
const whole = (f) => st.start < 0.02 && st.end > f.info.duration - 0.02;

function stage(app, el) {
  const f = app.files.find((x) => !x.error && x.info);
  if (!f) { el.replaceChildren(app.files.some((x) => x.meta.loading) ? h('div', { class: 'panel' }, h('p', { class: 'pv-wait' }, 'Reading the video…')) : ''); return; }
  if (st.file === f && st.ui) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  st.file = f; st.start = 0; st.end = Math.round(f.info.duration * 1000) / 1000; st.err = '';
  st.ui = timeline(f, st, { kind: 'video', min: MIN_SEGMENT, label: 'part to keep', onChange: (e) => { st.err = e || ''; app.update(); } });
  el.replaceChildren(st.ui.panel);
}

tool({
  kinds: VIDEO_KINDS, multiple: false, wrongKind: wrongVideo,
  pick: 'Choose a video', drop: 'MP4, MOV, MKV or WebM, from a phone, camera or screen recording.',
  verb: 'Trimming',
  options: [
    { id: 'cut', type: 'seg', label: 'Cut', value: 'exact', more: true, choices: [{ value: 'exact', label: 'Exact' }, { value: 'fast', label: 'Fast' }], hint: (o) => CUT_HINT[o.cut] },
  ],
  moreLabel: 'Exact or fast cut',
  init(app) { loadCaps().catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['video'] }),
  metaLine: mediaLine,
  stage,
  reset() { st.file = null; st.ui = null; },
  check(files, o) {
    const f = files[0];
    if (!f.info || st.file !== f) return 'Reading the video…';
    if (st.err) return 'Fix the start or end time.';
    if (whole(f)) return 'Drag a handle, or type a time, to choose the part to keep.';
    if (o.cut === 'exact' && !f.info.video.canDecode) return `This browser can’t play ${f.info.video.name} video, so it can only cut it fast. Choose Fast in Exact or fast cut.`;
    return '';
  },
  action: () => `Keep ${formatLength(st.end - st.start)}`,
  showSaving: false,
  async run(f, o, job) {
    const to = ['mp4', 'mov', 'mkv', 'webm'].includes(f.format) ? f.format : 'mp4';
    const fast = o.cut === 'fast';
    const webm = to === 'webm';
    const codec = webm ? (caps && !caps.video.vp9 && caps.video.vp8 ? 'vp8' : 'vp9') : f.info.video.codec === 'avc' || !caps || !caps.video[f.info.video.codec] ? 'avc' : f.info.video.codec;
    const args = { file: f.file, to, trim: { start: st.start, end: st.end } };
    if (fast) args.fast = true;
    else {
      args.exact = true;
      args.video = { codec, bitrate: matchBps(f.info, codec) };
      if (f.info.audio) args.audio = webm ? { codec: 'opus', bitrate: 128000 } : { codec: 'aac', bitrate: audioFor('m4a', f.info).bitrate || 160000 };
    }
    const r = await runJob('convert', args, job, f, 'Trimming');
    announce(`Kept ${formatClock(st.start)} to ${formatClock(st.end)}.`);
    return { outputs: [{ name: job.name(f.stem, (f.name.split('.').pop() || to).toLowerCase() === 'm4v' ? 'm4v' : to, 'trimmed'), blob: r.blob }], note: outNote(r.out, [fast ? 'fast cut, copied as it is with no quality lost' : 'exact cut']) };
  },
});
