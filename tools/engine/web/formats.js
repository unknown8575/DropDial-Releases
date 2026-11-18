// shared/formats.js from the app, as a module (the website's copy; built by website/build.mjs).
const module = { exports: {} };
const process = { platform: 'web' };
const Buffer = { byteLength: (s) => new TextEncoder().encode(String(s)).length, from(b, off, len) {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b, off || 0, len) : new Uint8Array(b);
  return Object.assign(u, { toString: () => new TextDecoder().decode(u), indexOf(s) { const t = new TextEncoder().encode(s); outer: for (let i = 0; i + t.length <= u.length; i++) { for (let k = 0; k < t.length; k++) if (u[i + k] !== t[k]) continue outer; return i; } return -1; } });
} };
'use strict';
// The format catalogue: what DropDial recognises, what each format converts to (and with which engine),
// the tool catalogue and the file actions. Shared by the main process and the tests (see INTERFACE.md §1).

const CATEGORIES = {
  image: { label: 'Images', icon: 'image' },
  video: { label: 'Video', icon: 'film' },
  audio: { label: 'Audio', icon: 'music' },
  document: { label: 'Documents', icon: 'file-text' },
  subtitle: { label: 'Subtitles', icon: 'captions' },
};

const fmt = (label, category, aliases, ext = aliases[0]) => ({ label, ext, aliases, category });
const FORMATS = {
  jpg: fmt('JPEG', 'image', ['jpg', 'jpeg', 'jfif', 'jpe']),
  png: fmt('PNG', 'image', ['png']),
  webp: fmt('WebP', 'image', ['webp']),
  heic: fmt('HEIC', 'image', ['heic', 'heif']),
  avif: fmt('AVIF', 'image', ['avif']),
  tiff: fmt('TIFF', 'image', ['tiff', 'tif']),
  bmp: fmt('BMP', 'image', ['bmp']),
  gif: fmt('GIF', 'image', ['gif']),
  ico: fmt('ICO', 'image', ['ico']),
  svg: fmt('SVG', 'image', ['svg']),
  pdf: fmt('PDF', 'document', ['pdf']),
  docx: fmt('DOCX', 'document', ['docx']),
  txt: fmt('TXT', 'document', ['txt', 'md', 'markdown']),
  csv: fmt('CSV', 'document', ['csv']),
  xlsx: fmt('XLSX', 'document', ['xlsx']),
  xls: fmt('XLS', 'document', ['xls']),
  json: fmt('JSON', 'document', ['json']),
  mp4: fmt('MP4', 'video', ['mp4', 'm4v']),
  mov: fmt('MOV', 'video', ['mov', 'qt']),
  mkv: fmt('MKV', 'video', ['mkv']),
  webm: fmt('WebM', 'video', ['webm']),
  avi: fmt('AVI', 'video', ['avi']),
  wmv: fmt('WMV', 'video', ['wmv']),
  mp3: fmt('MP3', 'audio', ['mp3']),
  m4a: fmt('M4A', 'audio', ['m4a', 'm4b']),
  wav: fmt('WAV', 'audio', ['wav', 'wave']),
  flac: fmt('FLAC', 'audio', ['flac']),
  ogg: fmt('OGG', 'audio', ['ogg', 'oga']),
  opus: fmt('Opus', 'audio', ['opus']),
  aiff: fmt('AIFF', 'audio', ['aiff', 'aif']),
  wma: fmt('WMA', 'audio', ['wma']),
  srt: fmt('SRT', 'subtitle', ['srt']),
  vtt: fmt('VTT', 'subtitle', ['vtt']),
};

// Formats DropDial makes but doesn't open: only conversion targets, never recognised as a file's format. (XLSX and
// JSON were here until DropDial learned to read them.)
const OUTPUT_FORMATS = {};
/** A format's {label, ext, aliases, category}, including the output-only ones. */
const formatInfo = (id) => FORMATS[id] || OUTPUT_FORMATS[id] || null;

const BY_ALIAS = new Map(Object.entries(FORMATS).flatMap(([id, f]) => f.aliases.map((a) => [a, id])));
const idsIn = (category) => Object.keys(FORMATS).filter((id) => FORMATS[id].category === category);

/** Format id from a file name's extension (case-insensitive), or null. */
function detect(fileName) {
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || /[\\/]/.test(name.slice(dot))) return null;
  return BY_ALIAS.get(name.slice(dot + 1).toLowerCase()) || null;
}

// ------------------------------------------------------------------ names
/** "photo.final.jpg" → "photo.final"; names without an extension (or dot files) stay as they are. */
function baseName(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(0, dot) : s;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i; // Windows also reserves "CON.anything"
// A file name may be 255 bytes (macOS, Linux; UTF-8) or 255 UTF-16 units (Windows). A full Windows path may be 259
// characters (MAX_PATH less its end mark) for most apps, Explorer included, even where long paths are turned on.
const NAME_MAX = 255, WIN_PATH_MAX = 259, WIN_FOLDER_ROOM = 48;

/** A file name stem that is valid on Windows and macOS: no reserved names or characters, at most 255 bytes. */
function safeStem(stem, { cap = true } = {}) {
  let s = String(stem || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim();
  if (cap && Buffer.byteLength(s) > NAME_MAX) s = cutStem(s, (t) => Buffer.byteLength(t) <= NAME_MAX);
  s = s.replace(/[. ]+$/, '');
  if (!s || /^\.+$/.test(s)) return 'file';
  return RESERVED.test(s) ? 'file-' + s : s;
}

/**
 * The longest start of `stem` for which fits(start) holds, cut at a word break (space, _, -, .) when one is near
 * (the last 40% of what fits), never inside a character; separators and commas left at the end are dropped.
 */
function cutStem(stem, fits) {
  const chars = [...String(stem)];
  let n = 0;
  while (n < chars.length && fits(chars.slice(0, n + 1).join(''))) n++;
  if (n >= chars.length) return chars.join('');
  let cut = n;
  for (let i = n; i > Math.floor(n * 0.6); i--) if (/[\s_.-]/.test(chars[i] || '')) { cut = i; break; }
  return chars.slice(0, Math.max(1, cut)).join('').replace(/[\s_.,;-]+$/, '') || chars.slice(0, Math.max(1, n)).join('');
}

/**
 * The name before numbering: "stem suffix". A stem that already ends with the suffix ("hos framed", or a numbered
 * "hos framed 2") keeps it once, so framing "hos framed.jpg" again gives "hos framed 2.jpg", not "hos framed framed".
 */
function suffixed(stem, suffix, opts) {
  const st = String(stem);
  if (!suffix) return safeStem(st, opts);
  const esc = String(suffix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^(.*\\S) (${esc})(?: \\d+)?$`, 'i').exec(st);
  return m ? safeStem(`${m[1]} ${m[2]}`, opts) : safeStem(st, opts) + ' ' + suffix;
}

/**
 * The n-th name for a result, shortened only when the system needs it: {name, shortened: null | 'name' | 'path'}.
 * n = 1 → "stem.ext", then "stem 2.ext", … With a suffix: "stem suffix.ext", "stem suffix 2.ext". The stem is cut at a
 * word break; the suffix, number and extension stay. `dir` (the folder it goes in) and `platform` check the whole
 * path on Windows (259 characters); `folder` leaves room for the files a new folder will hold.
 */
function fitName(stem, ext, n = 1, suffix = '', { dir = '', platform = process.platform, folder = false } = {}) {
  if (/[\\/\0]/.test(String(ext)) || /[\\/\0]/.test(String(suffix))) throw new Error('Invalid file name part');
  const base = suffixed(stem, suffix, { cap: false }); // shortened below, where it is said
  // Only the stem part is shortened: " suffix", " 2" and ".ext" are kept.
  const sfx = suffix && base.toLowerCase().endsWith(' ' + String(suffix).toLowerCase()) ? base.slice(base.length - String(suffix).length - 1) : '';
  const head = base.slice(0, base.length - sfx.length);
  const tail = `${sfx}${n > 1 ? ' ' + n : ''}${ext ? '.' + ext : ''}`;
  const win = platform === 'win32';
  const size = (t) => (win ? t.length : Buffer.byteLength(t)); // Windows counts UTF-16 units; macOS and Linux bytes
  const room = win && dir ? (folder ? WIN_PATH_MAX - WIN_FOLDER_ROOM : WIN_PATH_MAX) - (String(dir).replace(/[\\/]+$/, '').length + 1) : Infinity;
  const fits = (h) => size(h + tail) <= NAME_MAX && (h + tail).length <= room;
  if (fits(head)) return { name: head + tail, shortened: null };
  const cut = cutStem(head, fits);
  return { name: cut + tail, shortened: size(head + tail) > NAME_MAX ? 'name' : 'path' };
}

/** n = 1 → "stem.ext", then "stem 2.ext", … With a suffix: "stem suffix.ext", "stem suffix 2.ext". (See fitName.) */
function candidateName(stem, ext, n = 1, suffix = '', where) {
  return fitName(stem, ext, n, suffix, where || { platform: 'none' }).name;
}

/** Words for a shortened name, for footers and results. */
const SHORTENED = { path: 'Name shortened to fit Windows’ path limit.', name: 'Name shortened to fit the 255-character file name limit.' };

// ------------------------------------------------------------------ conversions
// Engines (implemented in src/main/conversions.js):
//   image        decode + encode in the processor          image-pdf / image-docx   image → document
//   image-avif   processor → PNG → FFmpeg (AV1)            image-heic               processor → PNG → macOS sips
//   pdf-image / pdf-text / pdf-docx                         docx-pdf / docx-text / text-pdf / text-docx
//   subtitle     SRT/VTT in the main process               ffmpeg                   audio and video
//   csv-table    CSV → XLSX / JSON in the processor
//   sheet-table  XLSX / XLS / JSON → CSV / JSON / XLSX in the processor, → PDF printed as a table
const STILL = ['jpg', 'png', 'webp', 'heic', 'avif', 'tiff', 'bmp', 'ico'];
const RASTER_OUT = ['jpg', 'png', 'webp', 'tiff', 'bmp', 'gif', 'ico'];
const VIDEO = idsIn('video');
const AUDIO = idsIn('audio');
const NEEDS_FFMPEG = new Set(['ffmpeg', 'image-avif']);

const ROUTES = {};
const route = (from, to, engine) => { (ROUTES[from] ||= {})[to] = engine; };
for (const from of [...STILL, 'gif']) {
  for (const to of RASTER_OUT) route(from, to, 'image');
  route(from, 'avif', 'image-avif');
  route(from, 'heic', 'image-heic');
  route(from, 'pdf', 'image-pdf');
}
for (const from of STILL) route(from, 'docx', 'image-docx');
for (const to of ['png', 'jpg', 'webp']) route('svg', to, 'image');
route('svg', 'pdf', 'image-pdf');
for (const to of ['mp4', 'webm', 'mov']) route('gif', to, 'ffmpeg'); // animated GIF → video
for (const from of VIDEO) for (const to of [...VIDEO, 'gif', 'mp3', 'm4a', 'wav']) route(from, to, 'ffmpeg');
for (const from of AUDIO) for (const to of AUDIO) route(from, to, 'ffmpeg');
route('pdf', 'png', 'pdf-image'); route('pdf', 'jpg', 'pdf-image'); route('pdf', 'txt', 'pdf-text'); route('pdf', 'docx', 'pdf-docx');
route('docx', 'pdf', 'docx-pdf'); route('docx', 'txt', 'docx-text');
route('txt', 'pdf', 'text-pdf'); route('txt', 'docx', 'text-docx');
route('csv', 'xlsx', 'csv-table'); route('csv', 'json', 'csv-table');
for (const from of ['xlsx', 'xls']) for (const to of ['csv', 'xlsx', 'json', 'pdf']) route(from, to, 'sheet-table');
route('json', 'csv', 'sheet-table'); route('json', 'xlsx', 'sheet-table');
route('srt', 'vtt', 'subtitle'); route('srt', 'txt', 'subtitle'); route('vtt', 'srt', 'subtitle'); route('vtt', 'txt', 'subtitle');
for (const from of Object.keys(ROUTES)) delete ROUTES[from][from]; // never "convert" to the same format

// The order targets appear in on the wheel.
const TARGET_ORDER = ['jpg', 'png', 'webp', 'heic', 'avif', 'gif', 'tiff', 'bmp', 'ico', 'pdf', 'docx', 'txt',
  'csv', 'xlsx', 'json', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'wma', 'srt', 'vtt'];

const routeEngine = (from, to) => (ROUTES[from] && ROUTES[from][to]) || null;

const FFMPEG_REASON = 'Needs FFmpeg. Check Settings → Formats.';

/** Why a route can't run with these capabilities, or null if it can. Undefined means it is not offered at all. */
function blocked(engine, caps) {
  if (engine === 'image-heic') return caps.heicEncode ? null : undefined;
  if (NEEDS_FFMPEG.has(engine) && !caps.ffmpeg) return FFMPEG_REASON;
  if (engine === 'image-avif' && caps.av1 === false) return 'The FFmpeg in use can’t make AVIF files. Choose another in Settings → Formats.';
  return null;
}

/**
 * How a selection goes to `to` (QA round 7: every format at least one file can go to is offered). `items` are
 * format ids or {format, name?, still?} (`still`: a GIF without animation, which has no video to make).
 * → {convert: [i], same: [i] (already that format: left as they are, no copy), skip: [{i, reason}], blocked}
 * `blocked` is the reason when files could go but this computer can't do it (FFmpeg missing).
 */
function planTarget(items, to, caps = {}) {
  const plan = { convert: [], same: [], skip: [], blocked: null };
  const label = (formatInfo(to) || {}).label || String(to).toUpperCase();
  items.forEach((it, i) => {
    const f = typeof it === 'string' ? it : it && it.format;
    if (f === to) { plan.same.push(i); return; }
    const engine = routeEngine(f, to);
    const why = engine ? blocked(engine, caps) : undefined;
    if (!engine || why === undefined) { plan.skip.push({ i, reason: `can’t become ${label}` }); return; }
    if (why) { plan.skip.push({ i, reason: why === FFMPEG_REASON ? 'needs FFmpeg' : `can’t be made as ${label} here`, blocked: true }); plan.blocked = plan.blocked || why; return; }
    if (it && it.still && FORMATS[to] && FORMATS[to].category === 'video') { plan.skip.push({ i, reason: 'isn’t animated', still: true }); return; }
    plan.convert.push(i);
  });
  return plan;
}

/**
 * Names for a batch that makes one result per file (QA round 8): files whose results would land in the same folder
 * under the same name ("sample.heic" and "sample.png" → JPEG) are told apart by their own format — "sample (HEIC)",
 * "sample (PNG)" — rather than numbered in the order they happen to finish. items: [{stem, dir, label, ext}] (ext:
 * the file's own extension, used when two of them share a format label) → stems, in the same order.
 */
function batchStems(items) {
  const fold = (t) => String(t || '').normalize('NFC').toLowerCase();
  const key = (it) => `${fold(it.dir)}\n${fold(it.stem)}`;
  const groups = new Map();
  items.forEach((it, i) => { const k = key(it); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const out = items.map((it) => it.stem);
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const labels = idx.map((i) => items[i].label || String(items[i].ext || '').toUpperCase());
    idx.forEach((i, k) => {
      const own = labels[k];
      const tag = labels.filter((l) => fold(l) === fold(own)).length > 1 && items[i].ext ? String(items[i].ext).toUpperCase() : own;
      if (tag) out[i] = `${items[i].stem} (${tag})`;
    });
  }
  return out;
}

const list3 = (names) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);
/**
 * Words for the files a conversion leaves out: "3 already JPEG, left as they are · 1 skipped: notes.txt can’t become
 * JPEG". `names[i]` is file i's name. Empty when every file converts.
 */
function skipNote(plan, names, to) {
  const label = (formatInfo(to) || {}).label || String(to).toUpperCase();
  const parts = [];
  if (plan.same.length) parts.push(`${plan.same.length} already ${label}, left as ${plan.same.length === 1 ? 'it is' : 'they are'}`);
  const byReason = new Map();
  for (const s of plan.skip) { if (!byReason.has(s.reason)) byReason.set(s.reason, []); byReason.get(s.reason).push(names[s.i] || 'a file'); }
  if (byReason.size) {
    const n = plan.skip.length;
    parts.push(`${n} skipped: ` + [...byReason].map(([why, list]) => `${list3(list)} ${list.length > 1 ? why.replace(/^isn’t/, 'aren’t').replace(/^needs/, 'need') : why}`).join('; '));
  }
  return parts.join(' · ');
}

/**
 * Targets for a selection: every format at least one of the files converts to (a union, not only the formats all
 * share): [{id, label, available, reason?}] — with several files also {count (files that convert), total, same,
 * hint ("24 of 26")}. A format offered only to files already in it isn't listed. `items` as for planTarget.
 */
function targetsFor(items, caps = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const out = [];
  for (const to of TARGET_ORDER) {
    const plan = planTarget(list, to, caps);
    const label = formatInfo(to).label;
    const n = plan.convert.length;
    // Only still GIFs could go (to a video): listed but dimmed, saying why.
    const still = plan.skip.filter((s) => s.still).length;
    const why = plan.blocked || (still ? (list.length === 1 ? 'This GIF isn’t animated, so there is no video to make' : still === 1 ? 'This GIF isn’t animated, so there is no video to make' : 'These GIFs aren’t animated, so there is no video to make') : null);
    if (!n && !why) continue;
    const t = n ? { id: to, label, available: true } : { id: to, label, available: false, reason: why };
    if (list.length > 1) {
      Object.assign(t, { count: n, total: list.length, same: plan.same.length, hint: n && n < list.length ? `${n} of ${list.length}` : '' });
      const names = list.map((x) => x && typeof x === 'object' && x.name);
      if (n && names.every(Boolean)) { const note = skipNote(plan, names, to); if (note) t.note = note; }
    }
    out.push(t);
  }
  return out;
}

/** How many from → to conversions can run with these capabilities. */
function totalRoutes(caps = {}) {
  let n = 0;
  for (const [from, tos] of Object.entries(ROUTES)) for (const to of Object.keys(tos)) if (blocked(routeEngine(from, to), caps) === null) n++;
  return n;
}

// ------------------------------------------------------------------ tools
// `cats` lists what a tool takes: categories, format ids, or 'still' (images that aren't GIF animations).
// `ffmpegFor`: categories for which a tool needs FFmpeg (media tools need it for everything).
const KINDS = { still: [...STILL, 'svg'], image: idsIn('image'), video: VIDEO, audio: AUDIO };
const tool = (id, title, icon, group, arity, cats, extra = {}) => ({ id, title, icon, group, arity, cats, ...extra });
const TOOLS = [
  tool('photoAdjust', 'Adjust photo', 'sliders-horizontal', 'image', 'any', ['still']),
  tool('photoBackdrop', 'Background & frame', 'frame', 'image', 'single', ['still']),
  tool('photoCrop', 'Crop & straighten', 'crop', 'image', 'single', ['still']),
  tool('photoRedact', 'Hide details', 'eye-off', 'image', 'single', ['still']),
  tool('photoResize', 'Resize', 'scaling', 'image', 'any', ['still']),
  tool('photoRotate', 'Rotate & flip', 'rotate-cw', 'image', 'any', ['still']),
  tool('imagesToPdf', 'Images to PDF', 'file-plus-2', 'image', 'any', ['image']),
  tool('photoCollage', 'Collage', 'layout-grid', 'image', 'multiple', ['still']),
  tool('readQR', 'Read QR code', 'qr-code', 'image', 'single', ['still']),
  tool('videoTrim', 'Trim video', 'scissors', 'video', 'single', ['video']),
  tool('videoReframe', 'Crop & reframe', 'crop', 'video', 'single', ['video']),
  tool('videoSpeed', 'Change speed', 'gauge', 'video', 'single', ['video']),
  tool('videoSplit', 'Cut into parts', 'columns-2', 'video', 'single', ['video']),
  tool('videoMerge', 'Combine videos', 'link-2', 'video', 'multiple', ['video']),
  tool('videoFrames', 'Save frames', 'camera', 'video', 'single', ['video']),
  tool('videoBlur', 'Blur areas', 'video-off', 'video', 'single', ['video']),
  tool('videoGif', 'GIF & sticker', 'image-play', 'video', 'single', ['video']),
  tool('audioTrim', 'Trim audio', 'scissors', 'audio', 'single', ['audio', 'video']), // on a video: the picture is kept (QA round 7)
  tool('audioLevel', 'Even out volume', 'audio-waveform', 'audio', 'any', ['audio', 'video']),
  tool('audioStereo', 'Stereo & mono', 'headphones', 'audio', 'single', ['audio', 'video']),
  tool('audioBeep', 'Beep out parts', 'volume-x', 'audio', 'single', ['audio', 'video']),
  tool('audioVideo', 'Audio to video', 'audio-lines', 'audio', 'single', ['audio']),
  tool('audioClean', 'Reduce noise', 'sparkles', 'audio', 'any', ['audio', 'video']),
  tool('pdfMerge', 'Combine PDFs', 'layers', 'pdf', 'multiple', ['pdf']),
  tool('pdfSplit', 'Split PDF', 'file-stack', 'pdf', 'single', ['pdf']),
  tool('pdfPages', 'Arrange pages', 'layout-list', 'pdf', 'single', ['pdf']),
  tool('pdfShrink', 'Shrink PDF', 'file-minus', 'pdf', 'any', ['pdf']),
  tool('pdfNumbers', 'Page numbers', 'list-ordered', 'pdf', 'any', ['pdf']),
  tool('pdfWatermark', 'Watermark', 'stamp', 'pdf', 'any', ['pdf']),
  tool('analyzeStatement', 'Analyze bank statement', 'chart-pie', 'money', 'any', ['pdf', 'csv', 'xlsx', 'xls']),
  // Make smaller works on images and PDFs without FFmpeg; its window explains which files need it.
  // `nothingFor`: formats the tool only skips; it is dimmed, with the reason, when every chosen file is one of them.
  tool('shrink', 'Make smaller', 'shrink', 'any', 'any', ['image', 'video', 'audio', 'pdf'], { ffmpegFor: ['video', 'audio'], ffmpegPartial: true, nothingFor: { ico: 'Icons are already small, so Make smaller has nothing to do.' } }),
  tool('fileInfo', 'Info & privacy', 'tag', 'any', 'single', ['image', 'video', 'audio', 'pdf'], { ffmpegFor: ['video', 'audio'] }),
];
for (const t of TOOLS) t.formats = new Set(t.cats.flatMap((c) => KINDS[c] || [c]));
const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const MEDIA_TOOLS = new Set(TOOLS.filter((t) => t.group === 'video' || t.group === 'audio').map((t) => t.id));

const ARITY = { single: (n) => n === 1, multiple: (n) => n >= 2, any: (n) => n >= 1 };

/** Does the tool take exactly this selection (formats and number of files)? */
function toolApplies(toolOrId, formatIds) {
  const t = typeof toolOrId === 'string' ? TOOL_BY_ID[toolOrId] : toolOrId;
  return !!t && Array.isArray(formatIds) && ARITY[t.arity](formatIds.length) && formatIds.every((f) => t.formats.has(f));
}

function needsFfmpeg(t, formatIds) {
  if (MEDIA_TOOLS.has(t.id)) return true;
  const media = (f) => (t.ffmpegFor || []).includes(FORMATS[f] && FORMATS[f].category);
  // `ffmpegPartial`: the tool still runs on the files that don't need FFmpeg (only an all-media selection is blocked).
  return t.ffmpegPartial ? formatIds.length > 0 && formatIds.every(media) : formatIds.some(media);
}

/** Tools for a selection: [{id, label, icon, group, available, reason}]. */
function toolsFor(formatIds, caps = {}) {
  return TOOLS.filter((t) => toolApplies(t, formatIds)).map((t) => {
    const missing = needsFfmpeg(t, formatIds) && !caps.ffmpeg;
    const nothing = t.nothingFor && formatIds.every((f) => t.nothingFor[f]) ? t.nothingFor[formatIds[0]] : null;
    return { id: t.id, label: t.title, icon: t.icon, group: t.group, available: !missing && !nothing, reason: nothing || (missing ? FFMPEG_REASON : null) };
  });
}

// ------------------------------------------------------------------ file actions (implemented in operations.js)
// `only`: the extensions an action takes (lower case), `single`: one file at a time. Other actions take any files.
// `window`: the action opens a window first (Rename… shows its plan before anything changes).
const ACTIONS = [
  { id: 'reveal', title: 'Show in folder', icon: 'folder-open' },
  { id: 'copyFiles', title: 'Copy files', icon: 'copy' },
  { id: 'copyPaths', title: 'Copy paths', icon: 'clipboard-copy' },
  { id: 'duplicate', title: 'Duplicate', icon: 'files' },
  { id: 'sha256', title: 'SHA-256', icon: 'hash' },
  { id: 'copyTo', title: 'Copy to…', icon: 'folder-input' },
  { id: 'moveTo', title: 'Move to…', icon: 'folder-output' },
  { id: 'nearby', title: 'Send to nearby', icon: 'radar' },
  { id: 'rename', title: 'Rename…', icon: 'text-cursor-input', window: true },
  { id: 'zip', title: 'Zip', icon: 'file-archive' },
  { id: 'unzip', title: 'Unzip', icon: 'package-open', only: ['zip'], single: true },
];

const extOf = (name) => { const s = String(name || ''); const dot = s.lastIndexOf('.'); return dot > 0 ? s.slice(dot + 1).toLowerCase() : ''; };
/** Does a file action take these files ([{name}])? */
function actionApplies(actionOrId, files) {
  const a = typeof actionOrId === 'string' ? ACTIONS.find((x) => x.id === actionOrId) : actionOrId;
  if (!a || !Array.isArray(files) || !files.length) return false;
  if (a.single && files.length !== 1) return false;
  return !a.only || files.every((f) => a.only.includes(extOf(f && f.name)));
}
/** The file actions for a selection, in catalogue order. */
const actionsFor = (files) => ACTIONS.filter((a) => actionApplies(a, files));

module.exports = {
  FORMATS, OUTPUT_FORMATS, formatInfo, CATEGORIES, detect, baseName, safeStem, candidateName, fitName, cutStem, SHORTENED,
  routeEngine, targetsFor, planTarget, skipNote, batchStems, totalRoutes, NEEDS_FFMPEG, TARGET_ORDER,
  TOOLS, TOOL_BY_ID, MEDIA_TOOLS, toolApplies, toolsFor, ACTIONS, actionApplies, actionsFor,
};

export default module.exports;
