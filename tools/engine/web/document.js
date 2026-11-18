// decodeText() and blocksToText() from src/main/engines/document.js (copied by website/build.mjs).
export function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}

export function blocksToText(blocks) {
  const text = (runs) => (Array.isArray(runs) ? runs.map((r) => r.text || '').join('') : '');
  const lines = [];
  let n = 0;
  for (const b of blocks) {
    n = b.type === 'li' && b.ordered ? n + 1 : 0;
    if (b.type === 'h' || b.type === 'p') lines.push(text(b.runs));
    else if (b.type === 'li') lines.push((b.ordered ? `${n}. ` : '• ') + text(b.runs));
    else if (b.type === 'table') for (const row of b.rows || []) lines.push(row.map((c) => String(c).replace(/\s*\n\s*/g, ' ')).join('\t'));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
