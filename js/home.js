// Home page: the live wheel, the pinned "Drop. Point. Click." chapter, the format finder, the tool gallery
// and the Nearby illustration.
import { ringMarkup } from './wheel-geom.js';
import { reduced, watch, setupVideo, BASE, dir } from './site.js';

const $ = (s, el = document) => el.querySelector(s);
const data = (id) => JSON.parse(document.getElementById(id).textContent);

// ------------------------------------------------------------ the wheel
(function wheel() {
  const stage = $('[data-wheel]');
  if (!stage) return;
  const files = data('hero-data');
  const svg = $('.wheel', stage), ring = $('.ring', stage);
  const big = $('.hub-big', stage), cap = $('.hub-cap', stage), chip = $('.file-chip', stage);
  const ctl = $('.wheel-ctl', stage);
  let fileIdx = 0, labels = files[0].targets, hot = labels.indexOf('WebP');
  let visible = true, paused = false, pointerIn = false, timers = [], rot = 0, last = 0, raf = 0, savedTimer = 0;

  const setCap = (text) => {
    if (cap.textContent === text) return;
    cap.textContent = text;
    cap.classList.remove('swap'); void cap.offsetWidth; cap.classList.add('swap');
  };
  function setHot(i) {
    hot = i;
    ring.querySelectorAll('.seg').forEach((g, k) => { g.classList.toggle('on', k === i); g.setAttribute('aria-selected', String(k === i)); });
    if (i >= 0) svg.setAttribute('aria-activedescendant', 'seg-' + i); else svg.removeAttribute('aria-activedescendant');
    setCap(i >= 0 ? 'Convert to ' + labels[i] : 'Choose a format');
  }
  function showFile(idx, { animate = true } = {}) {
    fileIdx = idx;
    const f = files[idx];
    labels = f.targets;
    ring.innerHTML = ringMarkup(labels, -1);
    big.textContent = f.label;
    chip.querySelector('i').textContent = f.label;
    chip.querySelector('span').textContent = f.name;
    svg.setAttribute('aria-label', `Formats DropDial offers for ${f.name} (a demo; use the arrow keys)`);
    if (animate && !reduced.matches) {
      svg.classList.remove('enter'); void svg.getBoundingClientRect(); svg.classList.add('enter');
      chip.classList.remove('fly'); void chip.offsetWidth; chip.classList.add('fly');
    }
    hot = -1;
    setCap('Choose a format');
  }

  // Auto tour: two formats per file, then the next file. Stops while the pointer is on the wheel or when paused.
  const running = () => visible && !paused && !pointerIn && !reduced.matches && !document.hidden;
  const clear = () => { timers.forEach(clearTimeout); timers = []; };
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  function tour() {
    clear();
    if (!running()) return;
    const picks = { 'photo.heic': ['WebP', 'PDF'], 'clip.mov': ['MP4', 'GIF'], 'voice memo.m4a': ['MP3', 'WAV'] }[files[fileIdx].name] || [];
    const idx = picks.map((p) => labels.indexOf(p)).filter((i) => i >= 0);
    let t = 900;
    for (const i of idx) { later(t, () => setHot(i)); t += 1700; }
    later(t + 200, () => { showFile((fileIdx + 1) % files.length); tour(); });
  }

  // Slow turn of the ring (labels stay upright). Only while running.
  function frame(ts) {
    raf = 0;
    if (!running()) { last = 0; return; }
    if (last) rot = (rot + (ts - last) * 0.004) % 360; // 4° a second
    last = ts;
    svg.style.setProperty('--rot', rot.toFixed(2) + 'deg');
    raf = requestAnimationFrame(frame);
  }
  const resume = () => { if (running()) { if (!raf) raf = requestAnimationFrame(frame); if (!timers.length) tour(); } else { clear(); } };

  // Pointer and keyboard: the visitor takes over.
  svg.addEventListener('pointerover', (e) => {
    pointerIn = true; clear();
    const g = e.target.closest('.seg');
    if (g) setHot(+g.dataset.i);
  });
  svg.addEventListener('pointerleave', () => { pointerIn = false; setTimeout(resume, 1600); });
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.seg');
    if (!g) return;
    choose(+g.dataset.i);
  });
  function choose(i) {
    setHot(i);
    const stem = files[fileIdx].name.replace(/\.[^.]+$/, '');
    clearTimeout(savedTimer);
    setCap(`Saved ${stem}.${labels[i].toLowerCase()}`);
    savedTimer = setTimeout(() => { if (hot === i) setCap('Convert to ' + labels[i]); }, 1600);
  }
  svg.addEventListener('keydown', (e) => {
    const n = labels.length;
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); clear(); pointerIn = true; setHot(hot < 0 ? 0 : (hot + 1) % n); }
    else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); clear(); pointerIn = true; setHot(hot < 0 ? n - 1 : (hot - 1 + n) % n); }
    else if ((e.key === 'Enter' || e.key === ' ') && hot >= 0) { e.preventDefault(); choose(hot); }
  });
  svg.addEventListener('blur', () => { pointerIn = false; setTimeout(resume, 1600); });

  ctl.addEventListener('click', () => {
    paused = !paused;
    ctl.setAttribute('aria-pressed', String(paused));
    ctl.setAttribute('aria-label', paused ? 'Play the wheel animation' : 'Pause the wheel animation');
    resume();
  });
  watch(stage, (on) => { visible = on; resume(); }, { threshold: 0.1 });
  document.addEventListener('visibilitychange', resume);
  reduced.addEventListener('change', resume);

  // The opening moment: panes spring in, the file drops in, then WebP lights up.
  svg.classList.add('ready');
  if (reduced.matches) {
    ctl.hidden = true;
    chip.classList.add('static');
  } else {
    showFile(0);
    timers.push(setTimeout(() => { setHot(labels.indexOf('WebP')); timers = []; later(1500, () => { setHot(labels.indexOf('PDF')); }); later(3300, () => { showFile(1); tour(); }); }, 1100));
    raf = requestAnimationFrame(frame);
  }
})();

// ------------------------------------------------------------ pinned chapter
(function pinned() {
  const pin = $('[data-pin]');
  if (!pin) return;
  const section = pin.closest('section');
  const steps = [...pin.querySelectorAll('.step')];
  const mq = matchMedia('(min-width: 900px) and (min-height: 640px) and (prefers-reduced-motion: no-preference)');
  let ticking = false;
  const update = () => {
    ticking = false;
    if (!mq.matches) return;
    const box = pin.getBoundingClientRect();
    const total = box.height - innerHeight;
    const p = Math.min(1, Math.max(0, -box.top / Math.max(1, total)));
    pin.style.setProperty('--p', p.toFixed(3));
    const idx = Math.min(steps.length - 1, Math.floor(p * steps.length * 1.05));
    steps.forEach((s, i) => s.classList.toggle('on', i === idx));
  };
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  const mode = () => { section.classList.toggle('no-pin', !mq.matches); steps.forEach((s) => s.classList.toggle('on', !mq.matches ? false : s.classList.contains('on'))); update(); };
  mq.addEventListener('change', mode);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  mode();
})();

// ------------------------------------------------------------ videos
for (const f of document.querySelectorAll('.frame[data-video]:not(#tool-frame)')) setupVideo(f);

// ------------------------------------------------------------ format finder
(function finder() {
  const box = $('[data-finder]');
  if (!box) return;
  const { formats } = data('format-data');
  const [catRow, fmtRow] = box.querySelectorAll('.chips');
  const result = $('.result', box);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const show = (id) => {
    const f = formats.find((x) => x.id === id);
    fmtRow.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.fmt === id)));
    const only = (t) => (t.only === 'mac' ? '<small>Mac only</small>' : t.only === 'win' ? '<small>Windows only</small>' : '');
    result.innerHTML = `<h3>${esc(f.label)} converts to</h3><ul class="tags">${f.to.map((t) => `<li>${esc(t.label)}${only(t)}</li>`).join('')}</ul>`;
    result.classList.remove('swap'); void result.offsetWidth; result.classList.add('swap');
  };
  catRow.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    catRow.querySelectorAll('.chip').forEach((c) => { c.classList.toggle('on', c === b); c.setAttribute('aria-pressed', String(c === b)); });
    const list = formats.filter((f) => f.cat === b.dataset.cat);
    fmtRow.innerHTML = list.map((f) => `<button type="button" class="chip" data-fmt="${f.id}" aria-pressed="false">${esc(f.label)}</button>`).join('');
    show(list[0].id);
  });
  fmtRow.addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) show(b.dataset.fmt); });
})();

// ------------------------------------------------------------ tool gallery
(function tools() {
  const frame = $('#tool-frame');
  if (!frame) return;
  const { groups, media, summary } = data('tool-data');
  const tabs = $('.segctl');
  const thumb = $('.thumb', tabs);
  const list = $('.tool-list');
  const panel = $('#tool-panel');
  const img = $('img', frame), video = $('video', frame), btn = $('.media-btn', frame);
  const sum = $('#tool-sum'), howto = $('#tool-guide'), desc = $('#tool-desc');
  const vid = setupVideo(frame);
  let visible = false, imgPaused = false;
  const os = () => (document.documentElement.dataset.guideOs === 'win' ? 'win' : 'mac');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const syncImg = () => {
    if (frame.dataset.mode !== 'img') return;
    const play = visible && !imgPaused && (!reduced.matches || frame.dataset.force === '1');
    const want = play ? img.dataset.anim : img.dataset.poster;
    if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    frame.classList.toggle('paused', !play);
    btn.dataset.state = play ? 'playing' : 'paused';
    btn.setAttribute('aria-label', play ? 'Pause demo' : 'Play demo');
  };
  watch(frame, (on) => { visible = on; syncImg(); });
  btn.addEventListener('click', () => {
    if (frame.dataset.mode !== 'img') return;
    const playing = !frame.classList.contains('paused');
    imgPaused = playing;
    if (!playing) frame.dataset.force = '1';
    syncImg();
  });

  function pick(id, title) {
    list.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
    // Phones show the list as a sideways row: bring the chosen tool into view without moving the page.
    const on = list.querySelector(`[data-tool="${id}"]`);
    if (on && list.scrollWidth > list.clientWidth) list.scrollTo({ left: Math.max(0, on.parentElement.offsetLeft - 20), behavior: reduced.matches ? 'auto' : 'smooth' });
    sum.textContent = summary[id];
    howto.href = dir('guide') + '#' + id;
    howto.setAttribute('aria-label', 'How to use ' + title);
    frame.classList.add('fading');
    setTimeout(() => {
      if (id === 'videoMerge') {
        frame.dataset.mode = 'video';
        img.hidden = true; video.hidden = false;
        desc.textContent = 'Recording: three clips are added to Combine videos, the order is changed, 720p is picked and the joined video is saved.';
        vid.set('combine-videos');
        frame.classList.remove('fading');
      } else {
        frame.dataset.mode = 'img';
        vid.stop();
        video.hidden = true; img.hidden = false;
        const m = media[id];
        img.dataset.poster = `${BASE}media/guide/${os()}/${m}-poster.webp`;
        img.dataset.anim = `${BASE}media/guide/${os()}/${m}.webp`;
        img.alt = '';
        desc.textContent = `Recording of ${title} in DropDial.`;
        img.onload = () => frame.classList.remove('fading');
        img.setAttribute('src', img.dataset.poster);
        syncImg();
        setTimeout(() => frame.classList.remove('fading'), 600);
      }
    }, reduced.matches ? 0 : 200);
  }
  function moveThumb(btnEl) {
    thumb.style.width = btnEl.offsetWidth + 'px';
    thumb.style.transform = `translateX(${btnEl.offsetLeft - 3}px)`;
  }
  function selectGroup(gid, focus) {
    const g = groups.find((x) => x.id === gid);
    tabs.querySelectorAll('[role=tab]').forEach((t) => { const on = t.dataset.group === gid; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on) { moveThumb(t); if (focus) t.focus(); t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } });
    panel.setAttribute('aria-labelledby', 'tab-' + gid);
    list.innerHTML = g.tools.map((t) => `<li><button type="button" data-tool="${t.id}" aria-pressed="false"><span class="tl-t">${esc(t.title)}</span><span class="tl-d">${esc(t.blurb)}</span></button></li>`).join('');
    const first = g.tools.find((t) => t.id === 'videoMerge') || g.tools[0];
    pick(first.id, first.title);
  }
  tabs.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) selectGroup(t.dataset.group); });
  tabs.addEventListener('keydown', (e) => {
    const all = [...tabs.querySelectorAll('[role=tab]')];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % all.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + all.length) % all.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = all.length - 1;
    if (j >= 0) { e.preventDefault(); selectGroup(all[j].dataset.group, true); }
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pick(b.dataset.tool, b.querySelector('.tl-t').textContent); });
  frame.dataset.mode = 'video';
  { const on = list.querySelector('[aria-pressed=true]'); if (on && list.scrollWidth > list.clientWidth) list.scrollLeft = Math.max(0, on.parentElement.offsetLeft - 20); }
  const sel = tabs.querySelector('[aria-selected=true]');
  requestAnimationFrame(() => moveThumb(sel));
  addEventListener('resize', () => moveThumb(tabs.querySelector('[aria-selected=true]')), { passive: true });
  document.fonts && document.fonts.ready.then(() => moveThumb(tabs.querySelector('[aria-selected=true]')));
})();

// ------------------------------------------------------------ Nearby illustration
(function nearby() {
  const art = $('[data-nearby]');
  if (!art) return;
  const btn = $('.media-btn', art);
  let visible = false, paused = false;
  const sync = () => {
    const play = visible && !paused && !reduced.matches;
    art.classList.toggle('playing', play);
    btn.dataset.state = play ? 'playing' : 'paused';
    btn.setAttribute('aria-label', play ? 'Pause animation' : 'Play animation');
    btn.hidden = reduced.matches;
  };
  watch(art, (on) => { visible = on; sync(); });
  btn.addEventListener('click', () => { paused = art.classList.contains('playing'); sync(); });
  reduced.addEventListener('change', sync);
  sync();
})();
