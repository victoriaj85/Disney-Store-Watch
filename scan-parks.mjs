// Disneyland Resort add-on for the Disney Store watch.
// Separate from scan.mjs, so it can never break the main tracker.
// Watches https://www.disneystore.com/new/disney-parks-shop/disneyland-resort/
// Writes data/disneyland.csv, data/parks-report.md, parks-comment.md
import fs from 'node:fs';

const BASE = 'https://www.disneystore.com';
const PATH = '/new/disney-parks-shop/disneyland-resort/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,*/*;q=0.8' };
const FILE = 'data/disneyland.csv';
const PAGE = 120, MAX_PAGES = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (res.ok) return await res.text();
      if (i === tries) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (e) { if (i === tries) throw e; }
    await sleep(2000 * i);
  }
}

const unent = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&reg;/g, '®').replace(/&trade;/g, '™')
  .replace(/&eacute;/g, 'é').replace(/&nbsp;/g, ' ');

function parseTiles(html) {
  const out = new Map();
  const re = /data-tealium-productstring="([^"]*)"[\s\S]{0,800}?(?:itemprop="url" content="([^"]+)"|href="(\/[^"]+\.html)")/g;
  let m;
  while ((m = re.exec(html))) {
    let j;
    try { j = JSON.parse(unent(m[1])); } catch { continue; }
    if (!j.id || out.has(j.id)) continue;
    out.set(j.id, {
      id: j.id, name: unent(j.name || ''), price: j.price || '', original_price: j.original_price || '',
      category: j.category || '', department: j.subcategory || '', character: j.pims_character_name || '',
      availability: j.availability || '', badge: j.badge || '', url: m[2] || BASE + m[3],
    });
  }
  return out;
}

const totalItems = (html) => { const m = html.match(/([\d,]+) items/); return m ? +m[1].replace(/,/g, '') : null; };

async function scan() {
  const all = new Map(); let total = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const text = await get(`${BASE}${PATH}?srule=newest&start=${p * PAGE}&sz=${PAGE}`);
    if (total === null) total = totalItems(text);
    let added = 0;
    for (const [id, t] of parseTiles(text)) if (!all.has(id)) { all.set(id, { ...t, rank: all.size + 1 }); added++; }
    if (!added || (total && all.size >= total)) break;
    await sleep(1500);
  }
  return { items: all, total };
}

const COLS = ['rank', 'id', 'name', 'price', 'original_price', 'category', 'department', 'character', 'availability', 'badge', 'url'];
const csvCell = (v) => { v = String(v ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const toCsv = (rows) => [COLS.join(','), ...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
function fromCsv(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n'); const head = lines.shift().split(',');
  const parse = (line) => { const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
    out.push(cur); return out; };
  const map = new Map();
  for (const l of lines) { const v = parse(l); const o = {}; head.forEach((h, i) => (o[h] = v[i])); map.set(o.id, o); }
  return map;
}
const money = (v) => (v ? `$${v}` : '');

async function main() {
  fs.mkdirSync('data', { recursive: true });
  const prev = fromCsv(FILE);
  const { items, total } = await scan();
  if (items.size === 0) { console.log('Disneyland page has 0 products right now - skipping, nothing saved'); return; }
  if (prev && items.size < prev.size * 0.5) throw new Error(`Disneyland page shrank ${prev.size} -> ${items.size} — aborting`);

  const now = new Date().toISOString();
  const L = [`# Disneyland Resort watch — ${now}`, '', `Items on the Disneyland Resort New page: ${items.size} (site says ${total ?? '?'})`, ''];
  if (!prev) {
    L.unshift('PARKS: baseline');
    L.push('**Baseline run.** Nothing is flagged as new yet. The next run reports changes.');
  } else {
    const added = [...items.values()].filter((t) => !prev.has(t.id));
    const priceCh = [], stockCh = [];
    for (const t of items.values()) { const o = prev.get(t.id); if (!o) continue;
      if (o.price !== t.price) priceCh.push(`- ${t.name}: ${money(o.price)} → ${money(t.price)} — ${t.url}`);
      if (o.availability !== t.availability) stockCh.push(`- ${t.name}: ${o.availability} → ${t.availability} — ${t.url}`); }
    const sec = (title, arr, fmt) => { L.push(`## ${title} (${arr.length})`); arr.length ? arr.forEach((x) => L.push(fmt(x))) : L.push('- none'); L.push(''); };
    sec('NEW at Disneyland Resort', added, (t) => `- ${t.name} — ${money(t.price)}${t.badge ? ` [${t.badge}]` : ''} — ${t.character || t.category} — ${t.availability} — ${t.url}`);
    sec('Price changes', priceCh, (x) => x);
    sec('Stock changes', stockCh, (x) => x);
    L.unshift(`PARKS: ${added.length} new · ${priceCh.length} price · ${stockCh.length} stock`);
  }
  fs.writeFileSync(FILE, toCsv([...items.values()]));
  fs.writeFileSync('data/parks-report.md', L.join('\n') + '\n');
  let body = '', cut = false;
  for (const line of L) { if (body.length + line.length > 60000) { cut = true; break; } body += line + '\n'; }
  if (cut) body += '\n…report truncated; the full report is data/parks-report.md in the repository.\n';
  fs.writeFileSync('parks-comment.md', body);
  console.log(L.slice(0, 4).join('\n'));
}

main().catch((e) => { console.error('PARKS SCAN FAILED:', e.message); process.exit(1); });
