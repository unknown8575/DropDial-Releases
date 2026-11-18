// Convert video: the app's video conversion (src/main/conversions.js, FFmpeg) made in the browser: MP4 is H.264 with
// AAC sound and WebM is VP9 (VP8 where the browser has no VP9 encoder) with Opus, as the app makes them. A picture or
// sound already in the right codec is copied as it is, so MOV → MP4 from a phone takes seconds and loses nothing.
import { tool, plural, F } from './ui.js';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, outNote, matchBps, audioFor, loadCaps, caps } from './media-kit.js';

const label = (id) => F.formatInfo(id).label;

function plan(f, to) {
  const v = f.info.video, a = f.info.audio;
  if (to === 'webm') {
    const codec = caps && !caps.video.vp9 && caps.video.vp8 ? 'vp8' : 'vp9';
    return { video: { codec, bitrate: matchBps(f.info, codec) }, audio: a ? { codec: 'opus', bitrate: Math.min(160000, Math.max(96000, a.bitrate || 128000)) } : null, vcopy: v.codec === codec, acopy: !a || a.codec === 'opus' };
  }
  return { video: { codec: 'avc', bitrate: matchBps(f.info, 'avc') }, audio: a ? { codec: 'aac', bitrate: audioFor('m4a', f.info).bitrate || 192000 } : null, vcopy: v.codec === 'avc', acopy: !a || a.codec === 'aac' };
}

tool({
  kinds: VIDEO_KINDS, multiple: true, max: 20, wrongKind: wrongVideo,
  accept: 'video/*,.mp4,.m4v,.mov,.mkv,.webm',
  pick: 'Choose videos', drop: 'MOV, MP4, MKV or WebM, from a phone, camera or screen recording. Up to 20 at a time.',
  verb: 'Converting',
  showSaving: false,
  options: [
    { id: 'to', type: 'chips', label: 'Convert to', value: 'mp4',
      choices: () => [{ value: 'mp4', label: 'MP4' }, ...(!caps || caps.video.vp9 || caps.video.vp8 ? [{ value: 'webm', label: 'WebM' }] : [])],
      hint: (o) => (caps && !caps.video.vp9 && !caps.video.vp8 ? 'This browser can’t make WebM videos. MP4 works everywhere.'
        : o.to === 'webm' ? 'For websites and Android. VP9 video with Opus sound.' : 'Plays on every phone, computer, TV and website. H.264 video with AAC sound.') },
  ],
  init(app) { loadCaps().then(() => app.update()).catch(() => {}); },
  inspect: (f) => inspectMedia(f, { need: ['video'] }),
  metaLine: mediaLine,
  check(files, o) { return files.every((f) => f.format === o.to) && o.to === 'mp4' && files.every((f) => f.info && f.info.video.codec === 'avc' && (!f.info.audio || f.info.audio.codec === 'aac')) ? `${files.length === 1 ? 'This video is' : 'These videos are'} already MP4 with H.264 video.` : ''; },
  action: (files, o) => `Convert ${files.length === 1 ? 'to' : plural(files.length, 'video') + ' to'} ${label(o.to)}`,
  zipName: (a) => `Videos as ${label(a.o.to)}.zip`,
  async run(f, o, job) {
    const p = plan(f, o.to);
    if (f.format === o.to && p.vcopy && p.acopy) return { skipped: `Already ${label(o.to)} with ${f.info.video.name} video, so it was left as it is.` };
    if (!p.vcopy && !f.info.video.canDecode) return { skipped: `This browser can’t play ${f.info.video.name} video, so it can’t convert it. Try Chrome or Edge, or the DropDial app.` };
    const r = await runJob('convert', { file: f.file, to: o.to, video: p.video, audio: p.audio }, job, f, 'Converting');
    const notes = [p.vcopy ? 'picture copied as it is, no quality lost' : `${p.video.codec === 'avc' ? 'H.264' : p.video.codec.toUpperCase()} video`, f.info.audio && !p.acopy ? `${p.audio.codec === 'aac' ? 'AAC' : 'Opus'} sound` : ''];
    return { outputs: [{ name: job.name(f.stem, o.to), blob: r.blob }], note: outNote(r.out, notes) };
  },
});
