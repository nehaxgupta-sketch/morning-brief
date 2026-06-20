#!/usr/bin/env node
/**
 * preview-rss.cjs — Morning Brief Sprint 15: the new engine, in a safe sandbox.
 *
 * This is the WHOLE new approach in miniature, runnable in Codespaces with no
 * API key and no changes to your app:
 *   1. pull today's news from your real feeds (backbone + new sources + wires)
 *   2. unwrap Google News redirect links to the real publisher link
 *   3. remove exact + near-duplicate stories (the "go wide -> trim" funnel)
 *   4. rank best sources first, sort into sections
 *   5. pull the market index moves from Yahoo
 *   6. print a sample brief with REAL, clickable links
 *
 *     node preview-rss.cjs
 *
 * Nothing here writes to your database or touches the live site. It just proves
 * the engine works on real news before we wire it in behind the on/off switch.
 */

'use strict';

try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { timeout: 30000 } }));
} catch (_) {}

if (typeof fetch !== 'function') {
  console.error('Needs Node 18+ (global fetch). Check `node --version`.');
  process.exit(1);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
};
const RECENCY_HOURS = 48;
const G = (q) => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en';

// ── Feeds (subset of feeds.config.ts) → which sections they fill, + tier ──────
// tier: 3 = wires/record (lead), 2 = national-digital/specialist, 1 = regional/topical
const FEEDS = [
  // Backbone (direct publisher RSS — clean links)
  { src: 'The Hindu', tier: 3, secs: ['india', 'major_events'], url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { src: 'The Hindu', tier: 3, secs: ['world'], url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
  { src: 'The Hindu', tier: 3, secs: ['business'], url: 'https://www.thehindu.com/business/feeder/default.rss' },
  { src: 'The Hindu', tier: 3, secs: ['sport'], url: 'https://www.thehindu.com/sport/feeder/default.rss' },
  { src: 'Indian Express', tier: 3, secs: ['india', 'major_events'], url: 'https://indianexpress.com/section/india/feed/' },
  { src: 'Indian Express', tier: 3, secs: ['world'], url: 'https://indianexpress.com/section/world/feed/' },
  { src: 'Indian Express', tier: 3, secs: ['business'], url: 'https://indianexpress.com/section/business/feed/' },
  { src: 'Indian Express', tier: 3, secs: ['technology'], url: 'https://indianexpress.com/section/technology/feed/' },
  { src: 'Hindustan Times', tier: 3, secs: ['india', 'major_events'], url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { src: 'Hindustan Times', tier: 3, secs: ['world'], url: 'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml' },
  { src: 'Times of India', tier: 3, secs: ['major_events', 'india'], url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
  { src: 'Times of India', tier: 3, secs: ['world'], url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms' },
  { src: 'Times of India', tier: 3, secs: ['business'], url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms' },
  { src: 'NDTV', tier: 3, secs: ['india', 'major_events'], url: 'https://feeds.feedburner.com/ndtvnews-india-news' },
  { src: 'NDTV', tier: 3, secs: ['world'], url: 'https://feeds.feedburner.com/ndtvnews-world-news' },
  { src: 'Mint', tier: 2, secs: ['business'], url: 'https://www.livemint.com/rss/markets' },
  { src: 'Mint', tier: 2, secs: ['business'], url: 'https://www.livemint.com/rss/companies' },
  { src: 'Business Standard', tier: 2, secs: ['business'], url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { src: 'Scroll', tier: 2, secs: ['india', 'culture'], url: 'https://feeds.feedburner.com/ScrollinArticles.rss' },
  { src: 'BBC', tier: 3, secs: ['world', 'major_events'], url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { src: 'BBC', tier: 3, secs: ['technology'], url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { src: 'The Guardian', tier: 3, secs: ['world'], url: 'https://www.theguardian.com/world/rss' },
  { src: 'Al Jazeera', tier: 3, secs: ['world'], url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  // New Sprint 15 direct RSS
  { src: 'The Diplomat', tier: 2, secs: ['world'], url: 'https://thediplomat.com/feed/' },
  { src: 'Rest of World', tier: 2, secs: ['technology', 'world'], url: 'https://restofworld.org/feed/' },
  { src: 'MIT Technology Review', tier: 2, secs: ['technology'], url: 'https://www.technologyreview.com/feed/' },
  { src: 'Medianama', tier: 2, secs: ['technology'], url: 'https://www.medianama.com/feed/' },
  { src: 'Mongabay India', tier: 2, secs: ['climate_health'], url: 'https://india.mongabay.com/feed/' },
  { src: 'Carbon Brief', tier: 2, secs: ['climate_health'], url: 'https://www.carbonbrief.org/feed/' },
  // Wires via Google News (links get unwrapped below)
  { src: 'Reuters', tier: 3, secs: ['world'], url: G('site:reuters.com when:1d') },
  { src: 'AP', tier: 3, secs: ['world'], url: G('site:apnews.com when:1d') },
  // Personalisation samples (Google News) — demonstrate the engine, also unwrapped
  { src: 'Google News', tier: 1, secs: ['technology'], url: G('(artificial intelligence OR AI) (India OR global) when:2d') },
  { src: 'Google News', tier: 1, secs: ['sport'], url: G('cricket (India OR ICC OR Test OR ODI) when:2d') },
];

const TICKERS = [
  { symbol: '^BSESN', label: 'Sensex' },
  { symbol: '^NSEI', label: 'Nifty' },
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'Nasdaq' },
];

// ── helpers ───────────────────────────────────────────────────────────────
async function fetchText(url, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, body: '', err: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) };
  } finally { clearTimeout(timer); }
}

function stripTags(s) {
  return String(s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Unwrap a Google News redirect link to the real publisher URL (best-effort).
function unwrapGoogle(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)news\.google\.com$/.test(u.hostname)) return href; // already real
    const m = u.pathname.match(/\/articles\/([^/?]+)/);
    if (!m) return null;
    let id = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (id.length % 4) id += '=';
    const raw = Buffer.from(id, 'base64').toString('binary');
    const um = raw.match(/https?:\/\/[^\x00-\x1f\s"'<>]+/);
    if (!um) return null; // opaque id — cannot decode; caller drops it
    return um[0].replace(/[^\x20-\x7e].*$/, '');
  } catch (_) { return null; }
}

function parseItems(body, feed) {
  const blocks = body.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = stripTags((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1];
    if (!link) link = (b.match(/<link[^>]+href="([^"]+)"/i) || [])[1];
    link = (link || '').trim();
    const desc = stripTags((b.match(/<description[^>]*>([\s\S]*?)<\/description>/i)
      || b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1]).slice(0, 400);
    const date = ((b.match(/<pubDate>([^<]+)<\/pubDate>/i)
      || b.match(/<published>([^<]+)<\/published>/i)
      || b.match(/<updated>([^<]+)<\/updated>/i) || [])[1] || '').trim();
    const real = unwrapGoogle(link);
    if (!title || !real) continue; // drop items we couldn't get a real link for
    out.push({ headline: title, body: desc, source: feed.src, url: real, tier: feed.tier, secs: feed.secs, date });
  }
  return out;
}

const STOP = new Set('the a an of to in on for and or with at by from is are as it its this that than over after into amid new'.split(' '));
function words(h) {
  return new Set(String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
}
function overlap(a, b) { let n = 0; for (const w of a) if (b.has(w)) n++; return n; }

async function yahooChange(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d';
  const r = await fetchText(url);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.body);
    const res = j.chart && j.chart.result && j.chart.result[0];
    const closes = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close || [])
      .filter((x) => typeof x === 'number');
    if (closes.length < 2) return null;
    const last = closes[closes.length - 1], prev = closes[closes.length - 2];
    const pct = ((last - prev) / prev) * 100;
    return { last, pct };
  } catch (_) { return null; }
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

// ── run ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('\nMorning Brief — Sprint 15 NEW ENGINE preview (sandbox, no app changes)\n');

  // 1) PULL WIDE
  let all = [];
  let feedsOk = 0, feedsBad = 0;
  for (const f of FEEDS) {
    const r = await fetchText(f.url);
    if (!r.ok) { feedsBad++; continue; }
    const items = parseItems(r.body, f);
    if (items.length) feedsOk++; else feedsBad++;
    all = all.concat(items);
  }
  const pulled = all.length;

  // 2) TRIM — exact URL duplicates
  const seen = new Set();
  const noDupUrl = [];
  for (const s of all) {
    const key = s.url.split('?')[0].replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key); noDupUrl.push(s);
  }

  // 3) TRIM — near-duplicates (same story, different outlet). Keep higher tier.
  noDupUrl.sort((a, b) => b.tier - a.tier);
  const kept = [];
  for (const s of noDupUrl) {
    const sw = words(s.headline);
    const dup = kept.find((k) => overlap(sw, k._w) >= 4);
    if (dup) continue;
    s._w = sw; kept.push(s);
  }

  // 4) BUCKET into sections + rank by tier, then recency
  const SECTIONS = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  const pool = {};
  for (const sec of SECTIONS) pool[sec] = [];
  for (const s of kept) {
    for (const sec of s.secs) if (pool[sec]) pool[sec].push(s);
  }
  for (const sec of SECTIONS) {
    pool[sec].sort((a, b) => (b.tier - a.tier) || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  }

  // 5) MARKETS
  const indices = [];
  for (const t of TICKERS) {
    const q = await yahooChange(t.symbol);
    indices.push({ name: t.label, change: q ? (q.pct >= 0 ? '+' : '') + q.pct.toFixed(1) + '%' : 'n/a', level: q ? q.last : null });
  }

  // ── REPORT ────────────────────────────────────────────────────────────
  console.log('THE "GO WIDE -> TRIM" FUNNEL');
  console.log('  feeds answered:        ' + feedsOk + '/' + FEEDS.length);
  console.log('  stories pulled:        ' + pulled);
  console.log('  after exact de-dupe:   ' + noDupUrl.length);
  console.log('  after merging near-dups: ' + kept.length + '   <- final clean pool\n');

  console.log('POOL BY SECTION (best source leads)');
  for (const sec of SECTIONS) console.log('  ' + pad(sec, 16) + pool[sec].length);
  console.log('');

  console.log('MARKETS (from Yahoo, real moves)');
  for (const ix of indices) console.log('  ' + pad(ix.name, 10) + pad(ix.change, 8) + (ix.level != null ? 'level ' + ix.level.toFixed(0) : ''));
  console.log('');

  // ── SAMPLE BRIEF (what a reader would see) — top items with REAL links ──
  console.log('────────────────────────────────────────────────────────');
  console.log('SAMPLE BRIEF (real links — click any to confirm they work)');
  console.log('────────────────────────────────────────────────────────');
  const SHOW = { major_events: 3, india: 3, world: 2, business: 2, technology: 2, sport: 1, culture: 1, climate_health: 1 };
  for (const sec of SECTIONS) {
    const items = pool[sec].slice(0, SHOW[sec] || 1);
    if (!items.length) continue;
    console.log('\n## ' + sec.toUpperCase().replace('_', ' '));
    for (const s of items) {
      console.log('• ' + s.headline);
      console.log('  ' + s.source + ' — ' + s.url);
    }
  }
  console.log('\n(End of sample. This came entirely from real feeds with real links — no AI invented anything.)\n');
})();
