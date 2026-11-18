// Download page: finds the latest release on GitHub and points every button at the right file.
// If GitHub can't be reached, or there is no release yet, the buttons open the releases page instead.
import { store, dir } from './site.js';

const REPO = 'unknown8575/DropDial-Releases';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES = `https://github.com/${REPO}/releases`;
const PATTERNS = {
  'mac-arm': /^DropDial-(.+)-macOS-arm64\.zip$/i,
  'mac-x64': /^DropDial-(.+)-macOS-x64\.zip$/i,
  win: /^DropDial-(.+)-Windows-Setup\.zip$/i,
};
const root = document.documentElement;
const status = document.getElementById('release-status');

async function latest() {
  const cached = store.get('dd-release');
  if (cached) {
    try { const c = JSON.parse(cached); if (Date.now() - c.at < 10 * 60 * 1000) return c.data; } catch { /* ignore */ }
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    const json = await res.json();
    const data = { tag: json.tag_name, name: json.name, published: json.published_at, assets: (json.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
    store.set('dd-release', JSON.stringify({ at: Date.now(), data }));
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const mb = (n) => (n >= 1024 * 1024 ? Math.round(n / 1024 / 1024) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

function apply(release) {
  const found = {};
  if (release) {
    for (const [key, re] of Object.entries(PATTERNS)) {
      const a = release.assets.find((x) => re.test(x.name));
      if (a) found[key] = { ...a, version: a.name.match(re)[1] };
    }
  }
  for (const el of document.querySelectorAll('[data-asset]')) {
    const a = found[el.dataset.asset];
    el.href = a ? a.url : RELEASES;
    if (a) el.removeAttribute('rel'); else el.setAttribute('rel', 'noopener');
  }
  for (const el of document.querySelectorAll('[data-file]')) {
    const a = found[el.dataset.file];
    if (a) el.textContent = `${a.name} · ${mb(a.size)}`;
  }
  const any = Object.values(found)[0];
  if (any) {
    const version = any.version || (release.tag || '').replace(/^v/, '');
    let when = '';
    try { when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(release.published)); } catch { /* no date */ }
    status.textContent = `Version ${version}${when ? `, released ${when}` : ''}.`;
    if (Object.keys(found).length < 3) status.textContent += ' Files that aren’t in this release open the releases page.';
  } else {
    status.textContent = release === undefined ? '' : 'The download buttons open DropDial’s releases page on GitHub.';
  }
}

// Mac: Chromium can tell Apple silicon from Intel. If it's Intel, offer Intel first.
async function macArch() {
  if (root.dataset.os !== 'mac' || !navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return;
  try {
    const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
    if (architecture !== 'x86') return;
    const card = document.querySelector('.dl-variant[data-for="mac"]');
    const arm = card.querySelector('[data-asset="mac-arm"]'), x64 = card.querySelector('[data-asset="mac-x64"]');
    arm.dataset.asset = 'mac-x64'; x64.dataset.asset = 'mac-arm';
    arm.querySelector('[data-label]').textContent = 'Download for Mac (Intel)';
    x64.querySelector('[data-label]').textContent = 'Apple silicon Mac? Download for Apple silicon';
    card.querySelector('[data-arch-note]').textContent = 'For Macs with an Intel processor.';
  } catch { /* keep Apple silicon first */ }
}

// Phones and tablets: send the link to your computer.
function handoff() {
  const url = new URL(dir('download'), location.href).href;
  const share = document.getElementById('share-link');
  const copy = document.getElementById('copy-link');
  const note = document.getElementById('share-status');
  if (navigator.share) {
    share.hidden = false;
    share.addEventListener('click', () => navigator.share({ title: 'DropDial for Mac and Windows', text: 'Download DropDial on your computer:', url }).catch(() => {}));
  }
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      note.textContent = 'Link copied. Open it on your Mac or PC.';
    } catch {
      note.textContent = 'Copy this link: ' + url;
    }
  });
}

// Install tabs follow this computer.
function tabs() {
  const list = document.querySelector('#install [role=tablist]');
  const all = [...list.querySelectorAll('[role=tab]')];
  const select = (tab, focus) => {
    for (const t of all) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  };
  list.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) select(t); });
  list.addEventListener('keydown', (e) => {
    const i = all.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
    select(all[j], true);
  });
  if (root.dataset.os === 'win' || root.dataset.guideOs === 'win') select(all[1]);
}

tabs();
handoff();
apply(undefined);
macArch().then(latest).then(apply);
