// pages/api/pfeedcheck.tsx
//
// Stage 1 of the unified-RSS rewrite — validate the PERSONALISATION feeds
// (city patterns + the few niche-topic feeds) live from Vercel's IP, exactly like
// feedcheck did for the wire tier. Interests/professions that overlap the broad
// pool need NO feed (they're pool-selectors) — only these do.
//
// Deploy as pages/api/pfeedcheck.tsx, open /api/pfeedcheck, paste the JSON back,
// then delete. PASS = 200 + parseable items + on-domain article links.

import type { NextApiRequest, NextApiResponse } from 'next';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type Cand = { use: string; url: string; expectDomain: string };

// City-feed URL PATTERNS to discover which work for arbitrary cities, + the
// niche-topic feeds. Alts included where the path is uncertain.
const CANDIDATES: Cand[] = [
  // ── Indian Express city pattern (the cleanest if it holds for many cities) ──
  { use: 'IE city: mumbai',    url: 'https://indianexpress.com/section/cities/mumbai/feed/',     expectDomain: 'indianexpress.com' },
  { use: 'IE city: delhi',     url: 'https://indianexpress.com/section/cities/delhi/feed/',      expectDomain: 'indianexpress.com' },
  { use: 'IE city: bangalore', url: 'https://indianexpress.com/section/cities/bangalore/feed/',  expectDomain: 'indianexpress.com' },
  { use: 'IE city: pune',      url: 'https://indianexpress.com/section/cities/pune/feed/',       expectDomain: 'indianexpress.com' },
  { use: 'IE city: hyderabad', url: 'https://indianexpress.com/section/cities/hyderabad/feed/',  expectDomain: 'indianexpress.com' },
  { use: 'IE city: chennai',   url: 'https://indianexpress.com/section/cities/chennai/feed/',    expectDomain: 'indianexpress.com' },
  { use: 'IE city: kolkata',   url: 'https://indianexpress.com/section/cities/kolkata/feed/',    expectDomain: 'indianexpress.com' },
  { use: 'IE city: ahmedabad', url: 'https://indianexpress.com/section/cities/ahmedabad/feed/',  expectDomain: 'indianexpress.com' },
  // ── TOI city pattern (fallback shape; numeric per-city ids vary — test generic) ──
  { use: 'TOI city: mumbai',   url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128838597.cms', expectDomain: 'indiatimes.com' },
  // ── Hindustan Times city pattern ──
  { use: 'HT city: mumbai',    url: 'https://www.hindustantimes.com/feeds/rss/cities/mumbai-news/rssfeed.xml', expectDomain: 'hindustantimes.com' },

  // ── Niche-topic feeds (where a dedicated source beats the pool) ──
  { use: 'legal: LiveLaw',     url: 'https://www.livelaw.in/rss/',            expectDomain: 'livelaw.in' },
  { use: 'legal: Bar & Bench', url: 'https://www.barandbench.com/feed',       expectDomain: 'barandbench.com' },
  { use: 'startups: Inc42',    url: 'https://inc42.com/feed/',                expectDomain: 'inc42.com' },
  { use: 'startups: YourStory',url: 'https://yourstory.com/feed',            expectDomain: 'yourstory.com' },
  { use: 'business: Moneycontrol', url: 'https://www.moneycontrol.com/rss/latestnews.xml', expectDomain: 'moneycontrol.com' },
];

function fetchT(url: string, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA } })
    .finally(() => clearTimeout(t));
}
function analyze(xml: string, expectDomain: string) {
  const total = (xml.match(/<item[\s>]/g) || []).length + (xml.match(/<entry[\s>]/g) || []).length;
  const rss = Array.from(xml.matchAll(/<link>\s*(https?:\/\/[^<\s]+?)\s*<\/link>/g)).map((m) => m[1]);
  const atom = Array.from(xml.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)).map((m) => m[1]);
  const sample = [...rss, ...atom].filter((u) => !u.includes('google.com')).slice(0, 3);
  const onDomain = sample.length > 0 && sample.every((u) => {
    try { const h = new URL(u).hostname.replace(/^www\./, ''); return h === expectDomain || h.endsWith('.' + expectDomain); }
    catch { return false; }
  });
  return { itemCount: total, sampleLinks: sample, linksOnExpectedDomain: onDomain };
}
async function check(c: Cand) {
  const out: any = { use: c.use, url: c.url };
  try {
    const r = await fetchT(c.url, 8000);
    out.status = r.status; out.finalUrl = r.url;
    if (r.status !== 200) { out.verdict = `FAIL_HTTP_${r.status}`; return out; }
    const a = analyze(await r.text(), c.expectDomain);
    out.itemCount = a.itemCount; out.sampleLinks = a.sampleLinks; out.linksOnExpectedDomain = a.linksOnExpectedDomain;
    out.verdict = a.itemCount === 0 ? 'FAIL_NO_ITEMS' : a.linksOnExpectedDomain ? 'PASS' : 'REVIEW_LINKS_OFF_DOMAIN';
  } catch (e: any) { out.error = String(e?.message || e); out.verdict = 'FAIL_FETCH'; }
  return out;
}
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const results = await Promise.all(CANDIDATES.map(check));
  const rank = (v: string) => (v === 'PASS' ? 0 : v.startsWith('REVIEW') ? 1 : 2);
  results.sort((a, b) => rank(a.verdict) - rank(b.verdict));
  res.status(200).json({
    ranAt: new Date().toISOString(),
    summary: {
      pass: results.filter((r) => r.verdict === 'PASS').length,
      review: results.filter((r) => String(r.verdict).startsWith('REVIEW')).length,
      fail: results.filter((r) => String(r.verdict).startsWith('FAIL')).length,
      cityPatternWorks: results.filter((r) => r.use.startsWith('IE city') && r.verdict === 'PASS').map((r) => r.use),
    },
    results,
  });
}
