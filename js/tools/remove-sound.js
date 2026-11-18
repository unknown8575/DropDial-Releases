// Remove sound: the picture copied as it is with no sound track (as the app's Change speed saves “name muted.ext”
// with Mute on and the speed at 1×). Nothing is made again, so it is quick and loses nothing. The container is kept.
import { tool, plural } from './ui.js';
import { VIDEO_KINDS, wrongVideo, inspectMedia, mediaLine, runJob, outNote } from './media-kit.js';

tool({
  kinds: VIDEO_KINDS, multiple: true, max: 20, wrongKind: wrongVideo,
  pick: 'Choose videos', drop: 'MP4, MOV, MKV or WebM. Up to 20 at a time.',
  verb: 'Removing the sound from',
  showSaving: false,
  inspect: (f) => inspectMedia(f, { need: ['video'] }),
  metaLine: mediaLine,
  check(files) { return files.every((f) => f.info && !f.info.audio) ? (files.length === 1 ? 'This video has no sound already.' : 'These videos have no sound already.') : ''; },
  action: (files) => (files.length === 1 ? 'Remove the sound' : `Remove the sound from ${plural(files.length, 'video')}`),
  againLabel: 'Back to the videos',
  zipName: () => 'Videos without sound.zip',
  async run(f, o, job) {
    if (!f.info.audio) return { skipped: 'This video has no sound, so it was left as it is.' };
    const to = ['mp4', 'mov', 'mkv', 'webm'].includes(f.format) ? f.format : 'mp4';
    const r = await runJob('convert', { file: f.file, to, audio: { discard: true } }, job, f, 'Removing the sound from');
    const ext = (f.name.split('.').pop() || to).toLowerCase();
    return { outputs: [{ name: job.name(f.stem, ext === 'm4v' ? ext : to, 'muted'), blob: r.blob }], note: outNote(r.out, ['no sound', 'picture copied as it is']) };
  },
});
