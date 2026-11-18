// Trim audio: the app's Trim audio (src/renderer/tools/audio-trim.js): a waveform with start and end handles, exact
// times, I and O at the playhead, play the part, and a fade in and out (None, 0.5, 1, 2 or 3 s, each at most half the
// part: audiotools.mjs fadeOptions and fitFades, the same linear ramps the app makes). The format is kept where the
// browser can write it (MP3, M4A, WAV, FLAC, OGG as Opus), at about the source's quality. Saved as “name trimmed.ext”.
import { tool, h } from './ui.js';
import { MIN_TRIM, FADE_PRESETS, maxFade, fitFades } from '../../tools/engine/shared/audiotools.mjs';
import { formatLength } from '../../tools/engine/shared/videotools.mjs';
import { AUDIO_KINDS, wrongAudio, inspectMedia, mediaLine, runJob, outNote, timeline, audioFor, loadCaps, caps } from './media-kit.js';

const st = { start: 0, end: 0, file: null, ui: null, err: '', app: null };
const fadeChoices = () => FADE_PRESETS.filter((v) => !v || v <= maxFade(st.end - st.start) + 1e-9).map((v) => ({ value: v, label: v ? `${v} s` : 'None' }));

function stage(app, el) {
  const f = app.files.find((x) => !x.error && x.info);
  if (!f) { el.replaceChildren(app.files.some((x) => x.meta.loading) ? h('div', { class: 'panel' }, h('p', { class: 'pv-wait' }, 'Reading the sound…')) : ''); return; }
  if (st.file === f && st.ui) { if (!el.contains(st.ui.panel)) el.replaceChildren(st.ui.panel); return; }
  st.file = f; st.start = 0; st.end = Math.round(f.info.duration * 1000) / 1000; st.err = '';
  st.ui = timeline(f, st, { kind: 'audio', min: MIN_TRIM, label: 'part to keep', fades: () => ({ in: app.o.fadeIn, out: app.o.fadeOut }),
    onChange: (e) => { st.err = e || ''; clampFades(app); app.update(); } });
  el.replaceChildren(st.ui.panel);
}
function clampFades(app) {
  const m = maxFade(st.end - st.start);
  if (app.o.fadeIn > m) app.o.fadeIn = FADE_PRESETS.filter((v) => v <= m).pop() || 0;
  if (app.o.fadeOut > m) app.o.fadeOut = FADE_PRESETS.filter((v) => v <= m).pop() || 0;
}
/** The format kept, or the nearest one the browser can write. */
function outFormat(f) {
  if (['mp3', 'm4a', 'wav', 'flac'].includes(f.format)) return { to: f.format };
  if ((f.format === 'ogg' || f.format === 'opus') && (!caps || caps.audio.opus)) return { to: f.format === 'opus' ? 'opus' : 'ogg', note: f.info.audio.codec === 'vorbis' ? 'saved as Opus' : '' };
  return { to: 'm4a', note: 'saved as M4A (AAC): this browser can’t make Opus' };
}

tool({
  kinds: AUDIO_KINDS, multiple: false, wrongKind: wrongAudio,
  pick: 'Choose a sound file', drop: 'MP3, M4A, WAV, FLAC, OGG or Opus: a song, voice memo or recording.',
  verb: 'Trimming',
  showSaving: false,
  options: [
    { id: 'fadeIn', type: 'chips', label: 'Fade in', value: 0, choices: () => fadeChoices() },
    { id: 'fadeOut', type: 'chips', label: 'Fade out', value: 0, choices: () => fadeChoices(), hint: 'A fade is at most half the part, so the two never overlap.' },
  ],
  onOptions: () => { if (st.ui) st.ui.draw(); },
  init(app) { loadCaps().catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['audio', 'decode-audio'] }),
  metaLine: mediaLine,
  stage,
  reset() { st.file = null; st.ui = null; },
  check(files, o) {
    const f = files[0];
    if (!f.info || st.file !== f) return 'Reading the sound…';
    if (st.err) return 'Fix the start or end time.';
    const whole = st.start < 0.005 && st.end > f.info.duration - 0.005;
    if (whole && !o.fadeIn && !o.fadeOut) return 'Drag the handles, or type the times, to choose what to keep, or add a fade.';
    return '';
  },
  action: () => `Keep ${formatLength(st.end - st.start)}`,
  async run(f, o, job) {
    const { to, note } = outFormat(f);
    const enc = audioFor(to === 'opus' ? 'ogg' : to, f.info);
    const fades = fitFades(o.fadeIn, o.fadeOut, st.end - st.start);
    const r = await runJob('convert', { file: f.file, to, trim: { start: st.start, end: st.end }, exact: true, audio: { codec: enc.codec, bitrate: enc.bitrate, sampleRate: enc.sampleRate, transcode: true, fades } }, job, f, 'Trimming');
    const notes = [enc.label, fades.in ? `fades in over ${fades.in} s` : '', fades.out ? `fades out over ${fades.out} s` : '', note];
    return { outputs: [{ name: job.name(f.stem, to === f.format ? (f.name.split('.').pop() || to).toLowerCase() : to, 'trimmed'), blob: r.blob }], note: outNote(r.out, notes) };
  },
});
