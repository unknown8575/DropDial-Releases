// User guide: Mac/Windows switch, search, topic jump, the current-topic marker and the demo players.
import { setupAnimImage } from './site.js';

const root = document.documentElement;
const picks = [...document.querySelectorAll('[data-os-pick]')];
const setOS = (os, save) => {
  root.dataset.guideOs = os;
  picks.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.osPick === os)));
  if (save) { try { localStorage.setItem('dd-guide-os', os); } catch { /* storage blocked */ } }
  players.forEach((p) => p.sync());
};
const players = [];
for (const fig of document.querySelectorAll('[data-demo]')) {
  const imgs = () => [...fig.querySelectorAll('img')].filter((img) => img.classList.contains('os-' + (root.dataset.guideOs === 'win' ? 'win' : 'mac')));
  players.push(setupAnimImage(fig, imgs, fig.querySelector('.demo-toggle')));
}
picks.forEach((b) => b.addEventListener('click', () => setOS(b.dataset.osPick, true)));
setOS(root.dataset.guideOs === 'win' ? 'win' : 'mac', false);

// Search: hide topics that don't contain every word typed.
const input = document.getElementById('guide-search');
const topics = [...document.querySelectorAll('.topic')];
const groups = [...document.querySelectorAll('.g-group')];
const none = document.getElementById('no-results');
const said = document.getElementById('search-status');
let t = 0;
input.addEventListener('input', () => {
  clearTimeout(t);
  t = setTimeout(() => {
    const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const el of topics) {
      const hit = !words.length || words.every((w) => el.dataset.words.includes(w));
      el.hidden = !hit;
      if (hit) shown++;
    }
    groups.forEach((g) => { g.hidden = !g.querySelector('.topic:not([hidden])'); });
    none.hidden = shown > 0;
    said.textContent = words.length ? `${shown} ${shown === 1 ? 'topic' : 'topics'} found` : '';
  }, 120);
});

// Jump menu (phones and tablets).
const jump = document.getElementById('guide-jump');
jump.addEventListener('change', () => {
  if (!jump.value) return;
  const el = document.getElementById(jump.value);
  if (el) { el.hidden = false; history.replaceState(null, '', '#' + jump.value); el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); el.querySelector('h3').setAttribute('tabindex', '-1'); el.querySelector('h3').focus({ preventScroll: true }); }
  jump.value = '';
});

// Current topic in the index.
const links = new Map([...document.querySelectorAll('.gi-list a')].map((a) => [a.hash.slice(1), a]));
let current = null;
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const a = links.get(e.target.id);
    if (!a || a === current) continue;
    if (current) { current.classList.remove('current'); current.removeAttribute('aria-current'); }
    current = a;
    a.classList.add('current');
    a.setAttribute('aria-current', 'true');
    const box = a.closest('.guide-index');
    if (box && box.scrollHeight > box.clientHeight) {
      const top = a.offsetTop - box.clientHeight / 2;
      box.scrollTo({ top, behavior: 'auto' });
    }
  }
}, { rootMargin: '-140px 0px -60% 0px' });
topics.forEach((el) => spy.observe(el));

// Back at the top: no topic is current, and the index starts at the beginning.
const index = document.querySelector('.guide-index');
addEventListener('scroll', () => {
  if (scrollY > 240 || !current) return;
  current.classList.remove('current'); current.removeAttribute('aria-current'); current = null;
  if (index) index.scrollTop = 0;
}, { passive: true });
