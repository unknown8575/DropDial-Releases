// Video tools (phases 6–7): the maths and FFmpeg arguments shared by the tool windows (previews, plans, checks) and
// the main process (exports). Pure functions only: no DOM, no Node. Main loads this module with import() and keeps
// its validation bounds in step with the constants here (src/main/tools/video-common.js, checked by unit tests).
//
// Times are seconds (numbers). Crop rectangles are in display pixels: what a player shows after the video's
// rotation is applied (FFmpeg applies the same rotation before any filter, so the numbers mean the same thing).

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r3 = (t) => Math.round(t * 1000) / 1000;

// ------------------------------------------------------------------ limits
export const MAX_DURATION = 24 * 3600;  // longest time accepted in options
export const MAX_SEGMENTS = 50;         // Trim: parts kept
export const MAX_MARKS = 50;            // Cut into parts: marks
export const MAX_PARTS = 50;            // Cut into parts: parts made
export const MIN_SEGMENT = 0.1;         // shortest part kept by Trim (s)
export const MIN_PART = 0.2;            // shortest part made by Cut into parts (s)
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.25, 1.5, 2, 3, 4];
export const SIZE_MIN_MB = 1;
export const SIZE_MAX_MB = 4000;
export const SIZE_PRESETS = [
  { value: 16, label: '16 MB', hint: 'WhatsApp' },
  { value: 25, label: '25 MB', hint: 'Email' },
];
export const EVERY_PRESETS = [10, 15, 30, 60];
export const MB = 1000 * 1000; // size limits are decimal megabytes, so a "16 MB" part is under any app's 16 MB

// ------------------------------------------------------------------ time
/** 4.5 → "0:04.50"; 3725.25 → "1:02:05.25". `digits` decimals (0–3). */
export function formatClock(sec, digits = 2) {
  if (!Number.isFinite(sec)) sec = 0;
  const k = 10 ** digits;
  const total = Math.round(Math.max(0, sec) * k) / k;
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const ss = s.toFixed(digits).padStart(digits ? digits + 3 : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * A short length: "0.8 s", "12.4 s", "1:05". The one way lengths are written (Info, tool windows, results):
 * tenths under a minute, then whole seconds rounded to the nearest, so the same length always reads the same.
 */
export function formatLength(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  if (sec < 59.95) return `${(Math.round(sec * 10) / 10).toFixed(1)} s`;
  return formatClock(Math.round(sec), 0);
}

/**
 * Read a typed time: "1:05.5", "0:01:05", "65.5", "65.5 s" or "65,5". {value} or {error} (friendly words).
 */
export function parseClock(text) {
  const t = String(text == null ? '' : text).trim().replace(/,/g, '.').replace(/\s*s(ec(onds?)?)?$/i, '');
  if (!t) return { error: 'Enter a time, like 0:12.5.' };
  if (/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return { value: Number(t) };
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(\.\d+)?$/.exec(t);
  if (!m) return { error: 'Use minutes:seconds, like 1:05.5, or just seconds, like 65.5.' };
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  const frac = m[4] ? Number(m[4]) : 0;
  const [h, mm, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  if (parts.length === 3 && mm > 59) return { error: 'Minutes go up to 59 in hours:minutes:seconds.' };
  if (s > 59) return { error: `Seconds go up to 59. Did you mean ${formatClock(mm * 60 + s + frac, frac ? 2 : 0)}?` };
  return { value: h * 3600 + mm * 60 + s + frac };
}

/** A typed time checked against [min, max]: {value} or {error}. */
export function checkClock(text, { min = 0, max = Infinity } = {}) {
  const r = parseClock(text);
  if (r.error) return r;
  if (r.value < min - 0.0005 || r.value > max + 0.0005) {
    return { error: Number.isFinite(max) ? `Use a time from ${formatClock(min)} to ${formatClock(max)}.` : `Use ${formatClock(min)} or later.` };
  }
  return { value: r3(clamp(r.value, min, max)) };
}

/** One frame's length (s) at this frame rate; 1/30 when the rate is unknown. */
export const frameStep = (fps) => (fps > 1 && fps <= 1000 ? 1 / fps : 1 / 30);

// ------------------------------------------------------------------ Trim: parts kept
/** Parts sorted by start, cut to the video and with overlaps joined. Parts shorter than MIN_SEGMENT are dropped. */
export function cleanSegments(segs, duration) {
  const list = (segs || [])
    .map((s) => ({ start: r3(clamp(Number(s.start) || 0, 0, duration)), end: r3(clamp(Number(s.end) || 0, 0, duration)) }))
    .filter((s) => s.end - s.start >= MIN_SEGMENT - 1e-9)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 0.001) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export const segmentsLength = (segs) => (segs || []).reduce((a, s) => a + Math.max(0, s.end - s.start), 0);

/**
 * What a fast (copied) trim really keeps (QA round 7): a copy can only start on a keyframe, so each part starts at
 * the last keyframe at or before its start and runs to its end. `keyframes`: the video's keyframe times (seconds).
 * Returns {kept, extra (seconds more than asked), starts (where each part really starts)}; with no keyframe list,
 * the parts as asked (extra 0).
 */
export function fastKept(segments, keyframes) {
  const keys = Array.isArray(keyframes) ? keyframes.filter((k) => Number.isFinite(k) && k >= 0).sort((a, b) => a - b) : null;
  const starts = (segments || []).map((s) => {
    if (!keys || !keys.length) return s.start;
    let best = 0;
    for (const k of keys) { if (k <= s.start + 0.001) best = k; else break; }
    return r3(best);
  });
  const kept = (segments || []).reduce((a, s, i) => a + Math.max(0, s.end - starts[i]), 0);
  return { kept, extra: Math.max(0, kept - segmentsLength(segments)), starts };
}
/** "fast cuts start at keyframes, +2.0 s" (nothing when the difference is under a tenth of a second). */
export const fastExtraNote = (extra) => (extra >= 0.05 ? `fast cuts start at keyframes, +${formatLength(extra)}` : '');

/** Does this keep the whole video (nothing trimmed)? */
export const keepsAll = (segs, duration) => segs.length === 1 && segs[0].start <= 0.02 && segs[0].end >= duration - 0.02;

/** What's wrong with these parts (in time order), or null. */
export function segmentsIssue(segs, duration) {
  if (!segs || !segs.length) return 'Keep at least one part of the video.';
  if (segs.length > MAX_SEGMENTS) return `Keep at most ${MAX_SEGMENTS} parts.`;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const n = segs.length > 1 ? `Part ${i + 1}` : 'The part kept';
    if (!(s.end > s.start)) return `${n} ends before it starts.`;
    if (s.end - s.start < MIN_SEGMENT - 1e-9) return `${n} is shorter than ${MIN_SEGMENT} s.`;
    if (duration > 0 && s.start >= duration) return `${n} starts after the video ends (${formatClock(duration)}).`;
    if (i && s.start < segs[i - 1].end - 0.001) return `Parts ${i} and ${i + 1} overlap.`;
  }
  if (duration > 0 && keepsAll(segs, duration)) return 'The whole video is selected. Move a handle to trim it.';
  return null;
}

/**
 * Add a part at time `at`: in the free gap there (or the next free gap after it, else the largest), up to `len`
 * seconds long. Returns {segs, index} (segs in time order) or null when there is no room left.
 */
export function addSegment(segs, duration, at, len = 2) {
  if (segs.length >= MAX_SEGMENTS) return null;
  const gaps = [];
  let from = 0;
  for (const s of segs) { if (s.start - from >= MIN_SEGMENT) gaps.push({ start: from, end: s.start }); from = s.end; }
  if (duration - from >= MIN_SEGMENT) gaps.push({ start: from, end: duration });
  if (!gaps.length) return null;
  const pick = gaps.find((g) => at >= g.start && at < g.end - MIN_SEGMENT + 1e-9)
    || gaps.find((g) => g.start >= at)
    || gaps.reduce((a, g) => (g.end - g.start > a.end - a.start ? g : a));
  const start = r3(at >= pick.start && at < pick.end - MIN_SEGMENT + 1e-9 ? at : pick.start);
  const seg = { start, end: r3(Math.min(pick.end, start + Math.max(MIN_SEGMENT, len))) };
  const next = [...segs, seg].sort((a, b) => a.start - b.start);
  return { segs: next, index: next.indexOf(seg) };
}

// ------------------------------------------------------------------ Size as shown
/**
 * The size a player shows for a stored w × h picture: pixels that aren't square (sample aspect ratio `sar` ≠ 1,
 * e.g. 1080 × 658 stored, 1169 × 658 shown) are stretched to square ones, then the rotation turns it. Every video
 * tool works at this size.
 */
export function displaySize(w, h, rotation = 0, sar = 1) {
  const sw = sar > 0 && Math.abs(sar - 1) > 1e-3 && w > 0 ? Math.max(2, Math.round(w * sar)) : w;
  return Math.abs(Math.round(rotation / 90)) % 2 ? { w: h, h: sw } : { w: sw, h };
}
/** The sample aspect ratio of a probed video's picture (1 when its pixels are square or it is unknown). */
export function sarOf(info) {
  const v = info && videoOf(info);
  const s = (v && v.sar) || (info && info.sar) || 1;
  return s > 0 ? s : 1;
}
/** A probed video's size as shown (see displaySize). */
export function shownSize(info) {
  const v = (info && videoOf(info)) || {};
  return displaySize(v.width || info.width || 0, v.height || info.height || 0, info.rotation || 0, sarOf(info));
}
/**
 * The filter that turns a non-square-pixel picture into square pixels at its shown size ('' when it already is),
 * placed first so crops, boxes and sizes worked out at the shown size land where they were drawn.
 */
export function squarePixels(info) {
  if (Math.abs(sarOf(info) - 1) <= 1e-3) return '';
  const d = shownSize(info);
  return d.w > 0 && d.h > 0 ? `scale=${d.w}:${d.h},setsar=1` : '';
}
const withSquare = (info, f) => { const q = squarePixels(info); return q ? `${q},${f}` : f; };

// ------------------------------------------------------------------ Crop & reframe

export const REFRAME_SHAPES = [
  { value: 'original', label: 'Original', ratio: null, hint: 'The video’s own shape' },
  { value: '9:16', label: '9:16', ratio: [9, 16], hint: 'Reels, Shorts and Status' },
  { value: '1:1', label: '1:1', ratio: [1, 1], hint: 'Square post' },
  { value: '4:5', label: '4:5', ratio: [4, 5], hint: 'Portrait post' },
  { value: '16:9', label: '16:9', ratio: [16, 9], hint: 'YouTube and TV' },
];
export const SHAPE_IDS = [...REFRAME_SHAPES.map((s) => s.value), 'free'];
export const OUTPUT_SIZES = [
  { value: 'original', label: 'Same as crop' },
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
  { value: 480, label: '480p' },
];
export const SIZE_IDS = OUTPUT_SIZES.map((s) => s.value);

/** Width / height of a shape for a W × H video, or null for a free crop. */
export function shapeAspect(shape, W, H) {
  if (shape === 'free') return null;
  if (shape === 'original') return W / H;
  const s = REFRAME_SHAPES.find((x) => x.value === shape);
  return s && s.ratio ? s.ratio[0] / s.ratio[1] : null;
}

/** The largest crop of this shape, centred (pixels). */
export function centerCrop(aspect, W, H) {
  if (!aspect) return { x: 0, y: 0, w: W, h: H };
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
/** A crop in whole, even pixels inside the W × H frame (what yuv420p video needs). */
export function evenCrop(r, W, H) {
  const w = Math.min(even(r.w + 0.5), even(W)), h = Math.min(even(r.h + 0.5), even(H));
  const x = clamp(Math.round(r.x / 2) * 2, 0, Math.floor((W - w) / 2) * 2);
  const y = clamp(Math.round(r.y / 2) * 2, 0, Math.floor((H - h) / 2) * 2);
  return { x, y, w, h };
}

/** A crop given as fractions of the frame ({x, y, w, h}, 0–1) in whole even pixels. */
export const cropFromFractions = (n, W, H) => evenCrop({ x: n.x * W, y: n.y * H, w: n.w * W, h: n.h * H }, W, H);

/**
 * The saved video's size for a crop (even pixels). 'original' keeps the crop's pixels; 1080/720/480 set the
 * short side, with the long side from the shape (exact for presets, so 9:16 at 1080p is 1080 × 1920).
 */
export function outputSize(crop, size, aspect = null) {
  if (size === 'original' || !size) return { w: crop.w, h: crop.h };
  const a = aspect || crop.w / crop.h;
  return a >= 1 ? { w: even(size * a + 1), h: even(size) } : { w: even(size), h: even(size / a + 1) };
}

/** Does this crop and size change anything? */
export const reframeChanges = (crop, out, W, H) => crop.w < even(W) || crop.h < even(H) || out.w !== crop.w || out.h !== crop.h;

// ------------------------------------------------------------------ Change speed
/** Steps of FFmpeg's atempo (each kept within 0.5–2 for the best sound) whose product is `speed`. */
export function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2 + 1e-9) { out.push(2); s /= 2; }
  while (s < 0.5 - 1e-9) { out.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-9 || !out.length) out.push(Math.round(s * 1e6) / 1e6);
  return out;
}
const num = (v) => String(Math.round(v * 100) / 100);
export const speedLabel = (s) => num(s) + '×';
/** For file names: "clip 2x.mp4", "clip 0.5x.mp4". */
export const speedSuffix = (s) => num(s) + 'x';
/** Frame rate of a sped-up or slowed video: the source's (at most 60), 30 when unknown. */
export const outputFps = (fps) => (fps > 1 && fps <= 1000 ? Math.min(60, Math.round(fps * 1000) / 1000) : 30);
/** Snap a slider position to a preset when it is close. */
export function snapSpeed(v) {
  const near = [1, ...SPEED_PRESETS].find((p) => Math.abs(Math.log2(v) - Math.log2(p)) < 0.035);
  return near || Math.round(clamp(v, SPEED_MIN, SPEED_MAX) * 100) / 100;
}

// ------------------------------------------------------------------ Cut into parts
export const SPLIT_MODES = [
  { value: 'count', label: 'Equal parts' },
  { value: 'every', label: 'Every N seconds' },
  { value: 'marks', label: 'At marks' },
  { value: 'size', label: 'Under a size' },
];

/** Marks in time order, inside the video, at least MIN_PART from each other and from the ends. */
export function cleanMarks(marks, duration) {
  const out = [];
  for (const m of [...(marks || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b)) {
    if (m < MIN_PART || m > duration - MIN_PART) continue;
    if (out.length && m - out[out.length - 1] < MIN_PART) continue;
    out.push(r3(m));
  }
  return out;
}

/**
 * Plan for a size limit. Parts are first cut as they are (no quality lost) when the average bitrate allows it
 * within MAX_PARTS; otherwise they are made again at a lower bitrate (and smaller picture when needed).
 * {count, reencode, videoKbps?, audioKbps?, height?} or {error}.
 */
export function sizePlan({ duration, bytes, limitMB, canCopy = true, hasAudio = true }) {
  const limit = limitMB * MB;
  if (!(duration > 0) || !(bytes > 0)) return { error: 'The video’s length or size is unknown.' };
  if (bytes <= limit) return { error: `This video is already under ${num(limitMB)} MB, so there’s nothing to cut.`, under: true };
  const target = limit * 0.92; // room for container overhead and uneven bitrate
  let count = Math.ceil(bytes / target);
  if (canCopy && count <= MAX_PARTS) return { count: Math.max(2, count), reencode: false };
  count = Math.max(2, Math.min(MAX_PARTS, count));
  const audioKbps = hasAudio ? 96 : 0;
  const totalKbps = (target * 8) / 1000 / (duration / count);
  const videoKbps = Math.min(8000, Math.floor(totalKbps - audioKbps));
  if (videoKbps < 150) return { error: `This video is too long to fit in ${MAX_PARTS} parts under ${num(limitMB)} MB. Choose a bigger size.` };
  const height = videoKbps >= 2500 ? 1080 : videoKbps >= 1200 ? 720 : videoKbps >= 600 ? 480 : 360;
  return { count, reencode: true, videoKbps, audioKbps, height };
}

/**
 * Where fast cuts (copied as they are) really fall. A part can only start on a keyframe, so each cut moves to the
 * nearest keyframe that isn't within MIN_PART of either end; cuts that land on the same keyframe become one.
 */
export function snapCuts(cuts, keyframes, duration) {
  const keys = (keyframes || []).filter((k) => k >= MIN_PART && k <= duration - MIN_PART);
  const out = [];
  if (!keys.length) return out;
  for (const c of cuts) {
    let best = keys[0];
    for (const k of keys) if (Math.abs(k - c) < Math.abs(best - c) - 1e-9) best = k;
    const t = r3(best);
    if (!out.includes(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The parts of a video of `duration` seconds for split options `o`:
 * {mode: 'count', count} · {mode: 'every', every} · {mode: 'marks', marks} · {mode: 'size', sizeMB} (with `bytes`).
 * With fast cuts (`o.fast`, `canCopy`) and the video's `keyframes` (seconds), the cuts are where the copy really
 * cuts (snapCuts): `wanted` is then the number of parts asked for, which may be more than `parts`.
 * Returns {parts: [{start, end}], cuts: [seconds], wanted, snapped?, size?} or {error} (`exact: true` when only exact
 * cuts can do it).
 */
export function planParts(duration, o, { bytes = 0, canCopy = true, hasAudio = true, keyframes = null } = {}) {
  if (!(duration > 0)) return { error: 'Reading the video…' };
  let cuts = [], size = null;
  if (o.mode === 'count') {
    const n = Math.round(Number(o.count));
    if (!(n >= 2 && n <= MAX_PARTS)) return { error: `Choose from 2 to ${MAX_PARTS} parts.` };
    if (duration / n < MIN_PART) return { error: 'The parts would be too short. Choose fewer parts.' };
    cuts = Array.from({ length: n - 1 }, (_, i) => ((i + 1) * duration) / n);
  } else if (o.mode === 'every') {
    const every = Number(o.every);
    if (!(every >= 1)) return { error: 'Choose 1 second or more.' };
    const n = Math.ceil(duration / every - 0.1 / every);
    if (n < 2) return { error: `The video is only ${formatLength(duration)} long, so it wouldn’t be cut. Choose a shorter time.` };
    if (n > MAX_PARTS) return { error: `That would make ${n} parts; the most is ${MAX_PARTS}. Choose a longer time.` };
    cuts = Array.from({ length: n - 1 }, (_, i) => (i + 1) * every);
  } else if (o.mode === 'marks') {
    const list = (o.marks || []).filter((m) => m > 0 && m < duration);
    if (!list.length) return { error: 'Add at least one mark: play to a moment and press M.' };
    if (list.length > MAX_MARKS) return { error: `Use at most ${MAX_MARKS} marks.` };
    const sorted = [...list].sort((a, b) => a - b);
    for (let i = 0; i <= sorted.length; i++) {
      const a = i ? sorted[i - 1] : 0, b = i < sorted.length ? sorted[i] : duration;
      if (b - a < MIN_PART) return { error: i === 0 ? 'A mark is too close to the start.' : i === sorted.length ? 'A mark is too close to the end.' : `Marks ${i} and ${i + 1} are too close together.` };
    }
    cuts = sorted;
  } else if (o.mode === 'size') {
    const mb = Number(o.sizeMB);
    if (!(mb >= SIZE_MIN_MB && mb <= SIZE_MAX_MB)) return { error: `Choose a size from ${SIZE_MIN_MB} to ${SIZE_MAX_MB} MB.` };
    size = sizePlan({ duration, bytes, limitMB: mb, canCopy, hasAudio });
    if (size.error) return { error: size.error, under: size.under };
    if (duration / size.count < MIN_PART) return { error: 'This video can’t be cut that small.' };
    cuts = Array.from({ length: size.count - 1 }, (_, i) => ((i + 1) * duration) / size.count);
  } else return { error: 'Choose how to cut the video.' };
  cuts = cuts.map(r3);
  const wanted = cuts.length + 1;
  let snapped = false;
  if (!size && o.fast && canCopy && Array.isArray(keyframes)) {
    cuts = snapCuts(cuts, keyframes, duration);
    snapped = true;
    if (!cuts.length) return { error: `Fast cuts can’t cut this video: it has no keyframe to cut at. Use exact cuts for ${wanted} parts.`, exact: true, wanted };
  }
  const edges = [0, ...cuts, r3(duration)];
  const parts = edges.slice(1).map((end, i) => ({ start: edges[i], end }));
  return size ? { parts, cuts, wanted, size } : { parts, cuts, wanted, ...(snapped ? { snapped } : {}) };
}

/** What fast cuts fall short of, in plain words ("Only 3 parts possible with fast cuts…"), or null. */
export const fewerPartsNote = (plan) => (plan && plan.parts && plan.wanted > plan.parts.length
  ? `Only ${plan.parts.length} parts possible with fast cuts. Use exact cuts for ${plan.wanted}.` : null);

// ------------------------------------------------------------------ FFmpeg arguments
// Output keeps the container for MP4, MOV, MKV and WebM; anything else becomes MP4. WebM is VP9 + Opus; the
// others H.264 + AAC (MP4/MOV with +faststart so they start playing before they have fully downloaded).
export const CONTAINERS = ['mp4', 'mov', 'mkv', 'webm'];
export const outputContainer = (format) => (CONTAINERS.includes(format) ? format : 'mp4');
export const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
const COPY_VIDEO = { mp4: ['h264', 'hevc', 'av1', 'mpeg4'], mov: ['h264', 'hevc', 'prores', 'mpeg4'], mkv: ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video', 'prores'], webm: ['vp8', 'vp9', 'av1'] };
const COPY_AUDIO = { mp4: ['aac', 'mp3', 'ac3', 'alac'], mov: ['aac', 'alac', 'pcm_s16le', 'mp3'], mkv: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'pcm_s16le'], webm: ['opus', 'vorbis'] };
const SEGMENT_FORMAT = { mp4: 'mp4', mov: 'mov', mkv: 'matroska', webm: 'webm' };

const videoOf = (info) => (info.streams || []).find((s) => s.type === 'video' && !s.attachedPic) || null;
const audioOf = (info) => (info.streams || []).find((s) => s.type === 'audio') || null;

/**
 * Can the video (and sound) be copied into this container as they are? Only into the file's own container
 * (`source`, its format id): an AVI's old codecs copied into MP4 would make a file many players refuse.
 */
export function canCopy(container, info, source = container) {
  if (source !== container) return false;
  const v = videoOf(info), a = audioOf(info);
  return !!v && (COPY_VIDEO[container] || []).includes(v.codec) && (!a || (COPY_AUDIO[container] || []).includes(a.codec));
}
const audioCopyable = (container, info, source = container) => { const a = audioOf(info); return source === container && !!a && (COPY_AUDIO[container] || []).includes(a.codec); };

/** The encoders a container needs when re-encoding: [video, audio]. */
export const encodersFor = (container) => (container === 'webm' ? ['libvpx-vp9', 'libopus'] : ['libx264', 'aac']);

/** Video encoder arguments: quality-based by default, or a bitrate (kbps) for size limits. */
export function videoCodec(container, kbps = 0, { cap = 0 } = {}) {
  if (container === 'webm') {
    // A cap with a quality setting is VP9's constrained quality: the quality asked for, never above the cap.
    return kbps ? ['-c:v', 'libvpx-vp9', '-b:v', `${kbps}k`, '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', cap ? `${cap}k` : '0', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
  }
  return kbps ? ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.25)}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...(cap ? ['-maxrate', `${cap}k`, '-bufsize', `${cap * 2}k`] : []), '-pix_fmt', 'yuv420p'];
}
export const audioCodec = (container, kbps = 0) => (container === 'webm' ? ['-c:a', 'libopus', '-b:a', `${kbps || 128}k`] : ['-c:a', 'aac', '-b:a', `${kbps || 192}k`]);

/**
 * The source's picture bitrate in kb/s (its stream's own, or the file's less the sound), 0 when it isn't known.
 * Tools that make the picture again cap theirs a little above it, so a blurred or trimmed video stays about the
 * size of the original instead of doubling (QA round 8: a 3-minute 480p video went from 8.1 MB to 17.1 MB).
 */
export function sourceKbps(info) {
  const v = videoOf(info || {});
  if (!v) return 0;
  if (v.bitrate > 0) return v.bitrate;
  const a = audioOf(info);
  const left = (info.bitrate || 0) - (a ? a.bitrate || 128 : 0);
  return left > 0 ? left : 0;
}
/** The cap for a re-made picture (kb/s): the source's bitrate (the quality setting often stays under it), at least 100; 0 (no cap) when unknown. */
export const matchCap = (info) => { const k = sourceKbps(info); return k > 0 ? Math.max(100, Math.round(k)) : 0; };
/** The picture made again close to the source's size (videoCodec with matchCap). */
export const matchCodec = (container, info) => videoCodec(container, 0, { cap: matchCap(info) });
/** Sound made again at about the source's bitrate (64–192 kb/s; the usual rate when it isn't known). */
export function matchAudio(container, info) {
  const a = audioOf(info || {});
  const k = a && a.bitrate > 0 ? [64, 96, 128, 160, 192].find((x) => x >= a.bitrate * 0.95) || 192 : 0;
  return audioCodec(container, k);
}
const tail = (container) => (container === 'mp4' || container === 'mov' ? ['-movflags', '+faststart'] : []);
const MAPS = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
const T = (t) => String(r3(Math.max(0, t)));

/**
 * Trim. {input, file(name) → staged path, ext, container, source (the file's format), info, segments (time order),
 * fast}. Returns
 * {runs: [{args, duration, weight?}], list?: {path, text}, output, fast}: `duration` is each run's output length (for
 * its progress) and `weight` how much of the job it is (its duration when not given);
 * `fast` says whether the cut really is a copy (not possible for every container and codec).
 */
export function trimJob({ input, file, ext, container, source = container, info, segments, fast }) {
  const output = file('out.' + ext);
  const a = !!audioOf(info);
  const copy = fast && canCopy(container, info, source);
  if (copy) {
    const cut = (s, out) => ['-ss', T(s.start), '-t', T(s.end - s.start), '-i', input, ...MAPS, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(segments.length === 1 ? tail(container) : []), '-n', out];
    if (segments.length === 1) return { runs: [{ args: cut(segments[0], output), duration: segments[0].end - segments[0].start }], output, fast: true };
    const runs = segments.map((s, i) => ({ args: cut(s, file(`seg${i + 1}.${ext}`)), duration: s.end - s.start }));
    const text = segments.map((_, i) => `file 'seg${i + 1}.${ext}'`).join('\n') + '\n';
    const list = { path: file('list.txt'), text };
    runs.push({ args: ['-f', 'concat', '-safe', '0', '-i', list.path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', ...tail(container), '-n', output], duration: segmentsLength(segments), weight: 0.1 });
    return { runs, list, output, fast: true };
  }
  const enc = [...matchCodec(container, info), ...(a ? matchAudio(container, info) : [])];
  if (segments.length === 1) {
    const s = segments[0];
    return { runs: [{ args: ['-ss', T(s.start), '-t', T(s.end - s.start), '-i', input, ...MAPS, '-vf', EVEN, ...enc, ...tail(container), '-n', output], duration: s.end - s.start }], output, fast: false };
  }
  // Several parts: one pass, reading from the first part's start; each part is cut out and they are joined.
  const off = segments[0].start, last = segments[segments.length - 1].end;
  const chains = [], joins = [];
  segments.forEach((s, i) => {
    const st = T(s.start - off), en = T(s.end - off);
    chains.push(`[0:v:0]trim=start=${st}:end=${en},setpts=PTS-STARTPTS[v${i}]`);
    if (a) chains.push(`[0:a:0]atrim=start=${st}:end=${en},asetpts=PTS-STARTPTS[a${i}]`);
    joins.push(a ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  const graph = `${chains.join(';')};${joins.join('')}concat=n=${segments.length}:v=1:a=${a ? 1 : 0}[vj]${a ? '[a]' : ''};[vj]${EVEN}[v]`;
  const args = ['-ss', T(off), '-t', T(last - off), '-i', input, '-filter_complex', graph, '-map', '[v]', ...(a ? ['-map', '[a]'] : []), '-fps_mode', 'vfr', ...enc, ...tail(container), '-n', output];
  return { runs: [{ args, duration: segmentsLength(segments) }], output, fast: false };
}

/** Crop & reframe. crop and out are even pixel sizes ({x, y, w, h} and {w, h}); the sound is copied when it can be. */
export function reframeArgs({ input, output, container, source = container, info, crop, out }) {
  const filters = [squarePixels(info), `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`].filter(Boolean);
  if (out.w !== crop.w || out.h !== crop.h) filters.push(`scale=${out.w}:${out.h}:flags=lanczos`);
  filters.push('setsar=1');
  const a = audioOf(info);
  const audio = !a ? [] : audioCopyable(container, info, source) ? ['-c:a', 'copy'] : matchAudio(container, info);
  return ['-i', input, ...MAPS, '-vf', filters.join(','), ...matchCodec(container, info), ...audio, ...tail(container), '-n', output];
}

/** Change speed: picture retimed (with frame interpolation for smooth slow motion), sound by atempo. */
export function speedArgs({ input, output, container, info, speed, mute = false, smooth = false }) {
  const fps = outputFps(info.fps);
  const v = [`setpts=PTS/${speed}`];
  v.push(smooth && speed < 1 ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `fps=${fps}`);
  v.push(EVEN);
  const sound = !mute && !!audioOf(info);
  return ['-i', input, '-map', '0:v:0', ...(sound ? ['-map', '0:a:0'] : ['-an']), '-sn', '-dn',
    '-filter:v', v.join(','), ...(sound ? ['-filter:a', atempoChain(speed).map((x) => `atempo=${x}`).join(',')] : []),
    // Faster plays more of the picture each second: the cap grows with the speed (the file stays about as large).
    ...videoCodec(container, 0, { cap: Math.round(matchCap(info) * Math.max(1, speed)) }), ...(sound ? matchAudio(container, info) : []), ...tail(container), '-n', output];
}

/**
 * Cut into parts in one pass with FFmpeg's segment muxer: copied as it is (parts start on keyframes, nothing
 * re-encoded) or re-encoded with keyframes forced at the cuts (exact). Parts are written as part001.ext, …
 */
export function splitArgs({ input, pattern, container, info, cuts, copy, fps }) {
  const list = cuts.map(T).join(',');
  const a = !!audioOf(info);
  const codec = copy ? ['-c', 'copy'] : [...matchCodec(container, info), '-vf', EVEN, '-force_key_frames', list, ...(a ? matchAudio(container, info) : [])];
  const opts = container === 'mp4' || container === 'mov' ? ['-segment_format_options', 'movflags=+faststart'] : [];
  return ['-i', input, ...MAPS, ...codec, '-f', 'segment', '-segment_format', SEGMENT_FORMAT[container], ...opts,
    '-segment_times', list, '-segment_time_delta', T(Math.min(0.05, frameStep(fps) / 2)), '-reset_timestamps', '1', '-avoid_negative_ts', 'make_zero', pattern];
}

/** One part made again for a size limit: bitrate-limited, smaller picture when `height` is below the source. */
export function partArgs({ input, output, container, info, start, end, videoKbps, audioKbps, height }) {
  const d = shownSize(info);
  const short = Math.min(d.w, d.h);
  const scale = withSquare(info, height && short > height ? (d.w >= d.h ? `scale=-2:${height}` : `scale=${height}:-2`) : EVEN);
  const a = !!audioOf(info);
  return ['-ss', T(start), '-t', T(end - start), '-i', input, ...MAPS, '-vf', scale, ...videoCodec(container, videoKbps),
    ...(a ? audioCodec(container, audioKbps || 96) : []), ...tail(container), '-n', output];
}

// ================================================================== Phase 7: Combine, Save frames, Blur areas, GIF
const r6 = (t) => Math.round(t * 1e6) / 1e6;
const hex = (c) => '0x' + String(c || '#000000').replace('#', '');
const dec1 = (v) => String(Math.round(v * 10) / 10);

// ------------------------------------------------------------------ Combine videos
export const MAX_CLIPS = 50;
export const FADE_PRESETS = [0.5, 1, 2];
export const FADE_IDS = [0, ...FADE_PRESETS];
export const MERGE_SIZES = [
  { value: 'first', label: 'First clip', hint: 'The size of the first clip' },
  { value: '1080l', label: '1080p', ratio: [16, 9], hint: '1920 × 1080, landscape (YouTube, TV)' },
  { value: '1080p', label: '1080p vertical', ratio: [9, 16], hint: '1080 × 1920, portrait (Reels, Shorts, Status)' },
  { value: '720', label: '720p', hint: '1280 × 720, turned to match the first clip' },
];
export const MERGE_SIZE_IDS = MERGE_SIZES.map((s) => s.value);

/** The combined video's size (even pixels) for a size choice; `first` is the first clip's size as shown. */
export function mergeSize(choice, first) {
  if (choice === '1080l') return { w: 1920, h: 1080 };
  if (choice === '1080p') return { w: 1080, h: 1920 };
  if (choice === '720') return first.h > first.w ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
  return { w: even(first.w), h: even(first.h) };
}

/**
 * Where a w × h clip goes in a W × H frame: as large as fits without stretching, centred, even pixels; the bars
 * (letterbox or pillarbox) are filled with the background colour. A clip within 2 px of the frame fills it.
 */
export function fitInside(w, h, W, H) {
  const s = Math.min(W / w, H / h);
  let fw = Math.min(W, Math.max(2, Math.round((w * s) / 2) * 2)), fh = Math.min(H, Math.max(2, Math.round((h * s) / 2) * 2));
  if (W - fw <= 2) fw = W;
  if (H - fh <= 2) fh = H;
  return { w: fw, h: fh, x: Math.floor((W - fw) / 4) * 2, y: Math.floor((H - fh) / 4) * 2 };
}

/**
 * The crossfade at each join (QA round 7): `fade` seconds where both clips are long enough, none at a join that
 * touches a clip too short for it (a clip needs its fades plus a tenth of a second; a middle clip has two, and keeps
 * the one into it when there is room for one). Only those joins lose their crossfade. Returns {fades: [seconds per join], skipped: [join numbers, from 1],
 * short: [clip numbers, from 1], note: "No crossfade at join 2: clip 3 is too short." or ''}.
 */
export function mergeFades(durations, fade = 0) {
  const n = durations.length;
  const fades = Array.from({ length: Math.max(0, n - 1) }, () => (fade > 0 ? fade : 0));
  const short = new Set();
  for (let changed = fade > 0; changed;) {
    changed = false;
    for (let i = 0; i < n; i++) {
      const left = i > 0 ? fades[i - 1] : 0, right = i < n - 1 ? fades[i] : 0;
      if ((left || right) && durations[i] < left + right + 0.1) {
        short.add(i + 1);
        if (left && right && durations[i] >= left + 0.1) fades[i] = 0; // room for one: keep the crossfade into it
        else { if (i > 0) fades[i - 1] = 0; if (i < n - 1) fades[i] = 0; }
        changed = true;
      }
    }
  }
  const skipped = fade > 0 ? fades.map((f, k) => (f ? 0 : k + 1)).filter(Boolean) : [];
  const list = (xs) => (xs.length === 1 ? String(xs[0]) : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const clips = [...short].sort((a, b) => a - b);
  let note = '';
  if (skipped.length && skipped.length === fades.length) note = `No crossfades: ${clips.length === 1 ? `clip ${clips[0]} is` : `clips ${list(clips)} are`} too short for ${num(fade)} s.`;
  else if (skipped.length) note = `No crossfade at ${skipped.length === 1 ? 'join' : 'joins'} ${list(skipped)}: ${clips.length === 1 ? `clip ${clips[0]} is` : `clips ${list(clips)} are`} too short.`;
  return { fades, skipped, short: clips, note };
}
const fadesOf = (durations, fade) => (Array.isArray(fade) ? fade : mergeFades(durations, fade).fades);

/**
 * The name for combined clips (QA round 7): the first clip's name without words about its size or frame rate
 * ("60fps_1080p", "4K", "1920x1080"), which the result may not have; "combined" when nothing else is left.
 */
export function mergeStem(stem) {
  const TOKEN = /(^|[\s_.\-]+)(?:\d{3,4}[pi](?:\d{2,3})?|[2458]k|uhd|fhd|qhd|hdr|\d{2,3}\s?fps|\d{3,5}\s?[x×]\s?\d{3,5})(?=$|[\s_.\-]+)/gi;
  let t = String(stem || ''), prev;
  do { prev = t; t = t.replace(TOKEN, '$1'); } while (t !== prev);
  t = t.replace(/[\s_.\-]+$/, '').replace(/^[\s_.\-]+/, '').replace(/([\s_.\-])[\s_.\-]+/g, '$1');
  return /[\p{L}\p{N}]/u.test(t) ? t : 'combined';
}

/** Length of clips joined one after another, each crossfade overlapping two clips (`fade`: seconds, or one per join). */
export const mergeTotal = (durations, fade = 0) => Math.max(0, durations.reduce((a, d) => a + d, 0) - fadesOf(durations, fade).reduce((a, f) => a + f, 0));

/** When each crossfade starts in the joined video so far (xfade `offset`s, one per join; `fade` as for mergeTotal). */
export function crossfadeOffsets(durations, fade) {
  const fades = fadesOf(durations, fade);
  const out = [];
  let acc = 0;
  for (let k = 0; k < durations.length - 1; k++) { acc += durations[k]; out.push(r3(acc - fades[k])); acc -= fades[k]; }
  return out;
}
export function mergeIssue(durations, fade = 0) {
  const n = durations.length;
  if (n < 2) return 'Combining needs at least two videos.';
  if (n > MAX_CLIPS) return `Combine at most ${MAX_CLIPS} videos at once.`;
  const bad = durations.findIndex((d) => !(d > 0));
  if (bad >= 0) return `The length of clip ${bad + 1} can’t be read.`;
  // A clip too short for a crossfade only loses the crossfades at its own joins (mergeFades), so it never blocks.
  return null;
}

/**
 * Can these clips ({format, info}) be joined as they are, with no re-encoding? Only MP4s whose picture and sound
 * match exactly (codec, profile, pixel format, size, frame rate, time base, rotation; sound codec, rate, channels).
 */
export function canJoinCopy(clips) {
  if (!clips || clips.length < 2) return false;
  const key = ({ format, info }) => {
    if (format !== 'mp4' || !canCopy('mp4', info, 'mp4')) return null;
    const v = videoOf(info), a = audioOf(info);
    if (!v.pixFmt || !v.tbn || !v.fps) return null;
    return JSON.stringify([v.codec, v.profile || '', v.pixFmt, v.width, v.height, Math.round(sarOf(info) * 1000), v.fps, v.tbn, v.rotation || 0,
      a ? [a.codec, a.profile || '', a.sampleRate, a.channels] : null]);
  };
  const first = key(clips[0]);
  return !!first && clips.every((c) => key(c) === first);
}

/** Text of a concat list naming files by full path (quotes escaped the concat demuxer's way). */
export const concatList = (paths) => paths.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join('\n') + '\n';

/**
 * Combine videos. inputs: [{path, info, duration}] in order; size {w, h}; fps; fade (s, 0 = none); color ('#rrggbb'
 * for the bars); copy (join as they are: a concat list). Returns {runs: [{args, duration}], list?, total, copy}.
 * Re-encoding is one pass: every clip fitted into the frame without stretching, at one frame rate; clips without
 * sound get silence so the sound stays in step; then joined (concat) or crossfaded (xfade + acrossfade). MP4 out.
 */
export function mergeJob({ inputs, output, listPath, size, fps, fade = 0, color = '#000000', copy = false }) {
  const durations = inputs.map((i) => i.duration);
  const fades = mergeFades(durations, fade).fades;
  const total = mergeTotal(durations, fades);
  if (copy) {
    const list = { path: listPath, text: concatList(inputs.map((i) => i.path)) };
    const args = ['-f', 'concat', '-safe', '0', '-i', list.path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-n', output];
    return { runs: [{ args, duration: total }], list, total, copy: true };
  }
  const { w: W, h: H } = size;
  const sound = inputs.some((i) => !!audioOf(i.info));
  // Every clip is cut to a whole number of frames on one grid (QA round 8), so the joins line up exactly: each
  // clip and each join's result has the same size, pixels, frame rate and time base (xfade refuses anything else),
  // and the sound of each clip is exactly as long as its picture.
  const frames = durations.map((d) => Math.max(1, Math.round(d * fps)));
  const lens = frames.map((n) => n / fps);
  const xf = fades.map((f) => (f > 0 ? Math.max(1, Math.round(f * fps)) / fps : 0));
  const total6 = r6(lens.reduce((a, b) => a + b, 0) - xf.reduce((a, b) => a + b, 0));
  const S = (t) => String(r6(Math.max(0, t)));
  const samples = (t) => Math.max(1, Math.round(t * 48000));
  const chains = [];
  inputs.forEach((inp, i) => {
    const v = videoOf(inp.info) || {};
    const d = v.width && v.height ? shownSize(inp.info) : { w: W, h: H };
    const f = fitInside(d.w, d.h, W, H);
    chains.push(`[${i}:v:0]setpts=PTS-STARTPTS,scale=${f.w}:${f.h}:flags=lanczos,setsar=1,pad=${W}:${H}:${f.x}:${f.y}:color=${hex(color)},`
      + `fps=${fps},tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${frames[i]},format=yuv420p[v${i}]`);
    if (sound) {
      chains.push(audioOf(inp.info)
        ? `[${i}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${samples(lens[i])},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples(lens[i])},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  });
  const n = inputs.length;
  if (fades.some((f) => f > 0)) {
    // Join by join: a crossfade where there is one, a plain cut (concat) where a clip is too short for it. A cut's
    // result is put back on the frame grid (concat gives another time base, which a following xfade refuses).
    let acc = 0;
    for (let k = 0; k < n - 1; k++) {
      const a = k ? `[x${k}]` : '[v0]', out = k === n - 2 ? '[v]' : `[x${k + 1}]`;
      const ia = k ? `[y${k}]` : '[a0]', oa = k === n - 2 ? '[a]' : `[y${k + 1}]`;
      acc += lens[k];
      if (xf[k] > 0) {
        chains.push(`${a}[v${k + 1}]xfade=transition=fade:duration=${S(xf[k])}:offset=${S(acc - xf[k])}${out}`);
        if (sound) chains.push(`${ia}[a${k + 1}]acrossfade=ns=${samples(xf[k])}:c1=tri:c2=tri${oa}`);
        acc -= xf[k];
      } else {
        chains.push(`${a}[v${k + 1}]concat=n=2:v=1:a=0,fps=${fps}${out}`);
        if (sound) chains.push(`${ia}[a${k + 1}]concat=n=2:v=0:a=1,asetpts=N/SR/TB${oa}`);
      }
    }
  } else {
    chains.push(`${inputs.map((_, i) => `[v${i}]${sound ? `[a${i}]` : ''}`).join('')}concat=n=${n}:v=1:a=${sound ? 1 : 0}[v]${sound ? '[a]' : ''}`);
  }
  const args = [...inputs.flatMap((i) => ['-i', i.path]), '-filter_complex', chains.join(';'), '-map', '[v]', ...(sound ? ['-map', '[a]'] : []),
    ...videoCodec('mp4'), ...(sound ? audioCodec('mp4') : []), '-movflags', '+faststart', '-n', output];
  return { runs: [{ args, duration: total6 }], total: total6, copy: false };
}

// ------------------------------------------------------------------ Save frames
export const MAX_FRAMES = 500;
export const FRAME_MODES = ['pick', 'every', 'count'];
export const FRAME_FORMATS = [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPEG' }];
export const FRAME_EVERY_PRESETS = [1, 2, 5, 10];
export const FRAME_COUNT_PRESETS = [6, 12, 24, 48];
export const FRAME_EVERY_MIN = 0.1;

/** The start of the frame shown at time `t` (players show the frame that began at or before t), on the frame grid. */
export function frameTime(t, fps, duration) {
  const step = frameStep(fps);
  const last = Math.max(0, Math.floor((Math.max(0, duration - step) + 1e-9) / step) * step);
  return r6(clamp(Math.floor(Math.max(0, t) / step + 1e-6) * step, 0, last));
}

/** Frames every `every` seconds from the start: how many, and their times. */
export const everyCount = (duration, every) => (duration > 0 && every > 0 ? Math.floor((duration - 1e-3) / every) + 1 : 0);
export const everyTimes = (duration, every) => Array.from({ length: everyCount(duration, every) }, (_, i) => r3(i * every));
/** `count` frames spread evenly: the middle of each equal slice of the video. */
export const spacedTimes = (duration, count) => Array.from({ length: count }, (_, i) => r3(((i + 0.5) * duration) / count));

/** Times of the frames to save: {times} or {error}. o: {mode, picked: [t], every, count}. */
export function framePlan(duration, o) {
  if (!(duration > 0)) return { error: 'Reading the video…' };
  let times;
  if (o.mode === 'pick') {
    times = [...new Set((o.picked || []).map(Number).filter((t) => t >= 0 && t <= duration))].sort((a, b) => a - b);
    if (!times.length) return { error: 'Add a frame: play or scrub to a moment and click Add this frame (S).' };
  } else if (o.mode === 'every') {
    const every = Number(o.every);
    if (!(every >= FRAME_EVERY_MIN)) return { error: `Choose ${FRAME_EVERY_MIN} seconds or more.` };
    const n = everyCount(duration, every);
    if (n > MAX_FRAMES) return { error: `That would save ${n} frames; the most is ${MAX_FRAMES}. Choose a longer time.` };
    times = everyTimes(duration, every);
  } else if (o.mode === 'count') {
    const n = Math.round(Number(o.count));
    if (!(n >= 2 && n <= MAX_FRAMES)) return { error: `Choose from 2 to ${MAX_FRAMES} frames.` };
    times = spacedTimes(duration, n);
  } else return { error: 'Choose which frames to save.' };
  if (times.length > MAX_FRAMES) return { error: `Save at most ${MAX_FRAMES} frames at once.` };
  return { times };
}

/** A time for a file name, sortable within one video: "0m03.25s", "12m03.25s" (minutes padded for long videos), "1h02m03.25s". */
export function frameStamp(t, duration, digits = 2) {
  const k = 10 ** digits;
  const tot = Math.round(Math.max(0, t) * k) / k;
  const h = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60);
  const ss = (tot - h * 3600 - m * 60).toFixed(digits).padStart(digits + 3, '0');
  if (duration >= 3600) return `${String(h).padStart(String(Math.floor(duration / 3600)).length, '0')}h${String(m).padStart(2, '0')}m${ss}s`;
  return `${String(m).padStart(String(Math.floor(duration / 60)).length, '0')}m${ss}s`;
}

/** File names for frames at these times: "clip 0m03.25s.png"; 3 decimals when 2 would repeat a name. */
export function frameNames(stem, times, duration, ext) {
  for (const digits of [2, 3]) {
    const names = times.map((t) => `${stem} ${frameStamp(t, duration, digits)}.${ext}`);
    if (new Set(names).size === names.length) return names;
  }
  const seen = new Map();
  return times.map((t) => { const b = `${stem} ${frameStamp(t, duration, 3)}`; const n = (seen.get(b) || 0) + 1; seen.set(b, n); return `${b}${n > 1 ? ` (${n})` : ''}.${ext}`; });
}

/** FFmpeg's JPEG quality (2 best – 31) for a 1–100 setting. */
export const jpegQ = (quality) => clamp(Math.round(31 - (Number(quality) || 90) * 0.29), 2, 31);

/**
 * One frame as a picture. The seek lands a quarter frame before `t` and FFmpeg decodes up to it, so the first frame
 * written is exactly the one that starts at `t` (a time on the frame grid, from frameTime). Shown upright, square pixels.
 */
export function frameArgs({ input, output, t, fps, format, quality = 90, info = null }) {
  const seek = Math.max(0, t - frameStep(fps) / 4).toFixed(6).replace(/\.?0+$/, '') || '0';
  const codec = format === 'jpg' ? ['-c:v', 'mjpeg', '-q:v', String(jpegQ(quality)), '-pix_fmt', 'yuvj444p'] : ['-c:v', 'png', '-pix_fmt', 'rgb24'];
  return ['-ss', seek, '-i', input, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-vf', (info && squarePixels(info)) || 'scale=iw*sar:ih,setsar=1', ...codec, '-update', '1', '-n', output];
}

// ------------------------------------------------------------------ Blur areas
export const MAX_BLUR_BOXES = 20;
export const MIN_BOX_TIME = 0.1;
export const BLUR_STYLES = [
  { value: 'blur', label: 'Blur', icon: 'droplet', hint: 'A heavy blur over large blocks, so faces and text can’t be made out or brought back.' },
  { value: 'pixelate', label: 'Pixelate', icon: 'grid-3x3', hint: 'Large blocks of colour; what’s underneath can’t be brought back.' },
  { value: 'black', label: 'Black', icon: 'square', hint: 'Solid black boxes. The safest choice for text and numbers.' },
];
export const BLUR_STYLE_IDS = BLUR_STYLES.map((s) => s.value);

/** Block size (pixels) for blur and pixelate: about a third of the box's short side, never under 8 px or 1.2% of the picture (as Hide details). */
export const blurBlock = (bw, bh, W, H) => Math.max(8, Math.round(Math.max(W, H) * 0.012), Math.ceil(Math.min(bw, bh) / 2.5));

/** Whole even pixels covering a box ({x, y, w, h} fractions) on an even W × H picture: never smaller than the box. */
export function boxArea(b, W, H) {
  const x0 = clamp(Math.floor((b.x * W) / 2 + 1e-9) * 2, 0, W - 2), y0 = clamp(Math.floor((b.y * H) / 2 + 1e-9) * 2, 0, H - 2);
  const x1 = clamp(Math.ceil(((b.x + b.w) * W) / 2 - 1e-9) * 2, x0 + 2, W), y1 = clamp(Math.ceil(((b.y + b.h) * H) / 2 - 1e-9) * 2, y0 + 2, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Does a box have its own time range ({start, end} in seconds)? Without one it covers the whole video. */
export const timedBox = (b) => !!b && b.start != null && b.end != null;
/** Is a box shown at time t? */
export const boxShows = (b, t) => !timedBox(b) || (t >= b.start - 1e-3 && t <= b.end + 1e-3);

/** What's wrong with these boxes, or null. */
export function boxesIssue(boxes, duration) {
  if (!boxes || !boxes.length) return 'Draw a box over what you want to hide.';
  if (boxes.length > MAX_BLUR_BOXES) return `Use at most ${MAX_BLUR_BOXES} boxes.`;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!timedBox(b)) continue;
    if (!(b.end - b.start >= MIN_BOX_TIME - 1e-9)) return `Box ${i + 1}’s time is too short (at least ${MIN_BOX_TIME} s).`;
    if (duration > 0 && b.start >= duration) return `Box ${i + 1} starts after the video ends.`;
  }
  return null;
}

/**
 * The filter graph that hides the boxes on a W × H picture (as shown; odd sizes are cut to even first), ending in
 * [v]. Black: filled boxes. Pixelate: each box made small (area average) and enlarged with hard edges. Blur: the same
 * small copy enlarged smoothly and blurred, so only block averages remain — it can't be undone. Timed boxes only
 * show between their start and end.
 */
export function blurGraph({ W, H, boxes, style, src = '0:v:0', square = '' }) {
  const We = even(W), He = even(H);
  const head = `[${src}]` + (square ? square + ',' : '') + (We !== W || He !== H ? `crop=${We}:${He}:0:0,` : '');
  const en = (b) => (timedBox(b) ? `:enable='between(t,${T(b.start)},${T(b.end)})'` : '');
  const list = boxes.map((b) => ({ r: boxArea(b, We, He), b }));
  if (style === 'black') return `${head}${list.map(({ r, b }) => `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=black:t=fill${en(b)}`).join(',')}[v]`;
  const parts = [`${head}split=${list.length + 1}[o0]${list.map((_, i) => `[c${i}]`).join('')}`];
  list.forEach(({ r, b }, i) => {
    const bs = blurBlock(r.w, r.h, We, He);
    const gw = Math.max(1, Math.ceil(r.w / bs)), gh = Math.max(1, Math.ceil(r.h / bs));
    const up = style === 'pixelate' ? `scale=${r.w}:${r.h}:flags=neighbor` : `scale=${r.w}:${r.h}:flags=bicubic,gblur=sigma=${dec1(bs * 0.5)}`;
    parts.push(`[c${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${gw}:${gh}:flags=area,${up}[p${i}]`);
    parts.push(`[o${i}][p${i}]overlay=x=${r.x}:y=${r.y}${en(b)}${i === list.length - 1 ? '[v]' : `[o${i + 1}]`}`);
  });
  return parts.join(';');
}

/** Blur areas: the picture made again with the boxes hidden; the sound copied as it is when the container allows. */
export function blurArgs({ input, output, container, source = container, info, boxes, style }) {
  const d = shownSize(info);
  const a = audioOf(info);
  const audio = !a ? [] : audioCopyable(container, info, source) ? ['-c:a', 'copy'] : matchAudio(container, info);
  return ['-i', input, '-filter_complex', blurGraph({ W: d.w, H: d.h, boxes, style, square: squarePixels(info) }), '-map', '[v]', ...(a ? ['-map', '0:a:0'] : []), '-sn', '-dn',
    ...matchCodec(container, info), ...audio, ...tail(container), '-n', output];
}

// ------------------------------------------------------------------ GIF & sticker
export const GIF_FORMATS = [{ value: 'gif', label: 'GIF' }, { value: 'webp', label: 'Animated WebP' }];
export const GIF_FORMAT_IDS = GIF_FORMATS.map((f) => f.value);
export const GIF_WIDTHS = [320, 480, 640, 'original'];
export const GIF_FPS = [10, 15, 24];
export const GIF_LIMITS = [{ value: 2, label: '2 MB' }, { value: 8, label: '8 MB' }, { value: 15, label: '15 MB' }];
export const GIF_LIMIT_MIN_MB = 0.2;
export const GIF_LIMIT_MAX_MB = 200;
export const GIF_MAX_SECONDS = 60;
export const GIF_MIN_SECONDS = 0.2;
export const GIF_FIRST_SECONDS = 5;
const GIF_COLORS = [256, 128, 64];
const WEBP_QUALITY = [75, 60, 45, 30];
const LADDER_FPS = [20, 15, 12, 10, 8, 6];

/** The picture size for a width choice (never wider than the video; even pixels, the shape kept). */
export function gifSize(width, W, H) {
  const w = even(width === 'original' ? W : Math.min(Number(width) || W, W));
  return { w, h: Math.max(2, Math.round((w * H) / W / 2) * 2) };
}

/** Rough relative size of a GIF/WebP made with these settings (for choosing the next try). */
export const gifEstimate = (s) => s.w * s.h * s.fps * (s.colors ? { 256: 1, 128: 0.82, 64: 0.68 }[s.colors] || 1 : 0.35 + (s.quality / 100) * 0.87);

/**
 * Settings to try, largest first, for a size limit: the chosen settings, then fewer colours (GIF) or lower quality
 * (WebP), fewer frames per second and smaller widths in every combination, ordered by estimated size.
 */
export function gifLadder({ fps, w, h, format, quality = 75 }) {
  const widths = [w];
  for (let k = 1; k <= 8; k++) { const x = even(w * 0.85 ** k); if (x < Math.min(w, 120)) break; if (x !== widths[widths.length - 1]) widths.push(x); }
  const rates = [fps, ...LADDER_FPS.filter((f) => f < fps)];
  const looks = format === 'webp' ? [quality, ...WEBP_QUALITY.filter((q) => q < quality)] : GIF_COLORS;
  const out = [];
  for (const ww of widths) for (const f of rates) for (const l of looks) {
    const s = { fps: f, w: ww, h: Math.max(2, Math.round((ww * h) / w / 2) * 2) };
    if (format === 'webp') s.quality = l; else s.colors = l;
    out.push(s);
  }
  const first = out[0];
  return [first, ...out.slice(1).sort((a, b) => gifEstimate(b) - gifEstimate(a))];
}

/** After a try at ladder[i] came out `bytes` big: the next try (its index), i itself when it fits, or -1 when nothing smaller is left. */
export function nextGifStep(ladder, i, bytes, limit) {
  if (bytes <= limit) return i;
  const want = (gifEstimate(ladder[i]) * limit * 0.9) / bytes;
  for (let j = i + 1; j < ladder.length; j++) if (gifEstimate(ladder[j]) <= want) return j;
  return i < ladder.length - 1 ? ladder.length - 1 : -1;
}

/** "15 fps · 400 × 226 · 128 colours" */
export const describeGifStep = (s) => `${num(s.fps)} fps · ${s.w} × ${s.h}${s.colors ? ` · ${s.colors} colours` : s.quality ? ` · quality ${s.quality}` : ''}`;

/**
 * GIF or animated WebP of [start, end]. GIF: one pass with its own palette (palettegen + paletteuse, good colour,
 * only changed areas stored). WebP: lossy animated WebP. loop: play forever, or once.
 */
export function gifArgs({ input, output, start, end, step, format, loop = true, webpEncoder = 'libwebp_anim' }) {
  const head = ['-ss', T(start), '-t', T(end - start), '-i', input];
  const scale = `fps=${num(step.fps)},scale=${step.w}:${step.h}:flags=lanczos,setsar=1`;
  if (format === 'webp') {
    return [...head, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `${scale},format=yuv420p`, '-c:v', webpEncoder, '-lossless', '0', '-quality', String(step.quality || 75),
      '-compression_level', '4', '-loop', loop ? '0' : '1', '-f', 'webp', '-n', output];
  }
  const graph = `[0:v:0]${scale},split[a][b];[a]palettegen=max_colors=${step.colors || 256}[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle[g]`;
  return [...head, '-filter_complex', graph, '-map', '[g]', '-loop', loop ? '0' : '-1', '-f', 'gif', '-n', output];
}
