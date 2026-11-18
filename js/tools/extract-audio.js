// Extract audio: the app's video → MP3 / M4A / WAV conversions (src/shared/formats.js routes; src/main/conversions.js
// with FFmpeg) in the browser, plus OGG. Sound already in the chosen codec is copied as it is (an iPhone video's AAC
// becomes an M4A in a moment, with no quality lost); otherwise it is made at about the source's quality, the app's
// way (src/shared/audiotools.mjs audioEncode). Saved as “name.m4a”.
import { tool, plural, F } from './ui.js';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, outNote, audioFor, loadCaps, caps } from './media-kit.js';

const KEEP = { m4a: ['aac'], mp3: ['mp3'], ogg: ['opus', 'vorbis'], wav: [] };
const HINT = {
  m4a: 'AAC sound, as phones record it. Plays everywhere, and is copied without any loss when the video’s sound is AAC.',
  mp3: 'Plays on everything, including old car stereos and players.',
  wav: 'Uncompressed: the best for editing, but large.',
  ogg: 'Opus sound: small files for Android, Discord and websites.',
};
const label = (id) => F.formatInfo(id).label;

tool({
  kinds: VIDEO_KINDS, multiple: true, max: 20, wrongKind: wrongVideo,
  pick: 'Choose videos', drop: 'MP4, MOV, MKV or WebM. Up to 20 at a time.',
  verb: 'Taking the sound from',
  showSaving: false,
  options: [
    { id: 'to', type: 'chips', label: 'Save as', value: 'm4a',
      choices: () => ['m4a', 'mp3', 'wav', ...(!caps || caps.audio.opus ? ['ogg'] : [])].map((v) => ({ value: v, label: label(v) })),
      hint: (o) => HINT[o.to] + (caps && !caps.audio.opus ? ' (This browser can’t make OGG Opus sound, so OGG isn’t offered.)' : '') },
  ],
  init(app) { loadCaps().then(() => app.update()).catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['audio'], thumb: true }),
  metaLine: mediaLine,
  action: (files, o) => `Save the sound as ${label(o.to)}${files.length > 1 ? ` (${plural(files.length, 'video')})` : ''}`,
  zipName: (a) => `Sound as ${label(a.o.to)}.zip`,
  async run(f, o, job) {
    const copy = KEEP[o.to].includes(f.info.audio.codec);
    if (!copy && !f.info.audio.canDecode) return { skipped: `This browser can’t read ${f.info.audio.name} sound. Try another browser, or the DropDial app.` };
    const enc = audioFor(o.to, f.info);
    const audio = copy ? { codec: f.info.audio.codec } : { codec: enc.codec, bitrate: enc.bitrate, sampleRate: enc.sampleRate, transcode: true };
    const r = await runJob('convert', { file: f.file, to: o.to, video: { discard: true }, audio }, job, f, 'Taking the sound from');
    return { outputs: [{ name: job.name(f.stem, o.to), blob: r.blob }], note: outNote(r.out, [copy ? `${f.info.audio.name}, copied as it is` : enc.label]) };
  },
});
