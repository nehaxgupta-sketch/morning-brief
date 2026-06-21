// src/pages/api/generate-desks.tsx
//
// Sprint 14 — DESKS. One API, separate from generate-brief.tsx by design
// (keeps the 4.3k-line brief pipeline from growing; own 300s budget).
//
// What a desk edition is: ~20 stories grouped like a real newspaper section
// plus a desk editorial, written in the desk's own voice (stored per desk row
// in the `desks` table and injected into prompts).
//
// Per-desk pipeline:
//   1. Two-pass fetch (gpt-4o-mini-search-preview):
//        Pass 1 — ~12 hard news developments from the last 24-48h
//        Pass 2 — ~8 features / analyses / interviews / explainers from the
//                 last 7 days
//      Whitelist-checked post-fetch; 7-day used-URL exclusion derived from
//      this desk's own prior editions (see loadRecentUsedUrls — no external
//      table dependency).
//   2. Write (gpt-4o-mini, desk voice): distributes kept stories into the
//      locked content shape — lens + top_stories(5) + india(4) + global(3) +
//      features(4) + quick_takes(4) + desk_editorial.
//   3. Save to desk_editions (status 'ready', or 'thin' below the 15-story
//      floor — written anyway, with a logged warning).
//   4. Score (gpt-4o-mini, 7-dim rubric + the Sprint 13 deterministic
//      empty-section penalty) → brief_scores with edition = 'desk:<slug>'.
//
// COST GATE: only desks with ≥1 subscriber are processed. Zero subscribers,
// zero cost. ~$0.05/desk/day on the mini models; all 6 live ≈ $0.30/day.
// Every call logs to brief_costs under the new 'desk' phase.
//
// RESUMABLE BY DESIGN: each run processes any subscribed, active desk that
// lacks today's edition (ready or thin), desk concurrency 2, and stops
// STARTING new desks once ~200s have elapsed. Cron hits this endpoint TWICE
// (06:20 and 06:27 IST); the second hit sweeps whatever the first didn't
// finish. A desk that failed outright (status 'failed') is also retried by
// the next hit.
//
// Body options (all POST):
//   {}                      → normal run (subscriber-gated, resumable)
//   { "desk": "business" }  → force ONE desk regardless of subscribers and
//                             even if today's edition exists (admin re-run)

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { isWhitelistedSource } from '@/lib/whitelist';
import { logOpenAICost, extractUsageFromChatCompletion } from '@/lib/cost-log';
import { attachLogCapture } from '@/lib/log-capture';

export const config = { maxDuration: 300 };

// ─── Env / clients ──────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─── Tunables ───────────────────────────────────────────────────────────────

const DESK_CONCURRENCY = 2;          // desks in flight at once (TPM discipline,
                                     // same lesson as tail-fetch's cap of 3 —
                                     // each desk makes 2 search calls, so 2
                                     // desks ≈ 4 concurrent search requests)
const TIME_BUDGET_MS = 200_000;      // stop STARTING new desks after this
const STORY_FLOOR = 15;              // below this → status 'thin' + warning
const FEATURE_TARGET = 8;            // 7-day features fetch ask (a couple extra to survive whitelist drops)
const DESK_FETCH_MODEL = 'gpt-4o-mini-search-preview';
const DESK_WRITE_MODEL = 'gpt-4o-mini'; // writer AND scorer (mini, per cost gate)

// ── Sprint 17: feature liveness + recency verification ──────────────────────
// The search model (gpt-4o-mini-search-preview) returns "last 7 days" features
// that are sometimes a YEAR stale (a July-2025 royalties piece, a Jan-2026
// AR Rahman piece) or point at dead URLs (a cntraveller 404). The model's own
// published_at is unreliable AND is dropped before the edition is written, so a
// date filter on stored content catches nothing. We instead VERIFY each feature
// against its source: fetch the page, drop a hard 4xx/5xx (broken link), read the
// real publish date from the page's meta/JSON-LD and drop anything older than the
// window. Only features are verified (a small set), not the whole pool (pool
// stories are already recency-gated upstream in the brief).
const FEATURE_MAX_AGE_DAYS = Math.max(1, parseInt(process.env.DESK_FEATURE_MAX_AGE_DAYS || '21', 10) || 21);
// What to do when the verification fetch itself fails (timeout / publisher blocks
// Vercel's IP): 'drop' (default — an unverifiable feature carries the same risk
// as the stale ones) or 'keep' (loosen if desks thin from reachability).
const FEATURE_VERIFY_ONFAIL = (process.env.DESK_FEATURE_VERIFY_ONFAIL || 'drop').toLowerCase() === 'keep' ? 'keep' : 'drop';

// ─── Auth (same contract as generate-brief: CRON_SECRET or session token) ───

async function authoriseRequest(req: NextApiRequest): Promise<{ ok: boolean; via: string }> {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret) {
    console.warn('[desks:auth] CRON_SECRET not set — endpoint is open. Set it in Vercel env to enforce.');
    return { ok: true, via: 'open' };
  }
  if (token && token === secret) return { ok: true, via: 'cron-secret' };
  if (token) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) return { ok: true, via: `user:${data.user.email || data.user.id}` };
    } catch { /* fall through */ }
  }
  return { ok: false, via: 'unauthorised' };
}

// ─── Date helper (IST) ──────────────────────────────────────────────────────

function getISTDate(offsetDays = 0): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

// ─── JSON extraction ────────────────────────────────────────────────────────

function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface DeskRow {
  slug: string;
  name: string;
  emoji: string;
  description: string;
  voice: string;
  status: string;
  sort_order: number;
}

interface RawDeskStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  kind?: string;    // features only: FEATURE | ANALYSIS | INTERVIEW | EXPLAINER
  segment?: string; // pool stories only: which raw_stories/tail bucket it came from
}

interface DeskEditionContent {
  desk: string;
  date: string;
  lens: string;
  top_stories: any[];
  india: any[];
  global: any[];
  features: any[];
  quick_takes: any[];
  desk_editorial: { title: string; body: string };
}

// ─── Shared daily pool (Sprint 14.2) ────────────────────────────────────────
//
// The big change: desks no longer fetch their own hard news with the weak
// search model. They draw from the SHARED POOL the main pipeline already
// fetched with the strong tools (gpt-5 / Perplexity) — every article section
// of today's brief plus every tail brief — deduped by URL and whitelist-
// rechecked. Each desk's writer reads the WHOLE pool and selects what's
// relevant to its scope (cross-listing allowed: one RBI story can surface in
// business, markets, and politics). Only the 7-day features pass still does a
// fresh fetch, because that depth isn't in the daily pool.
//
// Pool sources:
//   briefs.raw_stories  — major_events, world, india, business, technology,
//                         climate_health, sport, culture, politics, markets_news
//   tail_briefs.stories — city / interest / industry tail fetches (today, ready)
// (Personalised briefs are derived from these same sources, so including them
//  would add nothing but duplicates — we skip them.)

const POOL_SECTIONS = [
  'major_events', 'world', 'india', 'business', 'technology',
  'climate_health', 'sport', 'culture', 'politics', 'markets_news',
];

function normalisePoolStory(s: any, segment: string): RawDeskStory | null {
  if (!s || typeof s !== 'object') return null;
  const headline = typeof s.headline === 'string' ? s.headline : '';
  const body = typeof s.body === 'string' ? s.body
    : typeof s.what_happened === 'string' ? s.what_happened
    : typeof s.facts === 'string' ? s.facts
    : typeof s.summary === 'string' ? s.summary : '';
  const source = typeof s.source === 'string' ? s.source : '';
  const source_url = typeof s.source_url === 'string' ? s.source_url : '';
  if (!headline || !source_url) return null;
  if (!isWhitelistedSource(source_url)) return null;
  return { headline, body, source, source_url, segment } as RawDeskStory;
}

// ─── #3 (Sprint 17): deterministic per-desk relevance pre-filter ─────────────
//
// Relevance was a prompt-only instruction to gpt-4o-mini, which is handed the
// WHOLE day's cross-section pool ("NOT pre-filtered to this desk") and fills
// slots — quick_takes especially — with off-theme filler (yoga and AI-funding
// in the Sport desk; thermal-coal and asylum-seekers in Entertainment; school
// textbooks in Tech). We now gate the pool to each desk's scope BEFORE the
// writer sees it: a story is a candidate if it comes from one of the desk's
// HOME sections, or its headline/body matches the desk's keyword set. The writer
// still does the final editorial pick — but only from genuine candidates. This
// is the same "deterministic guardrail around LLM judgement" the main brief uses.
// A desk not listed here is left unfiltered (preserves behaviour for new desks).
const DESK_HOME_SECTIONS: Record<string, string[]> = {
  business:      ['business', 'markets_news'],
  markets:       ['business', 'markets_news'],
  tech:          ['technology'],
  entertainment: ['culture'],
  sport:         ['sport'],
  // politics has no dedicated brief bucket — political stories live inside the
  // generic `india` section mixed with non-political ones, so it is keyword-only.
  politics:      [],
};
const DESK_KEYWORDS: Record<string, string[]> = {
  business: ['rbi', 'sebi', 'earnings', 'ipo', 'merger', 'acquisition', 'm&a', 'revenue', 'profit', 'startup', 'funding', 'corporate', 'economy', 'gdp', 'inflation', 'tax', 'tariff', 'export', 'import', 'bank', 'investment', 'stock', 'equity', 'bond', 'rupee', 'sensex', 'nifty', 'fpi', 'fii', 'quarterly', 'results', 'layoff', 'hiring', 'deal', 'manufacturing', 'industry', 'fiscal', 'liquidity', 'capital', 'company'],
  markets: ['sensex', 'nifty', 'stock', 'equity', 'bond', 'yield', 'rupee', 'dollar', 'currency', 'commodity', 'crude', 'oil', 'gold', 'fpi', 'fii', 'rally', 'selloff', 'index', 'rate', 'rbi', 'inflation', 'portfolio', 'mutual fund', 'etf', 'ipo', 'buyback', 'liquidity', 'capital', 'valuation', 'earnings', 'investor'],
  tech: ['artificial intelligence', ' ai ', 'startup', 'chip', 'semiconductor', 'software', 'cloud', 'cyber', 'google', 'microsoft', 'apple', 'meta', 'openai', 'anthropic', 'nvidia', 'digital', 'internet', 'platform', 'algorithm', 'smartphone', '5g', 'quantum', 'robot', 'automation', 'space', 'satellite', 'isro', 'in-space', 'saas', 'fintech', 'crypto', 'data centre', 'data center'],
  entertainment: ['film', 'movie', 'bollywood', 'hollywood', 'cinema', 'box office', 'ott', 'streaming', 'netflix', 'prime video', 'music', 'album', 'song', 'singer', 'actor', 'actress', 'director', 'celebrity', 'award', 'festival', 'series', 'theatre', 'concert', 'trailer', 'rahman', 'royalt', 'artist'],
  sport: ['cricket', 'football', 'soccer', 'fifa', 'world cup', 'ipl', 'test ', 'odi', 't20', 'wicket', 'batsman', 'bowler', 'tennis', 'wimbledon', 'formula', 'grand prix', ' f1 ', 'badminton', 'hockey', 'kabaddi', 'pkl', 'olympic', 'medal', 'tournament', 'league', 'match', 'striker', 'midfielder', 'championship', 'isl', 'wrestling', 'athletics', 'chess', 'squad', 'selector'],
  politics: ['parliament', 'modi', 'bjp', 'congress', 'election', 'vote', 'poll', 'government', 'minister', 'cabinet', 'supreme court', 'high court', 'lok sabha', 'rajya sabha', 'governance', 'coalition', 'chief minister', 'rahul gandhi', 'amit shah', 'opposition', 'assembly', 'constitution', 'verdict', 'reservation', 'caste', 'policy', 'bill', 'party'],
};
function isRelevantToDesk(story: RawDeskStory, desk: DeskRow): boolean {
  // Unknown desk → don't filter (keep prior behaviour).
  if (!(desk.slug in DESK_KEYWORDS) && !(desk.slug in DESK_HOME_SECTIONS)) return true;
  const home = DESK_HOME_SECTIONS[desk.slug] || [];
  const seg = String(story.segment || '').replace(/^tail:/, '').toLowerCase();
  if (home.includes(seg)) return true;
  const kws = DESK_KEYWORDS[desk.slug] || [];
  const text = ` ${(story.headline || '')} ${(story.body || '')} `.toLowerCase();
  return kws.some((k) => text.includes(k));
}

// ─── #2 (Sprint 17): cross-section dedup of the writer's output ──────────────
//
// enforceDeskSourceUrls validates each section's URLs but never dedupes ACROSS
// sections, so when the writer (against its own instruction) places one story in
// two sections of the SAME desk, both survive — today's Entertainment desk ran
// "AR Rahman…" and "Digital Boom… Royalties" in BOTH features and top_stories;
// Sport ran one Iran-travel story in BOTH global and quick_takes. Walk sections
// in priority order; a story already used in a higher-priority section is
// dropped. Primary key is source_url (the writer carries it verbatim, so a
// reused pool/feature story is caught even if its headline was reworded); a
// significant-word headline overlap catches the rarer reworded-different-URL case.
function deskSigWords(headline: string): Set<string> {
  const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'over', 'after', 'amid', 'that', 'this', 'than', 'india', 'indian', 'new', 'says', 'said']);
  return new Set(
    String(headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}
function dedupeAcrossSections(content: any): { content: any; removed: number } {
  const order = ['top_stories', 'india', 'global', 'features', 'quick_takes'];
  const seenUrls = new Set<string>();
  const seenSigs: Set<string>[] = [];
  let removed = 0;
  const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; a.forEach((w) => { if (b.has(w)) n++; }); return n; };
  for (const sec of order) {
    if (!Array.isArray(content?.[sec])) continue;
    content[sec] = content[sec].filter((s: any) => {
      const url = String(s?.source_url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
      if (url && seenUrls.has(url)) { removed++; return false; }
      const sig = deskSigWords(s?.headline || '');
      for (const prev of seenSigs) { if (overlap(sig, prev) >= 5) { removed++; return false; } }
      if (url) seenUrls.add(url);
      seenSigs.push(sig);
      return true;
    });
  }
  return { content, removed };
}

// ─── #1 (Sprint 17): feature liveness + recency verification ────────────────
const VERIFY_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};
async function fetchPageForVerify(url: string, ms = 9000): Promise<{ status: number; html: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: VERIFY_HEADERS, redirect: 'follow', signal: ctrl.signal });
    const html = res.ok ? (await res.text()).slice(0, 24000) : '';
    return { status: res.status, html };
  } catch { return null; } finally { clearTimeout(timer); }
}
function extractPublishedTs(html: string): number | null {
  const patterns: RegExp[] = [
    /<meta[^>]+(?:property|name)=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']article:published_time["']/i,
    /<meta[^>]+(?:property|name)=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+(?:property|name)=["']og:updated_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+(?:name)=["'](?:date|pubdate|publishdate|publish-date|dc\.date\.issued|dc\.date)["'][^>]+content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /"dateModified"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) { const t = Date.parse(m[1]); if (!Number.isNaN(t)) return t; }
  }
  return null;
}
async function verifyFeatures(features: RawDeskStory[], label: string): Promise<RawDeskStory[]> {
  if (!features.length) return features;
  const cutoff = Date.now() - FEATURE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const out: RawDeskStory[] = [];
  let dead = 0, stale = 0, failHandled = 0;
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < features.length) {
      const f = features[idx++];
      const res = await fetchPageForVerify(f.source_url);
      if (res === null) {                 // fetch failed (timeout / blocked IP)
        if (FEATURE_VERIFY_ONFAIL === 'keep') out.push(f);
        failHandled++;
        continue;
      }
      if (res.status >= 400 || res.status === 0) { dead++; continue; }  // broken link → drop
      const ts = extractPublishedTs(res.html);
      if (ts !== null && ts < cutoff) { stale++; continue; }            // confirmed stale → drop
      if (ts !== null) f.published_at = new Date(ts).toISOString().slice(0, 10); // backfill real date
      out.push(f);                         // live + (recent OR no extractable date)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`[desk:${label}:verify] features in=${features.length} kept=${out.length} dropped(dead=${dead}, stale=${stale}, fetch-fail=${failHandled}, onfail=${FEATURE_VERIFY_ONFAIL})`);
  return out;
}

async function loadSharedPool(): Promise<RawDeskStory[]> {
  const today = getISTDate();
  const byUrl = new Map<string, RawDeskStory>();

  // 1. Main brief raw_stories (any one edition row — all three share it).
  const { data: briefRows, error: briefErr } = await supabase
    .from('briefs')
    .select('raw_stories')
    .eq('date', today)
    .limit(1);
  if (briefErr) {
    console.warn(`[desks:pool] briefs read failed (non-fatal): ${briefErr.message}`);
  } else if (briefRows && briefRows[0]?.raw_stories) {
    const raw = briefRows[0].raw_stories as any;
    for (const sec of POOL_SECTIONS) {
      const arr = raw[sec];
      if (Array.isArray(arr)) {
        for (const s of arr) {
          const n = normalisePoolStory(s, sec);
          if (n && !byUrl.has(n.source_url)) byUrl.set(n.source_url, n);
        }
      }
    }
  }

  // 2. Tail briefs (city / interest / industry), today, ready.
  const { data: tailRows, error: tailErr } = await supabase
    .from('tail_briefs')
    .select('tail_type, tail_key, stories, status')
    .eq('date', today)
    .eq('status', 'ready');
  if (tailErr) {
    console.warn(`[desks:pool] tail_briefs read failed (non-fatal): ${tailErr.message}`);
  } else {
    for (const row of (tailRows || []) as any[]) {
      const arr = row.stories;
      if (Array.isArray(arr)) {
        for (const s of arr) {
          const n = normalisePoolStory(s, `tail:${row.tail_type}`);
          if (n && !byUrl.has(n.source_url)) byUrl.set(n.source_url, n);
        }
      }
    }
  }

  const pool = Array.from(byUrl.values());
  console.log(`[desks:pool] assembled ${pool.length} unique stories from raw_stories + tail`);
  return pool;
}

// ─── 7-day URL dedup (self-contained, derived from this desk's own editions) ─
//
// Spec §11.3 originally said reuse tail_used_urls (tail_type='desk'). During
// Sprint 14 validation two problems with that surfaced: (1) the tail-fetch
// stage's same-day cleanup runs `delete().eq('date', today)` with no
// tail_type filter, so it wipes desk rows written earlier that morning, and
// (2) tail_used_urls.tail_type may carry a CHECK constraint that rejects
// 'desk'. Both silently degrade dedup. So instead we derive the exclude list
// from THIS desk's own stored editions over the previous 6 days — zero
// external-table dependency, and guaranteed to reflect exactly what was
// published. Windowed to [today-7, today-1] (i.e. NOT today) so a same-day
// admin re-run regenerates freely instead of excluding what it just shipped.

async function loadRecentUsedUrls(slug: string): Promise<string[]> {
  const startDate = getISTDate(-7);
  const endDate = getISTDate(-1);
  const { data, error } = await supabase
    .from('desk_editions')
    .select('content')
    .eq('desk_slug', slug)
    .in('status', ['ready', 'thin'])
    .gte('date', startDate)
    .lte('date', endDate);
  if (error) {
    console.warn(`[desk:${slug}] used-url lookup failed (non-fatal): ${error.message}`);
    return [];
  }
  const urls = new Set<string>();
  for (const row of (data || []) as any[]) {
    const c = row.content;
    if (!c) continue;
    for (const k of ['top_stories', 'india', 'global', 'features', 'quick_takes']) {
      if (Array.isArray(c[k])) {
        for (const s of c[k]) {
          if (s && typeof s.source_url === 'string') urls.add(s.source_url);
        }
      }
    }
  }
  return Array.from(urls);
}

function formatExcludeBlock(urls: string[]): string {
  if (urls.length === 0) return '';
  const trimmed = urls.slice(0, 40);
  return `\nEXCLUDE — these URLs were already covered in this desk in the last week; do NOT include them again:\n${trimmed.map((u) => `- ${u}`).join('\n')}\n`;
}

// ─── Shared whitelist prompt block ──────────────────────────────────────────

function whitelistBlock(): string {
  return `SOURCE WHITELIST — direct article URLs only from these publishers:
Global wires/papers: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist, Al Jazeera, ABC News Australia.
India national: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, Financial Express, Moneycontrol, Business Today, The Hindu BusinessLine, NDTV, Times of India, Deccan Herald, New Indian Express, Telegraph India, Tribune India.
India digital: The Print, Scroll, The Wire, India Today, Outlook India, The Quint, Caravan, The News Minute.
India wires: PTI, ANI.
India specialist: Live Law, Bar & Bench (law), Down To Earth (environment).
Government primary: RBI, SEBI, MoSPI, PIB.
Specialist: TechCrunch, The Verge, Wired, Ars Technica (tech), Nature, Science, STAT (science/health), Variety, Hollywood Reporter (entertainment), ESPNCricinfo, ESPN (sport).
No aggregators, no social media, no Google News redirects. Only return URLs you actually retrieved from a search result — never construct or guess a URL.`;
}

// ─── Search-model call (mirrors callTailFetch's mini-search path) ───────────

async function callDeskSearch(
  prompt: string,
  label: string,
  slug: string,
  cap: number,
): Promise<RawDeskStory[]> {
  let text = '';
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: DESK_FETCH_MODEL,
        web_search_options: {},
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5000,
      }),
    });
    const data = await response.json();
    if (response.status !== 200) {
      console.warn(`[desk:${label}] ${DESK_FETCH_MODEL} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
      return [];
    }
    const usage = extractUsageFromChatCompletion(data);
    void logOpenAICost({
      phase: 'desk',
      model: DESK_FETCH_MODEL,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      detail: label,
    });
    text = data?.choices?.[0]?.message?.content || '';
  } catch (err: any) {
    console.warn(`[desk:${label}] network/api error: ${err?.message || err}`);
    return [];
  }

  if (!text) {
    console.warn(`[desk:${label}] empty text in response`);
    return [];
  }

  let parsed: any;
  try {
    parsed = extractJsonObject(text);
  } catch (err: any) {
    console.warn(`[desk:${label}] JSON parse failed: ${err.message}. Preview: ${text.slice(0, 300)}`);
    return [];
  }

  const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
  const kept: RawDeskStory[] = [];
  const seenUrls = new Set<string>();
  for (const s of raw) {
    if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string' || typeof s.source !== 'string') continue;
    if (!isWhitelistedSource(s.source_url)) {
      console.warn(`[desk:${label}] dropping non-whitelisted source: ${s.source_url}`);
      continue;
    }
    if (seenUrls.has(s.source_url)) continue;
    seenUrls.add(s.source_url);
    kept.push(s as RawDeskStory);
    if (kept.length >= cap) break;
  }
  return kept;
}

// ─── Features fetch (the one fresh fetch desks still do) ─────────────────────

async function fetchDeskFeatures(desk: DeskRow, excludeUrls: string[]): Promise<RawDeskStory[]> {
  const today = getISTDate();
  const prompt = `You are the features editor sourcing the "${desk.name}" section for Morning Brief, a daily digest for thoughtful urban Indian professionals (25-45). Today is ${today}.

DESK SCOPE: ${desk.description}

Search the web for ${FEATURE_TARGET}-10 substantial NON-BREAKING pieces published in the LAST 7 DAYS in this desk's scope: features, analyses, interviews, profiles, and explainers. The pieces a good weekend section would run — depth over recency. India-relevant preferred; global pieces welcome when they illuminate something for Indian readers.

STRICT RECENCY: only include pieces published within the last 14 days. Do NOT include anything older, however good — no archive pieces, no "evergreen" explainers from months ago. Every item MUST carry an accurate published_at (YYYY-MM-DD); if you cannot establish a recent date for a piece, leave it out.

Each item: paraphrase the piece's argument or substance into 2-4 sentences — do NOT quote at length. Tag each with its kind. Headlines must be your own summary, not the original title verbatim. Source diversity matters: no more than 3 from any one publisher.
${formatExcludeBlock(excludeUrls)}
${whitelistBlock()}

Return ONLY a JSON object — no markdown:
{
  "stories": [
    {
      "headline": "your factual summary headline",
      "body": "2-4 sentence summary of the piece's substance",
      "kind": "FEATURE" | "ANALYSIS" | "INTERVIEW" | "EXPLAINER",
      "source": "Publisher Name",
      "source_url": "https://...",
      "published_at": "YYYY-MM-DD"
    }
  ]
}`;
  return verifyFeatures(await callDeskSearch(prompt, `${desk.slug}:features`, desk.slug, FEATURE_TARGET + 2), desk.slug);
}

// ─── Writer ─────────────────────────────────────────────────────────────────

async function callDeskWriter(prompt: string, label: string): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DESK_WRITE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 12000,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await response.json();
  const usage = extractUsageFromChatCompletion(data);
  void logOpenAICost({
    phase: 'desk',
    model: DESK_WRITE_MODEL,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail: label,
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Empty writer response (${label}): ${JSON.stringify(data).slice(0, 400)}`);
  return extractJsonObject(text);
}

async function writeDeskEdition(
  desk: DeskRow,
  poolForDesk: RawDeskStory[],
  features: RawDeskStory[],
): Promise<DeskEditionContent> {
  const today = getISTDate();
  const prompt = `You are writing today's "${desk.name}" desk edition for Morning Brief — a full newspaper-section daily read for thoughtful urban Indian professionals (25-45) who subscribed to this desk specifically. Today is ${today}.

DESK VOICE (write the ENTIRE edition in this register):
${desk.voice}

You are given two pools of raw stories:
- POOL (today's hard news, fetched across ALL of today's news — NOT pre-filtered to this desk): the candidate set for top_stories, india, global, and quick_takes. SELECT only the stories genuinely relevant to THIS desk's scope and IGNORE the rest. A single story may be relevant to several desks — judge it on this desk's scope. Each pool story carries a "segment" hint (e.g. business, india, world, tail:interest) — a clue, not a rule.
- FEATURES (last 7 days, already specific to this desk): for the features section ONLY.

DESK SCOPE (use this to decide what's relevant from the POOL): ${desk.description}

STRUCTURE — distribute the SELECTED stories into these sections:

1. lens: ONE sentence (≤ 30 words) capturing what today means for this desk. The line a section editor would put at the top of the page.

2. top_stories: the 5 MOST consequential hard-news stories, full detail. Each:
   - headline: clear, factual (≤ 16 words), leading with the subject
   - facts: 1-2 sentences. What happened — numbers, names, dates.
   - background: 1-2 sentences. What led here; why it's bigger than the headline.
   - why_it_matters: 1-2 sentences. ANCHOR TO INDIA and to this desk's reader specifically — the sector, portfolio, industry, or cultural impact. Name the transmission channel.
   - source, source_url: carried VERBATIM from the raw story.

3. india: the next 4 most important INDIA-CENTRED hard-news stories, same field shape as top_stories.

4. global: 3 hard-news stories from outside India that this desk's reader needs, same field shape. why_it_matters must still name the Indian angle.

5. features: 4 pieces from the FEATURES pool. Each:
   - headline (your own, ≤ 16 words)
   - body: 2-4 sentences conveying the piece's substance and why it's worth the reader's time
   - kind: carried from the raw story (FEATURE / ANALYSIS / INTERVIEW / EXPLAINER)
   - source, source_url: carried VERBATIM.

6. quick_takes: 4 remaining hard-news items as two-sentence briefs. Each:
   - headline (≤ 14 words)
   - body: EXACTLY 2 sentences.
   - source, source_url: carried VERBATIM.

7. desk_editorial: 250-350 words of flowing prose IN THE DESK VOICE — the section's leader column. Pick the day's most important thread in this desk's world and go deep: context, stakes, second-order implications, a forward-looking close. Title ≤ 12 words, an angle not a headline. Do not merely summarise the stories above.

HARD RULES:
- USE ONLY THE RAW STORIES PROVIDED BELOW. Do not invent, infer, or recall stories from your own knowledge. Every source_url you output must appear VERBATIM in the inputs below.
- SELECT for relevance: only include POOL stories that genuinely belong in this desk. A thin but relevant edition beats a padded one full of off-topic stories.
- Each story may be used in AT MOST ONE section. No story appears twice.
- If relevant stories are fewer than the slots, fill sections in priority order (top_stories → india → global → features → quick_takes) and leave later arrays SHORT or empty rather than fabricating. Never pad with off-topic stories.
- If there are not enough India-centred stories for the india section, move global stories up — but never fabricate an Indian angle the raw story does not support.
- EVERY field listed for a section is REQUIRED on every story in it. Null/missing text fields are NOT acceptable.
- Output ONLY JSON. No markdown fences, no commentary. Start with { and end with }.

OUTPUT SHAPE:
{
  "desk": "${desk.slug}",
  "date": "${today}",
  "lens": "...",
  "top_stories": [{ "headline": "...", "facts": "...", "background": "...", "why_it_matters": "...", "source": "...", "source_url": "..." }],
  "india":       [ /* same shape, 4 */ ],
  "global":      [ /* same shape, 3 */ ],
  "features":    [{ "headline": "...", "body": "...", "kind": "FEATURE", "source": "...", "source_url": "..." }],
  "quick_takes": [{ "headline": "...", "body": "...", "source": "...", "source_url": "..." }],
  "desk_editorial": { "title": "...", "body": "250-350 words" }
}

POOL (today's cross-topic hard news — SELECT what fits this desk):
${JSON.stringify(poolForDesk)}

RAW FEATURES (last 7 days, this desk):
${JSON.stringify(features)}`;

  return callDeskWriter(prompt, `write:${desk.slug}`);
}

// ─── Post-write source-URL guard ────────────────────────────────────────────
// The writer is forbidden from inventing URLs, but enforce it anyway: any
// story whose source_url is not whitelisted OR not present in the raw pools
// is dropped. (Same belt-and-braces as generate-brief's stripNonWhitelisted.)

function enforceDeskSourceUrls(
  content: any,
  rawUrls: Set<string>,
): { content: any; dropped: number } {
  let dropped = 0;
  const guard = (arr: any) => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((s: any) => {
      const ok = s && typeof s.source_url === 'string'
        && rawUrls.has(s.source_url)
        && isWhitelistedSource(s.source_url);
      if (!ok) dropped++;
      return ok;
    });
  };
  content.top_stories = guard(content.top_stories);
  content.india = guard(content.india);
  content.global = guard(content.global);
  content.features = guard(content.features);
  content.quick_takes = guard(content.quick_takes);
  return { content, dropped };
}

function deskStoryCount(content: any): number {
  return ['top_stories', 'india', 'global', 'features', 'quick_takes']
    .reduce((n, k) => n + (Array.isArray(content?.[k]) ? content[k].length : 0), 0);
}

// ─── Scorer (7-dim rubric + deterministic empty-section penalty) ────────────

const DESK_SECTIONS = ['top_stories', 'india', 'global', 'features', 'quick_takes'];

function deskEmptySectionCount(content: any): number {
  let empty = 0;
  for (const sec of DESK_SECTIONS) {
    if (!Array.isArray(content?.[sec]) || content[sec].length === 0) empty++;
  }
  return empty;
}

async function scoreDeskEdition(desk: DeskRow, content: any): Promise<void> {
  const today = getISTDate();
  const compact = JSON.stringify(content, null, 0).slice(0, 26000);

  const prompt = `You are the quality auditor for Morning Brief. You score one DESK edition — a full newspaper-section daily read — against a 7-dimension rubric. Be honest and discerning. Most production editions score 50-62/70; 70/70 is rare.

DESK SCORED: ${desk.name} (${desk.slug}). Desk scope: ${desk.description}
DESK VOICE the writing should match: ${desk.voice}

RUBRIC — score each dimension 0-10:
1. COVERAGE: Does the edition cover the most consequential developments in this desk's scope? Glaring omissions a rival section would lead with?
2. FIELD COMPLETENESS: top_stories/india/global need headline, facts, background, why_it_matters on every story; features need headline, body, kind; quick_takes need headline + 2-sentence body. Empty/null/placeholder text reduces this significantly.
3. INDIA ANCHOR: Do stories — even global ones — name a specific Indian transmission channel relevant to this desk's reader?
4. SOURCE QUALITY: Diverse (no publisher dominating, none above ~30% of stories), authoritative sources?
5. EDITORIAL SHARPNESS: Does the edition hold the desk voice described above? Is the desk_editorial a genuine leader column with a point of view, or a summary? Specific names/numbers/dates over generic phrases.
6. CURRENTNESS: Hard-news headlines describe TODAY'S development, not the running narrative. Features may be up to 7 days old — that is by design, do not penalise their age.
7. RELEVANCE: Right mix and depth for a reader who chose to subscribe to THIS desk specifically?

EDITION CONTENT:
${compact}

OUTPUT — return ONLY this JSON, no preamble, no markdown:
{
  "dim_coverage": <integer 0-10>,
  "dim_field_completeness": <integer 0-10>,
  "dim_india_anchor": <integer 0-10>,
  "dim_source_quality": <integer 0-10>,
  "dim_editorial_sharpness": <integer 0-10>,
  "dim_currentness": <integer 0-10>,
  "dim_relevance": <integer 0-10>,
  "notes": "<2-3 sentence assessment naming the strongest and weakest dimension>"
}`;

  let parsed: any;
  try {
    parsed = await callDeskWriter(prompt, `score:${desk.slug}`);
  } catch (e: any) {
    console.warn(`[desk:${desk.slug}] scoring failed (non-fatal): ${e?.message || e}`);
    return;
  }

  const clamp = (n: any) => {
    const v = typeof n === 'number' ? Math.round(n) : parseInt(String(n || 0), 10);
    if (isNaN(v)) return 0;
    return Math.max(0, Math.min(10, v));
  };

  const dim_coverage_raw        = clamp(parsed?.dim_coverage);
  const dim_field_raw           = clamp(parsed?.dim_field_completeness);
  const dim_india_anchor        = clamp(parsed?.dim_india_anchor);
  const dim_source_quality      = clamp(parsed?.dim_source_quality);
  const dim_editorial_sharpness = clamp(parsed?.dim_editorial_sharpness);
  const dim_currentness         = clamp(parsed?.dim_currentness);
  const dim_relevance           = clamp(parsed?.dim_relevance);

  // Sprint 13 discipline carried over: deterministic -5 per empty section on
  // Coverage AND Field Completeness, computed in code.
  const emptySections = deskEmptySectionCount(content);
  const penalty = emptySections * 5;
  const dim_coverage           = Math.max(0, dim_coverage_raw - penalty);
  const dim_field_completeness = Math.max(0, dim_field_raw - penalty);
  if (emptySections > 0) {
    console.warn(`[desk-score:${desk.slug}] ${emptySections} empty section(s) → -${penalty} on coverage and field_completeness.`);
  }

  const total =
    dim_coverage + dim_field_completeness + dim_india_anchor +
    dim_source_quality + dim_editorial_sharpness + dim_currentness + dim_relevance;

  const { error } = await supabase
    .from('brief_scores')
    .upsert(
      {
        date: today,
        edition: `desk:${desk.slug}`,
        dim_coverage,
        dim_field_completeness,
        dim_india_anchor,
        dim_source_quality,
        dim_editorial_sharpness,
        dim_currentness,
        dim_relevance,
        total,
        max_score: 70,
        notes: (typeof parsed?.notes === 'string' ? parsed.notes.slice(0, 800) : '')
          + (emptySections > 0 ? ` [auto-penalty: ${emptySections} empty section(s), -${penalty} on coverage & field completeness]` : ''),
      },
      { onConflict: 'date,edition' },
    );
  if (error) console.warn(`[desk-score:${desk.slug}] brief_scores upsert failed (non-fatal): ${error.message}`);
}

// ─── Per-desk pipeline ──────────────────────────────────────────────────────

interface DeskRunResult {
  slug: string;
  status: 'ready' | 'thin' | 'failed';
  stories: number;
  reason?: string;
}

async function runDesk(desk: DeskRow, pool: RawDeskStory[]): Promise<DeskRunResult> {
  const today = getISTDate();
  const t0 = Date.now();
  console.log(`[desk:${desk.slug}] starting`);

  try {
    // 1. Hard news = the shared pool (already strong-fetched), minus anything
    //    this desk already ran in the last 6 days. Features = a fresh 7-day
    //    fetch (that depth isn't in the daily pool).
    const excludeUrls = new Set(await loadRecentUsedUrls(desk.slug));
    const poolFresh = pool.filter((s) => !excludeUrls.has(s.source_url));
    const poolForDesk = poolFresh.filter((s) => isRelevantToDesk(s, desk));
    const offTopic = poolFresh.length - poolForDesk.length;
    if (offTopic > 0) {
      console.log(`[desk:${desk.slug}] relevance filter dropped ${offTopic} off-scope pool stories (${poolForDesk.length} candidates remain).`);
    }
    const features = await fetchDeskFeatures(desk, Array.from(excludeUrls));
    console.log(`[desk:${desk.slug}] pool=${poolForDesk.length} features=${features.length}`);

    if (poolForDesk.length === 0 && features.length === 0) {
      await supabase.from('desk_editions').upsert(
        { desk_slug: desk.slug, date: today, content: null, status: 'failed', generated_at: new Date().toISOString() },
        { onConflict: 'desk_slug,date' },
      );
      return { slug: desk.slug, status: 'failed', stories: 0, reason: 'empty pool and no features' };
    }

    // 2. Write in desk voice — the writer SELECTS pool stories relevant to
    //    this desk's scope (cross-listing allowed) and distributes them.
    let content = await writeDeskEdition(desk, poolForDesk, features);

    // 3. Enforce: every output URL must come from the inputs + whitelist.
    const rawUrls = new Set<string>([...poolForDesk, ...features].map((s) => s.source_url));
    const enforced = enforceDeskSourceUrls(content, rawUrls);
    content = enforced.content;
    if (enforced.dropped > 0) {
      console.warn(`[desk:${desk.slug}] dropped ${enforced.dropped} stories with invented/non-whitelisted URLs post-write.`);
    }

    // Sprint 17 #2: remove the same story repeated across sections of this desk.
    const deduped = dedupeAcrossSections(content);
    content = deduped.content;
    if (deduped.removed > 0) {
      console.warn(`[desk:${desk.slug}] cross-section dedup removed ${deduped.removed} duplicate placement(s).`);
    }

    // Minimal structural validation.
    if (!content || typeof content.lens !== 'string' || !content.desk_editorial?.body) {
      throw new Error('Writer output failed structural validation (missing lens or editorial)');
    }
    content.desk = desk.slug;
    content.date = today;

    const count = deskStoryCount(content);
    const status: 'ready' | 'thin' = count >= STORY_FLOOR ? 'ready' : 'thin';
    if (status === 'thin') {
      console.warn(`[desk:${desk.slug}] THIN edition: ${count} stories (< floor ${STORY_FLOOR}). Shipping anyway with status=thin.`);
    }

    // 4. Save.
    const { error: saveErr } = await supabase.from('desk_editions').upsert(
      { desk_slug: desk.slug, date: today, content, status, generated_at: new Date().toISOString() },
      { onConflict: 'desk_slug,date' },
    );
    if (saveErr) throw new Error(`desk_editions save failed: ${saveErr.message}`);

    // 5. Score (non-fatal). 7-day dedup needs no write step — the next run
    //    derives its exclude list from saved editions (see loadRecentUsedUrls).
    await scoreDeskEdition(desk, content);

    console.log(`[desk:${desk.slug}] done in ${Math.round((Date.now() - t0) / 1000)}s — ${count} stories, status=${status}`);
    return { slug: desk.slug, status, stories: count };
  } catch (e: any) {
    console.error(`[desk:${desk.slug}] FAILED: ${e?.message || e}`);
    await supabase.from('desk_editions').upsert(
      { desk_slug: desk.slug, date: today, content: null, status: 'failed', generated_at: new Date().toISOString() },
      { onConflict: 'desk_slug,date' },
    ).then(({ error }) => {
      if (error) console.warn(`[desk:${desk.slug}] failed-status save also failed: ${error.message}`);
    });
    return { slug: desk.slug, status: 'failed', stories: 0, reason: e?.message || String(e) };
  }
}

// ─── Orchestrator — resumable, subscriber-gated, concurrency 2 ──────────────

async function runDesks(forceSlug?: string) {
  const today = getISTDate();
  const startedAt = Date.now();

  // 1. Catalog.
  const { data: deskRows, error: deskErr } = await supabase
    .from('desks')
    .select('slug, name, emoji, description, voice, status, sort_order')
    .eq('status', 'active')
    .order('sort_order', { ascending: true });
  if (deskErr) return { ok: false as const, error: `desks read failed: ${deskErr.message}` };
  const catalog = (deskRows || []) as DeskRow[];
  if (catalog.length === 0) {
    return { ok: true as const, date: today, processed: [], skipped: [], note: 'No active desks in catalog.' };
  }

  let pending: DeskRow[];
  const skipped: { slug: string; reason: string }[] = [];

  if (forceSlug) {
    // Admin force-run: one desk, ignore subscriber gate and existing edition.
    const target = catalog.find((d) => d.slug === forceSlug);
    if (!target) return { ok: false as const, error: `Unknown or inactive desk: ${forceSlug}` };
    pending = [target];
  } else {
    // 2. Cost gate: subscriber counts.
    const { data: subRows, error: subErr } = await supabase
      .from('desk_subscriptions')
      .select('desk_slug');
    if (subErr) return { ok: false as const, error: `subscriptions read failed: ${subErr.message}` };
    const subCounts: Record<string, number> = {};
    for (const r of (subRows || []) as any[]) {
      subCounts[r.desk_slug] = (subCounts[r.desk_slug] || 0) + 1;
    }

    // 3. Resumability: skip desks whose today-edition already exists as
    //    ready or thin. failed (or missing) → eligible for (re)processing.
    const { data: edRows } = await supabase
      .from('desk_editions')
      .select('desk_slug, status')
      .eq('date', today);
    const doneSlugs = new Set(
      ((edRows || []) as any[])
        .filter((r) => r.status === 'ready' || r.status === 'thin')
        .map((r) => r.desk_slug),
    );

    pending = [];
    for (const d of catalog) {
      if (!subCounts[d.slug]) { skipped.push({ slug: d.slug, reason: 'no subscribers' }); continue; }
      if (doneSlugs.has(d.slug)) { skipped.push({ slug: d.slug, reason: 'already generated today' }); continue; }
      pending.push(d);
    }
  }

  if (pending.length === 0) {
    const anySubscribed = forceSlug ? true : Object.keys(
      // recompute cheaply: a desk counts as subscribed if it appears in skipped
      // with a reason other than 'no subscribers'
      skipped.reduce((acc, s) => {
        if (s.reason !== 'no subscribers') acc[s.slug] = true
        return acc
      }, {} as Record<string, boolean>),
    ).length > 0
    const note = !anySubscribed
      ? 'No desks have subscribers yet — subscribe to a desk first (Desks tab), or use a per-desk RE-RUN to force one.'
      : "Nothing to do — every subscribed desk already has today's edition. Use a per-desk RE-RUN to regenerate."
    return { ok: true as const, date: today, processed: [], skipped, note }
  }

  console.log(`[desks] ${pending.length} desk(s) to process: ${pending.map((d) => d.slug).join(', ')}`);

  // Load the shared pool ONCE (all desks select from the same set).
  const pool = await loadSharedPool();
  if (pool.length === 0) {
    console.warn('[desks] shared pool is EMPTY — today\'s main brief raw_stories and tail briefs are both missing/unreadable. Desks will rely on their features fetch only.');
  }

  // 4. Process with concurrency 2 and the 200s start budget. A simple
  //    worker-pool: each worker pulls the next desk off the queue, but only
  //    if we're still inside the time budget — anything left is swept by the
  //    second cron hit.
  const queue = [...pending];
  const processed: DeskRunResult[] = [];
  const deferred: string[] = [];

  async function worker() {
    while (queue.length > 0) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Out of start-budget — drain the queue into deferred and stop.
        while (queue.length > 0) deferred.push(queue.shift()!.slug);
        return;
      }
      const desk = queue.shift();
      if (!desk) return;
      const result = await runDesk(desk, pool);
      processed.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DESK_CONCURRENCY, pending.length) }, () => worker()),
  );

  if (deferred.length > 0) {
    console.log(`[desks] time budget reached — deferred to next run: ${deferred.join(', ')}`);
  }

  const summary = {
    ready: processed.filter((r) => r.status === 'ready').length,
    thin: processed.filter((r) => r.status === 'thin').length,
    failed: processed.filter((r) => r.status === 'failed').length,
    deferred: deferred.length,
  };

  return {
    ok: true as const,
    date: today,
    summary,
    processed,
    skipped,
    deferred,
    elapsed_s: Math.round((Date.now() - startedAt) / 1000),
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  attachLogCapture(res); // Sprint 14.5: tee server logs into the JSON response
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'Missing OPENAI_API_KEY' });

  const auth = await authoriseRequest(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: 'Unauthorised. Provide Authorization: Bearer <CRON_SECRET> or a valid user session token.' });
  }

  const { desk } = (req.body || {}) as any;

  try {
    const result = await runDesks(typeof desk === 'string' && desk.trim() ? desk.trim() : undefined);
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e: any) {
    console.error('[desks] top-level error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
