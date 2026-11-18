// Convert audio: the app's audio conversions (src/shared/formats.js routes, made with FFmpeg in the app) in the
// browser: MP3, M4A (AAC), WAV, FLAC and OGG (Opus). Each is made close to the source the app's way
// (src/shared/audiotools.mjs audioEncode: the same bitrate snapped to what the encoder takes, the same sample rate
// and bit depth where the format allows), or at a bitrate you choose. Tags such as title and artist are kept.
import { tool, plural, F } from './ui.js';
import { AUDIO_KINDS, wrongAudio, inspectMedia, mediaLine, runJob, outNote, audioFor, loadCaps, caps } from './media-kit.js';

const label = (id) => F.formatInfo(id).label;
const LOSSY = ['mp3', 'm4a', 'ogg'];
const HINT = {
  mp3: 'Plays on everything, including old players and car stereos.',
  m4a: 'AAC, as iPhones and Android phones use: better sound than MP3 at the same size.',
  wav: 'Uncompressed: the best for editing, but large.',
  flac: 'Lossless and about half the size of WAV. Plays on most phones and computers.',
  ogg: 'Opus: very good sound in small files, for Android, Discord and websites.',
};

tool({
  kinds: AUDIO_KINDS, multiple: true, max: 50, wrongKind: wrongAudio,
  pick: 'Choose sound files', drop: 'MP3, M4A, WAV, FLAC, OGG or Opus: songs, voice memos and recordings. Up to 50 at a time.',
  verb: 'Converting',
  showSaving: false,
  options: [
    { id: 'to', type: 'chips', label: 'Convert to', value: 'mp3',
      choices: () => ['mp3', 'm4a', 'wav', 'flac', ...(!caps || caps.audio.opus ? ['ogg'] : [])].map((v) => ({ value: v, label: v === 'ogg' ? 'OGG (Opus)' : label(v) })),
      hint: (o) => HINT[o.to] + (caps && !caps.audio.opus ? ' (This browser can’t make Opus sound, so OGG isn’t offered.)' : '') },
    { id: 'kbps', type: 'select', label: 'Quality', value: 0, more: true, when: (o) => LOSSY.includes(o.to),
      choices: [{ value: 0, label: 'Like the original' }, ...[320, 256, 192, 160, 128, 96, 64].map((k) => ({ value: k, label: `${k} kbps` }))],
      hint: (o) => (o.kbps ? (o.kbps >= 192 ? 'High quality, for music.' : o.kbps >= 128 ? 'Good for music and voice.' : 'Small files, best for voice.') : 'About the bitrate of each file, so nothing is lost that was there.') },
  ],
  init(app) { loadCaps().then(() => app.update()).catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['audio', 'decode-audio'] }),
  metaLine: (f) => [...mediaLine(f), f.info && f.info.audio && f.info.audio.bitrate ? `${Math.round(f.info.audio.bitrate / 1000)} kbps` : ''],
  check(files, o) { return files.every((f) => f.format === o.to || (o.to === 'ogg' && f.format === 'opus')) ? `${files.length === 1 ? 'This file is' : 'These files are'} already ${label(o.to)}.` : ''; },
  action: (files, o) => `Convert ${files.length === 1 ? 'to' : plural(files.length, 'file') + ' to'} ${o.to === 'ogg' ? 'OGG' : label(o.to)}`,
  zipName: (a) => `Sound as ${a.o.to === 'ogg' ? 'OGG' : label(a.o.to)}.zip`,
  async run(f, o, job) {
    if (f.format === o.to || (o.to === 'ogg' && f.format === 'opus' && !o.kbps)) return { skipped: `Already ${label(f.format)}, so it was left as it is.` };
    const enc = audioFor(o.to, f.info);
    if (o.kbps && LOSSY.includes(o.to)) { enc.bitrate = o.kbps * 1000; enc.label = enc.label.replace(/\d+ kbps/, `${o.kbps} kbps`); }
    const r = await runJob('convert', { file: f.file, to: o.to, video: { discard: true }, audio: { codec: enc.codec, bitrate: enc.bitrate, sampleRate: enc.sampleRate, transcode: true } }, job, f, 'Converting');
    return { outputs: [{ name: job.name(f.stem, o.to), blob: r.blob }], note: outNote(r.out, [enc.label]) };
  },
});
