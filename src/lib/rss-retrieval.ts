// src/lib/rss-retrieval.ts
//
// Sprint 15 — deterministic RSS retrieval. This REPLACES "ask the LLM for the
// news" with "pull the news from real feeds." It is wired in as one more fetch
// strategy behind generate-brief.tsx's existing FETCH switch, so it returns the
// EXACT same shape the rest of the pipeline already consumes (RawStories). The
// old path is untouched and stays the default until RETRIEVAL=rss is set.
//
// Pipeline: poll feeds -> parse -> unwrap Google links -> whitelist-filter ->
// de-duplicate (word-overlap default; embeddings optional) -> rank by source
// tier -> bucket into sections -> pull market moves -> (optionally) store items.
//
// Everything is fail-safe: any single feed, the embedder, the quotes endpoint,
// or storage can fail without taking down the fetch. A duplicate is always a
// better failure than a missing story, so de-dup is deliberately conservative.
//
// Env flags (all optional, safe defaults):
//   RETRIEVAL=rss        -> generate-brief uses this engine (default: old engine)
//   CLUSTER=embeddings   -> use OpenAI embeddings to merge near-dups (default: words)
//   CLUSTER_THRESHOLD    -> cosine cutoff, biased toward keeping separate (default 0.86)
//   STORE_ITEMS=off      -> skip persisting the pool (default: on)
//   RSS_RECENCY_HOURS    -> freshness window (default 48)

import { createClient } from '@supabase/supabase-js';
import {
  SECTION_FEEDS, WIRE_FEEDS, NEW_SOURCE_QUERY_FEEDS, MARKET_TICKERS, googleNewsFeed,
} from '@/lib/retrieval/feeds.config';
import { isWhitelistedSource, sourceTier, publisherLabel } from '@/lib/whitelist';

// ── Output shape (mirrors RawStory / RawStories in generate-brief.tsx) ────────
export interface RssStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  must_include?: boolean;
}
type Section =
  | 'major_events' | 'world' | 'india' | 'business'
  | 'technology' | 'climate_health' | 'sport' | 'culture';
const SECTIONS: Section[] = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];

export interface RssPool {
  major_events: RssStory[]; world: RssStory[]; india: RssStory[]; business: RssStory[];
  technology: RssStory[]; climate_health: RssStory[]; sport: RssStory[]; culture: RssStory[];
  politics?: RssStory[]; markets_news?: RssStory[];
  markets: { summary: string; indices: { name: string; change: string }[] };
  lens: { world: string; india: string; markets: string; watch: string } | null;
  _source?: string;
  _fetched_at?: string;
}

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  'Accept-Language': 'en-IN,en;q=0.9',
};
const RECENCY_HOURS = parseInt(process.env.RSS_RECENCY_HOURS || '48', 10);

// ── fetch + parse ─────────────────────────────────────────────────────────
async function fetchText(url: string, ms = 30000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

function stripTags(s: string): string {
  return String(s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Unwrap a Google News redirect to the real publisher URL (best-effort). Items
// whose id is opaque (cannot decode) are dropped so no google.com links leak
// into the pool — the backbone (direct RSS) carries clean links regardless.
function unwrapGoogle(href: string): string | null {
  try {
    const u = new URL(href);
    if (!/(^|\.)news\.google\.com$/.test(u.hostname)) return href;
    const m = u.pathname.match(/\/articles\/([^/?]+)/);
    if (!m) return null;
    let id = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (id.length % 4) id += '=';
    const raw = Buffer.from(id, 'base64').toString('binary');
    const um = raw.match(/https?:\/\/[^\x00-\x1f\s"'<>]+/);
    if (!um) return null;
    return um[0].replace(/[^\x20-\x7e].*$/, '');
  } catch { return null; }
}

interface PoolItem extends RssStory { _tier: number; _secs: Section[]; _w?: Set<string>; _emb?: number[]; }

function parseFeed(body: string, src: string, tier: number, secs: Section[]): PoolItem[] {
  const blocks = body.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  const out: PoolItem[] = [];
  for (const b of blocks) {
    const headline = stripTags((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1];
    if (!link) link = (b.match(/<link[^>]+href="([^"]+)"/i) || [])[1];
    const body_ = stripTags(((b.match(/<description[^>]*>([\s\S]*?)<\/description>/i)
      || b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1]) || '').slice(0, 600);
    const date = ((b.match(/<pubDate>([^<]+)<\/pubDate>/i)
      || b.match(/<published>([^<]+)<\/published>/i)
      || b.match(/<updated>([^<]+)<\/updated>/i) || [])[1] || '').trim();
    const real = unwrapGoogle((link || '').trim());
    if (!headline || !real) continue;
    // Freshness (only when the feed gives a parseable date).
    const t = Date.parse(date);
    if (!Number.isNaN(t) && (Date.now() - t) / 36e5 > RECENCY_HOURS) continue;
    // Whitelist by the REAL publisher link.
    if (!isWhitelistedSource(real)) continue;
    out.push({
      headline,
      body: body_,
      source: publisherLabel(real) || src,
      source_url: real,
      published_at: date || undefined,
      // Full field set so the pool shape matches the writer's expectations
      // exactly (empty tag arrays are valid; personalisation tags are added
      // later when the tails move to RSS). Prevents the writer from dropping
      // the "carry unchanged" group, which caused a 10min validation hiccup.
      industries: [],
      interests: [],
      city_tags: [],
      topic_tags: [],
      must_include: false,
      _tier: sourceTier(real) || tier,
      _secs: secs,
    });
  }
  return out;
}

// ── de-duplication ─────────────────────────────────────────────────────────
const STOP = new Set('the a an of to in on for and or with at by from is are as it its this that than over after into amid said new will would india indian'.split(' '));
function words(h: string): Set<string> {
  return new Set(String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number { let n = 0; a.forEach((w) => { if (b.has(w)) n++; }); return n; }

async function embed(texts: string[]): Promise<number[][] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts.map((t) => t.slice(0, 400)) }),
    });
    const j: any = await res.json();
    if (!Array.isArray(j?.data)) return null;
    return j.data.map((d: any) => d.embedding as number[]);
  } catch { return null; }
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Conservative merge: keep the highest-tier representative; bias toward leaving
// stories SEPARATE (a duplicate is a better failure than a dropped story).
async function dedupe(items: PoolItem[]): Promise<{ kept: PoolItem[]; pulled: number; afterUrl: number }> {
  const pulled = items.length;
  // exact URL
  const seen = new Set<string>();
  const noUrl: PoolItem[] = [];
  for (const s of items) {
    const key = s.source_url.split('?')[0].replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key); noUrl.push(s);
  }
  noUrl.sort((a, b) => b._tier - a._tier);

  const useEmb = (process.env.CLUSTER || 'words').toLowerCase() === 'embeddings';
  const threshold = parseFloat(process.env.CLUSTER_THRESHOLD || '0.86');
  let embs: number[][] | null = null;
  if (useEmb) {
    embs = await embed(noUrl.map((s) => `${s.headline}. ${s.body}`));
    if (embs) noUrl.forEach((s, i) => { s._emb = embs![i]; });
    else console.warn('[rss] embeddings unavailable — falling back to word-overlap de-dup.');
  }

  const kept: PoolItem[] = [];
  for (const s of noUrl) {
    let dup = false;
    if (s._emb) {
      dup = kept.some((k) => k._emb && cosine(s._emb!, k._emb!) >= threshold);
    } else {
      const sw = words(s.headline); s._w = sw;
      dup = kept.some((k) => overlap(sw, k._w!) >= 4);
    }
    if (!dup) kept.push(s);
  }
  return { kept, pulled, afterUrl: noUrl.length };
}

// ── markets (Yahoo, real moves; no fabrication) ──────────────────────────────
async function marketMove(symbol: string): Promise<{ last: number; pct: number } | null> {
  const body = await fetchText('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d');
  if (!body) return null;
  try {
    const j: any = JSON.parse(body);
    const res = j?.chart?.result?.[0];
    const closes: number[] = (res?.indicators?.quote?.[0]?.close || []).filter((x: any) => typeof x === 'number');
    if (closes.length < 2) return null;
    const last = closes[closes.length - 1], prev = closes[closes.length - 2];
    return { last, pct: ((last - prev) / prev) * 100 };
  } catch { return null; }
}
async function fetchMarketsRss(): Promise<{ summary: string; indices: { name: string; change: string }[] }> {
  const indices: { name: string; change: string }[] = [];
  const parts: string[] = [];
  for (const t of MARKET_TICKERS) {
    const m = await marketMove(t.symbol);
    const change = m ? (m.pct >= 0 ? '+' : '') + m.pct.toFixed(1) + '%' : '0.0%';
    indices.push({ name: t.label, change });
    if (m) parts.push(`${t.label} ${change}`);
  }
  // Mechanical, fact-only summary built from the numbers themselves.
  const summary = parts.length ? `Latest close: ${parts.join(', ')}.` : '';
  return { summary, indices };
}

// ── storage (metadata; pgvector embedding column optional) ───────────────────
async function storeItems(items: RssStory[]): Promise<void> {
  if ((process.env.STORE_ITEMS || 'on').toLowerCase() === 'off') return;
  try {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    // A story can appear in more than one section, so the flattened list may
    // contain the same source_url twice. De-dupe before upsert, otherwise the
    // batch hits "ON CONFLICT cannot affect row a second time".
    const rows = Array.from(new Map(items.map((s) => [s.source_url, {
      source_url: s.source_url, headline: s.headline, source: s.source,
      published_at: s.published_at || null, fetched_at: new Date().toISOString(),
    }])).values());
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from('news_items').upsert(rows.slice(i, i + 200), { onConflict: 'source_url' });
      if (error) { console.warn('[rss] storeItems upsert failed (non-fatal):', error.message); break; }
    }
    console.log(`[rss] stored ${rows.length} items to news_items.`);
  } catch (e: any) { console.warn('[rss] storeItems threw (non-fatal):', e?.message || e); }
}

// ── orchestrator: the drop-in fetch strategy ─────────────────────────────────
export async function fetchStrategy_Rss(_universe?: any): Promise<RssPool> {
  console.log('[fetch] RSS engine — polling feeds…');

  // Assemble the feed list: backbone (explicit sections) + wires + new sources.
  type Job = { url: string; src: string; tier: number; secs: Section[] };
  const tagToSec = (tags: string[]): Section[] => {
    const map: Record<string, Section> = {
      'sec:world': 'world', 'sec:india': 'india', 'sec:business': 'business',
      'sec:tech': 'technology', 'sec:climate': 'climate_health', 'sec:sport': 'sport',
      'sec:entertainment': 'culture', 'sec:top': 'major_events', 'sec:markets': 'business',
      'sec:factcheck': 'india',
    };
    const out = tags.map((t) => map[t]).filter(Boolean) as Section[];
    return out.length ? out : ['world'];
  };
  const jobs: Job[] = [];
  for (const f of SECTION_FEEDS) jobs.push({ url: f.url, src: f.source, tier: f.tier, secs: f.sections.filter((s) => (SECTIONS as string[]).includes(s)) as Section[] });
  for (const q of [...WIRE_FEEDS, ...NEW_SOURCE_QUERY_FEEDS]) jobs.push({ url: googleNewsFeed(q.q), src: q.slug.replace('src:', ''), tier: 2, secs: tagToSec(q.tags) });

  // Poll (bounded concurrency).
  const items: PoolItem[] = [];
  let feedsOk = 0;
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const body = await fetchText(job.url);
      if (!body) continue;
      const parsed = parseFeed(body, job.src, job.tier, job.secs.length ? job.secs : ['world']);
      if (parsed.length) feedsOk++;
      for (const p of parsed) items.push(p);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // De-duplicate (the "go wide -> trim" funnel).
  const { kept, pulled, afterUrl } = await dedupe(items);
  console.log(`[fetch] RSS funnel — feeds ${feedsOk}/${jobs.length}, pulled ${pulled} -> ${afterUrl} (url) -> ${kept.length} (near-dup).`);

  // Bucket + rank (tier first, then recency). buildSubset re-ranks downstream too.
  const pool: any = {};
  for (const sec of SECTIONS) pool[sec] = [];
  for (const s of kept) for (const sec of s._secs) if (pool[sec]) pool[sec].push(s);
  for (const sec of SECTIONS) {
    (pool[sec] as PoolItem[]).sort((a, b) => (b._tier - a._tier) || ((Date.parse(b.published_at || '') || 0) - (Date.parse(a.published_at || '') || 0)));
    // strip internal fields -> clean RssStory
    pool[sec] = (pool[sec] as PoolItem[]).map(({ _tier, _secs, _w, _emb, ...rest }) => rest as RssStory);
  }

  // Markets (real numbers) + a mechanical lens (no fabrication).
  const markets = await fetchMarketsRss();
  const top = (sec: Section): string => (pool[sec][0]?.headline || '');
  const lens = {
    world: top('world') || top('major_events'),
    india: top('india'),
    markets: markets.summary,
    watch: top('major_events') || top('india'),
  };

  // Persist the clean pool (fail-safe).
  await storeItems(SECTIONS.flatMap((s) => pool[s] as RssStory[]));

  const out: RssPool = {
    major_events: pool.major_events, world: pool.world, india: pool.india, business: pool.business,
    technology: pool.technology, climate_health: pool.climate_health, sport: pool.sport, culture: pool.culture,
    markets, lens,
    _source: 'rss', _fetched_at: new Date().toISOString(),
  };
  console.log('[fetch] RSS section counts — ' + SECTIONS.map((s) => `${s}=${(out as any)[s].length}`).join(', '));
  return out;
}
