// Shared behaviour for every page: the nav, the menu, magnetic buttons, in-view classes and the
// video/animation players (they load near the viewport, play only in view and always have a pause button).
export const reduced = matchMedia('(prefers-reduced-motion: reduce)');
export const darkMode = matchMedia('(prefers-color-scheme: dark)');
// Where the site lives: '' or '../' (set by the build on <html data-base>), so it works from any folder.
export const BASE = document.documentElement.dataset.base ?? '/';
const IDX = document.documentElement.dataset.index ?? '';
/** Link to a section folder, e.g. dir('guide') → '../guide/' (or '../guide/index.html' in previews). */
export const dir = (d) => BASE + d + '/' + IDX;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');

const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
export { store };

// ------------------------------------------------------------ nav
const nav = document.getElementById('top-nav');
if (nav) {
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const here = location.pathname.replace(/index\.html$/, '');
  for (const a of nav.querySelectorAll('.nav-links a, .menu-panel a')) {
    const p = new URL(a.href, location.href).pathname;
    if (p !== '/' && here.startsWith(p) && !a.hash) a.setAttribute('aria-current', 'page');
  }
  const btn = nav.querySelector('.menu-btn');
  const panel = document.getElementById('menu-panel');
  const close = (focus) => { btn.setAttribute('aria-expanded', 'false'); panel.classList.remove('open'); if (focus) btn.focus(); };
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('open', open);
    if (open) nav.classList.add('scrolled');
  });
  panel.addEventListener('click', (e) => { if (e.target.closest('a')) close(false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) close(true); });
  document.addEventListener('pointerdown', (e) => { if (panel.classList.contains('open') && !nav.contains(e.target)) close(false); });
}

// ------------------------------------------------------------ magnetic buttons (fine pointers only)
for (const el of document.querySelectorAll('[data-magnetic]')) {
  el.addEventListener('pointermove', (e) => {
    if (!finePointer.matches || reduced.matches) return;
    const b = el.getBoundingClientRect();
    const dx = (e.clientX - (b.left + b.width / 2)) / (b.width / 2), dy = (e.clientY - (b.top + b.height / 2)) / (b.height / 2);
    el.style.setProperty('--mx', (dx * 5).toFixed(1) + 'px');
    el.style.setProperty('--my', (dy * 4).toFixed(1) + 'px');
  });
  el.addEventListener('pointerleave', () => { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); });
}

// ------------------------------------------------------------ in view
const inview = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); inview.unobserve(e.target); }
}, { threshold: 0.2 });
document.querySelectorAll('[data-inview]').forEach((el) => inview.observe(el));

/** Calls cb(true/false) as `el` comes in and out of view. */
export function watch(el, cb, opts = { threshold: 0.25 }) {
  const io = new IntersectionObserver((entries) => entries.forEach((e) => cb(e.isIntersecting)), opts);
  io.observe(el);
  return io;
}

const small = () => innerWidth < 700;
const pausedKey = (k) => 'dd-paused-' + k;

/**
 * A looping, muted demo video inside a .frame. Sources are attached about a screen ahead, the video plays
 * only while a quarter of it is in view, and the button pauses it (remembered for this visit). With
 * Reduce Motion it never starts by itself.
 */
export function setupVideo(frame) {
  const video = frame.querySelector('video');
  const btn = frame.querySelector('.media-btn');
  let key = null, near = false, visible = false;
  let userPaused = store.get(pausedKey(frame.dataset.name)) === '1';
  const base = () => (frame.dataset.dark && darkMode.matches ? frame.dataset.dark : frame.dataset.name);
  const attach = () => {
    if (!frame.dataset.name || !near) return;
    const k = base() + (small() ? '-sm' : '');
    if (k === key) return;
    key = k;
    video.poster = `${BASE}media/video/${k}.webp`;
    video.replaceChildren(
      Object.assign(document.createElement('source'), { src: `${BASE}media/video/${k}.webm`, type: 'video/webm' }),
      Object.assign(document.createElement('source'), { src: `${BASE}media/video/${k}.mp4`, type: 'video/mp4' }),
    );
    video.load();
    sync();
  };
  const sync = () => {
    const play = visible && !userPaused && (!reduced.matches || frame.dataset.force === '1') && !!key;
    if (play) { const p = video.play(); if (p) p.catch(() => {}); } else video.pause();
    const paused = !play;
    frame.classList.toggle('paused', paused);
    if (btn) {
      btn.dataset.state = paused ? 'paused' : 'playing';
      btn.setAttribute('aria-label', paused ? 'Play video' : 'Pause video');
    }
  };
  watch(frame, (on) => { if (on) { near = true; attach(); } }, { rootMargin: '100% 0px' });
  watch(frame, (on) => { visible = on; sync(); });
  if (btn) btn.addEventListener('click', () => {
    if (frame.dataset.mode === 'img') return; // the tool gallery is showing a still demo, handled by its own player
    const playing = !frame.classList.contains('paused');
    userPaused = playing;
    // An explicit Play overrides Reduce Motion for this video.
    if (!playing) { frame.dataset.force = '1'; near = true; attach(); }
    store.set(pausedKey(frame.dataset.name), userPaused ? '1' : '0');
    sync();
  });
  darkMode.addEventListener('change', attach);
  addEventListener('resize', () => { if (key && (key.endsWith('-sm') !== small())) attach(); }, { passive: true });
  return {
    /** Show another clip in the same frame (tool gallery). */
    set(name, dark) { frame.dataset.name = name; if (dark) frame.dataset.dark = dark; else delete frame.dataset.dark; key = null; userPaused = store.get(pausedKey(name)) === '1'; attach(); },
    stop() { video.pause(); video.removeAttribute('poster'); video.replaceChildren(); video.load(); key = null; },
    sync,
  };
}

/**
 * An animated WebP demo (the user-guide recordings): shows its still poster, swaps to the animation while
 * in view, and back to the poster when paused, so moving pictures can always be stopped.
 */
export function setupAnimImage(box, imgs, btn) {
  let visible = false, userPaused = false;
  const sync = () => {
    const play = visible && !userPaused && (!reduced.matches || box.dataset.force === '1');
    const active = imgs();
    for (const img of box.querySelectorAll('img[data-anim]')) {
      if (!img.dataset.poster) img.dataset.poster = img.getAttribute('src');
      const want = play && active.includes(img) ? img.dataset.anim : img.dataset.poster;
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    }
    box.classList.toggle('still', !play);
    box.classList.toggle('paused', !play);
    if (btn) { btn.setAttribute('aria-label', play ? 'Pause demo' : 'Play demo'); btn.dataset.state = play ? 'playing' : 'paused'; }
  };
  watch(box, (on) => { visible = on; sync(); }, { threshold: 0.35 });
  if (btn) btn.addEventListener('click', () => {
    const playing = !box.classList.contains('still');
    userPaused = playing;
    if (!playing) box.dataset.force = '1';
    sync();
  });
  return { sync, reset() { userPaused = false; sync(); } };
}
