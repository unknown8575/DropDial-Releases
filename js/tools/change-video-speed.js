// Change video speed: the app's Change speed (src/renderer/tools/video-speed.js): 0.25× to 4× (videotools.mjs
// SPEED_PRESETS), a preview that plays at that speed with the pitch kept, and Mute in More options. The picture is
// retimed at the source's frame rate (at most 60, videotools.mjs outputFps): faster drops frames, slower repeats them.
// The sound keeps its natural pitch (time-stretched in the worker, as the app does with FFmpeg's atempo). The
// container is kept; saved as “name 2x.mp4”.
import { tool, h, urlFor } from './ui.js';
import { SPEED_PRESETS, speedLabel, speedSuffix, formatLength } from '../../tools/engine/shared/videotools.mjs';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, outNote, matchBps, audioFor, loadCaps, caps } from './media-kit.js';

const describe = (s) => (s === 0.5 ? 'Half speed' : s === 2 ? 'Twice as fast' : s < 1 ? `${speedLabel(s)}, slower` : `${speedLabel(s)}, faster`);
let ui = null;

function stage(app, el) {
  const f = app.files.find((x) => !x.error && x.info);
  if (!f) { el.replaceChildren(); ui = null; return; }
  if (ui && ui.file === f) { if (!el.contains(ui.panel)) el.replaceChildren(ui.panel); sync(app); return; }
  const player = h('video', { src: urlFor(f.file), controls: true, preload: 'metadata', playsinline: true, 'aria-label': 'Preview at the chosen speed' });
  player.setAttribute('playsinline', '');
  const tag = h('span', { class: 'pv-tag', 'aria-hidden': 'true' });
  const panel = h('div', { class: 'panel mt is-video' }, h('div', { class: 'mt-view' }, player, tag),
    h('p', { class: 'fine' }, 'The preview plays at the chosen speed.'));
  player.addEventListener('error', () => { player.hidden = true; panel.querySelector('.fine').textContent = 'This browser can’t play this video here, but it can still change its speed.'; });
  ui = { file: f, panel, player, tag };
  el.replaceChildren(panel);
  sync(app);
}
function sync(app) {
  if (!ui) return;
  ui.player.playbackRate = app.o.speed;
  ui.player.defaultPlaybackRate = app.o.speed;
  if ('preservesPitch' in ui.player) ui.player.preservesPitch = true;
  ui.player.muted = !!app.o.mute;
  ui.tag.textContent = speedLabel(app.o.speed);
}

tool({
  kinds: VIDEO_KINDS, multiple: false, wrongKind: wrongVideo,
  pick: 'Choose a video', drop: 'MP4, MOV, MKV or WebM.',
  verb: 'Changing the speed of',
  showSaving: false,
  options: [
    { id: 'speed', type: 'chips', label: 'Speed', value: 2, choices: SPEED_PRESETS.map((s) => ({ value: s, label: speedLabel(s) })),
      hint: (o, app) => { const f = app && app.files.find((x) => x.info); return f ? `${formatLength(f.info.duration)} → ${formatLength(f.info.duration / o.speed)}. ${describe(o.speed)}${f.info.audio && !o.mute ? '; the sound keeps its natural pitch' : ''}.` : describe(o.speed) + '.'; } },
    { id: 'mute', type: 'toggle', label: 'Mute', value: false, more: true, hint: 'Save the video without its sound.' },
  ],
  onOptions: (app) => sync(app),
  init(app) { loadCaps().catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['video', 'decode'] }),
  metaLine: mediaLine,
  stage,
  reset() { ui = null; },
  action: (files, o) => `Save at ${speedLabel(o.speed)}`,
  async run(f, o, job) {
    const to = ['mp4', 'mov', 'mkv', 'webm'].includes(f.format) ? f.format : 'mp4';
    const webm = to === 'webm';
    const codec = webm ? (caps && !caps.video.vp9 && caps.video.vp8 ? 'vp8' : 'vp9') : 'avc';
    const sound = !!f.info.audio && !o.mute;
    if (sound && !f.info.audio.canDecode) return { skipped: `This browser can’t read ${f.info.audio.name} sound. Turn on Mute (More options), or try another browser.` };
    // Faster plays more of the picture each second: the bitrate grows with the speed, as the app's cap does.
    const bitrate = Math.round(matchBps(f.info, codec) * Math.min(2, Math.max(1, o.speed)));
    const args = { file: f.file, to, speed: o.speed, video: { codec, bitrate }, audio: sound ? (webm ? { codec: 'opus', bitrate: 128000 } : { codec: 'aac', bitrate: audioFor('m4a', f.info).bitrate || 160000 }) : { discard: true } };
    const r = await runJob('convert', args, job, f, 'Changing the speed of');
    const ext = (f.name.split('.').pop() || to).toLowerCase();
    return { outputs: [{ name: job.name(f.stem, ext === 'm4v' ? ext : to, speedSuffix(o.speed)), blob: r.blob }], note: outNote(r.out, [speedLabel(o.speed), !sound ? 'no sound' : '']) };
  },
});
