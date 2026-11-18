// What a QR code's text is (QA round 7), for Read QR code: UPI payment requests ("upi://pay?pa=…&pn=…&am=…") are
// read into a plain summary — payee, UPI ID, amount, note — with a caution line; web links are marked as links.
// Pure functions (window and unit tests).

const VPA = /^[A-Za-z0-9._-]{1,256}@[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const AMOUNT = /^\d{1,9}(?:\.\d{1,2})?$/;
const SYMBOLS = { INR: '₹' };

/** Query values of a link, decoded leniently (a bad % sequence is kept as typed). */
function query(text) {
  const q = text.slice(text.indexOf('?') + 1).split('#')[0];
  const out = {};
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).toLowerCase();
    let v = i < 0 ? '' : part.slice(i + 1).replace(/\+/g, ' ');
    try { v = decodeURIComponent(v); } catch { /* kept as typed */ }
    if (!(k in out)) out[k] = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  }
  return out;
}

/** "₹150.00", "12.50 USD" */
export function moneyText(amount, currency = 'INR') {
  const cur = String(currency || 'INR').toUpperCase();
  const n = Number(amount);
  const shown = n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return SYMBOLS[cur] ? `${SYMBOLS[cur]}${shown}` : `${shown} ${cur}`;
}

/**
 * A UPI payment link → {vpa, name, amount, currency, note} (amount '' when the payer chooses it), or null when the
 * text isn't a UPI payment link with a valid UPI ID.
 */
export function parseUpi(text) {
  const t = String(text || '').trim();
  if (!/^upi:\/\/pay\?/i.test(t)) return null;
  const q = query(t);
  const vpa = q.pa || '';
  if (!VPA.test(vpa)) return null;
  const amount = AMOUNT.test(q.am || '') && Number(q.am) > 0 ? q.am : '';
  const currency = /^[A-Za-z]{3}$/.test(q.cu || '') ? q.cu.toUpperCase() : 'INR';
  return { vpa, name: (q.pn || '').slice(0, 100), amount, currency, note: (q.tn || '').slice(0, 200) };
}

/** The plain summary of a UPI payment request: "Payment request: ₹150.00 to Test Shop (testshop@okaxis)". */
export function upiSummary(u) {
  const who = u.name ? `${u.name} (${u.vpa})` : u.vpa;
  return u.amount ? `Payment request: ${moneyText(u.amount, u.currency)} to ${who}` : `Payment request to ${who}. You enter the amount.`;
}
export const UPI_CAUTION = 'Before paying, check the name and UPI ID in your payment app. Anyone can make a QR code.';

/** {kind: 'upi' | 'link' | 'text', title, summary?, note?, caution?} for a code's text. */
export function describeCode(text) {
  const upi = parseUpi(text);
  if (upi) return { kind: 'upi', title: 'Found a payment request', summary: upiSummary(upi), note: upi.note ? `Note: ${upi.note}` : '', caution: UPI_CAUTION, upi };
  if (/^https?:\/\//i.test(String(text || '').trim())) return { kind: 'link', title: 'Found a web link', caution: 'This is a web link. Copy it to open it in your browser if you trust it.' };
  return { kind: 'text', title: 'Found a code' };
}
