// Make smaller (phase 9): how each kind of file is made smaller at each strength, shared by the window (what it says
// will happen, estimates), the main process (plans and FFmpeg arguments; loaded with import()) and the processor
// (pictures). Pure functions only: no DOM, no Node.
//
//   Pictures  JPEG/WebP: saved again at a lower quality (Strong also caps the longest side at 2560 px).
//             PNG: kept as PNG — Light packs it better without changing a pixel (or as exact palette colours when it
//             has 256 or fewer); Balanced and Strong reduce it to 256 well-chosen colours (Balanced dithers, so
//             gradients stay smooth). "Allow JPEG" (More options) saves PNG photos without transparency as JPEG.
//             BMP/TIFF: saved as JPEG when there is no transparency (else PNG) — the same picture, far smaller.
//             HEIC, AVIF, GIF, ICO and SVG are skipped with a reason.
//   Video     H.264 + AAC (WebM: VP9 + Opus) at a quality level by strength; Strong fits the picture in 1920 × 1920.
//   Audio     The same family at a lower bitrate (MP3 → MP3, AAC/M4A → AAC, Opus, Vorbis); lossless WAV/AIFF/FLAC
//             become FLAC (Light, still lossless) or AAC in M4A (Balanced, Strong).
//   PDF       Light and Balanced tidy the file and keep text sharp; Strong turns pages into pictures at 150 dpi.
// A result that isn't smaller than its file is never saved.

export const STRENGTHS = [
  { value: 'light', label: 'Light', icon: 'feather', hint: 'Looks the same. Saves less space.' },
  { value: 'balanced', label: 'Balanced', icon: 'scaling', hint: 'Good quality, much smaller. Right for most uses.' },
  { value: 'strong', label: 'Strong', icon: 'shrink', hint: 'Smallest files. Pictures and video may lose some detail, and large ones get fewer pixels.' },
];
export const STRENGTH_IDS = STRENGTHS.map((s) => s.value);

export const IMAGE_QUALITY = { light: 0.86, balanced: 0.76, strong: 0.62 };
export const IMAGE_CAP = { light: 0, balanced: 0, strong: 2560 };
export const PNG_MODE = { light: 'lossless', balanced: 'palette', strong: 'palette' };
export const VIDEO_CRF = { light: 23, balanced: 27, strong: 30 };
export const VP9_CRF = { light: 33, balanced: 37, strong: 41 };
export const VIDEO_BOX = { light: 0, balanced: 0, strong: 1920 };
export const AAC_KBPS = { light: 160, balanced: 128, strong: 96 };
export const OPUS_KBPS = { light: 128, balanced: 96, strong: 64 };
export const MP3_KBPS = { light: 192, balanced: 128, strong: 96 };
export const VORBIS_KBPS = { light: 160, balanced: 112, strong: 80 };
export const LOSSLESS_AAC = { balanced: 192, strong: 128 };
export const PDF_DPI = 150;
/** A result must be at least this much smaller than its file to be worth saving. */
export const MIN_SAVING = 0.02;
/** A saved result less than this much smaller is shown as a warning ("only a little smaller"), not a success. */
export const WORTH_SAVING = 0.1;

const IMAGE_SKIP = {
  heic: 'HEIC already uses very efficient compression, so it can’t be made smaller here.',
  avif: 'AVIF already uses very efficient compression, so it can’t be made smaller here.',
  gif: 'GIFs can’t be made smaller here. For an animation, try GIF & sticker with a video.',
  ico: 'Icons are already small.',
  svg: 'SVG drawings are text, not pixels, so there is nothing to compress.',
};
const VIDEO_KEEP = ['mp4', 'mov', 'mkv', 'webm'];
const pct = (q) => Math.round(q * 100);

/**
 * What happens to one file: {kind, ...} where kind is 'image' | 'video' | 'audio' | 'pdf' | 'skip'.
 * file: {format, category}. opts: {allowJpeg, ffmpeg (FFmpeg works), info (probe, for audio/video)}.
 * Every plan has `label` (a few words for the list) and skips have `reason`.
 */
export function shrinkPlan(file, strength, { allowJpeg = false, ffmpeg = true, info = null } = {}) {
  const s = STRENGTH_IDS.includes(strength) ? strength : 'balanced';
  const f = file.format;
  if (file.category === 'image') {
    if (IMAGE_SKIP[f]) return { kind: 'skip', reason: IMAGE_SKIP[f], label: 'Skipped' };
    const q = IMAGE_QUALITY[s], cap = IMAGE_CAP[s];
    if (f === 'jpg') return { kind: 'image', to: 'jpg', quality: q, cap, label: `JPEG at ${pct(q)}% quality` };
    if (f === 'webp') return { kind: 'image', to: 'webp', quality: q, cap, label: `WebP at ${pct(q)}% quality` };
    if (f === 'png') {
      const png = { mode: PNG_MODE[s], dither: s === 'balanced' };
      if (allowJpeg) return { kind: 'image', to: 'auto', quality: q, cap, ...png, label: 'JPEG if no transparency, else PNG' };
      return { kind: 'image', to: 'png', quality: q, cap, ...png, label: png.mode === 'lossless' ? 'PNG, packed better' : 'PNG with 256 colours' };
    }
    if (f === 'bmp' || f === 'tiff') return { kind: 'image', to: 'auto', quality: q, cap, mode: PNG_MODE[s], dither: s === 'balanced', label: 'JPEG (PNG if transparent)' };
    return { kind: 'skip', reason: 'This picture format can’t be made smaller here.', label: 'Skipped' };
  }
  if (f === 'pdf') return s === 'strong' ? { kind: 'pdf', level: 'strong', dpi: PDF_DPI, label: `Pages as pictures, ${PDF_DPI} dpi, if much smaller` } : { kind: 'pdf', level: 'light', label: 'Tidied, text stays sharp' };
  if (file.category === 'video' || file.category === 'audio') {
    if (!ffmpeg) return { kind: 'skip', reason: 'Needs FFmpeg for audio and video. Check Settings → Formats.', label: 'Needs FFmpeg', ffmpeg: true };
    return file.category === 'video' ? videoPlan(f, s, info) : audioPlan(f, s, info);
  }
  return { kind: 'skip', reason: 'This kind of file can’t be made smaller.', label: 'Skipped' };
}

function videoPlan(format, s, info) {
  const container = VIDEO_KEEP.includes(format) ? format : 'mp4';
  const webm = container === 'webm';
  const box = VIDEO_BOX[s];
  const big = !!(info && box && Math.max(info.width || 0, info.height || 0) > box);
  return {
    kind: 'video', container, ext: container === 'mp4' ? 'mp4' : container, webm, crf: webm ? VP9_CRF[s] : VIDEO_CRF[s], box,
    audioKbps: webm ? OPUS_KBPS[s] : AAC_KBPS[s], encoders: webm ? ['libvpx-vp9', 'libopus'] : ['libx264', 'aac'],
    label: `${webm ? 'VP9' : 'H.264'}${big ? ', up to 1080p' : ''}`, note: container !== format ? 'saved as MP4' : null,
  };
}

function audioPlan(format, s, info) {
  const stream = info && info.streams ? info.streams.find((x) => x.type === 'audio') || {} : {};
  const codec = stream.codec || '';
  const src = Number(stream.bitrate) || Number(info && info.bitrate) || 0;
  const lossless = ['wav', 'aiff', 'flac'].includes(format) || codec === 'alac' || /^pcm_/.test(codec);
  if (lossless) {
    if (s === 'light') return { kind: 'audio', format: 'flac', ext: 'flac', codec: 'flac', kbps: 0, encoder: 'flac', label: 'FLAC (lossless)', note: format !== 'flac' ? 'saved as FLAC: the same sound, compressed' : null, lossless: true };
    const kbps = LOSSLESS_AAC[s];
    return { kind: 'audio', format: 'm4a', ext: 'm4a', codec: 'aac', kbps, encoder: 'aac', label: `AAC ${kbps} kbps`, note: 'saved as M4A (AAC)' };
  }
  let out;
  if (format === 'mp3') out = { format: 'mp3', ext: 'mp3', codec: 'mp3', kbps: MP3_KBPS[s], encoder: 'libmp3lame', label: `MP3 ${MP3_KBPS[s]} kbps` };
  else if (format === 'opus' || (format === 'ogg' && codec === 'opus')) out = { format, ext: format, codec: 'opus', kbps: OPUS_KBPS[s], encoder: 'libopus', label: `Opus ${OPUS_KBPS[s]} kbps` };
  else if (format === 'ogg') out = { format: 'ogg', ext: 'ogg', codec: 'vorbis', kbps: VORBIS_KBPS[s], encoder: 'libvorbis', label: `Vorbis ${VORBIS_KBPS[s]} kbps` };
  else out = { format: 'm4a', ext: 'm4a', codec: 'aac', kbps: AAC_KBPS[s], encoder: 'aac', label: `AAC ${AAC_KBPS[s]} kbps`, note: format !== 'm4a' ? 'saved as M4A (AAC)' : null };
  // Already at or under this bitrate: it would only lose quality without getting smaller.
  if (src && src <= out.kbps * 1.05) return { kind: 'skip', reason: `It is already ${src} kbps, which is as small as ${STRENGTHS.find((x) => x.value === s).label} makes it.`, label: 'Already small' };
  return { kind: 'audio', ...out };
}

/**
 * The one rule for keeping a result, used by the job and by the window before saving: a result is saved only when it
 * is at least MIN_SAVING smaller than its file. The window says a file “will be skipped” only from a real size (a
 * picture made ahead, or a whole short video or sound made ahead), never from an estimate.
 */
export const worthSaving = (before, after) => before > 0 && after > 0 && after < before * (1 - MIN_SAVING);

/** Test encodes for estimates: media up to this long is made whole (its size is then exact), longer is sampled. */
export const SAMPLE_WHOLE = 12;
export const SAMPLE_SECONDS = 6;
/** The part of a `duration`-second file made ahead for an estimate: {start, length, whole}. From the middle. */
export function sampleWindow(duration) {
  if (!(duration > 0) || duration <= SAMPLE_WHOLE) return { start: 0, length: duration, whole: true };
  const length = SAMPLE_SECONDS;
  return { start: Math.round(Math.max(0, duration / 2 - length / 2) * 1000) / 1000, length, whole: false };
}
/** The whole result's size from the size of the sample made ahead (scaled to the length; a little room for the file's header). */
export const scaleSample = (bytes, sample, duration) => (sample.whole ? bytes : Math.round(Math.max(0, bytes - 2048) * (duration / sample.length) + 2048));

/** Rough size in bytes of a video or audio result (for “about …” before saving), or null. */
export function estimateBytes(plan, info) {
  if (!info || !(info.duration > 0)) return null;
  const d = info.duration;
  if (plan.kind === 'audio') {
    if (plan.lossless) return null;
    const ch = ((info.streams || []).find((x) => x.type === 'audio') || {}).channels || 2;
    return Math.round(((plan.kbps * (ch === 1 && plan.codec === 'aac' ? 0.75 : 1)) * 1000 / 8) * d);
  }
  if (plan.kind === 'video') {
    let w = info.width || 1280, h = info.height || 720;
    if (plan.box && Math.max(w, h) > plan.box) { const k = plan.box / Math.max(w, h); w *= k; h *= k; }
    const fps = Math.min(60, info.fps || 30);
    // Bits per pixel per frame for typical phone and screen video at these quality levels.
    const bpp = { 23: 0.075, 27: 0.045, 30: 0.03, 33: 0.06, 37: 0.038, 41: 0.024 }[plan.crf] || 0.05;
    const video = w * h * fps * bpp * d / 8;
    const audio = info.hasAudio ? (plan.audioKbps * 1000 / 8) * d : 0;
    return Math.round(video + audio + 4096);
  }
  return null;
}

const ev = (n) => String(Math.round(n));
/** FFmpeg arguments for a video plan (input → output). */
export function videoArgs(plan, input, output, info) {
  const audio = info && info.hasAudio;
  const vf = [];
  if (plan.box && info && Math.max(info.width || 0, info.height || 0) > plan.box) vf.push(`scale=w='min(iw,${plan.box})':h='min(ih,${plan.box})':force_original_aspect_ratio=decrease`);
  vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  const v = plan.webm
    ? ['-c:v', 'libvpx-vp9', '-crf', ev(plan.crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', ev(plan.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  const a = audio ? (plan.webm ? ['-c:a', 'libopus', '-b:a', `${plan.audioKbps}k`] : ['-c:a', 'aac', '-b:a', `${plan.audioKbps}k`]) : ['-an'];
  return ['-i', input, '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []), '-sn', '-dn', '-map_metadata', '0', '-vf', vf.join(','), ...v, ...a,
    ...(plan.container === 'mp4' || plan.container === 'mov' ? ['-movflags', '+faststart'] : []), '-n', output];
}

/** FFmpeg arguments for an audio plan; `keep` carries tags and cover art (audiotools keepArgs). */
export function audioArgs(plan, input, output, keep = ['-map_metadata', '0', '-vn']) {
  const enc = plan.codec === 'flac' ? ['-c:a', 'flac', '-compression_level', '8']
    : plan.codec === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${plan.kbps}k`, '-id3v2_version', '3', '-write_id3v1', '0']
    : plan.codec === 'opus' ? ['-c:a', 'libopus', '-b:a', `${plan.kbps}k`]
    : plan.codec === 'vorbis' ? ['-c:a', 'libvorbis', '-b:a', `${plan.kbps}k`]
    : ['-c:a', 'aac', '-b:a', `${plan.kbps}k`];
  return ['-i', input, '-map', '0:a:0', ...keep, ...enc, '-n', output];
}

/** "4.47 MB → 1.20 MB (−73%)" pieces: the saving as a whole percentage, or null when it isn't smaller. */
export const saving = (before, after) => (before > 0 && after > 0 && after < before ? Math.round((1 - after / before) * 100) : null);
