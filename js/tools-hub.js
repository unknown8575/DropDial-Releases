// Web tools hub: filters the tool cards as you type (titles, blurbs and a few extra words per tool).
const input = document.getElementById('tool-search');
const cards = [...document.querySelectorAll('.hub-groups .tool-card')];
const groups = [...document.querySelectorAll('.hub-groups .tool-group')];
const empty = document.getElementById('hub-empty');
const status = document.getElementById('hub-status');

function filter() {
  const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const a of cards) {
    const hit = words.every((w) => a.dataset.words.includes(w));
    a.parentElement.hidden = !hit;
    if (hit) shown++;
  }
  for (const g of groups) g.hidden = !g.querySelector('li:not([hidden])');
  empty.hidden = shown > 0;
  status.textContent = words.length ? `${shown} ${shown === 1 ? 'tool' : 'tools'} found` : '';
}
input.addEventListener('input', filter);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = cards.find((a) => !a.parentElement.hidden); if (first && input.value.trim()) first.click(); }
  if (e.key === 'Escape') { input.value = ''; filter(); }
});
if (input.value) filter();
