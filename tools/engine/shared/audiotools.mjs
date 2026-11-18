// Audio tools (phase 8): the maths, drawing and FFmpeg arguments shared by the audio windows (previews, plans,
// checks), the processor (the pictures Audio to video is made from) and the main process (exports). Pure functions
// only: no DOM, no Node. Main loads this module with import() and keeps its validation bounds in step with the
// constants here (src/main/tools/audio-common.js, checked by unit tests).
//
// Times are seconds. Levels are dBFS / LUFS. Waveform data ("peaks") is what the main process reads once per file
// (media:peaks): {rate (buckets per second), duration, channels (1 or 2), peak: [Uint8Array per channel],
// rms: [Uint8Array per channel]}, each value q meaning an amplitude of (q / 255)² of full scale — a square-root
// scale, so quiet parts keep some detail in one byte.

import { formatClock, formatLength, MAX_DURATION } from './videotools.mjs';

export { formatClock, formatLength, MAX_DURATION };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (t) => Math.round(t * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (Number.isFinite(v) ? String(r3(v)) : '0');
export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
/** "−16.0" with a real minus sign (one decimal). */
export const fmtDb = (v, digits = 1) => (Number.isFinite(v) ? (v < 0 ? '−' : v > 0 ? '+' : '') + Math.abs(v).toFixed(digits) : '−∞');
export const fmtLufs = (v) => (Number.isFinite(v) ? (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) : '−∞');

// ------------------------------------------------------------------ formats and encoders
/** Formats an audio result keeps; anything else (WMA) is saved as M4A (AAC), which plays everywhere. */
export const AUDIO_KEEP = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff'];
export const outputFormat = (format) => (AUDIO_KEEP.includes(format) ? format : 'm4a');
const LABEL = { mp3: 'MP3', m4a: 'M4A', wav: 'WAV', flac: 'FLAC', ogg: 'OGG', opus: 'Opus', aiff: 'AIFF', wma: 'WMA' };
/** Why the result's format differs from the file's, or null. */
/** Videos the audio tools work on (QA round 7): the picture is kept; these containers are kept, others become MP4. */
export const VIDEO_SOUND = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv'];
export const VIDEO_KEPT = ['mp4', 'mov', 'mkv', 'webm'];
export function formatNote(format, { trim = false } = {}) {
  if (VIDEO_SOUND.includes(format)) {
    return `${trim ? 'Video: the picture is cut with the sound, so they stay in step.' : 'Video: the picture is kept, only the sound changes.'}${VIDEO_KEPT.includes(format) ? '' : ' It’s saved as MP4.'}`;
  }
  return AUDIO_KEEP.includes(format) ? null : `${LABEL[format] || format.toUpperCase()} can’t be written here, so it’s saved as M4A (AAC), which plays on almost everything.`;
}

export const MP3_KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const AAC_RATES = [7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000];
const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
/** The closest allowed rate at or above v (the highest when none is). */
const atLeast = (list, v) => list.find((x) => x >= v) || list[list.length - 1];

/** Bits per sample of a probed audio stream: 16, 24, 32 (integer), 'f32'/'f64' (float), 8, or 0 when unknown. */
export function sampleDepth(stream = {}) {
  if (stream.bits) return stream.bits;
  const f = String(stream.sampleFmt || '').replace(/p$/, '');
  return { u8: 8, s16: 16, s32: 32, s64: 32, flt: 'f32', dbl: 'f64' }[f] || 0;
}

/**
 * How to encode a result of format `format` (an AUDIO_KEEP id) from a source audio stream, staying close to the
 * source: the same bitrate (snapped to what the encoder takes), the same bit depth for lossless formats, and the
 * source's sample rate where the format allows it. `channels` is the result's channel count.
 * Returns {args, encoder, rate, label}.
 */
export function audioEncode(format, stream = {}, { channels = stream.channels || 2, kbps: fallbackKbps = 0 } = {}) {
  const src = Number(stream.bitrate) || Number(fallbackKbps) || 0;
  const sr = Number(stream.sampleRate) || 44100;
  const depth = sampleDepth(stream);
  const codec = stream.codec || '';
  const lossy = (lo, hi, def) => Math.round(clamp(src || def, lo, hi));
  switch (format) {
    case 'mp3': {
      const kbps = nearest(MP3_KBPS, src || 192);
      const rate = MP3_RATES.includes(sr) ? sr : atLeast(MP3_RATES, Math.min(sr, 48000));
      return { args: ['-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-ar', String(rate), '-id3v2_version', '3', '-write_id3v1', '0'], encoder: 'libmp3lame', rate, label: `MP3 ${kbps} kbps` };
    }
    case 'm4a': {
      const rate = AAC_RATES.includes(sr) ? sr : atLeast(AAC_RATES, Math.min(sr, 96000));
      if (codec === 'alac') {
        const fmt = depth === 16 || depth === 8 ? 's16p' : 's32p';
        return { args: ['-c:a', 'alac', '-sample_fmt', fmt, '-ar', String(rate)], encoder: 'alac', rate, label: 'Apple Lossless' };
      }
      const kbps = lossy(32, channels > 2 ? 640 : 320, channels === 1 ? 128 : 192);
      return { args: ['-c:a', 'aac', '-b:a', kbps + 'k', '-ar', String(rate)], encoder: 'aac', rate, label: `AAC ${kbps} kbps` };
    }
    case 'ogg': {
      if (codec === 'opus') {
        const kbps = lossy(16, 510, 128);
        return { args: ['-c:a', 'libopus', '-b:a', kbps + 'k', '-ar', '48000'], encoder: 'libopus', rate: 48000, label: `Opus ${kbps} kbps` };
      }
      if (!src) return { args: ['-c:a', 'libvorbis', '-q:a', '5', '-ar', String(sr)], encoder: 'libvorbis', rate: sr, label: 'Vorbis' };
      const kbps = lossy(48, 480, 160);
      return { args: ['-c:a', 'libvorbis', '-b:a', kbps + 'k', '-ar', String(sr)], encoder: 'libvorbis', rate: sr, label: `Vorbis ${kbps} kbps` };
    }
    case 'opus': {
      const kbps = lossy(16, 510, 128);
      return { args: ['-c:a', 'libopus', '-b:a', kbps + 'k', '-ar', '48000'], encoder: 'libopus', rate: 48000, label: `Opus ${kbps} kbps` };
    }
    case 'flac': {
      const fmt = depth === 16 || depth === 8 ? 's16' : 's32';
      return { args: ['-c:a', 'flac', '-sample_fmt', fmt, '-ar', String(sr)], encoder: 'flac', rate: sr, label: `FLAC ${fmt === 's16' ? 16 : 24}-bit` };
    }
    case 'wav': case 'aiff': {
      const le = format === 'wav';
      const pcm = /^pcm_(u8|s16|s24|s32|f32|f64)/.exec(codec);
      let kind = pcm ? pcm[1] : depth === 24 ? 's24' : depth === 32 ? 's32' : depth === 'f32' ? 'f32' : 's16';
      if (kind === 'u8' && !le) kind = 's16'; // AIFF has no unsigned 8-bit
      if (kind === 'f64') kind = 'f32';
      const enc = kind === 'u8' ? 'pcm_u8' : `pcm_${kind}${le ? 'le' : 'be'}`;
      const bits = { u8: 8, s16: 16, s24: 24, s32: 32, f32: 32 }[kind];
      return { args: ['-c:a', enc, '-ar', String(sr)], encoder: enc, rate: sr, label: `${LABEL[format]} ${bits}-bit${kind === 'f32' ? ' float' : ''}` };
    }
    default: throw new Error('Unknown audio format: ' + format);
  }
}

/** Cover art and tags: copy the attached picture where the format can hold one (MP3, M4A, FLAC). */
export function keepArgs(format, info, input = 0) {
  const cover = (info.streams || []).some((s) => s.type === 'video' && s.attachedPic);
  const args = ['-map_metadata', String(input)];
  if (cover && ['mp3', 'm4a', 'flac'].includes(format)) args.push('-map', `${input}:v:0`, '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  else args.push('-vn');
  if (format === 'm4a') args.push('-movflags', '+faststart');
  args.push('-sn', '-dn');
  return args;
}

/** The first audio stream of a probe result (or {}). */
export const audioStream = (info) => (info && info.streams && info.streams.find((s) => s.type === 'audio')) || {};

/** Channel layout name FFmpeg understands for a stream ("stereo", "5.1(side)", "mono" …; "Nc" when unnamed). */
export function layoutOf(stream) {
  const l = String(stream.layout || '').trim();
  if (/^[a-z0-9.()+-]+$/i.test(l) && !/channels/.test(l)) return l;
  const n = stream.channels || Number((/(\d+) channels/.exec(l) || [])[1]) || 2;
  return n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n}c`;
}

// ------------------------------------------------------------------ waveform data
/** A byte (square-root scale) back to an amplitude 0..1. */
export const amp = (q) => (q / 255) ** 2;
/** An amplitude 0..1 to a byte (square-root scale). */
export const toByte = (a) => Math.round(Math.sqrt(clamp(a, 0, 1)) * 255);

/**
 * The envelope of [from, to] in `n` columns: {peak, rms} (Float32Arrays of amplitudes 0..1). `channel` picks one
 * channel (0 or 1); otherwise channels are combined (loudest peak, mean power). Columns narrower than one bucket
 * take the bucket under them.
 */
export function envelope(peaks, from, to, n, { channel = -1, matrix = null } = {}) {
  const peak = new Float32Array(n), rms = new Float32Array(n);
  if (!peaks || !peaks.peak || !peaks.peak.length || !(to > from) || n < 1) return { peak, rms };
  const R = peaks.rate, len = peaks.peak[0].length;
  const chans = peaks.peak.length;
  // A 2×2 matrix shows what a channel would hold after Stereo & mono (an estimate from each side's envelope: a mono
  // source is the same sound on both sides; two sides are treated as different sounds, so their power adds).
  const val = (arr, ch, k) => amp(arr[Math.min(ch, chans - 1)][k]);
  const pick = (arr, k, isRms) => {
    if (matrix && channel >= 0) {
      const [a, b] = matrix[channel];
      const l = val(arr, 0, k), r = val(arr, 1, k);
      if (chans === 1) return Math.abs(a + b) * l;
      return isRms ? Math.sqrt((a * l) ** 2 + (b * r) ** 2) : Math.abs(a) * l + Math.abs(b) * r;
    }
    if (channel >= 0) return val(arr, channel, k);
    if (chans === 1) return val(arr, 0, k);
    const l = val(arr, 0, k), r = val(arr, 1, k);
    return isRms ? Math.sqrt((l * l + r * r) / 2) : Math.max(l, r);
  };
  for (let i = 0; i < n; i++) {
    const a = Math.floor((from + ((to - from) * i) / n) * R);
    const z = Math.max(a + 1, Math.floor((from + ((to - from) * (i + 1)) / n) * R));
    let p = 0, s = 0, c = 0;
    for (let k = Math.max(0, a); k < Math.min(len, z); k++) {
      p = Math.max(p, pick(peaks.peak, k, false));
      const v = pick(peaks.rms, k, true);
      s += v * v; c++;
    }
    peak[i] = Math.min(1, p);
    rms[i] = c ? Math.min(1, Math.sqrt(s / c)) : 0;
  }
  return { peak, rms };
}

/** Loudest peak of the whole file (0..1), for scaling a waveform to fill its height. */
export function loudest(peaks) {
  let m = 0;
  if (peaks && peaks.peak) for (const ch of peaks.peak) for (let k = 0; k < ch.length; k++) if (ch[k] > m) m = ch[k];
  return amp(m);
}

// ------------------------------------------------------------------ Trim
export const MIN_TRIM = 0.1;                         // shortest part kept (s)
export const FADE_PRESETS = [0, 0.5, 1, 2, 3];       // fade in/out lengths offered (s)
export const FADE_IDS = FADE_PRESETS;
/** The longest a fade may be for a part this long: half of it, so a fade in and a fade out never overlap. */
export const maxFade = (len) => Math.max(0, len / 2);
/** The fades as they will be made: each at most half the part. */
export const fitFades = (fadeIn, fadeOut, len) => ({ in: r3(Math.min(fadeIn || 0, maxFade(len))), out: r3(Math.min(fadeOut || 0, maxFade(len))) });
/** Fade presets for a part of length `len`: longer than half the part is off, with why. */
export function fadeOptions(len) {
  return FADE_PRESETS.map((v) => ({ value: v, label: v ? `${v} s` : 'None', disabled: v > 0 && v > maxFade(len) + 1e-9, hint: v > maxFade(len) + 1e-9 ? 'Longer than half the part' : undefined }));
}
/** Gain (0..1) at time `t` (from the part's start) of a part `len` long with these fades (linear ramps). */
export function fadeGain(t, len, fades) {
  let g = 1;
  if (fades.in > 0 && t < fades.in) g = Math.min(g, Math.max(0, t / fades.in));
  if (fades.out > 0 && t > len - fades.out) g = Math.min(g, Math.max(0, (len - t) / fades.out));
  return g;
}

/** Arguments to keep [start, end) of `input` with fades, encoded as `enc` (audioEncode) and tags kept. */
export function trimArgs({ input, output, start, end, fades = { in: 0, out: 0 }, enc, keep }) {
  const len = r3(end - start);
  const f = fitFades(fades.in, fades.out, len);
  const chain = [];
  if (f.in > 0) chain.push(`afade=t=in:st=0:d=${num(f.in)}`);
  if (f.out > 0) chain.push(`afade=t=out:st=${num(len - f.out)}:d=${num(f.out)}`);
  return ['-ss', num(start), '-t', num(len), '-i', input, '-map', '0:a:0', ...(chain.length ? ['-af', chain.join(',')] : []), ...enc.args, ...keep, '-n', output];
}

// ------------------------------------------------------------------ Even out volume
export const LEVEL_TARGETS = [
  { value: 'podcast', lufs: -16, label: 'Podcast', icon: 'mic', hint: 'Talk, podcasts and voice-overs: clear and easy to hear on phones (−16 LUFS).' },
  { value: 'music', lufs: -14, label: 'Music', icon: 'music', hint: 'Songs for streaming and sharing, as loud as Spotify and YouTube play them (−14 LUFS).' },
  { value: 'voice', lufs: -23, label: 'Voice note', icon: 'radio', hint: 'Broadcast level (EBU R128, −23 LUFS): calmer, with room for loud moments. Good for voice notes, radio and TV.' },
];
export const LEVEL_IDS = [...LEVEL_TARGETS.map((t) => t.value), 'custom'];
export const PEAK_LIMITS = [-2, -1, -0.5];          // dBTP
export const LUFS_MIN = -40, LUFS_MAX = -6;         // custom targets
export const targetLufs = (level, custom) => (level === 'custom' ? custom : (LEVEL_TARGETS.find((t) => t.value === level) || LEVEL_TARGETS[0]).lufs);

/**
 * Read loudnorm's JSON report from FFmpeg's log: {i, tp, lra, thresh, offset, type, outI, outTp}, or null.
 * `i` is null when the sound is silent (FFmpeg says -inf).
 */
export function parseLoudnorm(text) {
  const s = String(text || '');
  const at = s.lastIndexOf('"input_i"');
  if (at < 0) return null;
  const open = s.lastIndexOf('{', at), close = s.indexOf('}', at);
  if (open < 0 || close < 0) return null;
  let j;
  try { j = JSON.parse(s.slice(open, close + 1)); } catch { return null; }
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  return { i: n(j.input_i), tp: n(j.input_tp), lra: n(j.input_lra) ?? 0, thresh: n(j.input_thresh), offset: n(j.target_offset) ?? 0, type: j.normalization_type || null, outI: n(j.output_i), outTp: n(j.output_tp) };
}

/** First pass: measure (arguments for FFmpeg; read the report from its log with parseLoudnorm). */
export const measureArgs = (input, target = -16, peak = -1) => ['-loglevel', 'info', '-i', input, '-map', '0:a:0', '-vn', '-af', `loudnorm=I=${target}:TP=${peak}:LRA=11:print_format=json`, '-f', 'null', '-'];

/** The loudness range target: 11 LU, or the file's own range (up to 20) so a dynamic recording can stay linear. */
export const lraTarget = (m) => clamp(Math.ceil(((m && m.lra) || 0) + 1), 11, 20);
/** Whether the level can change by a plain gain (no limiting): the loudest peak still fits under the limit. */
export const canBeLinear = (m, target, peak) => !!m && m.i != null && m.tp != null && m.tp + (target - m.i) <= peak + 1e-9 && (m.lra || 0) <= lraTarget(m);

/** Second pass: loudnorm with the measured values (linear when possible), at the result's sample rate. */
export function levelFilter(m, { target, peak, rate }) {
  const lra = lraTarget(m);
  const f = `loudnorm=I=${target}:TP=${peak}:LRA=${lra}:measured_I=${r2(m.i)}:measured_TP=${r2(m.tp)}:measured_LRA=${Math.max(0.01, r2(m.lra || 0))}:measured_thresh=${r2(m.thresh)}:offset=${r2(m.offset || 0)}:linear=true:print_format=json`;
  return rate ? `${f},aresample=${rate}` : f;
}

/** What evening out will do: {gain (dB), linear, words}. */
export function levelPlan(m, target, peak) {
  if (!m || m.i == null) return { gain: 0, linear: true, words: 'Silent: nothing to even out.' };
  const gain = target - m.i;
  const linear = canBeLinear(m, target, peak);
  const dir = Math.abs(gain) < 0.25 ? 'Already at this level' : gain > 0 ? `${fmtDb(gain)} dB louder` : `${fmtDb(gain)} dB quieter`;
  return { gain, linear, words: linear ? dir : `${dir}, with loud peaks gently held under ${fmtDb(peak)} dB` };
}

// ------------------------------------------------------------------ Stereo & mono
export const STEREO_MODES = [
  { value: 'mono', label: 'Make mono', icon: 'merge', hint: 'Both sides mixed into one channel. Plays the same in every speaker and earbud.' },
  { value: 'swap', label: 'Swap sides', icon: 'arrow-left-right', hint: 'Left becomes right and right becomes left.' },
  { value: 'left', label: 'Left only', icon: 'arrow-left-to-line', hint: 'The left side, played on both sides. Fixes recordings where only the left has sound.' },
  { value: 'right', label: 'Right only', icon: 'arrow-right-to-line', hint: 'The right side, played on both sides.' },
  { value: 'balance', label: 'Balance', icon: 'sliders-horizontal', hint: 'Make one side quieter.' },
];
export const STEREO_IDS = STEREO_MODES.map((m) => m.value);
export const BALANCE_MIN = -100, BALANCE_MAX = 100;

/** Left and right gains for a balance from −100 (left only) to 100 (right only): the other side is turned down. */
export const balanceGains = (b) => [b > 0 ? 1 - b / 100 : 1, b < 0 ? 1 + b / 100 : 1];

/**
 * The channel maths: {out: channels in the result, m: [[L from L, L from R], [R from L, R from R]]}. A mono result
 * uses m[0]. Sources with more than two channels are mixed down to stereo first; a mono source counts as both
 * sides (so Balance places it in a stereo result).
 */
export function stereoMatrix(mode, balance = 0) {
  switch (mode) {
    case 'mono': return { out: 1, m: [[0.5, 0.5], [0.5, 0.5]] };
    case 'swap': return { out: 2, m: [[0, 1], [1, 0]] };
    case 'left': return { out: 2, m: [[1, 0], [1, 0]] };
    case 'right': return { out: 2, m: [[0, 1], [0, 1]] };
    default: { const [l, r] = balanceGains(balance); return { out: 2, m: [[l, 0], [0, r]] }; }
  }
}

/** Which modes make sense for a source with `channels` channels: {value: reason | null}. */
export function stereoIssues(channels) {
  if (channels === 1) {
    const why = 'This file is already mono (one channel).';
    return { mono: why, swap: why, left: why, right: why, balance: null };
  }
  return { mono: null, swap: null, left: null, right: null, balance: null };
}

/** Is this choice a change at all? (Balance at 0 on stereo, or on a mono source, does nothing.) */
export const stereoChanges = (mode, balance) => mode !== 'balance' || Math.round(balance) !== 0;

/** The FFmpeg filter for a mode: mix down to stereo (or read mono as both sides), then pan. */
export function stereoFilter(mode, balance, channels) {
  const { out, m } = stereoMatrix(mode, balance);
  const c = (v) => r3(v);
  if (channels === 1) {
    // One channel is both sides: L = (a + b)·c0.
    const g = m.map(([a, b]) => c(a + b));
    return out === 1 ? `pan=mono|c0=${g[0]}*c0` : `pan=stereo|c0=${g[0]}*c0|c1=${g[1]}*c0`;
  }
  const pre = channels > 2 ? 'aformat=channel_layouts=stereo,' : '';
  const term = ([a, b]) => [a ? `${c(a)}*c0` : '', b ? `${c(b)}*c1` : ''].filter(Boolean).join('+') || '0*c0';
  return out === 1 ? `${pre}pan=mono|c0=${term(m[0])}` : `${pre}pan=stereo|c0=${term(m[0])}|c1=${term(m[1])}`;
}

// ------------------------------------------------------------------ Beep out parts
export const MAX_BEEPS = 50;
export const MIN_BEEP = 0.05;            // shortest part covered (s)
export const BEEP_HZ = 1000;
export const BEEP_LEVEL = 0.25;          // amplitude of the tone (−12 dBFS)
export const BEEP_MODES = [
  { value: 'beep', label: 'Beep', icon: 'audio-lines', hint: 'A 1 kHz tone covers each part, like on TV.' },
  { value: 'silence', label: 'Silence', icon: 'volume-x', hint: 'Each part goes quiet.' },
];
export const BEEP_MODE_IDS = BEEP_MODES.map((m) => m.value);

/**
 * Ranges as they will be used: inside [0, duration], at least MIN_BEEP long, in time order, and ranges that
 * overlap or touch merged into one.
 */
export function mergeRanges(list, duration = Infinity) {
  const rs = (list || []).map((r) => ({ start: r3(clamp(r.start, 0, duration)), end: r3(clamp(r.end, 0, duration)) }))
    .filter((r) => r.end - r.start >= MIN_BEEP - 1e-9).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.005) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
/** The range at time t (index), or -1. */
export const rangeAt = (list, t) => list.findIndex((r) => t >= r.start - 1e-9 && t <= r.end + 1e-9);
/** Total covered time. */
export const coveredLength = (list) => list.reduce((a, r) => a + (r.end - r.start), 0);
/** FFmpeg's "is t inside any range" expression. */
export const rangesExpr = (list) => list.map((r) => `between(t,${num(r.start)},${num(r.end)})`).join('+') || '0';

/**
 * filter_complex for Beep out parts on input 0: silence inside the ranges, and for `beep` a 1 kHz tone there,
 * mixed in at the source's sample rate and channel layout. Small audio frames (2.5 ms) keep the edges exact.
 */
export function beepGraph({ ranges, mode, rate, layout, duration }) {
  const e = rangesExpr(ranges);
  const n = Math.max(16, Math.round(rate / 400));
  const muted = `[0:a:0]asetnsamples=n=${n}:p=0,volume=0:enable='${e}'`;
  if (mode !== 'beep') return `${muted}[out]`;
  const tone = `sine=f=${BEEP_HZ}:r=${rate}:d=${num(duration + 1)},volume=${BEEP_LEVEL * 8},asetnsamples=n=${n}:p=0,volume=0:enable='not(${e})',aformat=sample_rates=${rate}:channel_layouts=${layout}`;
  return `${muted}[m];${tone}[b];[m][b]amix=inputs=2:duration=first:normalize=0,aformat=channel_layouts=${layout}[out]`;
}

// ------------------------------------------------------------------ Reduce noise
export const CLEAN_LEVELS = [
  { value: 'light', label: 'Light', nr: 10, above: 2, hint: 'Takes the edge off hiss. Voices stay completely natural.' },
  { value: 'medium', label: 'Medium', nr: 18, above: 6, hint: 'Clearly less hiss and hum, for most recordings.' },
  { value: 'strong', label: 'Strong', nr: 30, above: 10, hint: 'For very noisy recordings. Quiet sounds may soften a little.' },
];
export const CLEAN_IDS = CLEAN_LEVELS.map((l) => l.value);
export const RUMBLE_HZ = 80;
export const NOISE_SAMPLE = 1;            // seconds of the quietest moment used to learn the noise
export const EXCERPT = 8;                 // seconds played by the before/after preview

/**
 * The quietest stretch of `length` seconds (the noise between words or notes), skipping digital silence:
 * {start, length, rms (amplitude)} or null when the sound is too short or silent. `rms` is per-bucket amplitude
 * (Float32Array or bytes via amp()), `rate` buckets per second.
 */
export function quietestWindow(rms, rate, duration, length = NOISE_SAMPLE) {
  const n = rms ? rms.length : 0;
  const L = Math.min(length, duration / 3);
  const w = Math.round(L * rate);
  if (w < Math.max(2, rate * 0.1) || n < w) return null;
  const v = (k) => (rms instanceof Uint8Array ? amp(rms[k]) : rms[k]);
  const SILENT = 10 ** (-90 / 20);
  let best = null, sum = 0, silent = 0;
  for (let k = 0; k < n; k++) {
    const x = v(k);
    sum += x * x; if (x < SILENT) silent++;
    if (k >= w) { const y = v(k - w); sum -= y * y; if (y < SILENT) silent--; }
    if (k >= w - 1 && silent === 0 && (!best || sum < best.sum)) best = { at: k - w + 1, sum };
  }
  if (!best) return null;
  return { start: r3(best.at / rate), length: r3(w / rate), rms: Math.sqrt(Math.max(0, best.sum) / w) };
}

/** afftdn's settings for a level and the measured noise level (dBFS): {nr, nf}. */
export function cleanSettings(level, noiseDb) {
  const l = CLEAN_LEVELS.find((x) => x.value === level) || CLEAN_LEVELS[1];
  const base = Number.isFinite(noiseDb) ? noiseDb : -60;
  return { nr: l.nr, nf: Math.round(clamp(base + l.above, -80, -20)) };
}

/**
 * afftdn works on 50 ms windows and hands its sound back half a window late; the graph pads the end by this much
 * and cuts it from the start, so the cleaned sound lines up with the original to the sample and nothing is lost.
 */
export const denoiseDelay = (rate) => Math.floor(Math.round(rate * 0.05) / 2) / rate;

/**
 * filter_complex for Reduce noise at sample rate `rate`. Input `main` is the sound to clean; input `noise`
 * (optional) is the quietest stretch, played first so the noise reducer learns that exact noise, then cut off again.
 * Optional rumble filter. Output label [out].
 */
export function cleanGraph({ level, noiseDb, rumble, rate = 44100, main = 0, noise = null, noiseLength = 0 }) {
  const { nr, nf } = cleanSettings(level, noiseDb);
  const hp = rumble ? `highpass=f=${RUMBLE_HZ}:p=2,` : '';
  const lag = denoiseDelay(rate);
  const pad = `apad=pad_dur=${lag.toFixed(6)},`;
  if (noise == null || !(noiseLength > 0)) return `[${main}:a:0]${hp}${pad}afftdn=nr=${nr}:nf=${nf},atrim=start=${lag.toFixed(6)},asetpts=PTS-STARTPTS[out]`;
  const stop = num(Math.max(0.05, noiseLength - 0.02));
  return `[${noise}:a:0]asetpts=PTS-STARTPTS[ns];[${main}:a:0]asetpts=PTS-STARTPTS[ms];[ns][ms]concat=n=2:v=0:a=1,${hp}${pad}`
    + `asendcmd=c='0 afftdn@dn sample_noise start;${stop} afftdn@dn sample_noise stop',afftdn@dn=nr=${nr}:nf=${nf},atrim=start=${(noiseLength + lag).toFixed(6)},asetpts=PTS-STARTPTS[out]`;
}

/** Where the before/after preview starts for a playhead at t: a little before it, inside the file. */
export const excerptStart = (t, duration, len = EXCERPT) => r3(clamp(Math.floor(Math.max(0, t - 1) * 2) / 2, 0, Math.max(0, duration - len)));

// ------------------------------------------------------------------ Audio to video
export const LOOKS = [
  { value: 'wave', label: 'Waveform', icon: 'audio-waveform', hint: 'The whole recording as a waveform, filling in as it plays.' },
  { value: 'bars', label: 'Bars', icon: 'chart-column', hint: 'Bars that dance with the sound (a spectrum).' },
  { value: 'picture', label: 'Picture', icon: 'image', hint: 'A still picture, like cover art, for the whole video.' },
];
export const LOOK_IDS = LOOKS.map((l) => l.value);
export const VIDEO_SHAPES = [
  { value: '16:9', label: '16:9', ratio: [16, 9], hint: 'YouTube, TV and computers' },
  { value: '9:16', label: '9:16', ratio: [9, 16], hint: 'Reels, Shorts, TikTok and Status' },
  { value: '1:1', label: '1:1', ratio: [1, 1], hint: 'Square posts' },
];
export const SHAPE_IDS = VIDEO_SHAPES.map((s) => s.value);
export const VIDEO_SIZES = [1080, 720];
export const BAR_COUNT = 48;
export const TITLE_MAX = 80;
export const VIDEO_FPS = 30, PICTURE_FPS = 10;
export const LOOK_COLORS = {
  fg: ['#ff5c00', '#ffffff', '#ffd60a', '#30d158', '#64d2ff', '#bf5af2'],
  bg: ['#141418', '#000000', '#ffffff', '#1c2541', '#2b2d42', '#f4efe6'],
};
export const DEFAULT_LOOK = { fg: '#ff5c00', bg: '#141418' };

/** The video's size: 1080p or 720p in the chosen shape. */
export function lookSize(shape, size = 1080) {
  const s = size === 720 ? 720 : 1080;
  if (shape === '9:16') return { w: s, h: Math.round((s * 16) / 9) };
  if (shape === '1:1') return { w: s, h: s };
  return { w: Math.round((s * 16) / 9), h: s };
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
/**
 * Where everything goes (pixels of the video): {W, H, vis (waveform or bars box), pic (picture box), title (box,
 * font size), bar {slot, width, gap, count} for bars, wave {width, gap, count} for the waveform}.
 */
export function lookLayout({ shape = '16:9', size = 1080, title = '' } = {}) {
  const { w: W, h: H } = lookSize(shape, size);
  const S = Math.min(W, H);
  const m = Math.round(S * (shape === '1:1' ? 0.09 : 0.08));
  const fs = Math.round(S * (shape === '9:16' ? 0.058 : 0.05));
  const hasTitle = !!String(title || '').trim();
  const titleBox = { x: m, y: shape === '9:16' ? Math.round(H * 0.14) : m, w: W - 2 * m, h: Math.round(fs * 2.7), size: fs };
  const top = hasTitle ? titleBox.y + titleBox.h + Math.round(S * 0.03) : m;
  const bottom = H - m;
  // Bars: a whole number of slots, each a bar and a gap.
  const slot = Math.floor((W - 2 * m) / BAR_COUNT);
  const bw = Math.max(2, Math.round(slot * 0.7));
  const vw = slot * BAR_COUNT;
  const vh = even(shape === '9:16' ? W * 0.5 : S * (shape === '1:1' ? 0.34 : 0.3));
  const visY = even(Math.max(top, top + (bottom - top - vh) / 2));
  const vis = { x: even((W - vw) / 2), y: visY, w: even(vw), h: vh };
  const pic = { x: m, y: top, w: W - 2 * m, h: Math.max(2, bottom - top) };
  const ww = Math.max(2, Math.round(S * 0.0075));
  const wgap = Math.max(2, Math.round(ww * 0.7));
  return {
    W, H, margin: m, vis, pic, title: hasTitle ? titleBox : null,
    bar: { slot, width: bw, gap: slot - bw, count: BAR_COUNT },
    wave: { width: ww, gap: wgap, count: Math.floor((vis.w + wgap) / (ww + wgap)) },
  };
}

/** Readable title colour on a background: near-white on dark, near-black on light. */
export function titleColor(bg) {
  const h = String(bg || '#000000').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1d1d1f' : '#ffffff';
}

/** Split a title into at most `lines` lines that fit `width` (by ctx.measureText); the last one ends with … if cut. */
export function wrapTitle(ctx, text, width, lines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  const fits = (s) => ctx.measureText(s).width <= width;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? cur + ' ' + w : w;
    if (fits(next)) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === lines) { cur = ''; out[lines - 1] += ' ' + words.slice(i).join(' '); break; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) out.length = lines;
  // Words longer than the line (or the rest of a long title) are cut with an ellipsis.
  return out.map((l) => {
    if (fits(l)) return l;
    let s = l;
    while (s.length > 1 && !fits(s + '…')) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  });
}

const FONT = (px) => `600 ${px}px -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', 'Noto Sans', 'Helvetica Neue', Arial, system-ui, sans-serif`;
const rrect = (ctx, x, y, w, h, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else ctx.rect(x, y, w, h); };

/** The waveform bars' heights (0..1) across the whole recording, scaled so the loudest reaches the top. */
export function waveHeights(peaks, duration, count) {
  const env = envelope(peaks, 0, duration, count);
  const top = Math.max(1e-4, ...env.peak);
  return Array.from(env.peak, (p, i) => clamp(0.04 + 0.96 * ((0.65 * p + 0.35 * Math.min(p, env.rms[i] * 1.6)) / top) ** 0.85, 0, 1));
}

/**
 * Bars for the preview at time t: an approximation of the spectrum from the loudness there (the video uses FFmpeg's
 * real spectrum). Lower bars are taller, like most music and speech; each bar wobbles a little.
 */
export function previewBars(peaks, t, count = BAR_COUNT) {
  const env = envelope(peaks, Math.max(0, t - 0.05), t + 0.05, 1);
  const top = Math.max(1e-4, loudest(peaks));
  const level = clamp(Math.sqrt(env.rms[0] / top) * 1.15, 0, 1);
  const frame = Math.floor(t * 15);
  const out = [];
  for (let k = 0; k < count; k++) {
    const x = k / (count - 1);
    const tilt = 1 - 0.55 * x ** 0.8;
    const wob = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(k * 2.399 + frame * 0.9));
    out.push(clamp(level * tilt * wob, 0.02, 1));
  }
  return out;
}

/**
 * Draw the video's look on a canvas the size of layout.W × layout.H (used by the window's preview and, in the
 * processor, to make the pictures FFmpeg animates). `layer`:
 *   'preview' everything at time t (waveform filled up to t; bars as previewBars; picture);
 *   'base'    background, title and picture (no waveform or bars);
 *   'dim' / 'lit'  the waveform box only (vis.w × vis.h): the waveform not yet played / played, on the background;
 *   'gaps'    the bars box only, transparent with background-coloured gaps between bars (laid over FFmpeg's bars).
 */
export function drawLook(ctx, { layout, look, fg, bg, title = '', peaks, duration = 0, t = 0, picture = null, heights = null, layer = 'preview' }) {
  const L = layout;
  const band = layer === 'dim' || layer === 'lit' || layer === 'gaps';
  const W = band ? L.vis.w : L.W, H = band ? L.vis.h : L.H;
  const ox = band ? -L.vis.x : 0, oy = band ? -L.vis.y : 0;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (layer !== 'gaps') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  ctx.translate(ox, oy);
  const full = layer === 'preview' || layer === 'base';
  if (full && look === 'picture' && picture) {
    const pw = picture.width, ph = picture.height;
    const s = Math.min(L.pic.w / pw, L.pic.h / ph);
    const w = Math.round(pw * s), h = Math.round(ph * s);
    const x = Math.round(L.pic.x + (L.pic.w - w) / 2), y = Math.round(L.pic.y + (L.pic.h - h) / 2);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)'; ctx.shadowBlur = Math.round(L.H * 0.03); ctx.shadowOffsetY = Math.round(L.H * 0.008);
    rrect(ctx, x, y, w, h, Math.round(Math.min(L.W, L.H) * 0.016)); ctx.fillStyle = bg; ctx.fill();
    ctx.restore();
    ctx.save(); rrect(ctx, x, y, w, h, Math.round(Math.min(L.W, L.H) * 0.016)); ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(picture, x, y, w, h);
    ctx.restore();
  }
  if (full && L.title && String(title).trim()) {
    ctx.fillStyle = titleColor(bg);
    ctx.font = FONT(L.title.size);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapTitle(ctx, title, L.title.w, 2);
    const lh = Math.round(L.title.size * 1.25);
    const y0 = L.title.y + L.title.h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, L.W / 2, y0 + i * lh));
  }
  const v = L.vis;
  if (look === 'wave' && (layer === 'preview' || layer === 'dim' || layer === 'lit')) {
    const { width: bw, gap, count } = L.wave;
    const hs = heights || waveHeights(peaks, duration, count);
    const total = count * bw + (count - 1) * gap;
    const x0 = v.x + Math.round((v.w - total) / 2);
    const mid = v.y + v.h / 2;
    const drawBars = (alpha) => {
      ctx.globalAlpha = alpha; ctx.fillStyle = fg;
      for (let i = 0; i < count; i++) {
        const h = Math.max(bw, Math.round((hs[i] || 0) * v.h));
        rrect(ctx, x0 + i * (bw + gap), Math.round(mid - h / 2), bw, h, bw / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    if (layer === 'dim') drawBars(0.32);
    else if (layer === 'lit') drawBars(1);
    else {
      const p = duration > 0 ? clamp(t / duration, 0, 1) : 0;
      const px = v.x + v.w * p;
      drawBars(0.32);
      ctx.save(); ctx.beginPath(); ctx.rect(v.x, v.y - 2, px - v.x, v.h + 4); ctx.clip();
      ctx.fillStyle = bg; ctx.fillRect(v.x, v.y, px - v.x, v.h);
      drawBars(1);
      ctx.restore();
      const lw = playheadWidth(L);
      ctx.fillStyle = fg; ctx.fillRect(Math.round(px - lw / 2), v.y, lw, v.h);
    }
  }
  if (look === 'bars' && (layer === 'preview' || layer === 'gaps')) {
    const { slot, width: bw, count } = L.bar;
    if (layer === 'gaps') {
      ctx.fillStyle = bg;
      for (let i = 0; i < count; i++) ctx.fillRect(v.x + i * slot + bw, v.y, slot - bw, v.h);
    } else {
      const hs = heights || previewBars(peaks, t, count);
      ctx.fillStyle = fg;
      for (let i = 0; i < count; i++) {
        const h = Math.max(2, Math.round(hs[i] * v.h));
        ctx.fillRect(v.x + i * slot, v.y + v.h - h, bw, h);
      }
    }
  }
  ctx.restore();
}
/** The playhead line's width for a layout (3 px at 1080p). */
export const playheadWidth = (L) => Math.max(2, Math.round(Math.min(L.W, L.H) / 360));

/**
 * FFmpeg arguments for Audio to video. Inputs: 0 the sound; 1 base.png (background, title, picture); for `wave`
 * 2 dim.png and 3 lit.png (the waveform box); for `bars` 2 gaps.png. H.264 + AAC MP4 with +faststart.
 * `audio` is {copy} (AAC kept) or encoder args; `downmix` mixes more than two channels to stereo.
 */
export function videoArgs({ input, files, output, layout, look, fg, duration, audioCopy = false, downmix = false }) {
  const L = layout, v = L.vis, D = num(duration);
  const hex = (c) => '0x' + String(c).replace('#', '');
  const fps = look === 'picture' ? PICTURE_FPS : VIDEO_FPS;
  const args = ['-i', input, '-framerate', String(fps), '-i', files.base];
  let graph;
  if (look === 'wave') {
    args.push('-framerate', String(fps), '-i', files.dim, '-framerate', String(fps), '-i', files.lit);
    const lw = playheadWidth(L);
    graph = `[1:v]format=yuv420p,loop=loop=-1:size=1:start=0[bg];`
      + `[2:v]format=gbrp,loop=loop=-1:size=1:start=0[d];[3:v]format=gbrp,loop=loop=-1:size=1:start=0[l];`
      + `color=c=black:s=${v.w}x${v.h}:r=${fps},format=gbrp[k];color=c=white:s=${v.w}x${v.h}:r=${fps},format=gbrp[w];`
      + `[k][w]overlay=x='${v.w}*t/${D}-${v.w}':y=0:eval=frame:format=gbrp[m];[d][l][m]maskedmerge,format=yuv420p[band];`
      + `[bg][band]overlay=${v.x}:${v.y}:format=yuv420[o];color=c=${hex(fg)}:s=${lw}x${v.h}:r=${fps}[ph];`
      + `[o][ph]overlay=x='${v.x}+${v.w}*t/${D}-${lw / 2}':y=${v.y}:eval=frame:format=yuv420,trim=duration=${D}[v]`;
  } else if (look === 'bars') {
    args.push('-framerate', String(fps), '-i', files.gaps);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(String(fg).slice(i, i + 2), 16));
    graph = `[1:v]format=yuv420p,loop=loop=-1:size=1:start=0[bg];[2:v]format=rgba,loop=loop=-1:size=1:start=0[gp];`
      + `[0:a:0]aformat=channel_layouts=mono,showfreqs=s=${L.bar.count}x${v.h}:rate=${fps}:mode=bar:ascale=cbrt:fscale=log:win_size=4096:averaging=2,`
      + `format=rgba,lutrgb=r=${r}:g=${g}:b=${b},scale=${L.bar.count * L.bar.slot}:${v.h}:flags=neighbor[bars];`
      + `[bg][bars]overlay=${v.x}:${v.y}:format=yuv420[o];[o][gp]overlay=${v.x}:${v.y}:format=yuv420,trim=duration=${D}[v]`;
  } else {
    graph = `[1:v]format=yuv420p,loop=loop=-1:size=1:start=0,trim=duration=${D}[v]`;
  }
  args.push('-filter_complex', graph, '-map', '[v]', '-map', '0:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', look === 'picture' ? '18' : '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    ...(look === 'picture' ? ['-tune', 'stillimage'] : []),
    ...(audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', ...(downmix ? ['-ac', '2'] : [])]),
    '-shortest', '-movflags', '+faststart', '-map_metadata', '0', '-sn', '-dn', '-n', output);
  return args;
}
