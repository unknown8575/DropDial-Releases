// Make audio smaller: the app's Make smaller for sound (src/shared/shrink.mjs audioPlan): Light, Balanced or Strong;
// MP3 stays MP3, AAC/M4A stays AAC, Opus stays Opus, at a lower bitrate; WAV and FLAC become FLAC (Light: lossless)
// or AAC (Balanced, Strong). A file already at or under the bitrate is left as it is, and a result that isn't smaller
// is not kept. More options: Mono, half the size again for voice.
import { tool, plural, fmtBytes, F } from './ui.js';
import { STRENGTHS, shrinkPlan, worthSaving, WORTH_SAVING } from '../../tools/engine/shared/shrink.mjs';
import { AUDIO_KINDS, wrongAudio, inspectMedia, mediaLine, runJob, outNote, appInfo, loadCaps, caps } from './media-kit.js';

/** The app's plan, with what this browser can write: Vorbis is made as Opus, and Opus as AAC where it can't. */
function plan(f, o) {
  const p = shrinkPlan({ format: f.format, category: 'audio' }, o.how, { info: appInfo(f.info) });
  if (p.kind === 'skip') return { skip: o.mono && f.info.audio.channels > 1 ? null : p.reason, mono: true };
  let { format, codec, kbps, label } = p, note = p.note || '';
  if (codec === 'vorbis') { codec = 'opus'; label = `Opus ${kbps} kbps`; note = 'saved as Opus'; }
  if (codec === 'opus' && caps && !caps.audio.opus) { format = 'm4a'; codec = 'aac'; label = `AAC ${kbps} kbps`; note = 'saved as M4A (AAC): this browser can’t make Opus'; }
  return { to: format, codec, kbps, label, note, lossless: !!p.lossless };
}

tool({
  kinds: AUDIO_KINDS, multiple: true, max: 50, wrongKind: wrongAudio,
  pick: 'Choose sound files', drop: 'MP3, M4A, WAV, FLAC, OGG or Opus. Up to 50 at a time.',
  verb: 'Making smaller',
  options: [
    { id: 'how', type: 'seg', label: 'How small', value: 'balanced', choices: STRENGTHS.map((s) => ({ value: s.value, label: s.label, hint: s.hint })),
      hint: (o, app) => { const f = app && app.files.find((x) => x.info && !x.error); const p = f && plan(f, o); return [STRENGTHS.find((s) => s.value === o.how).hint.replace('Pictures and video may lose some detail, and large ones get fewer pixels.', 'Fine for voice; music loses some detail.'), p && p.label ? `${f.name}: ${p.label}.` : ''].filter(Boolean).join(' '); } },
    { id: 'mono', type: 'toggle', label: 'Mono (one channel)', value: false, more: true, hint: 'For voice notes, lectures and podcasts: about half the size again, and it sounds the same on a phone.' },
  ],
  init(app) { loadCaps().then(() => app.update()).catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['audio', 'decode-audio'] }),
  metaLine: (f) => [...mediaLine(f), f.info && f.info.audio && f.info.audio.bitrate ? `${Math.round(f.info.audio.bitrate / 1000)} kbps` : ''],
  action: (files) => `Make ${files.length === 1 ? 'it' : plural(files.length, 'file')} smaller`,
  zipName: () => 'Smaller sound.zip',
  async run(f, o, job) {
    let p = plan(f, o);
    if (p.skip) return { skipped: p.skip };
    if (p.mono) {
      // Already at this strength's bitrate, but mono still makes it smaller: the same codec, one channel.
      const fmt = ['mp3', 'm4a'].includes(f.format) ? f.format : 'm4a';
      const kbps = Math.max(48, Math.round(Math.round((f.info.audio.bitrate || 128000) / 1000) * 0.6 / 8) * 8);
      p = { to: fmt, codec: fmt === 'mp3' ? 'mp3' : 'aac', kbps, label: `${fmt === 'mp3' ? 'MP3' : 'AAC'} ${kbps} kbps` };
    }
    const mono = o.mono && f.info.audio.channels > 1;
    const kbps = p.kbps && mono && !p.lossless ? Math.max(32, Math.round((p.kbps * 0.6) / 8) * 8) : p.kbps;
    const audio = { codec: p.codec, bitrate: kbps ? kbps * 1000 : undefined, channels: mono ? 1 : undefined, transcode: true };
    const r = await runJob('convert', { file: f.file, to: p.to, video: { discard: true }, audio }, job, f, 'Making smaller');
    const before = f.size, after = r.blob.size;
    if (!worthSaving(before, after)) return { skipped: `Already as small as it gets (${fmtBytes(before)})${o.how !== 'strong' ? '. Strong may still help' : ''}.` };
    const little = after > before * (1 - WORTH_SAVING);
    const label = kbps !== p.kbps ? p.label.replace(/\d+ kbps/, `${kbps} kbps`) : p.label;
    const ext = p.to === f.format ? (f.name.split('.').pop() || p.to).toLowerCase() : F.formatInfo(p.to).ext;
    return { outputs: [{ name: job.name(f.stem, ext, 'smaller'), blob: r.blob }], note: outNote(r.out, [label, mono ? 'mono' : '', p.note, little ? 'only a little smaller' : '']), warn: little };
  },
});
