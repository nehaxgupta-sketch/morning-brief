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
//
// Sprint 18 (reachability observability) — ONLY the fetch/polling path changed:
//   * Per-feed diagnostics: each feed now logs HTTP status OR error class, raw
//     <item> count BEFORE filtering, kept count AFTER, bytes and ms. The old
//     code collapsed every failure into a silent `continue`, so "feeds X/51"
//     could not distinguish a 403 bot-block from a 404 dead URL from a timeout
//     from a feed that answered fine but whose items were all older than the
//     freshness window. The new table makes the next run diagnosable.
//   * Two cheap, low-risk recoveries: one retry on transient failures
//     (network error / timeout / 429 / 5xx), and — only on a "blocked" status
//     (401/403/406/451) — one retry with an honest feed-fetcher User-Agent.
//     The latter is a PROBE: it converts UA-based blocks to 200 and leaves
//     IP-based blocks failing, so the log tells us whether a proxy is the real
//     fix. The Chrome UA was already being sent, so this is NOT a headers fix.
//   Curation, de-dup, corroboration, cluster-freshest dating, the sport
//   down-weight, ranking, markets, the lens and storage are all UNCHANGED.

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
// Alternate identity used ONLY to retry a feed that hard-blocked the Chrome UA
// (401/403/406/451). Honest and self-identifying: many publishers explicitly
// allow declared feed fetchers while fingerprinting "a browser from a data
// centre". If this converts a 403 -> 200 the block was UA-based; if it still
// fails the block is IP-based and a fetch relay/proxy is the real fix.
const ALT_HEADERS: Record<string, string> = {
  ...HEADERS,
  'User-Agent': 'MorningBriefFeedFetcher/1.0 (+https://morning-brief-liart.vercel.app; RSS reader)',
};
const RECENCY_HOURS = parseInt(process.env.RSS_RECENCY_HOURS || '48', 10);

// ── fetch + parse ─────────────────────────────────────────────────────────
// Structured fetch: returns the body PLUS the HTTP status or error class, bytes
// and elapsed ms, so the caller can tell exactly how a feed failed. (The old
// fetchText returned string|null and threw all of that away.)
interface FetchResult { body: string | null; status: number | null; error: string | null; bytes: number; ms: number; }
async function fetchRaw(url: string, ms = 30000, headers: Record<string, string> = HEADERS): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { body: null, status: res.status, error: null, bytes: 0, ms: Date.now() - t0 };
    const text = await res.text();
    return { body: text, status: res.status, error: null, bytes: text.length, ms: Date.now() - t0 };
  } catch (e: any) {
    const error = e?.name === 'AbortError' ? 'timeout' : (e?.cause?.code || e?.code || e?.name || 'fetch-error');
    return { body: null, status: null, error: String(error), bytes: 0, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}
// Back-compat string fetcher for non-feed callers (markets, embeddings). Same
// behaviour as before: the body on success, null on any failure.
async function fetchText(url: string, ms = 30000): Promise<string | null> {
  return (await fetchRaw(url, ms)).body;
}

// Decode HTML entities. The old code replaced ALL "&name;" with a space, which
// both mangled named entities (&amp; -> ' ' instead of '&') and missed NUMERIC
// entities entirely (&#8217;, &#124;, &#8216;) — so curly quotes and pipes leaked
// raw into headlines, bodies and the lens. Decode decimal + hex numerics and the
// common named set; anything unknown still collapses to a space (safe).
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&nbsp;': ' ', '&ndash;': '\u2013', '&mdash;': '\u2014', '&hellip;': '\u2026',
    '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&rdquo;': '\u201d', '&ldquo;': '\u201c',
  };
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { const c = parseInt(n, 10); return c ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { const c = parseInt(h, 16); return c ? String.fromCodePoint(c) : ' '; })
    .replace(/&[a-zA-Z]+;/g, (m) => (m in named ? named[m] : ' '));
}

function stripTags(s: string): string {
  return decodeEntities(
    String(s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
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

interface PoolItem extends RssStory { _tier: number; _secs: Section[]; _w?: Set<string>; _emb?: number[]; _corr?: number; _isSport?: boolean; _eventCorr?: number; _eventSig?: Set<string>; _eventId?: number; }

// Sprint 18.1 (probe): per-feed drop reasons. A feed can respond 200 with N
// items yet keep 0 — and "X/51" never said WHY. These counters split the loss
// into nolink (link missing OR Google-unwrap returned null), stale (older than
// RSS_RECENCY_HOURS), notwhite (publisher not whitelisted) and nohdr (no title),
// so the next run pins the exact line to change instead of us guessing
// recency-vs-parse. Diagnostic only — no behaviour change.
interface DropCounts { nohdr: number; nolink: number; stale: number; notwhite: number; }

// Robust link extraction. The old two-regex approach (plain <link>text</link>,
// then atom href="…") returned null for several real feed shapes — the Sprint
// 18.1 probe caught this as the ENTIRE loss on The Hindu / HT / ToI / NDTV /
// Mint (drops:nolink == the whole feed). Handle, in priority order:
//   1. <feedburner:origLink> — the un-rewritten publisher URL. FeedBurner feeds
//      (e.g. NDTV) rewrite <link> to a feedproxy redirect; origLink is the real
//      article URL and is what the whitelist needs to see.
//   2. <link>…</link> text content, with CDATA unwrapped.
//   3. Atom <link href="…"> — single OR double quotes; skip rel="self".
//   4. <guid isPermaLink="true">…</guid> as a last resort.
// Returns a clean absolute http(s) URL or null. This is a SUPERSET of the old
// logic: every URL the old code accepted still resolves identically (plain text
// links and double-quoted atom hrefs are still cases 2 and 3), so feeds that
// already work cannot regress — it only recovers the shapes that returned null.
function extractLink(b: string): string | null {
  const clean = (x?: string | null) =>
    String(x || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
  const candidates: string[] = [];
  const fb = b.match(/<(?:[a-z]+:)?origLink[^>]*>([\s\S]*?)<\/(?:[a-z]+:)?origLink>/i);
  if (fb) candidates.push(clean(fb[1]));
  const rss = b.match(/<link\b(?![^>]*\brel\s*=\s*["']self["'])[^>]*>([\s\S]*?)<\/link>/i);
  if (rss) candidates.push(clean(rss[1]));
  const atomRe = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let am: RegExpExecArray | null;
  while ((am = atomRe.exec(b)) !== null) {
    if (/\brel\s*=\s*["']self["']/i.test(am[0])) continue;
    candidates.push(clean(am[1]));
  }
  const guid = b.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) candidates.push(clean(guid[1]));
  for (const c of candidates) {
    const u = c.replace(/\s+/g, '');
    if (/^https?:\/\//i.test(u)) return u;
  }
  return null;
}

function parseFeed(body: string, src: string, tier: number, secs: Section[]): { items: PoolItem[]; drops: DropCounts; linkSample?: string } {
  const blocks = body.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  const out: PoolItem[] = [];
  const drops: DropCounts = { nohdr: 0, nolink: 0, stale: 0, notwhite: 0 };
  let linkSample: string | undefined;
  for (const b of blocks) {
    const headline = stripTags((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const body_ = stripTags(((b.match(/<description[^>]*>([\s\S]*?)<\/description>/i)
      || b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1]) || '').slice(0, 600);
    const date = ((b.match(/<pubDate>([^<]+)<\/pubDate>/i)
      || b.match(/<published>([^<]+)<\/published>/i)
      || b.match(/<updated>([^<]+)<\/updated>/i) || [])[1] || '').trim();
    const rawLink = extractLink(b);
    const real = unwrapGoogle(rawLink || '');
    if (!headline) { drops.nohdr++; continue; }
    if (!real) {
      drops.nolink++;
      // When extractLink ITSELF failed (vs a Google URL we couldn't decode),
      // capture one raw sample so a residual parser miss is visible next run
      // without another probe cycle. Google links resolve here (extractLink
      // returns them) and only fail later in unwrapGoogle, so they aren't sampled.
      if (!rawLink && !linkSample) {
        linkSample = (b.match(/<link[\s\S]{0,180}?<\/link>/i)?.[0]
          || b.match(/<guid[\s\S]{0,140}?<\/guid>/i)?.[0]
          || b.slice(0, 140)).replace(/\s+/g, ' ').slice(0, 180);
      }
      continue;
    }
    // Freshness (only when the feed gives a parseable date).
    const t = Date.parse(date);
    if (!Number.isNaN(t) && (Date.now() - t) / 36e5 > RECENCY_HOURS) { drops.stale++; continue; }
    // Whitelist by the REAL publisher link.
    if (!isWhitelistedSource(real)) { drops.notwhite++; continue; }
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
  return { items: out, drops, linkSample };
}

// ── de-duplication ─────────────────────────────────────────────────────────
const STOP = new Set('the a an of to in on for and or with at by from is are as it its this that than over after into amid said new will would india indian'.split(' '));
function words(h: string): Set<string> {
  return new Set(String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number { let n = 0; a.forEach((w) => { if (b.has(w)) n++; }); return n; }

// ── Same-event detection (Sprint 18.2) ─────────────────────────────────────
// The near-dup merge in dedupe() is deliberately conservative (a duplicate is a
// safer failure than a dropped story), so reworded variants of ONE story stay
// separate. Fine for section depth, but it (a) let the same event reach the
// front page twice and (b) SPLIT cross-source corroboration — 12 outlets on the
// Qatar blast became six corr=2 pairs, so a hugely-covered story ranked no
// higher than a 2-source curio. eventSig folds the highest-frequency news
// synonyms (killed/dead, blast/explosion, resigns/quits, talks/deal) and keeps
// salient figures, so variants share tokens. sameEventSig is used ONLY for
// (1) an event-corroboration COUNT that feeds front-page ranking and (2)
// collapsing the 12-story front page — it never drops anything from a section.
const EVENT_SYN: Record<string, string> = {
  killed: '@kill', kills: '@kill', kill: '@kill', dead: '@kill', death: '@kill', deaths: '@kill', die: '@kill', dies: '@kill', died: '@kill', killing: '@kill', toll: '@kill',
  blast: '@blast', blasts: '@blast', explosion: '@blast', explosions: '@blast', explode: '@blast', exploded: '@blast', explodes: '@blast',
  fire: '@fire', blaze: '@fire', inferno: '@fire',
  resign: '@resign', resigns: '@resign', resigned: '@resign', resignation: '@resign', quit: '@resign', quits: '@resign', step: '@resign', steps: '@resign', stepping: '@resign', stepped: '@resign',
  talks: '@talks', talk: '@talks', negotiation: '@talks', negotiations: '@talks', deal: '@talks',
  strike: '@strike', strikes: '@strike', struck: '@strike', attack: '@strike', attacks: '@strike',
  bust: '@seize', seize: '@seize', seized: '@seize', seizes: '@seize', seizure: '@seize',
  poll: '@vote', polls: '@vote', vote: '@vote', votes: '@vote', election: '@vote', elections: '@vote', runoff: '@vote',
};
function eventSig(headline: string): Set<string> {
  const out = new Set<string>();
  const toks = String(headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
  for (const w of toks) {
    if (!w) continue;
    if (/^\d+$/.test(w)) { if (w.length >= 2 && parseInt(w, 10) >= 5) out.add('#' + w); continue; } // salient figures keep 13≠15 apart yet cluster matching tolls
    if (w.length < 4 || STOP.has(w)) continue;
    out.add(EVENT_SYN[w] || w);
  }
  return out;
}
function sameEventSig(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  a.forEach((w) => { if (b.has(w)) shared++; });
  if (shared >= 4) return true;
  const small = Math.min(a.size, b.size) || 1;
  return shared >= 3 && shared / small >= 0.6;
}
const pubOfItem = (s: PoolItem): string => (publisherLabel(s.source_url) || s.source || s.source_url || 'unknown').toLowerCase();

// Greedy single-link clustering of reworded variants → distinct-publisher count
// per event, stored as _eventCorr for ranking. Same greedy approach dedupe()
// uses; over/under-grouping only nudges ranking, never section contents.
type EventCluster = { id: number; sig: Set<string>; pubs: Set<string>; members: PoolItem[] };
function assignEventCorr(items: PoolItem[]): void {
  const clusters: EventCluster[] = [];
  for (const s of items) {
    const sig = eventSig(s.headline);
    s._eventSig = sig;
    let hit: EventCluster | undefined;
    for (const c of clusters) { if (sameEventSig(sig, c.sig)) { hit = c; break; } }
    if (hit) { hit.pubs.add(pubOfItem(s)); hit.members.push(s); sig.forEach((w) => hit!.sig.add(w)); }
    else clusters.push({ id: clusters.length, sig: new Set(Array.from(sig)), pubs: new Set([pubOfItem(s)]), members: [s] });
  }
  for (const c of clusters) { const n = c.pubs.size; for (const m of c.members) { m._eventCorr = n; m._eventId = c.id; } }
}

// ── Newsworthiness scoring (Sprint 18.3) ───────────────────────────────────
// Corroboration measures how WIDELY a story was covered, not how IMPORTANT it
// is — so heavily-aggregated sensational crime and "who is X" explainers led the
// front page. A cheap LLM pass rates the realistic contenders for genuine
// significance; the front-page score then blends it with corroboration. Fully
// fail-safe: any failure returns an empty map and the caller falls back to pure
// corroboration ranking (the prior behaviour).
async function scoreNewsworthiness(cands: PoolItem[]): Promise<Map<PoolItem, number>> {
  const out = new Map<PoolItem, number>();
  const key = process.env.OPENAI_API_KEY;
  if (!key || cands.length === 0) return out;
  const list = cands.slice(0, 30);
  const numbered = list.map((s, i) => `${i}: ${(s.headline || '').slice(0, 160)}`).join('\n');
  const prompt = `You are a senior wire editor for a serious daily news brief for Indian professionals (urban, 25-45). Rate each headline 0-10 for NEWSWORTHINESS — the genuine consequence a thoughtful reader needs to know — NOT how much coverage it got.
HIGH (7-10): major geopolitics, war, defence, significant government policy or economy, central-bank or market-moving decisions, large-scale disasters, consequential India national developments, major science/technology shifts.
MID (4-6): notable but second-order business, technology or world news.
LOW (0-3): sensational crime (abductions, ransom notes, murders), celebrity news or deaths, "who is X" personality explainers, viral, lifestyle or listicle content, routine sport.
Return ONLY a JSON array, one object per headline: [{"i":0,"score":7}, ...]. No prose, no code fences.
Headlines:
${numbered}`;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.NEWSWORTHINESS_MODEL || 'gpt-4o-mini',
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) { console.warn(`[newsworthiness] HTTP ${res.status} — falling back to corroboration ranking.`); return out; }
    const j: any = await res.json();
    const txt: string = j?.choices?.[0]?.message?.content || '';
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) { console.warn('[newsworthiness] no JSON array in response — falling back to corroboration.'); return out; }
    const arr: any[] = JSON.parse(m[0]);
    for (const o of arr) {
      const idx = parseInt(o?.i, 10);
      const sc = Number(o?.score);
      if (Number.isInteger(idx) && idx >= 0 && idx < list.length && Number.isFinite(sc)) {
        out.set(list[idx], Math.max(0, Math.min(10, sc)));
      }
    }
    console.log(`[newsworthiness] scored ${out.size}/${list.length} contenders via ${process.env.NEWSWORTHINESS_MODEL || 'gpt-4o-mini'}.`);
  } catch (e: any) {
    console.warn(`[newsworthiness] non-fatal error: ${e?.message || e} — falling back to corroboration.`);
  }
  return out;
}

// ── Conservative section reclassification (Sprint 18.3) ────────────────────
// The engine tags by FEED, so a masthead "top stories" feed drops its markets
// and sport columns into india/world (a US-markets story and a football opinion
// column were sitting in India). Move the clear cases into the section they
// belong to. Conservative by design: never touches major_events, and only moves
// sport when the story is low-corroboration (so a genuinely major sport event is
// never pulled off the front page).
const RECLASS_MARKETS_RE = /\b(sensex|nifty|nasdaq|dow jones|s&p 500|stock market|stocks?|shares?|ipo|bourse|equities|bond yield|wall street|dalal street)\b/i;
const RECLASS_SPORT_RE = /\b(world cup|fifa|uefa|la ?liga|serie a|bundesliga|premier league|champions league|europa league|test match|t20|odi|ipl|wicket|batsman|bowler|innings|grand prix|formula 1|f1|motogp|wimbledon|grand slam|olympics?|mbappe|messi|ronaldo)\b/i;
function reclassifySecs(s: PoolItem): void {
  const h = `${s.headline || ''} ${s.body || ''}`;
  const has = (x: Section) => s._secs.indexOf(x) >= 0;
  if (has('major_events')) return; // never disturb the curated front page
  if (RECLASS_MARKETS_RE.test(h) && (has('india') || has('world'))) {
    s._secs = s._secs.filter((x) => x !== 'india' && x !== 'world');
    if (s._secs.indexOf('business') < 0) s._secs.push('business');
    return;
  }
  if (RECLASS_SPORT_RE.test(h) && (has('india') || has('world')) && (s._eventCorr || 1) <= 2) {
    s._secs = s._secs.filter((x) => x !== 'india' && x !== 'world');
    if (s._secs.indexOf('sport') < 0) s._secs.push('sport');
  }
}

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
  // Cross-source corroboration: how many DISTINCT publishers ran essentially the
  // same story (the engine's own near-dup notion). Widely-covered stories cluster
  // (high _corr); a one-off single-source item stays at 1. Used to rank the front
  // page by importance, so a fresh-but-trivial story can't lead over a big one.
  // (With CLUSTER=embeddings this is semantic and much stronger than word-overlap.)
  const clusters = new Map<PoolItem, Set<string>>();
  const pubOf = (s: PoolItem) => (publisherLabel(s.source_url) || s.source || s.source_url || 'unknown').toLowerCase();
  for (const s of noUrl) {
    let match: PoolItem | undefined;
    if (s._emb) {
      match = kept.find((k) => k._emb && cosine(s._emb!, k._emb!) >= threshold);
    } else {
      const sw = words(s.headline); s._w = sw;
      match = kept.find((k) => overlap(sw, k._w!) >= 4);
    }
    if (match) {
      clusters.get(match)!.add(pubOf(s));   // another outlet on the same story
      // ── Cluster-freshest dating (Sprint 17) ─────────────────────────────
      // The kept representative is the highest-TIER article in the cluster,
      // which is not necessarily the most RECENT. Stamp it with the freshest
      // publish time across the cluster so "recency" downstream means "the
      // latest development on this story", not "when the lead outlet happened
      // to file". Effect: a story still being covered keeps a fresh date and
      // survives the recency gate; a story that has gone quiet keeps its old
      // date and ages out. That is exactly "carry forward only when there is a
      // genuine new update" — no blanket weekend widening, so a dead Friday
      // story does not replay on Sunday, but a live one (Iran strikes, an
      // unfolding disaster) is not silently binned for being >24h old.
      const tNew = Date.parse(s.published_at || '');
      const tCur = Date.parse(match.published_at || '');
      if (!Number.isNaN(tNew) && (Number.isNaN(tCur) || tNew > tCur)) {
        match.published_at = s.published_at;
      }
    } else {
      kept.push(s);
      clusters.set(s, new Set([pubOf(s)]));
    }
  }
  for (const k of kept) k._corr = clusters.get(k)!.size;
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

  // ── Poll (bounded concurrency) with per-feed instrumentation (Sprint 18) ───
  // Each feed records: HTTP status OR error class, raw <item> count BEFORE
  // filtering, kept count AFTER, bytes and ms. Two cheap recoveries: one retry
  // on transient failures (network / timeout / 429 / 5xx); and — only on a
  // "blocked" status — one retry with an honest feed-fetcher UA (a probe that
  // separates UA-based from IP-based blocking). Nothing about ranking or
  // bucketing changes; this only widens what we can SEE and recovers the easy
  // transient misses.
  type FeedStat = {
    src: string; host: string; secs: string;
    status: number | null; error: string | null;
    rawBlocks: number; kept: number; bytes: number; ms: number; note: string;
    drops: DropCounts;
    linkSample?: string;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isTransient = (r: { status: number | null; error: string | null }) =>
    (r.status != null && (r.status === 429 || r.status >= 500)) ||
    (r.error != null && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|timeout|socket|network|aborted|reset/i.test(r.error));
  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u.slice(0, 40); } };
  const blockStatuses = new Set([401, 403, 406, 451]);

  const items: PoolItem[] = [];
  const stats: FeedStat[] = [];
  let feedsOk = 0;
  const CONCURRENCY = 8;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      let r = await fetchRaw(job.url);
      let note = '';
      // 1) transient retry (one shot, short backoff)
      if (!r.body && isTransient(r)) {
        await sleep(400);
        const r2 = await fetchRaw(job.url);
        if (r2.body || (r2.status != null && r2.status < 500)) { r = r2; note = 'retried'; }
      }
      // 2) blocked-status retry with the alternate (honest feed-fetcher) UA
      if (!r.body && r.status != null && blockStatuses.has(r.status)) {
        const r3 = await fetchRaw(job.url, 30000, ALT_HEADERS);
        if (r3.body) { r = r3; note = note ? `${note},alt-ua` : 'alt-ua'; }
        else note = note ? `${note},alt-ua-x` : 'alt-ua-x';
      }
      const rawBlocks = r.body ? ((r.body.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || []).length) : 0;
      const pf = r.body
        ? parseFeed(r.body, job.src, job.tier, job.secs.length ? job.secs : ['world'])
        : { items: [] as PoolItem[], drops: { nohdr: 0, nolink: 0, stale: 0, notwhite: 0 } as DropCounts, linkSample: undefined as string | undefined };
      const parsed = pf.items;
      if (parsed.length) feedsOk++;
      for (const p of parsed) items.push(p);
      stats.push({
        src: job.src, host: hostOf(job.url), secs: job.secs.join('+') || 'world',
        status: r.status, error: r.error, rawBlocks, kept: parsed.length, bytes: r.bytes, ms: r.ms, note,
        drops: pf.drops,
        linkSample: pf.linkSample,
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // ── Per-feed reachability diagnostics ──────────────────────────────────────
  // classify each feed so the headline number ("X/51") is finally meaningful:
  //   ok        – produced >=1 kept story
  //   blocked   – 401/403/406/451 (bot-wall; alt-ua note shows if UA-fixable)
  //   notfound  – 404/410 (dead/changed feed URL -> fix in feeds.config)
  //   ratelimit – 429
  //   server    – 5xx
  //   neterr    – DNS/connect/timeout (status null)
  //   empty     – responded 200 but zero <item> blocks (format/empty feed)
  //   filtered  – responded 200 WITH items, all dropped by 48h window/whitelist
  //               (NOT a reachability problem — do not chase these as "blocked")
  const classify = (s: FeedStat): string => {
    if (s.kept > 0) return 'ok';
    if (s.status == null) return 'neterr';
    if (s.status === 404 || s.status === 410) return 'notfound';
    if (s.status === 429) return 'ratelimit';
    if (blockStatuses.has(s.status)) return 'blocked';
    if (s.status >= 500) return 'server';
    if (s.rawBlocks === 0) return 'empty';
    return 'filtered';
  };
  const order: Record<string, number> = {
    blocked: 0, notfound: 1, neterr: 2, server: 3, ratelimit: 4, empty: 5, filtered: 6, ok: 7,
  };
  const tag = (s: FeedStat) => (s.status != null ? String(s.status) : (s.error || 'ERR'));
  const dropStr = (s: FeedStat) => {
    const d = s.drops; const parts: string[] = [];
    if (d.nolink) parts.push(`nolink=${d.nolink}`);
    if (d.stale) parts.push(`stale=${d.stale}`);
    if (d.notwhite) parts.push(`notwhite=${d.notwhite}`);
    if (d.nohdr) parts.push(`nohdr=${d.nohdr}`);
    return parts.length ? ` drops:${parts.join(',')}` : '';
  };
  const rows = stats
    .map((s) => ({ s, c: classify(s) }))
    .sort((a, b) => (order[a.c] - order[b.c]) || a.s.src.localeCompare(b.s.src))
    .map(({ s, c }) =>
      `  ${c === 'ok' ? '·' : '✗'} ${c.padEnd(9)} ${tag(s).padEnd(7)} raw=${String(s.rawBlocks).padStart(3)} ` +
      `kept=${String(s.kept).padStart(3)} ${String(s.ms).padStart(5)}ms  ${s.src} [${s.secs}] ${s.host}` +
      `${s.note ? ` {${s.note}}` : ''}${dropStr(s)}${s.linkSample ? ` link⟨${s.linkSample}⟩` : ''}`);
  const count = (c: string) => stats.filter((s) => classify(s) === c).length;
  const responded = stats.filter((s) => s.kept > 0 || s.rawBlocks > 0 || (s.status != null && s.status < 400)).length;
  console.log(`[fetch] RSS per-feed diagnostics (${stats.length} feeds):\n${rows.join('\n')}`);
  console.log(
    `[fetch] RSS reachability — responded ${responded}/${stats.length} · kept-items ${feedsOk}/${stats.length} · ` +
    `blocked ${count('blocked')} · notfound ${count('notfound')} · neterr ${count('neterr')} · server ${count('server')} · ` +
    `ratelimit ${count('ratelimit')} · empty ${count('empty')} · all-filtered ${count('filtered')}`);

  // De-duplicate (the "go wide -> trim" funnel).
  const { kept, pulled, afterUrl } = await dedupe(items);
  console.log(`[fetch] RSS funnel — feeds ${feedsOk}/${jobs.length}, pulled ${pulled} -> ${afterUrl} (url) -> ${kept.length} (near-dup).`);

  // Event-level corroboration (reworded variants of one story counted together)
  // so the front-page ranking sees TRUE cross-source coverage. Drops nothing.
  assignEventCorr(kept);

  // Bucket + rank (tier first, then recency). buildSubset re-ranks downstream too.
  const pool: any = {};
  for (const sec of SECTIONS) pool[sec] = [];
  // Move feed-misfiled markets/sport columns into the right section first.
  for (const s of kept) reclassifySecs(s);
  for (const s of kept) for (const sec of s._secs) if (pool[sec]) pool[sec].push(s);

  // Rank every section: highest source tier first, then most recent.
  const rankSec = (a: PoolItem, b: PoolItem) =>
    (b._tier - a._tier) || ((Date.parse(b.published_at || '') || 0) - (Date.parse(a.published_at || '') || 0));
  for (const sec of SECTIONS) (pool[sec] as PoolItem[]).sort(rankSec);

  // ── Curate major_events as a SMALL, mixed front page ───────────────────────
  // Until now every national India feed AND every world wire was *mapped* into
  // major_events, so it held ~85 stories. Downstream, enforceQualityRules
  // de-duplicates india/world against major_events by headline-word overlap —
  // and with a giant major_events that stripped nearly all real India hard-news
  // OUT of the India section, leaving only feeds NOT mapped to major_events
  // (Mongabay nature pieces, Scroll long-reads). That is why India read as
  // "a Mongabay music video".
  //
  // Fix: major_events is now just the day's biggest handful of stories, taken
  // from the India + World pools (plus any feed explicitly tagged a front-page
  // "top" feed). India and World keep their FULL pools; downstream dedup now
  // only lifts these few leads out of them — no duplication — and India then
  // shows the next-best *real* India stories.
  const LEAD_MAX = 12;            // size of the curated front page
  const LEAD_PER_PUBLISHER = 3;   // keep the lead varied; no single masthead dominates
  const INDIA_LEAD_MIN = 4;       // India-anchored brief: reserve up to this many slots for India

  // ── P2 (Sprint 17): keep sport from dominating the front page ──────────────
  // Cross-source corroboration is the right importance signal, but during a big
  // tournament (the FIFA World Cup) heavily-covered match results score the
  // HIGHEST corroboration and were LEADING major_events over Gaza, Iran-US and
  // India politics. Sport has its own section AND its own desk, so it should not
  // lead the NEWS front page — but a genuinely huge event must still be able to,
  // so this is a gentle down-weight, not an exclusion (FIFA is real news).
  //
  // We flag a lead candidate as sport two ways: a tight sport lexicon, and an
  // overlap with the sport pool's own headlines (this catches football that
  // arrived dressed as "world" news via BBC World / wire feeds and so isn't
  // tagged sec:sport). A flagged story's corroboration is multiplied by
  // SPORT_LEAD_WEIGHT for ranking ONLY — its section placement is untouched.
  // Tunable via env; 1.0 disables the down-weight, lower clamps sport harder.
  const SPORT_LEAD_WEIGHT = (() => {
    const v = parseFloat(process.env.SPORT_LEAD_WEIGHT || '0.6');
    return Number.isFinite(v) && v > 0 ? v : 0.6;
  })();
  const SPORT_RE = /\b(world cup|fifa|uefa|la liga|serie a|bundesliga|premier league|champions league|europa league|test match|t20|odi|ipl|wicket|batsman|bowler|innings|grand prix|formula 1|f1|motogp|wimbledon|grand slam|olympics?)\b/i;
  const sportSigs = (pool.sport as PoolItem[]).map((s) => words(s.headline));
  const looksSporty = (s: PoolItem): boolean => {
    if (SPORT_RE.test(`${s.headline} ${s.body}`)) return true;
    const hw = words(s.headline);
    for (const sig of sportSigs) if (overlap(hw, sig) >= 3) return true;
    return false;
  };
  for (const sec of ['india', 'world', 'major_events'] as Section[]) {
    for (const s of (pool[sec] as PoolItem[])) if (s._isSport === undefined) s._isSport = looksSporty(s);
  }
  const effCorr = (s: PoolItem): number => (s._eventCorr || s._corr || 1) * (s._isSport ? SPORT_LEAD_WEIGHT : 1);

  // Newsworthiness blend (Sprint 18.3). Score the realistic contenders (top of
  // the corroboration ranking) for genuine significance, then rank the front
  // page on nw × (1 + log2(1 + effective-corroboration)) — a story must be BOTH
  // significant AND corroborated to lead, which demotes sensational-but-viral
  // items. Fail-safe: if scoring is unavailable, leadScoreOf === effCorr (the
  // prior behaviour exactly), so the front page still works.
  const contenderMap = new Map<string, PoolItem>();
  for (const s of [
    ...(pool.major_events as PoolItem[]),
    ...(pool.india as PoolItem[]),
    ...(pool.world as PoolItem[]),
  ]) {
    const k = s.source_url.split('?')[0].replace(/\/$/, '');
    if (!contenderMap.has(k)) contenderMap.set(k, s);
  }
  const contenders = Array.from(contenderMap.values()).sort(
    (a, b) => (effCorr(b) - effCorr(a)) || (b._tier - a._tier),
  );
  // Sprint 19 P0 — score one story per EVENT CLUSTER, not the top-30 individual
  // articles. `contenders` is de-duplicated only by URL, so the few big clusters
  // (Iran, Gaza, Senate, heatwave) each contribute many high-corroboration
  // members that ate all 30 scoring slots — leaving the smaller DISTINCT leads
  // (Qatar blast, Lucknow fire) unscored (`nw=-`) and pinned at the neutral
  // default, below sensational-but-viral listicles. Collapse to one
  // representative per `_eventId` (the highest-effCorr member — first in the
  // corroboration-sorted list); the 30 scored are then 30 distinct events, which
  // covers the whole 12-slot front page. Items with no cluster id stay as their
  // own singleton contender.
  const distinctContenders: PoolItem[] = [];
  const seenContenderEvents = new Set<number>();
  for (const s of contenders) {
    if (s._eventId != null) {
      if (seenContenderEvents.has(s._eventId)) continue;
      seenContenderEvents.add(s._eventId);
    }
    distinctContenders.push(s);
  }
  const nwScores = await scoreNewsworthiness(distinctContenders.slice(0, 30));
  const nwAvailable = nwScores.size > 0;
  // Resolve newsworthiness by CLUSTER ID, so whichever member of a scored event
  // becomes the displayed lead inherits its event's score (only the cluster
  // representative was sent to the scorer). Falls back to object identity for a
  // singleton, then to the neutral default for a genuinely unscored tail.
  const nwByEvent = new Map<number, number>();
  nwScores.forEach((sc, item) => { if (item._eventId != null) nwByEvent.set(item._eventId, sc); });
  const nwOf = (s: PoolItem): number | undefined => {
    if (s._eventId != null && nwByEvent.has(s._eventId)) return nwByEvent.get(s._eventId);
    return nwScores.has(s) ? (nwScores.get(s) as number) : undefined;
  };
  const leadScoreOf = (s: PoolItem): number => {
    const ec = effCorr(s);
    if (!nwAvailable) return ec;
    const nw = nwOf(s);
    return (nw == null ? 5 : nw) * (1 + Math.log2(1 + ec)); // neutral 5 only for a genuinely unscored tail
  };

  // Front-page ranking = IMPORTANCE, not recency. Newsworthiness-blended score
  // first, then source tier, then recency.
  const rankLead = (a: PoolItem, b: PoolItem) =>
    (leadScoreOf(b) - leadScoreOf(a)) ||
    (b._tier - a._tier) ||
    ((Date.parse(b.published_at || '') || 0) - (Date.parse(a.published_at || '') || 0));

  const indiaRanked = [...(pool.india as PoolItem[])].sort(rankLead);
  const restRanked = [
    ...(pool.major_events as PoolItem[]),   // explicit "top" feeds (e.g. TOI Top Stories)
    ...(pool.world as PoolItem[]),
  ].sort(rankLead);

  const leadSeen = new Set<string>();
  const leadByPub = new Map<string, number>();
  const leadEventIds = new Set<number>();
  const lead: PoolItem[] = [];
  const tryAddLead = (s: PoolItem): boolean => {
    const key = s.source_url.split('?')[0].replace(/\/$/, '');
    if (leadSeen.has(key)) return false;
    const pub = (publisherLabel(s.source_url) || s.source || 'unknown').toLowerCase();
    if ((leadByPub.get(pub) || 0) >= LEAD_PER_PUBLISHER) return false;
    // Same-event collapse by CLUSTER ID (consistent with how corroboration is
    // counted). Reworded angles of one story — the Lucknow fire as "15 dead",
    // "Papa save me", "PM announces aid", "AC duct cause" — share almost no
    // headline tokens pairwise, so a pairwise check missed them; but they chain
    // into one event cluster. One lead per cluster gives a genuinely diverse
    // front page instead of six takes on the same topic.
    if (s._eventId != null && leadEventIds.has(s._eventId)) return false;
    leadSeen.add(key);
    leadByPub.set(pub, (leadByPub.get(pub) || 0) + 1);
    if (s._eventId != null) leadEventIds.add(s._eventId);
    lead.push(s);
    return true;
  };
  // 1) Guarantee India presence (best India stories by importance) so the
  //    India-anchored front page is never squeezed out by world wire volume.
  for (const s of indiaRanked) { if (lead.length >= INDIA_LEAD_MIN) break; tryAddLead(s); }
  // 2) Fill the rest with the most-corroborated stories overall (India + world).
  for (const s of [...indiaRanked, ...restRanked].sort(rankLead)) {
    if (lead.length >= LEAD_MAX) break;
    tryAddLead(s);
  }
  // 3) Order the finished front page by importance so the biggest story leads.
  lead.sort(rankLead);
  pool.major_events = lead;

  // Verification line (Sprint 17): the curated front page with each story's raw
  // corroboration, sport flag, and effective (down-weighted) corroboration, so
  // it is provable from the log that sport is no longer leading the news.
  const sportLeadN = lead.filter((s) => s._isSport).length;
  console.log(
    `[fetch] RSS front page (lead ${lead.length}, sport-flagged ${sportLeadN}, SPORT_LEAD_WEIGHT=${SPORT_LEAD_WEIGHT}):\n` +
    lead.map((s, i) => `  ${i + 1}. nw=${nwOf(s) ?? '-'} corr=${s._eventCorr || s._corr || 1}${(s._eventCorr || 1) > (s._corr || 1) ? `(src${s._corr || 1})` : ''}${s._isSport ? `→${effCorr(s).toFixed(1)} [sport]` : ''} · ${(s.headline || '').slice(0, 80)}`).join('\n'),
  );

  // Strip internal fields -> clean RssStory.
  for (const sec of SECTIONS) {
    pool[sec] = (pool[sec] as PoolItem[]).map(({ _tier, _secs, _w, _emb, _corr, _isSport, _eventCorr, _eventSig, _eventId, ...rest }) => rest as RssStory);
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
