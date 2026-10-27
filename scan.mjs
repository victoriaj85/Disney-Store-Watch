// Disney Store new-merchandise watcher (TheDisneyScoop.com)
// No dependencies. Node 20+.  Run: node scan.mjs
// Sources (all public, no key):
//   1. New Arrivals grid  https://www.disneystore.com/new/?srule=newest&start=N&sz=120
//   2. "Coming Soon" page https://www.disneystore.com/trending/coming-soon/ (redirects to an editorial page)
//   3. Product sitemap    https://www.disneystore.com/sitemap_0-product.xml (whole catalog)
// Writes data/new.csv, data/featured.csv, data/sitemap.txt, data/report.md, data/last-run.json
import fs from 'node:fs';

const BASE = 'https://www.disneystore.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' };
const DATA = 'data';
const PAGE = 120;
const MAX_PAGES = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (res.ok) return { text: await res.text(), url: res.url };
      if (i === tries) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (e) { if (i === tries) throw e; }
    await sleep(2000 * i);
  }
}

const unent = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&reg;/g, '®').replace(/&trade;/g, '™')
  .replace(/&eacute;/g, 'é').replace(/&nbsp;/g, ' ');

// Every product tile carries a JSON blob in data-tealium-productstring, followed by its product URL.
function parseTiles(html) {
  const out = new Map();
  // Category grids give an absolute itemprop URL; editorial pages only give a relative href.
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

async function scanNew() {
  const all = new Map(); let total = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const { text } = await get(`${BASE}/new/?srule=newest&start=${p * PAGE}&sz=${PAGE}`);
    if (total === null) total = totalItems(text);
    const tiles = parseTiles(text); let added = 0;
    for (const [id, t] of tiles) if (!all.has(id)) { all.set(id, { ...t, rank: all.size + 1 }); added++; }
    if (!added || (total && all.size >= total)) break;
    await sleep(1500);
  }
  return { items: all, total };
}

async function scanFeatured() {
  const { text, url } = await get(`${BASE}/trending/coming-soon/`);
  return { items: parseTiles(text), url };
}

async function scanSitemap() {
  const { text } = await get(`${BASE}/sitemap_0-product.xml`);
  return [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
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
const slugName = (u) => u.replace(BASE + '/', '').replace(/-[0-9A-Za-z]+\.html$/, '').replace(/-/g, ' ');
// Tile ids are lowercase ("…1247m") while URLs end in uppercase ("…1247M.html"), so compare lowercased.
const pidOf = (u) => ((u.match(/-([0-9A-Za-z]+)\.html$/) || [])[1] || u).toLowerCase();
const money = (v) => (v ? `$${v}` : '');

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const prevNew = fromCsv(`${DATA}/new.csv`);
  const prevFeat = fromCsv(`${DATA}/featured.csv`);
  const prevMap = fs.existsSync(`${DATA}/sitemap.txt`) ? fs.readFileSync(`${DATA}/sitemap.txt`, 'utf8').trim().split('\n') : null;

  const [nw, feat, smap] = [await scanNew(), await scanFeatured(), await scanSitemap()];

  // Abort guards: a partial or blocked fetch must never overwrite a good snapshot.
  if (nw.items.size < 50) throw new Error(`New grid returned only ${nw.items.size} items — aborting`);
  if (prevNew && nw.items.size < prevNew.size * 0.5) throw new Error(`New grid shrank ${prevNew.size} -> ${nw.items.size} — aborting`);
  if (smap.length < 1500) throw new Error(`Sitemap returned only ${smap.length} URLs — aborting`);
  if (prevMap && smap.length < prevMap.length * 0.7) throw new Error(`Sitemap shrank ${prevMap.length} -> ${smap.length} — aborting`);

  const now = new Date().toISOString();
  const L = [`# Disney Store watch — ${now}`, '',
    `New Arrivals grid: ${nw.items.size} items scanned (site says ${nw.total ?? '?'}) · Featured/Coming Soon page: ${feat.items.size} · Catalog sitemap: ${smap.length} products`, ''];

  if (!prevNew) {
    L.push('**Baseline run.** No previous snapshot, so nothing is flagged as new yet. The next run reports changes.');
  } else {
    const added = [...nw.items.values()].filter((t) => !prevNew.has(t.id));
    const dropped = [...prevNew.values()].filter((t) => !nw.items.has(t.id));
    const priceCh = [], stockCh = [];
    for (const t of nw.items.values()) { const o = prevNew.get(t.id); if (!o) continue;
      if (o.price !== t.price) priceCh.push(`- ${t.name}: ${money(o.price)} → ${money(t.price)} — ${t.url}`);
      if (o.availability !== t.availability) stockCh.push(`- ${t.name}: ${o.availability} → ${t.availability} — ${t.url}`); }
    const featAdded = prevFeat ? [...feat.items.values()].filter((t) => !prevFeat.has(t.id)) : [];
    const prevSet = new Set(prevMap || []), curSet = new Set(smap);
    const mapAdded = prevMap ? smap.filter((u) => !prevSet.has(u)) : [];
    const mapGone = prevMap ? prevMap.filter((u) => !curSet.has(u)) : [];
    const newIds = new Set(added.map((t) => t.id.toLowerCase()));
    const mapAddedOnly = mapAdded.filter((u) => !newIds.has(pidOf(u)));

    const sec = (title, arr, fmt) => { L.push(`## ${title} (${arr.length})`); arr.length ? arr.forEach((x) => L.push(fmt(x))) : L.push('- none'); L.push(''); };
    const tile = (t) => `- ${t.name} — ${money(t.price)}${t.badge ? ` [${t.badge}]` : ''} — ${t.character || t.category} — ${t.availability} — ${t.url}`;
    sec('NEW on the New Arrivals page', added, tile);
    sec('New on the Featured / Coming Soon page', featAdded, tile);
    sec('New in the full catalog (not on New Arrivals)', mapAddedOnly, (u) => `- ${slugName(u)} — ${u}`);
    sec('Price changes (New Arrivals items)', priceCh, (x) => x);
    sec('Stock changes (New Arrivals items)', stockCh, (x) => x);
    sec('Rotated off the New Arrivals page', dropped, (t) => `- ${t.name} — ${t.url}`);
    sec('Removed from the catalog sitemap', mapGone, (u) => `- ${slugName(u)} — ${u}`);
    L.unshift(`CHANGES: ${added.length} new arrivals · ${featAdded.length} featured · ${mapAddedOnly.length} other catalog adds · ${priceCh.length} price · ${stockCh.length} stock`);
  }

  fs.writeFileSync(`${DATA}/new.csv`, toCsv([...nw.items.values()]));
  fs.writeFileSync(`${DATA}/featured.csv`, toCsv([...feat.items.values()].map((t, i) => ({ ...t, rank: i + 1 }))));
  fs.writeFileSync(`${DATA}/sitemap.txt`, smap.join('\n') + '\n');
  fs.writeFileSync(`${DATA}/report.md`, L.join('\n') + '\n');
  // GitHub issue comments max out at 65,536 characters; cap the posted copy by whole lines.
  let body = '', cut = false;
  for (const line of L) { if (body.length + line.length > 60000) { cut = true; break; } body += line + '\n'; }
  if (cut) body += '\n…report truncated here; the full report is data/report.md in the repository.\n';
  fs.writeFileSync('comment.md', body);
  fs.writeFileSync(`${DATA}/last-run.json`, JSON.stringify({ at: now, newGrid: nw.items.size, siteTotal: nw.total, featured: feat.items.size, featuredUrl: feat.url, sitemap: smap.length }, null, 2) + '\n');
  console.log(L.slice(0, 4).join('\n'));
}

main().catch((e) => { console.error('SCAN FAILED:', e.message); process.exit(1); });
