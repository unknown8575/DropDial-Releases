// Audio to video in the sandbox: the pictures FFmpeg animates, drawn with the same code the window's preview uses
// (src/shared/audiotools.mjs drawLook). Returns PNG bytes: base (background, title, picture) and, for the waveform
// look, the waveform box not yet played (dim) and played (lit); for bars, the gaps laid over FFmpeg's bars.
import * as A from '../shared/audiotools.mjs';
import { decode, encode } from './image.js';
import { UserError } from './errors.js';

const HEX = /^#[0-9a-f]{6}$/i;

export async function look({ shape, size, look, fg, bg, title, peaks, duration, picture, limits }) {
  if (!A.LOOK_IDS.includes(look) || !HEX.test(fg) || !HEX.test(bg)) throw new UserError('The look of the video is not valid.');
  const layout = A.lookLayout({ shape, size, title });
  let pic = null;
  if (look === 'picture') {
    if (!picture) throw new UserError('Choose a picture for the video.');
    pic = (await decode(picture, limits)).canvas;
  }
  const opts = { layout, look, fg, bg, title: String(title || '').slice(0, A.TITLE_MAX), peaks, duration, picture: pic };
  const draw = async (layer, w, h) => {
    const c = new OffscreenCanvas(w, h);
    A.drawLook(c.getContext('2d'), { ...opts, layer });
    return encode(c, 'png');
  };
  const out = { base: await draw('base', layout.W, layout.H), width: layout.W, height: layout.H };
  if (look === 'wave') {
    out.dim = await draw('dim', layout.vis.w, layout.vis.h);
    out.lit = await draw('lit', layout.vis.w, layout.vis.h);
  } else if (look === 'bars') out.gaps = await draw('gaps', layout.vis.w, layout.vis.h);
  return out;
}
