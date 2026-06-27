// pages/api/gtest.tsx
//
// Sprint 21 — throwaway diagnostic. The one question it answers:
//   "Can we resolve a Google News /articles/ link to the real publisher URL,
//    server-side, from Vercel?"  → decides option (A) vs (B) for the nolink fix.
//
// HOW TO USE
//   1. Drop this file in the SAME folder your generate-brief / fetch handler lives in
//      (i.e. pages/api/gtest.tsx). Commit + push in GitHub Desktop. Let Vercel deploy.
//   2. Open  https://<your-app>/api/gtest  in a browser.
//   3. Copy the WHOLE JSON response and paste it back to me.
//   4. Delete this file afterwards — it imports nothing of yours and touches nothing else.
//
//   Optional: test one of YOUR exact feeds by appending
//      ?feed=<url-encoded google-news-rss-url>
//
// Why a deployed route and not a local script: Google blocks datacentre IPs differently
// from home IPs, so a test from your laptop wouldn't tell us how production behaves.
// This runs from Vercel's IP — the same one the real pipeline fetches from.

import type { NextApiRequest, NextApiResponse } from 'next';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_FEED =
  'https://news.google.com/rss/search?q=reuters&hl=en-IN&gl=IN&ceid=IN:en';

function fetchT(url: string, ms: number, opts: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, redirect: 'follow', signal: ctrl.signal }).finally(() =>
    clearTimeout(t),
  );
}

function isGoogle(u: string) {
  try {
    const h = new URL(u).hostname;
    return h === 'google.com' || h.endsWith('.google.com') || h.endsWith('.gstatic.com');
  } catch {
    return false;
  }
}

// Try to pull a plausible real-publisher URL out of a Google "shell" HTML page.
function scanForPublisherUrl(html: string): string | null {
  const tries = [
    /data-n-au="([^"]+)"/,
    /<a[^>]+href="(https?:\/\/[^"]+)"/i,
    /"(https?:\/\/[^"]+)"/,
  ];
  for (const re of tries) {
    const m = html.match(re);
    const u = m?.[1];
    if (u && !isGoogle(u)) return u;
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const feed = (typeof req.query.feed === 'string' && req.query.feed) || DEFAULT_FEED;
  const out: any = { feed, items: [] };

  // 1) Fetch the Google News RSS, extract the first few opaque /articles/ links.
  let xml = '';
  try {
    const r = await fetchT(feed, 10000, { headers: { 'user-agent': UA } });
    out.rssStatus = r.status;
    xml = await r.text();
  } catch (e: any) {
    out.rssError = String(e?.message || e);
    return res.status(200).json(out);
  }

  const links = Array.from(
    xml.matchAll(/<link>\s*(https?:\/\/news\.google\.com\/[^<]+?)\s*<\/link>/g),
  )
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter((u) => u.includes('/articles/') || u.includes('/read/'))
    .slice(0, 3);

  if (links.length === 0) {
    out.note =
      'No /articles/ links found — inspect linkShape to see what the feed actually returns.';
    out.linkShape = (xml.match(/<link>[^<]*<\/link>/) || ['<none>'])[0];
    out.xmlHead = xml.slice(0, 800);
    return res.status(200).json(out);
  }

  // 2) Try to resolve each link to the real publisher.
  for (const gUrl of links) {
    const item: any = { googleUrl: gUrl };
    try {
      const r = await fetchT(gUrl, 10000, { headers: { 'user-agent': UA } });
      item.status = r.status;
      item.finalUrl = r.url;
      item.contentType = r.headers.get('content-type') || '';
      const onPublisher = !isGoogle(r.url) && r.url !== gUrl;

      if (onPublisher) {
        item.verdict = 'REDIRECTED_TO_PUBLISHER';
      } else {
        const body = await r.text();
        item.bodyBytes = body.length;
        const scanned = scanForPublisherUrl(body);
        item.scannedPublisherUrl = scanned;
        item.bodyHead = body.slice(0, 300);
        item.verdict = scanned ? 'SHELL_BUT_PARSEABLE' : 'SHELL_NO_URL_FOUND';
      }
    } catch (e: any) {
      item.error = String(e?.message || e);
      item.verdict = 'FETCH_FAILED';
    }
    out.items.push(item);
  }

  // 3) One-line decision signal.
  const v = out.items.map((i: any) => i.verdict);
  out.summary = v.includes('REDIRECTED_TO_PUBLISHER')
    ? 'A_VIABLE_REDIRECT — option A is trivial (just follow redirects)'
    : v.includes('SHELL_BUT_PARSEABLE')
    ? 'A_VIABLE_VIA_HTML_PARSE — option A works but is brittle; lean B, A as fallback'
    : v.every((x: string) => x === 'FETCH_FAILED')
    ? 'A_DEAD_BLOCKED — Google blocks Vercel; go pure B'
    : 'A_UNLIKELY_SHELL_ONLY — shells with no extractable URL; go B';

  return res.status(200).json(out);
}
