// pages/api/feedcheck.tsx
//
// Sprint 21 — throwaway. Validates candidate DIRECT-RSS feed URLs from Vercel's IP,
// so only confirmed-good feeds get wired into SECTION_FEEDS. Same reason as gtest:
// a test from your laptop would use your home IP and miss data-centre-IP blocks
// (that's exactly why Business Standard 403s in production but might load for you).
//
// HOW TO USE
//   1. Drop in as pages/api/feedcheck.tsx. Commit + push (esbuild check first). Vercel deploys.
//   2. Open  https://<your-app>/api/feedcheck  in a browser.
//   3. Paste the WHOLE JSON back to me. I wire the PASS feeds into SECTION_FEEDS.
//   4. Delete the file after.
//
// Reads PASS = 200 + parseable items + article links on the expected publisher domain.

import type { NextApiRequest, NextApiResponse } from 'next';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type Candidate = {
  source: string;
  url: string;
  expectDomain: string; // article links should sit on this root domain
  section: string;      // where it would land in SECTION_FEEDS
  note?: string;
};

// Candidate URLs are best-guesses from memory — the whole point of this route is
// to find out which are real. Alts (same publisher, different path) are included
// where I'm unsure; we keep whichever passes.
const CANDIDATES: Candidate[] = [
  // ── wire / specialist: move OFF Google News onto direct RSS ──
  { source: 'CNBC (top news)',      url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', expectDomain: 'cnbc.com',       section: 'business' },
  { source: 'CNBC (world)',         url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', expectDomain: 'cnbc.com',       section: 'world' },
  { source: 'SCMP (news)',          url: 'https://www.scmp.com/rss/4/feed',                       expectDomain: 'scmp.com',       section: 'world' },
  { source: 'SCMP (alt 91)',        url: 'https://www.scmp.com/rss/91/feed',                      expectDomain: 'scmp.com',       section: 'world' },
  { source: 'Nikkei Asia',          url: 'https://asia.nikkei.com/rss/feed/nar',                  expectDomain: 'nikkei.com',     section: 'world' },
  { source: 'NDTV Profit',          url: 'https://www.ndtvprofit.com/feed',                       expectDomain: 'ndtvprofit.com', section: 'business' },
  { source: 'Fortune India',        url: 'https://www.fortuneindia.com/feed',                     expectDomain: 'fortuneindia.com', section: 'business' },
  { source: 'Dialogue Earth',       url: 'https://dialogue.earth/feed/',                          expectDomain: 'dialogue.earth', section: 'climate_health' },
  { source: 'Dialogue Earth (/en/)',url: 'https://dialogue.earth/en/feed/',                       expectDomain: 'dialogue.earth', section: 'climate_health' },
  { source: 'IndiaSpend',           url: 'https://www.indiaspend.com/feed',                       expectDomain: 'indiaspend.com', section: 'climate_health' },
  { source: 'BOOM',                 url: 'https://www.boomlive.in/feed',                          expectDomain: 'boomlive.in',    section: 'india' },

  // ── repairs of the three known-broken feeds ──
  { source: 'Deccan Herald (current row — known 404)', url: 'https://www.deccanherald.com/rss-feed/52', expectDomain: 'deccanherald.com', section: 'india', note: 'confirm it still 404s' },
  { source: 'Deccan Herald (alt /feed)',               url: 'https://www.deccanherald.com/feed',         expectDomain: 'deccanherald.com', section: 'india' },
  { source: 'Deccan Herald (alt national.rss)',        url: 'https://www.deccanherald.com/rss/national.rss', expectDomain: 'deccanherald.com', section: 'india' },
  { source: 'Business Standard (markets — known 403)', url: 'https://www.business-standard.com/rss/markets-106.rss', expectDomain: 'business-standard.com', section: 'markets_news', note: 'confirm if still IP-blocked from Vercel' },
];

function fetchT(url: string, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA } })
    .finally(() => clearTimeout(t));
}

function analyze(xml: string, expectDomain: string) {
  const items = (xml.match(/<item[\s>]/g) || []).length;     // RSS
  const entries = (xml.match(/<entry[\s>]/g) || []).length;  // Atom
  const total = items + entries;

  const rssLinks = Array.from(xml.matchAll(/<link>\s*(https?:\/\/[^<\s]+?)\s*<\/link>/g)).map((m) => m[1]);
  const atomLinks = Array.from(xml.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)).map((m) => m[1]);
  const links = [...rssLinks, ...atomLinks].filter((u) => !u.includes('google.com'));
  const sample = links.slice(0, 3);

  const onDomain =
    sample.length > 0 &&
    sample.every((u) => {
      try {
        const h = new URL(u).hostname.replace(/^www\./, '');
        return h === expectDomain || h.endsWith('.' + expectDomain);
      } catch {
        return false;
      }
    });

  return { itemCount: total, sampleLinks: sample, linksOnExpectedDomain: onDomain };
}

async function check(c: Candidate) {
  const out: any = { source: c.source, url: c.url, section: c.section };
  if (c.note) out.note = c.note;
  try {
    const r = await fetchT(c.url, 8000);
    out.status = r.status;
    out.finalUrl = r.url;
    out.contentType = r.headers.get('content-type') || '';
    if (r.status !== 200) {
      out.verdict = `FAIL_HTTP_${r.status}`;
      return out;
    }
    const xml = await r.text();
    const a = analyze(xml, c.expectDomain);
    out.itemCount = a.itemCount;
    out.sampleLinks = a.sampleLinks;
    out.linksOnExpectedDomain = a.linksOnExpectedDomain;
    if (a.itemCount === 0) out.verdict = 'FAIL_NO_ITEMS';
    else if (a.linksOnExpectedDomain) out.verdict = 'PASS';
    else out.verdict = 'REVIEW_LINKS_OFF_DOMAIN';
  } catch (e: any) {
    out.error = String(e?.message || e);
    out.verdict = 'FAIL_FETCH';
  }
  return out;
}

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const results = await Promise.all(CANDIDATES.map(check));

  // Sort PASS → REVIEW → FAIL for readability.
  const rank = (v: string) => (v === 'PASS' ? 0 : v.startsWith('REVIEW') ? 1 : 2);
  results.sort((a, b) => rank(a.verdict) - rank(b.verdict));

  const pass = results.filter((r) => r.verdict === 'PASS').map((r) => `${r.source} → ${r.url}`);
  res.status(200).json({
    ranAt: new Date().toISOString(),
    summary: {
      pass: pass.length,
      review: results.filter((r) => String(r.verdict).startsWith('REVIEW')).length,
      fail: results.filter((r) => String(r.verdict).startsWith('FAIL')).length,
      wireIntoSectionFeeds: pass,
    },
    results,
  });
}
