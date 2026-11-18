// The video and audio tools' worker: reads, changes and writes video and audio files in the browser, with Mediabunny
// (MPL-2.0, /tools/engine/media/) driving the browser's own decoders and encoders (WebCodecs). The MP3, AAC and FLAC
// encoders are WebAssembly extensions loaded only when a file needs them (AAC only where the browser has none).
// Files arrive as File objects and are read a slice at a time; results are written in chunks into a Blob, so a large
// video is never held in one piece. The page cancels a job by stopping this worker.
//
// Messages: page → {dd: 2, id, op, args}; worker → {dd: 2, id, progress, note?} while working, then
// {dd: 2, id, ok: true, result} or {dd: 2, id, ok: false, error: {message, user, code}}.
import * as MB from '../media/mediabunny.js';
import { GIFEncoder, quantize, applyPalette } from '../processor/vendor/gifenc.esm.js';
import { gifLadder, nextGifStep, describeGifStep, outputFps } from '../shared/videotools.mjs';
import { fitFades, fadeGain, toByte } from '../shared/audiotools.mjs';

class UserError extends Error { constructor(m, code) { super(m); this.user = true; this.code = code || ''; } }
const post = (m) => self.postMessage({ dd: 2, ...m });
const open = (file) => new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });

const VIDEO_NAMES = { avc: 'H.264', hevc: 'HEVC (H.265)', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', prores: 'ProRes' };
const AUDIO_NAMES = { aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', ulaw: 'G.711', alaw: 'G.711' };
const codecName = (c, video) => (!c ? 'unknown' : video ? VIDEO_NAMES[c] || c.toUpperCase() : AUDIO_NAMES[c] || (/^pcm/.test(c) ? 'PCM' : c.toUpperCase()));

// ------------------------------------------------------------------ what this browser can do
let capsCache = null;
async function caps() {
  if (capsCache) return capsCache;
  const venc = typeof VideoEncoder !== 'undefined', aenc = typeof AudioEncoder !== 'undefined';
  const video = {};
  for (const c of ['avc', 'vp9', 'vp8', 'av1', 'hevc']) {
    video[c] = venc ? await MB.canEncodeVideo(c, { width: 1280, height: 720, bitrate: 2e6 }).catch(() => false) : false;
  }
  const native = {};
  for (const c of ['aac', 'opus', 'mp3', 'flac']) native[c] = aenc ? await MB.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 }).catch(() => false) : false;
  let webp = false;
  try { const c = new OffscreenCanvas(8, 8); c.getContext('2d').fillRect(0, 0, 4, 4); webp = (await c.convertToBlob({ type: 'image/webp', quality: 0.8 })).type === 'image/webp'; } catch { webp = false; }
  const wasm = typeof WebAssembly === 'object' && typeof Worker !== 'undefined';
  capsCache = {
    videoDecode: typeof VideoDecoder !== 'undefined', audioDecode: typeof AudioDecoder !== 'undefined', videoEncode: venc, audioEncode: aenc,
    video, aacNative: native.aac, opusNative: native.opus,
    // What a tool can save: AAC, MP3 and FLAC have WebAssembly encoders when the browser has none.
    audio: { aac: native.aac || wasm, mp3: native.mp3 || wasm, flac: native.flac || wasm, opus: native.opus, pcm: true },
    webp,
  };
  return capsCache;
}

/** Load an encoder extension when the browser has no encoder of its own for this codec. */
const extensions = {};
async function needEncoder(codec) {
  if (!['aac', 'mp3', 'flac'].includes(codec)) return;
  const c = await caps();
  if (codec === 'aac' && c.aacNative) return;
  extensions[codec] ||= (async () => {
    if (codec !== 'aac' && await MB.canEncodeAudio(codec).catch(() => false)) return;
    const m = await import(`../media/${codec}-encoder.js`);
    ({ aac: m.registerAacEncoder, mp3: m.registerMp3Encoder, flac: m.registerFlacEncoder })[codec]();
  })();
  return extensions[codec];
}

// ------------------------------------------------------------------ reading a file
async function tracksOf(input) {
  let format;
  try { format = await input.getFormat(); } catch (e) {
    throw new UserError('This file can’t be read here. It may be damaged, or a kind of file this browser can’t open.', 'unreadable');
  }
  const v = await input.getPrimaryVideoTrack().catch(() => null);
  const a = await input.getPrimaryAudioTrack().catch(() => null);
  return { format, v, a };
}

async function probe({ file }) {
  const input = open(file);
  try {
    const { format, v, a } = await tracksOf(input);
    if (!v && !a) throw new UserError('No video or sound was found in this file. It may be damaged.', 'empty');
    const duration = await input.computeDuration().catch(() => 0);
    const out = { container: format.name, mime: await input.getMimeType().catch(() => ''), duration, size: file.size, video: null, audio: null };
    if (v) {
      const fr = await v.computeFrameRateMetrics({ targetPacketCount: 120 }).catch(() => null);
      const bitrate = await v.getAverageBitrate().catch(() => null) || (await v.computePacketStats(240).catch(() => ({}))).averageBitrate || 0;
      out.video = {
        codec: v.codec, name: codecName(v.codec, true), width: v.displayWidth, height: v.displayHeight, codedWidth: v.codedWidth, codedHeight: v.codedHeight,
        rotation: v.rotation, fps: fr ? Math.round(fr.bestGuessFrameRate * 1000) / 1000 : 0, bitrate, canDecode: await v.canDecode().catch(() => false),
      };
      if (await v.hasOnlyKeyPackets().catch(() => false) && duration < 0.05) out.still = true;
    }
    if (a) {
      const bitrate = await a.getAverageBitrate().catch(() => null) || (await a.computePacketStats(200).catch(() => ({}))).averageBitrate || 0;
      out.audio = { codec: a.codec, name: codecName(a.codec, false), sampleRate: a.sampleRate, channels: a.numberOfChannels, bitrate, canDecode: await a.canDecode().catch(() => false) };
    }
    return out;
  } finally { input.dispose(); }
}

/** One picture from the video at time t, `width` pixels wide (as shown: turned the way the video plays). */
async function frame({ file, t = 0, width = 320, type = 'image/jpeg' }) {
  const input = open(file);
  try {
    const { v } = await tracksOf(input);
    if (!v || !(await v.canDecode())) return { blob: null };
    const w = Math.max(16, Math.round(Math.min(width, v.displayWidth) / 2) * 2);
    const h = Math.max(16, Math.round((w * v.displayHeight) / v.displayWidth / 2) * 2);
    const sink = new MB.CanvasSink(v, { width: w, height: h, fit: 'fill', poolSize: 1 });
    const first = await v.getFirstTimestamp().catch(() => 0);
    const got = await sink.getCanvas(Math.max(first, t));
    if (!got) return { blob: null };
    const blob = await got.canvas.convertToBlob({ type, quality: 0.82 });
    return { blob, width: w, height: h, t: got.timestamp };
  } finally { input.dispose(); }
}

/** `count` small pictures spread over the video (a filmstrip for the trim timeline): {blobs, width, height}. */
async function strip({ file, count = 8, height = 72 }) {
  const input = open(file);
  try {
    const { v } = await tracksOf(input);
    if (!v || !(await v.canDecode())) return { blobs: [] };
    const duration = await input.computeDuration([v]).catch(() => 0);
    const h = Math.max(16, Math.round(height / 2) * 2), w = Math.max(16, Math.round((h * v.displayWidth) / v.displayHeight / 2) * 2);
    const sink = new MB.CanvasSink(v, { width: w, height: h, fit: 'fill', poolSize: 1 });
    const first = await v.getFirstTimestamp().catch(() => 0);
    const times = Array.from({ length: count }, (_, i) => first + ((i + 0.5) * Math.max(0, duration - first)) / count);
    const blobs = [];
    for await (const c of sink.canvasesAtTimestamps(times)) blobs.push(c ? await c.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }) : null);
    return { blobs, width: w, height: h };
  } finally { input.dispose(); }
}

/**
 * The sound's waveform, in the app's format (src/shared/audiotools.mjs): {rate (buckets per second), duration,
 * channels (1 or 2), peak: [Uint8Array per channel], rms: [Uint8Array per channel]}, square-root scaled bytes.
 */
async function peaks({ file, id }) {
  const input = open(file);
  try {
    const { a } = await tracksOf(input);
    if (!a) throw new UserError('This file has no sound.', 'no-audio');
    if (!(await a.canDecode())) throw cantDecode(a, false);
    const duration = await input.computeDuration([a]).catch(() => 0) || 1;
    const rate = duration > 1800 ? 10 : duration > 300 ? 25 : 100;
    const n = Math.ceil(duration * rate) + 2;
    const ch = Math.min(2, a.numberOfChannels || 1);
    const peak = [...Array(ch)].map(() => new Float32Array(n)), sum = [...Array(ch)].map(() => new Float64Array(n)), count = new Float64Array(n);
    let buf = new Float32Array(0), last = 0;
    for await (const s of new MB.AudioSampleSink(a).samples()) {
      const frames = s.numberOfFrames, sr = s.sampleRate;
      if (buf.length < frames) buf = new Float32Array(frames);
      for (let c = 0; c < ch; c++) {
        s.copyTo(buf, { planeIndex: Math.min(c, s.numberOfChannels - 1), format: 'f32-planar', frameCount: frames });
        const t0 = s.timestamp;
        for (let i = 0; i < frames; i++) {
          const k = Math.min(n - 1, Math.max(0, Math.floor((t0 + i / sr) * rate)));
          const x = Math.abs(buf[i]);
          if (x > peak[c][k]) peak[c][k] = x;
          sum[c][k] += x * x;
          if (c === 0) count[k]++;
        }
      }
      const done = (s.timestamp + s.duration) / duration;
      s.close();
      if (done - last > 0.02) { last = done; post({ id, progress: Math.min(1, done) }); }
    }
    const bytes = (f) => { const o = new Uint8Array(n); for (let k = 0; k < n; k++) o[k] = toByte(f(k)); return o; };
    return { rate, duration, channels: ch, peak: peak.map((p) => bytes((k) => p[k])), rms: sum.map((s) => bytes((k) => (count[k] ? Math.sqrt(s[k] / count[k]) : 0))) };
  } finally { input.dispose(); }
}

function cantDecode(track, video) {
  const what = codecName(track.codec, video);
  if (video && typeof VideoDecoder === 'undefined') return new UserError('Changing videos needs a newer browser: Safari 16.4 or later, Chrome or Edge 94 or later, or Firefox 130 or later. Update it, or use the DropDial app.', 'decode');
  return new UserError(video
    ? `This browser can’t play ${what} video, so it can’t change this file. Try Chrome or Edge, or the DropDial app.`
    : `This browser can’t read ${what} sound${typeof AudioDecoder === 'undefined' ? ' (it needs Safari 26, Chrome, Edge or Firefox)' : ''}. Try another browser, or the DropDial app.`, 'decode');
}

// ------------------------------------------------------------------ writing: chunks into a Blob
/**
 * A StreamTarget's writes collected into a Blob. Writes come mostly in order; the few that go back (the MP4 index
 * written into the space kept for it at the start, sizes in headers) patch the parts already written. Parts that are
 * no longer near the end or the start become Blobs at once, so the browser can keep them out of the page's memory.
 */
class Collector {
  constructor() { this.parts = []; this.size = 0; }
  writable() { return new WritableStream({ write: (c) => this.write(c.data, c.position) }); }
  write(data, pos) {
    if (pos > this.size) this.append(new Uint8Array(pos - this.size));
    let off = 0;
    if (pos < this.size) {
      const upto = Math.min(this.size, pos + data.length);
      for (const p of this.parts) {
        if (p.pos + p.size <= pos || p.pos >= upto) continue;
        if (p.blob) { p.data = new Uint8Array(new FileReaderSync().readAsArrayBuffer(p.blob)); p.blob = null; }
        const a = Math.max(pos, p.pos), b = Math.min(upto, p.pos + p.size);
        p.data.set(data.subarray(a - pos, b - pos), a - p.pos);
      }
      off = upto - pos;
    }
    if (off < data.length) this.append(data.slice(off));
  }
  append(d) {
    this.parts.push({ pos: this.size, size: d.length, data: d, blob: null });
    this.size += d.length;
    // Keep the first part and the last two writable; the rest become Blobs.
    for (let i = 1; i < this.parts.length - 2; i++) { const p = this.parts[i]; if (p.data) { p.blob = new Blob([p.data]); p.data = null; } }
  }
  blob(type) { return new Blob(this.parts.map((p) => p.blob || p.data), { type }); }
}

const OUTPUTS = {
  mp4: () => new MB.Mp4OutputFormat({ fastStart: 'reserve' }),
  m4a: () => new MB.Mp4OutputFormat({ fastStart: 'reserve' }),
  mov: () => new MB.MovOutputFormat({ fastStart: 'reserve' }),
  webm: () => new MB.WebMOutputFormat(),
  mkv: () => new MB.MkvOutputFormat(),
  mp3: () => new MB.Mp3OutputFormat(),
  wav: () => new MB.WavOutputFormat(),
  ogg: () => new MB.OggOutputFormat(),
  opus: () => new MB.OggOutputFormat(),
  flac: () => new MB.FlacOutputFormat(),
};
const MIME = { mp4: 'video/mp4', m4a: 'audio/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', gif: 'image/gif', webp: 'image/webp' };
const AUDIO_ONLY = new Set(['m4a', 'mp3', 'wav', 'ogg', 'opus', 'flac']);

function newOutput(to) {
  const make = OUTPUTS[to];
  if (!make) throw new Error('Unknown output ' + to);
  const col = new Collector();
  const output = new MB.Output({ format: make(), target: new MB.StreamTarget(col.writable(), { chunked: true, chunkSize: 4 * 1024 * 1024 }) });
  return { output, col };
}

const REASONS = {
  undecodable_source_codec: (t) => cantDecode(t, t.isVideoTrack()),
  no_encodable_target_codec: (t) => new UserError(t.isVideoTrack()
    ? 'This browser can’t make this kind of video. Try MP4, or another browser.'
    : 'This browser can’t make this kind of sound. Try another format, or another browser.', 'encode'),
  unknown_source_codec: (t) => new UserError(`This file’s ${t.isVideoTrack() ? 'picture' : 'sound'} is in a format DropDial’s web tools don’t know.`, 'unknown'),
};

/** A Quality from a bitrate in bits per second (or a level name). */
const quality = (q) => (q == null ? undefined : new MB.Quality(typeof q === 'number' ? { bitrate: Math.max(8000, Math.round(q)) } : q));

/**
 * Convert, trim, make smaller, mute, extract the sound, change speed: one Conversion.
 * args: {file, to, video: {discard, codec, bitrate, width, height, fps, keyFrames, transcode} | null,
 *        audio: {discard, codec, bitrate, sampleRate, channels, transcode, fades: {in, out}, sampleFormat},
 *        trim: {start, end}, exact (always re-encode), fast (copy, starting at the keyframe before the start),
 *        speed (0.25–4: picture retimed, sound stretched with its pitch kept)}
 */
async function convert(args) {
  const { file, to, id } = args;
  const input = open(file);
  try {
    const { v, a } = await tracksOf(input);
    const wantVideo = !!v && !AUDIO_ONLY.has(to) && !(args.video && args.video.discard);
    const wantAudio = !!a && !(args.audio && args.audio.discard);
    if (!wantVideo && !wantAudio) throw new UserError(AUDIO_ONLY.has(to) ? 'This file has no sound to save.' : 'There is nothing left to save.', 'empty');
    if (args.needVideo && !v) throw new UserError('This file has no picture. Choose a video.', 'no-video');
    const vo = args.video || {}, ao = args.audio || {};
    if (wantAudio && ao.codec) await needEncoder(ao.codec);
    const { output, col } = newOutput(to);
    const speed = args.speed && Math.abs(args.speed - 1) > 1e-3 ? args.speed : 0;
    const duration = await input.computeDuration().catch(() => 0);
    const start = args.trim ? Math.max(0, args.trim.start || 0) : 0;
    const end = args.trim && args.trim.end ? args.trim.end : duration;
    const video = !wantVideo ? { discard: true } : {
      codec: vo.codec, quality: quality(vo.bitrate), width: vo.width, height: vo.height, fit: vo.width && vo.height ? 'contain' : undefined,
      frameRate: vo.fps, keyFrameInterval: vo.keyFrames, forceTranscode: !!vo.transcode || !!speed || undefined,
    };
    // A browser that can't decode the sound (Safari before 26 has no AudioDecoder) can still copy it as it is.
    const copySound = wantAudio && !(await a.canDecode().catch(() => false)) && !AUDIO_ONLY.has(to);
    if (copySound && (speed || (ao.fades && (ao.fades.in || ao.fades.out)))) throw cantDecode(a, false);
    if (copySound && args.exact) video.forceTranscode = true;
    const audio = !wantAudio ? { discard: true } : copySound ? {} : {
      codec: ao.codec, quality: quality(ao.bitrate), sampleRate: ao.sampleRate, numberOfChannels: ao.channels, sampleFormat: ao.sampleFormat,
      forceTranscode: !!ao.transcode || !!speed || !!(ao.fades && (ao.fades.in || ao.fades.out)) || undefined,
    };
    // Fades (Trim audio): the gain at each moment of the part kept (the app's linear ramps, src/shared/audiotools.mjs).
    if (wantAudio && ao.fades && (ao.fades.in > 0 || ao.fades.out > 0)) {
      const len = end - start, f = fitFades(ao.fades.in, ao.fades.out, len);
      audio.process = (s) => gainSample(s, (t) => fadeGain(t, len, f));
    }
    if (speed && wantAudio) Object.assign(audio, speedAudio(speed));
    if (speed) {
      const fps = outputFps((await v.computeFrameRateMetrics({ targetPacketCount: 120 }).catch(() => null) || {}).bestGuessFrameRate || 0);
      Object.assign(video, speedVideo(speed, fps, (end - start) / speed));
      if (wantAudio) audio.maximumPacketCount = Math.ceil(((end - start) / speed) * (a.sampleRate / 900) * 1.2) + 64;
    }
    const conv = await MB.Conversion.init({
      input, output, tracks: 'primary', video, audio,
      trim: args.trim ? { start, end } : undefined,
      copy: (args.exact && !copySound) || speed ? false : args.fast ? { boundaryPolicy: 'expand' } : {},
      showWarnings: false,
    });
    for (const d of conv.discardedTracks) {
      if (d.reason === 'discarded_by_user' || d.reason === 'max_track_count_reached' || d.reason === 'max_track_count_of_type_reached') continue;
      if ((d.track === v && wantVideo) || (d.track === a && wantAudio) || !conv.isValid) throw (REASONS[d.reason] || (() => new UserError('This file can’t be changed in this browser.', d.reason)))(d.track);
    }
    if (!conv.isValid) throw new UserError('This file can’t be changed in this browser.', 'invalid');
    let last = 0;
    conv.onProgress = (p) => { if (p - last >= 0.005 || p === 1) { last = p; post({ id, progress: p }); } };
    await conv.execute();
    const blob = col.blob(MIME[to]);
    const out = await probe({ file: blob }).catch(() => null);
    return { blob, out };
  } finally { input.dispose(); }
}

/** A copy of an audio sample with every frame multiplied by gain(t), t in seconds from the output's start. */
function gainSample(s, gain) {
  const n = s.numberOfFrames, ch = s.numberOfChannels, sr = s.sampleRate;
  const data = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) s.copyTo(data.subarray(c * n, (c + 1) * n), { planeIndex: c, format: 'f32-planar' });
  for (let i = 0; i < n; i++) {
    const g = gain(s.timestamp + i / sr);
    if (g !== 1) for (let c = 0; c < ch; c++) data[c * n + i] *= g;
  }
  const out = new MB.AudioSample({ data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: s.timestamp });
  s.close();
  return out;
}

// ------------------------------------------------------------------ Change speed
/** The picture retimed: faster drops frames, slower repeats them, so the result plays at the source's rate (≤ 60). */
function speedVideo(speed, fps, length) {
  const step = 1 / fps;
  let next = 0;
  return {
    forceTranscode: true,
    maximumPacketCount: Math.ceil(length * fps * 1.15) + 64,
    process: (s) => {
      const t0 = s.timestamp / speed, t1 = (s.timestamp + (s.duration || step * speed)) / speed;
      const out = [];
      while (next < t1 - 1e-6) {
        if (next >= t0 - step / 2 || !out.length) out.push(new MB.VideoSample(s.toVideoFrame(), { timestamp: Math.max(next, 0), duration: step }));
        next += step;
        if (out.length > 16) break;
      }
      s.close();
      return out.length ? out : null;
    },
  };
}

/**
 * The sound made faster or slower with its pitch kept: WSOLA (overlapping 40 ms pieces of the sound, each placed
 * where it continues the last one best). The search runs on a quarter-rate mono copy and is then refined, so it
 * stays fast. Streams: each sample in gives the finished sound so far.
 */
function speedAudio(speed) {
  let st = null;
  return {
    forceTranscode: true,
    process: (s) => {
      const sr = s.sampleRate, ch = s.numberOfChannels, n = s.numberOfFrames;
      if (!st) st = wsola(sr, ch, speed);
      const planes = [];
      for (let c = 0; c < ch; c++) { const p = new Float32Array(n); s.copyTo(p, { planeIndex: c, format: 'f32-planar' }); planes.push(p); }
      s.close();
      const out = st.push(planes);
      if (!out || !out[0].length) return null;
      const m = out[0].length, data = new Float32Array(m * ch);
      for (let c = 0; c < ch; c++) data.set(out[c], c * m);
      const sample = new MB.AudioSample({ data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: st.written / sr });
      st.written += m;
      return sample;
    },
  };
}

function wsola(sr, ch, speed) {
  const N = Math.round(sr * 0.04) & ~1, Hs = N / 2, Ha = Hs * speed, D = Math.round(sr * 0.012), Q = 4;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // Hann: halves overlap-add to 1
  let buf = [...Array(ch)].map(() => new Float32Array(0)), base = 0; // buf[c][i] is input sample base + i
  let acc = [...Array(ch)].map(() => new Float32Array(N)); // overlap-add of the frame being finished
  let k = 0, prev = -1; // synthesis frame number; where the last frame was taken from
  const st = { written: 0 };
  const mono = (at, len, step) => { const out = new Float32Array(Math.ceil(len / step)); for (let i = 0, j = 0; i < len; i += step, j++) { let v = 0; for (let c = 0; c < ch; c++) v += buf[c][at - base + i] || 0; out[j] = v; } return out; };
  const score = (a, b) => { let s = 0, ea = 1e-9, eb = 1e-9; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; ea += a[i] * a[i]; eb += b[i] * b[i]; } return s / Math.sqrt(ea * eb); };
  st.push = (planes) => {
    const add = planes[0].length;
    buf = buf.map((b, c) => { const x = new Float32Array(b.length + add); x.set(b); x.set(planes[c], b.length); return x; });
    const out = [...Array(ch)].map(() => []);
    for (;;) {
      const nominal = Math.round(k * Ha);
      if (nominal + D + N > base + buf[0].length) break;
      let pos = nominal;
      if (prev >= 0) {
        // The natural continuation of the last piece, matched against candidates around the nominal place.
        const want = prev + Hs, target = mono(want, N, Q);
        const lo = Math.max(base, nominal - D), hi = nominal + D;
        let best = -2, at = nominal;
        for (let p = lo; p <= hi; p += Q) { const sc = score(target, mono(p, N, Q)); if (sc > best) { best = sc; at = p; } }
        const fine = mono(want, N, 1);
        for (let p = Math.max(lo, at - Q); p <= Math.min(hi, at + Q); p++) { const sc = score(fine, mono(p, N, 1)); if (sc > best) { best = sc; at = p; } }
        pos = at;
      }
      for (let c = 0; c < ch; c++) {
        const b = buf[c], a = acc[c], o = pos - base;
        for (let i = 0; i < N; i++) a[i] += (b[o + i] || 0) * win[i];
        out[c].push(a.slice(0, Hs));
        const next = new Float32Array(N); next.set(a.subarray(Hs)); acc[c] = next;
      }
      prev = pos; k++;
      // Forget what no frame can reach again.
      const keep = Math.min(prev, Math.round(k * Ha) - D) - base;
      if (keep > sr) { buf = buf.map((b) => b.slice(keep)); base += keep; }
    }
    return out.map((parts) => { const len = parts.reduce((x, p) => x + p.length, 0), r = new Float32Array(len); let o = 0; for (const p of parts) { r.set(p, o); o += p.length; } return r; });
  };
  return st;
}

// ------------------------------------------------------------------ GIF and animated WebP
/** Frames of [start, end) at `fps`, `w` × `h`, as canvases (shown the way the video plays). */
async function* framesOf(v, start, end, step) {
  const times = [];
  for (let t = start; t < end - 1e-6; t = start + times.length / step.fps) times.push(t);
  const sink = new MB.CanvasSink(v, { width: step.w, height: step.h, fit: 'fill', poolSize: 2 });
  let i = 0;
  for await (const c of sink.canvasesAtTimestamps(times)) { yield { canvas: c && c.canvas, i, n: times.length }; i++; }
}

async function gif(args) {
  const { file, id, start, end, format = 'gif', loop = true } = args;
  const input = open(file);
  try {
    const { v } = await tracksOf(input);
    if (!v) throw new UserError('This file has no picture. Choose a video.', 'no-video');
    if (!(await v.canDecode())) throw cantDecode(v, true);
    const ladder = args.limit ? gifLadder({ fps: args.fps, w: args.w, h: args.h, format, quality: args.quality || 75 }) : [{ fps: args.fps, w: args.w, h: args.h, ...(format === 'webp' ? { quality: args.quality || 75 } : { colors: 256 }) }];
    let i = 0, best = null, tries = 0;
    for (;;) {
      const step = ladder[i];
      tries++;
      const say = (p) => post({ id, progress: Math.min(0.999, p), note: tries > 1 ? `Trying ${describeGifStep(step)}` : '' });
      const made = format === 'webp' ? await webpOf(v, start, end, step, loop, say) : await gifOf(v, start, end, step, loop, say);
      if (!best || made.blob.size < best.blob.size) best = { ...made, step };
      if (!args.limit) break;
      const j = nextGifStep(ladder, i, made.blob.size, args.limit);
      if (j === i || j < 0 || tries >= 6) break;
      i = j;
    }
    return { blob: best.blob, frames: best.frames, w: best.step.w, h: best.step.h, fps: best.step.fps, used: describeGifStep(best.step), fits: !args.limit || best.blob.size <= args.limit, tries };
  } finally { input.dispose(); }
}

/** GIF: one palette for the whole clip (from frames across it), and only the pixels that change are stored. */
async function gifOf(v, start, end, step, loop, say) {
  const colors = Math.min(256, step.colors || 256);
  // The palette, from up to eight frames spread over the part.
  const sampleStep = { ...step, fps: Math.min(step.fps, 8 / Math.max(0.2, end - start)) };
  const parts = [];
  for await (const f of framesOf(v, start, end, sampleStep)) if (f.canvas) parts.push(f.canvas.getContext('2d').getImageData(0, 0, step.w, step.h).data);
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const palette = quantize(all, colors - 1, { format: 'rgb565' });
  const T = palette.length; // the "unchanged" index, shown as see-through
  palette.push([0, 0, 0]);
  const enc = GIFEncoder();
  let prevIdx = null, frames = 0, clock = 0;
  for await (const f of framesOf(v, start, end, step)) {
    say((f.i + 1) / f.n);
    if (!f.canvas) continue;
    const data = f.canvas.getContext('2d').getImageData(0, 0, step.w, step.h).data;
    const idx = applyPalette(data, palette.slice(0, T), 'rgb565');
    let index = idx, transparent = false;
    if (prevIdx) {
      index = new Uint8Array(idx);
      for (let k = 0; k < idx.length; k++) if (idx[k] === prevIdx[k]) index[k] = T;
      transparent = true;
    }
    // GIF delays are hundredths of a second: kept on time over the whole clip.
    const t1 = Math.round(((f.i + 1) * 100) / step.fps), delay = (t1 - clock) * 10;
    clock = t1;
    enc.writeFrame(index, step.w, step.h, { palette: frames === 0 ? palette : undefined, delay, repeat: frames === 0 ? (loop ? 0 : -1) : undefined, transparent, transparentIndex: T, dispose: 1 });
    prevIdx = idx; frames++;
  }
  if (!frames) throw new UserError('No pictures could be read from this part of the video.', 'no-frames');
  enc.finish();
  return { blob: new Blob([enc.bytes()], { type: 'image/gif' }), frames };
}

/** Animated WebP: each frame made by the browser's WebP encoder, put together in one animated file. */
async function webpOf(v, start, end, step, loop, say) {
  const frames = [];
  let clock = 0;
  for await (const f of framesOf(v, start, end, step)) {
    say((f.i + 1) / f.n);
    if (!f.canvas) continue;
    const b = new Uint8Array(await (await f.canvas.convertToBlob({ type: 'image/webp', quality: (step.quality || 75) / 100 })).arrayBuffer());
    const t1 = Math.round(((f.i + 1) * 1000) / step.fps);
    frames.push({ data: webpFrameChunks(b), ms: t1 - clock });
    clock = t1;
  }
  if (!frames.length) throw new UserError('No pictures could be read from this part of the video.', 'no-frames');
  return { blob: new Blob([animatedWebp(frames, step.w, step.h, loop)], { type: 'image/webp' }), frames: frames.length };
}
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const le32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
/** The ALPH / VP8 / VP8L chunks of a still WebP, as they are. */
function webpFrameChunks(b) {
  if (fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') throw new Error('The browser didn’t make a WebP picture.');
  const out = [];
  for (let o = 12; o + 8 <= b.length;) {
    const id = fourcc(b, o), size = le32(b, o + 4), total = 8 + size + (size & 1);
    if (id === 'ALPH' || id === 'VP8 ' || id === 'VP8L') out.push(b.subarray(o, o + total));
    o += total;
  }
  return out;
}
function animatedWebp(frames, w, h, loop) {
  const u24 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >> 8) & 255; a[o + 2] = (v >> 16) & 255; };
  const chunk = (id, body) => { const c = new Uint8Array(8 + body.length + (body.length & 1)); for (let i = 0; i < 4; i++) c[i] = id.charCodeAt(i); new DataView(c.buffer).setUint32(4, body.length, true); c.set(body, 8); return c; };
  const vp8x = new Uint8Array(10); vp8x[0] = 0x02 | (frames.some((f) => f.data.some((c) => fourcc(c, 0) === 'ALPH' || fourcc(c, 0) === 'VP8L')) ? 0x10 : 0); u24(vp8x, 4, w - 1); u24(vp8x, 7, h - 1);
  const anim = new Uint8Array(6); new DataView(anim.buffer).setUint16(4, loop ? 0 : 1, true);
  const body = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
  for (const f of frames) {
    const len = f.data.reduce((a, c) => a + c.length, 0);
    const head = new Uint8Array(16 + len);
    u24(head, 6, w - 1); u24(head, 9, h - 1); u24(head, 12, Math.max(1, Math.min(0xffffff, f.ms))); head[15] = 0x02; // no blending, no disposal
    let o = 16; for (const c of f.data) { head.set(c, o); o += c.length; }
    body.push(chunk('ANMF', head));
  }
  const size = 4 + body.reduce((a, c) => a + c.length, 0);
  const file = new Uint8Array(8 + size);
  file.set([82, 73, 70, 70]); new DataView(file.buffer).setUint32(4, size, true); file.set([87, 69, 66, 80], 8);
  let o = 12; for (const c of body) { file.set(c, o); o += c.length; }
  return file;
}

// ------------------------------------------------------------------ messages
const OPS = { caps, probe, frame, strip, peaks, convert, gif };
self.addEventListener('message', async (ev) => {
  const m = ev.data;
  if (!m || m.dd !== 2) return;
  try {
    const fn = OPS[m.op];
    if (!fn) throw new Error('Unknown operation ' + m.op);
    const result = await fn({ ...(m.args || {}), id: m.id });
    self.postMessage({ dd: 2, id: m.id, ok: true, result }, result && result.peak ? [...result.peak, ...result.rms].map((x) => x.buffer) : []);
  } catch (e) {
    const memory = /memory|allocation|RangeError|QuotaExceeded/i.test(String(e && (e.name + ' ' + e.message)));
    if (!e || !e.user) console.error(e);
    self.postMessage({ dd: 2, id: m.id, ok: false, error: { message: String((e && e.message) || e).slice(0, 500), user: !!(e && e.user), code: (e && e.code) || (memory ? 'memory' : '') } });
  }
});
self.postMessage({ dd: 2, ready: true });
