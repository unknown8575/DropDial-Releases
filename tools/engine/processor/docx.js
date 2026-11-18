// Word documents: reading .docx into simple blocks (headings, paragraphs, lists, tables, pictures) and
// writing plain, readable .docx files. Only the parts needed are read; nothing is extracted to disk.
import { UserError } from './errors.js';

const DAMAGED = 'This Word document could not be read. It may be damaged.';
const MAX_XML = 64 * 1024 * 1024, MAX_IMAGE = 20 * 1024 * 1024, MAX_IMAGES = 150 * 1024 * 1024;

// ------------------------------------------------------------------ reading
const uncompressed = (f) => (f && f._data && Number.isFinite(f._data.uncompressedSize) ? f._data.uncompressedSize : Infinity);

async function readXml(zip, name, required) {
  const f = zip.file(name);
  if (!f) { if (required) throw new UserError(DAMAGED); return null; }
  if (uncompressed(f) > MAX_XML) throw new UserError('This Word document is too large to open.');
  const xml = await f.async('string');
  // Word never needs a DTD; refusing one rules out entity-expansion attacks.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new UserError('This document contains unsupported content, so it wasn’t opened.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new UserError(DAMAGED);
  return doc;
}

const kids = (el, name) => [...el.children].filter((c) => !name || c.localName === name);
const kid = (el, name) => (el ? kids(el, name)[0] || null : null);
const attr = (el, name) => { if (!el) return null; for (const a of el.attributes) if (a.localName === name) return a.value; return null; };
const on = (el) => !!el && !/^(0|false|none)$/i.test(attr(el, 'val') || '');

/** Relationship id → part path inside the package (internal targets under word/ only). */
async function relationships(zip) {
  const doc = await readXml(zip, 'word/_rels/document.xml.rels', false);
  const map = new Map();
  if (!doc) return map;
  for (const r of doc.getElementsByTagName('*')) {
    if (r.localName !== 'Relationship' || /external/i.test(attr(r, 'TargetMode') || '')) continue;
    const target = attr(r, 'Target') || '';
    if (/^[a-z]+:|^\/|\.\./i.test(target)) continue;
    map.set(attr(r, 'Id'), 'word/' + target);
  }
  return map;
}

/** numId → ordered? (from numbering.xml), and style id → {name, numId} (from styles.xml). */
async function definitions(zip) {
  const ordered = new Map(), styles = new Map();
  const numbering = await readXml(zip, 'word/numbering.xml', false);
  if (numbering) {
    const abstract = new Map();
    for (const a of numbering.documentElement.children) {
      if (a.localName !== 'abstractNum') continue;
      const lvl = kids(a, 'lvl').find((l) => (attr(l, 'ilvl') || '0') === '0');
      abstract.set(attr(a, 'abstractNumId'), attr(kid(lvl, 'numFmt'), 'val') !== 'bullet');
    }
    for (const n of numbering.documentElement.children) if (n.localName === 'num') ordered.set(attr(n, 'numId'), !!abstract.get(attr(kid(n, 'abstractNumId'), 'val')));
  }
  const st = await readXml(zip, 'word/styles.xml', false);
  if (st) {
    for (const s of st.documentElement.children) {
      if (s.localName !== 'style') continue;
      styles.set(attr(s, 'styleId'), { name: (attr(kid(s, 'name'), 'val') || '').toLowerCase(), numId: attr(kid(kid(kid(s, 'pPr'), 'numPr'), 'numId'), 'val') });
    }
  }
  return { ordered, styles };
}

const SKIP = new Set(['del', 'moveFrom', 'pPr', 'rPr', 'instrText', 'delText', 'fldChar']);

/** Runs [{text, b, i, u}] and picture relationship ids of a paragraph, in order. */
function paragraphContent(p) {
  const runs = [], pictures = [];
  const add = (text, f) => {
    const last = runs[runs.length - 1];
    if (last && last.b === f.b && last.i === f.i && last.u === f.u) last.text += text;
    else runs.push({ text, ...f });
  };
  const walk = (el) => {
    for (const c of el.children) {
      if (SKIP.has(c.localName)) continue;
      if (c.localName !== 'r') { walk(c); continue; }
      const pr = kid(c, 'rPr');
      const u = kid(pr, 'u');
      const f = { b: on(kid(pr, 'b')), i: on(kid(pr, 'i')), u: !!u && !/^none$/i.test(attr(u, 'val') || '') };
      for (const x of c.children) {
        const n = x.localName;
        if (n === 't') add(x.textContent, f);
        else if (n === 'tab') add('\t', f);
        else if (n === 'br' || n === 'cr') add('\n', f);
        else if (n === 'noBreakHyphen') add('-', f);
        else if (n === 'drawing' || n === 'pict' || n === 'object') {
          for (const d of x.getElementsByTagName('*')) {
            const id = d.localName === 'blip' ? attr(d, 'embed') : d.localName === 'imagedata' ? attr(d, 'id') : null;
            if (id) pictures.push(id);
          }
        }
      }
    }
  };
  walk(p);
  return { runs, pictures };
}

const runsText = (runs) => runs.map((r) => r.text).join('');
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };

/**
 * Read a .docx: {blocks}. Blocks: {type:'h', level, runs}, {type:'p', runs}, {type:'li', ordered, runs},
 * {type:'table', rows:[[text]]}, {type:'img', src} (PNG/JPEG/GIF pictures as data URLs, when `images`).
 */
export async function read({ bytes, images = true }) {
  let zip;
  try { zip = await self.JSZip.loadAsync(bytes); } catch { throw new UserError(DAMAGED); }
  const doc = await readXml(zip, 'word/document.xml', true);
  const body = kid(doc.documentElement, 'body');
  if (!body) throw new UserError(DAMAGED);
  const rels = await relationships(zip);
  const { ordered, styles } = await definitions(zip);
  const blocks = [];
  let imageBytes = 0;

  const picture = async (id) => {
    const part = rels.get(id);
    const type = part && IMAGE_TYPES[(part.split('.').pop() || '').toLowerCase()];
    const f = type && zip.file(part);
    if (!f || uncompressed(f) > MAX_IMAGE || imageBytes + uncompressed(f) > MAX_IMAGES) return;
    imageBytes += uncompressed(f);
    blocks.push({ type: 'img', src: `data:${type};base64,` + (await f.async('base64')) });
  };

  const paragraph = async (p) => {
    const { runs, pictures } = paragraphContent(p);
    const pPr = kid(p, 'pPr');
    const style = styles.get(attr(kid(pPr, 'pStyle'), 'val')) || { name: '' };
    const heading = /^heading (\d)$/.exec(style.name);
    const numId = attr(kid(kid(pPr, 'numPr'), 'numId'), 'val') || style.numId;
    if (heading || style.name === 'title') blocks.push({ type: 'h', level: heading ? Number(heading[1]) : 1, runs });
    else if (numId && numId !== '0') blocks.push({ type: 'li', ordered: !!ordered.get(numId) || /number/.test(style.name), runs });
    else if (runs.length || !pictures.length) blocks.push({ type: 'p', runs });
    if (images) for (const id of pictures) await picture(id);
  };

  const cellText = (tc) => [...tc.getElementsByTagName('*')].filter((e) => e.localName === 'p').map((p) => runsText(paragraphContent(p).runs)).join('\n');

  const walk = async (el) => {
    for (const c of el.children) {
      if (c.localName === 'p') await paragraph(c);
      else if (c.localName === 'tbl') blocks.push({ type: 'table', rows: kids(c, 'tr').map((tr) => kids(tr, 'tc').map(cellText)) });
      else if (c.localName !== 'sectPr') await walk(c); // content controls, insertions and the like
    }
  };
  await walk(body);
  return { blocks };
}

// ------------------------------------------------------------------ writing
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PAPER = { A4: [11906, 16838], Letter: [12240, 15840] }; // twentieths of a point
const MARGIN = 1440;
const EMU_PER_TWIP = 635;

const xmlText = (s) => String(s)
  .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A run's text with tabs and line breaks as Word elements. */
function runXml(text) {
  const parts = String(text).split(/(\t|\n)/).filter((x) => x !== '');
  return '<w:r>' + parts.map((x) => (x === '\t' ? '<w:tab/>' : x === '\n' ? '<w:br/>' : `<w:t xml:space="preserve">${xmlText(x)}</w:t>`)).join('') + '</w:r>';
}

function paragraphXml({ text = '', style, pageBreak }) {
  const ppr = style || pageBreak ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pageBreak ? '<w:pageBreakBefore/>' : ''}</w:pPr>` : '';
  return `<w:p>${ppr}${text ? runXml(text) : ''}</w:p>`;
}

function pictureXml(cx, cy) {
  return '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>'
    + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
    + '<pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
${[[2, 28], [3, 25], [4, 23], [5, 22], [6, 21]].map(([n, sz]) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`).join('')}
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F4"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D0D0"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="444444"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0B57D0"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

/**
 * A .docx from paragraphs [{text, style?: 'Heading1', pageBreak?}] and/or one picture {bytes, ext, width, height}
 * (px, shown at 96 dpi and shrunk to fit the page).
 */
async function writeDocx({ paragraphs = [], picture = null, paper = 'A4', body: given = '', links = [] }) {
  const [pw, ph] = PAPER[paper] || PAPER.A4;
  let body = given + paragraphs.map(paragraphXml).join('');
  if (picture) {
    const k = Math.min(1, (pw - 2 * MARGIN) / (picture.width * 15), (ph - 2 * MARGIN - 400) / (picture.height * 15)); // 15 twips per px
    body += pictureXml(Math.round(picture.width * 15 * k * EMU_PER_TWIP), Math.round(picture.height * 15 * k * EMU_PER_TWIP));
  }
  const zip = new self.JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + (picture ? `<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.${picture.ext}"/>` : '')
    + links.map((href, k) => `<Relationship Id="rIdLink${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlText(href)}" TargetMode="External"/>`).join('')
    + '</Relationships>');
  zip.file('word/styles.xml', STYLES);
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body>${body}<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  if (picture) zip.file(`word/media/image1.${picture.ext}`, picture.bytes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** A text file as a document: one paragraph per line. */
export async function fromText({ text, paper }) {
  return { bytes: await writeDocx({ paragraphs: String(text).replace(/\r\n?/g, '\n').split('\n').map((t) => ({ text: t })), paper }) };
}

/** PDF paragraphs ([[{text, heading}]] per page) as a document; each page after the first starts a new page. */
export async function fromParagraphs({ pages, paper }) {
  const paragraphs = [];
  pages.forEach((paras, n) => paras.forEach((p, i) => paragraphs.push({ text: p.text, style: p.heading ? 'Heading1' : undefined, pageBreak: n > 0 && i === 0 })));
  return { bytes: await writeDocx({ paragraphs, paper }) };
}

/** One picture on a page. */
export async function fromPicture({ picture, paper }) {
  return { bytes: await writeDocx({ picture, paper }) };
}

// ------------------------------------------------------------------ Markdown (QA round 7)
const MD_LINK = /^(https?:\/\/|mailto:)/i;
/**
 * A Markdown file as a document, from the main process's flat paragraphs (src/main/engines/markdown.js toParagraphs):
 * headings, paragraphs with bold/italic/strikethrough/code/links, nested list items (marks as text, indented), code
 * blocks, quotes, rules and tables. Pictures appear as their description.
 */
export async function fromMarkdown({ paragraphs, paper }) {
  const list = Array.isArray(paragraphs) ? paragraphs.slice(0, 200000) : [];
  const links = [];
  const linkId = (href) => { let k = links.indexOf(href); if (k < 0) { if (links.length >= 5000) return null; links.push(href); k = links.length - 1; } return `rIdLink${k + 1}`; };
  const runs = (rs) => (Array.isArray(rs) ? rs : []).map((r) => {
    if (r && r.img) return `<w:r><w:rPr><w:i/><w:color w:val="666666"/></w:rPr><w:t xml:space="preserve">${xmlText(`[${r.img.alt || 'picture'}]`)}</w:t></w:r>`;
    const text = String((r && r.text) || '');
    if (!text) return '';
    const pr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (r.s ? '<w:strike/>' : '')
      + (r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F1F1F1"/>' : '');
    const href = typeof r.href === 'string' && MD_LINK.test(r.href) ? r.href : null;
    const run = runXml(text).replace('<w:r>', `<w:r>${pr || href ? `<w:rPr>${href ? '<w:rStyle w:val="Hyperlink"/>' : ''}${pr}</w:rPr>` : ''}`);
    const id = href && linkId(href);
    return id ? `<w:hyperlink r:id="${id}">${run}</w:hyperlink>` : run;
  }).join('');
  const ind = (depth, hanging) => (depth || hanging ? `<w:ind w:left="${360 + Math.min(8, depth || 0) * 360}"${hanging ? ' w:hanging="360"' : ''}/>` : '');
  let body = '';
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const quote = p.quote ? '<w:pStyle w:val="Quote"/>' : '';
    if (p.kind === 'h') body += `<w:p><w:pPr><w:pStyle w:val="Heading${Math.min(6, Math.max(1, p.level | 0))}"/></w:pPr>${runs(p.runs)}</w:p>`;
    else if (p.kind === 'p') body += `<w:p>${quote || p.depth ? `<w:pPr>${quote}${p.depth ? ind(p.depth - 1) : ''}</w:pPr>` : ''}${runs(p.runs)}</w:p>`;
    else if (p.kind === 'li') body += `<w:p><w:pPr>${quote}<w:spacing w:after="60"/>${ind(p.depth, true)}</w:pPr>${p.mark ? runXml(String(p.mark).slice(0, 12) + '\t') : '<w:r><w:tab/></w:r>'}${runs(p.runs)}</w:p>`;
    else if (p.kind === 'code') {
      const lines = String(p.text || '').split('\n');
      body += lines.map((l, k) => `<w:p><w:pPr><w:pStyle w:val="Code"/>${p.depth ? ind(p.depth - 1) : ''}${k === lines.length - 1 ? '<w:spacing w:after="160"/>' : ''}</w:pPr>${l ? runXml(l) : ''}</w:p>`).join('');
    } else if (p.kind === 'hr') body += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>';
    else if (p.kind === 'table') {
      const head = Array.isArray(p.head) ? p.head.slice(0, 60) : [];
      const align = Array.isArray(p.align) ? p.align : [];
      const cell = (rs, k, th) => `<w:tc><w:p>${align[k] ? `<w:pPr><w:jc w:val="${align[k] === 'right' ? 'right' : align[k] === 'center' ? 'center' : 'left'}"/></w:pPr>` : ''}${runs(th ? (rs || []).map((r) => ({ ...r, b: true })) : rs)}</w:p></w:tc>`;
      const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join('') + '</w:tblBorders>';
      body += `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`
        + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h, k) => cell(h, k, true)).join('')}</w:tr>`
        + (Array.isArray(p.rows) ? p.rows.slice(0, 20000) : []).map((r) => `<w:tr>${head.map((_, k) => cell(Array.isArray(r) ? r[k] : [], k, false)).join('')}</w:tr>`).join('')
        + '</w:tbl><w:p/>';
    }
  }
  return { bytes: await writeDocx({ body, links, paper }) };
}
