#!/usr/bin/env node
/**
 * validate-feeds.cjs — Morning Brief Sprint 15, Phase 0 feed-manifest validator
 *
 * Runs in GitHub Codespaces (Node 18+). No AI, no API keys, no `npm install`.
 * Drop it anywhere (a scratch folder is fine) and run:
 *
 *     node validate-feeds.cjs
 *
 * The .cjs extension forces CommonJS, so it ignores any `"type": "module"`
 * in a nearby package.json.
 *
 * For each feed in the build-plan §5 manifest it checks:
 *   - HTTP reachable (browser-like headers; some publishers 403 default agents)
 *   - body is valid XML (RSS / Atom / RDF)
 *   - returns >= 1 item, and how fresh the newest item is
 * Plus:
 *   - the Google News query-feed pattern (one sample per category)
 *   - the Yahoo Finance quotes endpoint for the 4 indices (Decision 1)
 *
 * Output: a PASS / WARN / FAIL table + a summary + a "substitute these" list.
 * Any FAIL section feed -> swap to a Google News query feed scoped to that
 * publisher in feeds.config.ts (build-plan §5.1), then re-run.
 */

'use strict';

// Generous timeouts, matching the project's long-fetch pattern (test-gpt5.js).
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({ headersTimeout: 60000, bodyTimeout: 60000, connect: { timeout: 30000 } }));
} catch (_) {
  console.warn('(undici not available — relying on default fetch + per-request abort timeout)');
}

if (typeof fetch !== 'function') {
  console.error('This script needs Node 18+ (global fetch). Check `node --version` in Codespaces.');
  process.exit(1);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
};

const RECENCY_HOURS = 48; // newest item within this window = "fresh"
const Q = (q) => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en';

// ------------------------------------------------------------ manifest (build-plan §5.1)
const SECTION_FEEDS = [
  // The Hindu (T3)
  { source: 'The Hindu',         tier: 3, url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { source: 'The Hindu',         tier: 3, url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
  { source: 'The Hindu',         tier: 3, url: 'https://www.thehindu.com/business/feeder/default.rss' },
  { source: 'The Hindu',         tier: 3, url: 'https://www.thehindu.com/sport/feeder/default.rss' },
  // Indian Express (T3)
  { source: 'Indian Express',    tier: 3, url: 'https://indianexpress.com/section/india/feed/' },
  { source: 'Indian Express',    tier: 3, url: 'https://indianexpress.com/section/world/feed/' },
  { source: 'Indian Express',    tier: 3, url: 'https://indianexpress.com/section/business/feed/' },
  { source: 'Indian Express',    tier: 3, url: 'https://indianexpress.com/section/technology/feed/' },
  // Hindustan Times (T3)
  { source: 'Hindustan Times',   tier: 3, url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { source: 'Hindustan Times',   tier: 3, url: 'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml' },
  // Times of India (T3)
  { source: 'Times of India',    tier: 3, url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
  { source: 'Times of India',    tier: 3, url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms' },
  { source: 'Times of India',    tier: 3, url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms' },
  // NDTV (T3)
  { source: 'NDTV',              tier: 3, url: 'https://feeds.feedburner.com/ndtvnews-india-news' },
  { source: 'NDTV',              tier: 3, url: 'https://feeds.feedburner.com/ndtvnews-world-news' },
  // Mint (T2)
  { source: 'Mint',              tier: 2, url: 'https://www.livemint.com/rss/markets' },
  { source: 'Mint',              tier: 2, url: 'https://www.livemint.com/rss/companies' },
  // Business Standard (T2)
  { source: 'Business Standard', tier: 2, url: 'https://www.business-standard.com/rss/markets-106.rss' },
  // Scroll (T2)
  { source: 'Scroll',            tier: 2, url: 'https://feeds.feedburner.com/ScrollinArticles.rss' },
  // Deccan Herald (T3)
  { source: 'Deccan Herald',     tier: 3, url: 'https://www.deccanherald.com/rss-feed/52' },
  // World wires (T3)
  { source: 'BBC',               tier: 3, url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'BBC',               tier: 3, url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { source: 'The Guardian',      tier: 3, url: 'https://www.theguardian.com/world/rss' },
  { source: 'Al Jazeera',        tier: 3, url: 'https://www.aljazeera.com/xml/rss/all.xml' },
];

// AP / Reuters public RSS discontinued -> Google News query feeds (§5.1 note),
// plus one sample per personalisation category to prove the pattern works.
const QUERY_SAMPLES = [
  { label: 'wire: Reuters via Google', url: Q('site:reuters.com when:1d') },
  { label: 'wire: AP via Google',      url: Q('site:apnews.com when:1d') },
  { label: 'city: Bengaluru',          url: Q('"Bengaluru" (BBMP OR BWSSB OR traffic OR water) when:2d') },
  { label: 'interest: AI',             url: Q('(artificial intelligence OR AI) (India OR global) when:2d') },
  { label: 'profession: banking',      url: Q('(RBI OR banking OR NPA OR fintech OR UPI) India when:2d') },
  { label: 'follow: India-Canada',     url: Q('"India" "Canada" (diplomacy OR relations OR visa OR expel) when:7d') },
];

const MARKET_TICKERS = [
  { symbol: '^BSESN', label: 'Sensex' },
  { symbol: '^NSEI',  label: 'Nifty 50' },
  { symbol: '^DJI',   label: 'Dow Jones' },
  { symbol: '^IXIC',  label: 'Nasdaq' },
];

// ------------------------------------------------------------ helpers
async function fetchText(url, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
    const body = await res.text();
    return { status: res.status, ok: res.ok, finalUrl: res.url, body };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeXml(body) {
  const head = body.replace(/^\uFEFF/, '').trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<?xml') || head.indexOf('<rss') !== -1 ||
         head.indexOf('<feed') !== -1 || head.indexOf('<rdf:rdf') !== -1;
}

function countItems(body) {
  const rss = (body.match(/<item[\s>]/gi) || []).length;
  const atom = (body.match(/<entry[\s>]/gi) || []).length;
  return Math.max(rss, atom);
}

function newestAgeHours(body) {
  const dates = [];
  const grab = (re) => { let m; while ((m = re.exec(body)) !== null) dates.push(m[1]); };
  grab(/<pubDate>([^<]+)<\/pubDate>/gi);
  grab(/<published>([^<]+)<\/published>/gi);
  grab(/<updated>([^<]+)<\/updated>/gi);
  grab(/<dc:date>([^<]+)<\/dc:date>/gi);
  let newest = -Infinity;
  for (const d of dates) {
    const t = Date.parse(d.trim());
    if (!Number.isNaN(t)) newest = Math.max(newest, t);
  }
  if (newest === -Infinity) return null;
  return Math.max(0, (Date.now() - newest) / 36e5);
}

function firstItemLink(body) {
  const itemMatch = body.match(/<item[\s\S]*?<\/item>/i);
  const block = itemMatch ? itemMatch[0] : body;
  const rss = block.match(/<link>([^<]+)<\/link>/i);
  if (rss) return rss[1].trim();
  const atom = block.match(/<link[^>]+href="([^"]+)"/i);
  return atom ? atom[1].trim() : null;
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

// ------------------------------------------------------------ checks
async function checkFeed(url) {
  try {
    const r = await fetchText(url);
    if (!r.ok) return { pass: false, note: 'HTTP ' + r.status };
    if (!looksLikeXml(r.body)) return { pass: false, note: 'not XML (HTML / consent page?)' };
    const items = countItems(r.body);
    if (items === 0) return { pass: false, items, note: 'XML but 0 items' };
    const age = newestAgeHours(r.body);
    const fresh = age === null ? null : age <= RECENCY_HOURS;
    const note = age === null ? 'no parseable dates'
               : fresh ? 'fresh' : 'newest ' + age.toFixed(0) + 'h old';
    return { pass: true, items, ageH: age, fresh, note };
  } catch (e) {
    return { pass: false, note: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error' };
  }
}

async function checkYahoo(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol);
  try {
    const r = await fetchText(url);
    if (!r.ok) return { pass: false, note: 'HTTP ' + r.status };
    let json;
    try { json = JSON.parse(r.body); } catch (_) { return { pass: false, note: 'non-JSON response' }; }
    if (json && json.chart && json.chart.error) return { pass: false, note: 'chart error' };
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    const meta = result && result.meta;
    if (!meta) return { pass: false, note: 'no meta block' };
    const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose
               : meta.previousClose != null ? meta.previousClose
               : meta.regularMarketPrice;
    if (prev == null) return { pass: false, note: 'no previousClose in meta' };
    return { pass: true, value: prev, note: 'prevClose ' + prev };
  } catch (e) {
    return { pass: false, note: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error' };
  }
}

// ------------------------------------------------------------ run
(async () => {
  console.log('\nMorning Brief — Sprint 15 Phase 0 feed validation');
  console.log('Recency window: ' + RECENCY_HOURS + 'h   |   ' + new Date().toISOString() + '\n');

  // 1) Section feeds (the backbone)
  console.log('SECTION FEEDS (backbone)');
  console.log(pad('result', 8) + pad('tier', 6) + pad('source', 18) + pad('items', 7) + 'url   [note]');
  console.log('-'.repeat(100));
  const sectionFails = [];
  for (const f of SECTION_FEEDS) {
    const r = await checkFeed(f.url);
    const mark = r.pass ? (r.fresh === false ? 'WARN' : 'PASS') : 'FAIL';
    console.log(
      pad(mark, 8) + pad('T' + f.tier, 6) + pad(f.source, 18) +
      pad(r.items != null ? r.items : '-', 7) +
      f.url + '   [' + r.note + ']'
    );
    if (!r.pass) sectionFails.push(f);
  }

  // 2) Query-feed pattern (the personalisation engine)
  console.log('\nGOOGLE NEWS QUERY FEEDS (personalisation engine — pattern check)');
  console.log(pad('result', 8) + pad('sample', 26) + pad('items', 7) + 'note');
  console.log('-'.repeat(72));
  for (const s of QUERY_SAMPLES) {
    const r = await checkFeed(s.url);
    console.log(pad(r.pass ? 'PASS' : 'FAIL', 8) + pad(s.label, 26) + pad(r.items != null ? r.items : '-', 7) + r.note);
  }
  // redirect-resolution probe (one sample); robust resolution is a Phase-1 normalise[B] job
  try {
    const r = await fetchText(QUERY_SAMPLES[2].url);
    const link = firstItemLink(r.body);
    if (link) {
      let finalUrl = '(unresolved)';
      try { const f = await fetchText(link); finalUrl = f.finalUrl || '(no redirect)'; } catch (_) {}
      console.log('\nredirect probe: first item link ->');
      console.log('  raw:   ' + link);
      console.log('  final: ' + finalUrl);
      console.log('  (note: robust Google-News link resolution lands in Phase-1 normalise[B])');
    }
  } catch (_) {}

  // 3) Yahoo quotes (Decision 1)
  console.log('\nMARKET QUOTES — Yahoo Finance (Decision 1)');
  console.log(pad('result', 8) + pad('index', 12) + pad('symbol', 10) + 'note');
  console.log('-'.repeat(58));
  let yahooPass = 0;
  for (const t of MARKET_TICKERS) {
    const r = await checkYahoo(t.symbol);
    if (r.pass) yahooPass++;
    console.log(pad(r.pass ? 'PASS' : 'FAIL', 8) + pad(t.label, 12) + pad(t.symbol, 10) + r.note);
  }

  // 4) Summary + substitutions
  const secPass = SECTION_FEEDS.length - sectionFails.length;
  console.log('\nSUMMARY');
  console.log('  Section feeds:  ' + secPass + '/' + SECTION_FEEDS.length + ' reachable & valid');
  console.log('  Yahoo indices:  ' + yahooPass + '/' + MARKET_TICKERS.length + ' returning previous close');
  if (sectionFails.length) {
    console.log('\n  SUBSTITUTE THESE (swap to a Google News query feed scoped to the publisher, §5.1):');
    for (const f of sectionFails) {
      let host = f.source;
      try { host = new URL(f.url).host.replace(/^www\./, ''); } catch (_) {}
      console.log('   - ' + pad(f.source, 18) + '  ->  q=site:' + host + ' when:1d');
    }
  }
  if (yahooPass < MARKET_TICKERS.length) {
    console.log('\n  Yahoo incomplete -> use the Decision 1 fallback (keyed free-tier API):');
    console.log('   Twelve Data (800/day), Finnhub, or Alpha Vantage (25/day) — any covers 4 daily.');
  }
  console.log('\nDone. Paste this table back to lock the verified manifest before Phase 1.\n');
})();
