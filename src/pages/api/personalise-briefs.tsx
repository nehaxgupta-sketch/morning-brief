// src/pages/api/personalise-briefs.tsx
//
// Sprint 8 — personalise-briefs.
//
// Architecture:
//   1. Load today's three shared briefs (5min, 10min, deep).
//   2. Load all personalised profiles.
//   3. Build the city cache (1 OpenAI call per unique city, parallel).
//   4. Build the interest-topic cache (1 OpenAI call per unique non-standard
//      interest, parallel). Standard-topic interests like "Business & Economy"
//      and "Markets & Investing" map to existing sections in the shared brief
//      and need no extra fetch.
//   5. For each user × edition: produce the personalised brief in CODE
//      (no LLM per user). The transform is:
//        - take the shared brief
//        - drop standard topic sections the user did not opt into
//        - splice in your_city / your_home_city / your_interests
//        - reorder stories by relevance score from profile
//        - pick the long_read theme (Editorial) by profile relevance
//        - reorder watching_this_week (Editorial) by relevance
//        - append a templated "quick_personal_relevance" paragraph
//      Save to personalised_briefs.
//
// No Anthropic, no per-user LLM call. Cost scales with unique cities + unique
// non-standard interests, NOT with user count.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
// Sprint 11: shared whitelist module — fixes the Sprint 10 Law & Policy gap
// caused by a smaller, drifted whitelist copy. Single source of truth now.
import { isWhitelistedSource, REGIONAL_BY_CITY, publisherLabel, TOPIC_SOURCES } from '@/lib/whitelist';
import { dropDeadStories } from '@/lib/liveness';
// Sprint 11: per-call cost capture.
import { logOpenAICost, extractUsageFromResponses } from '@/lib/cost-log';
import { attachLogCapture } from '@/lib/log-capture';
import { applyCitySafety } from '@/lib/editorial-safety';
// Sprint 22 (Stage 4) — RSS personalisation: fetch city/interest candidates from
// real feeds via the existing engine helper instead of Perplexity, killing the
// URL hallucinations. Same Claude editorial + finalise layers; only the source
// changes. Behind PERSONAL_RSS (default off); Perplexity stays as the fallback.
import { fetchStoriesFromFeeds } from '@/lib/rss-retrieval';
import { cityFeed, INTEREST_SECTIONS, SECTION_FEEDS, type PersonalSectionDef } from '@/lib/retrieval/feeds.config';

export const config = { maxDuration: 60 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Sprint 14.7: city sections now use a Perplexity (retrieve) -> Claude
// (select / write / sensitivity) hybrid. PERPLEXITY_API_KEY already exists in
// this project (used by generate-brief). ANTHROPIC_API_KEY must be set in
// Vercel env for the editorial pass; without it, the retrieved candidates are
// used directly as a graceful fallback.
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar-pro';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_CITY_MODEL = process.env.ANTHROPIC_CITY_MODEL || 'claude-sonnet-4-6';
const EDITIONS = ['5min', '10min', 'deep'] as const;
type Edition = (typeof EDITIONS)[number];

// Sprint 20 Drop #4 — when on, the personalised 5-min edition backfills its
// remaining slot budget (up to the 20-story cap) with the highest-scored topical
// stories from the shared brief's `topics` bucket, instead of discarding them and
// shipping thin (~13/20). Pairs with FIVE_MIN_FILL in generate-brief.tsx, which
// provisions the shared 5-min brief to 20. Default on; 'off' restores old behaviour.
const FIVE_MIN_FILL = (process.env.FIVE_MIN_FILL || 'on').toLowerCase() !== 'off';

// Sprint 12: feature flag. When true, this endpoint becomes a pure code-only
// transform — no OpenAI calls. City/interest/industry stories are read from
// the `tail_briefs` table (populated by generate-brief.tsx mode=tail-fetch).
// When false, the legacy in-handler OpenAI fetch path runs (Sprint 11 behaviour).
//
// To enable: set USE_TAIL_BRIEFS=true in Vercel env vars. The cron sequence
// must be updated to run tail-fetch BEFORE personalise-briefs so data is
// available when this handler runs.
const USE_TAIL_BRIEFS = (process.env.USE_TAIL_BRIEFS || '').toLowerCase() === 'true';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } },
);

// ─── Date ─────────────────────────────────────────────────────────────────────

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asObject(value: any): any {
  if (value && typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function profileForPrompt(p: any) {
  return {
    full_name: p.full_name ?? null,
    city_current: p.city_current ?? null,
    city_home: p.city_home ?? null,
    profession: p.profession ?? null,
    industry: p.industry ?? null,
    work_area: p.work_area ?? null,
    interests: p.interests ?? null,
  };
}

function normaliseStr(s: any): string {
  return typeof s === 'string' ? s.trim() : '';
}

function cityKey(s: string): string {
  // Normalise a city display name to a lookup key.
  // "Delhi / NCR" → "delhi / ncr"
  return s.toLowerCase().trim();
}

// Sprint 14.7: tolerant JSON-object extractor for model responses.
function extractJsonObject(text: string): any | null {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// ─── Interest → standard-section mapping ────────────────────────────────────
//
// Some interests already have a counterpart section in the shared brief.
// Those interests get filled from the existing section's stories (no extra
// fetch needed). Interests with no mapping get a fresh per-topic OpenAI fetch.

const STANDARD_INTEREST_MAP: Record<string, { section: string; label: string; icon: string }> = {
  'Business & Economy':   { section: 'business',       label: 'Business & Economy',   icon: '💼' },
  'Markets & Investing':  { section: 'markets',        label: 'Markets & Investing',  icon: '📈' },
  'Technology':           { section: 'technology',     label: 'Technology',           icon: '💻' },
  'Artificial Intelligence': { section: 'technology',  label: 'AI & Technology',      icon: '🤖' },
  'Science':              { section: 'technology',     label: 'Science & Tech',       icon: '🔬' },
  'Environment & Climate': { section: 'climate_health', label: 'Climate',             icon: '🌱' },
  'Health & Wellness':    { section: 'climate_health', label: 'Health',               icon: '🩺' },
  'Sport':                { section: 'sport',          label: 'Sport',                icon: '🏏' },
  'Cricket':              { section: 'sport',          label: 'Cricket & Sport',      icon: '🏏' },
  'Football':             { section: 'sport',          label: 'Football & Sport',     icon: '⚽' },
  'Formula 1':            { section: 'sport',          label: 'F1 & Sport',           icon: '🏎️' },
  'Culture & Arts':       { section: 'culture',        label: 'Culture & Arts',       icon: '🎭' },
  'Film & OTT':           { section: 'culture',        label: 'Film & OTT',           icon: '🎬' },
  'Music':                { section: 'culture',        label: 'Music',                icon: '🎵' },
  'Books & Literature':   { section: 'culture',        label: 'Books',                icon: '📚' },
  'World Affairs':        { section: 'world',          label: 'World',                icon: '🌍' },
  'Indian Politics':      { section: 'politics',       label: 'Politics & Policy',    icon: '🏛️' },
};

// Default pre-checked interests for new personalised users.
// Used by onboarding.tsx — exported as reference here for backend coherence.
// (We don't enforce defaults server-side; the client writes the actual array.)
export const DEFAULT_INTERESTS: string[] = [
  'Business & Economy',
  'Markets & Investing',
  'Technology',
  'Sport',
];

// ─── Phase 2.5: City news fetch ─────────────────────────────────────────────
//
// Sprint 11: TIER_1_HOSTS and isWhitelistedSource moved to @/lib/whitelist
// (imported at top). The old inline copy here was missing Live Law, Bar &
// Bench, PIB, RBI, and other specialist sources — which caused the Law &
// Policy interest to return 0 hits in Sprint 10. Now both files share the
// same 47-domain whitelist.

interface CityStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  why_it_matters?: string; // Sprint 14.5: real relevance line, replaces template filler
}

// ─── Phase 2.5: City news (Sprint 14.7 — Perplexity retrieve → Claude edit) ──
//
// City sections used to be a single gpt-4o + web_search_preview call whose
// prompt hard-coded a NATIONAL source list and never consulted REGIONAL_BY_CITY.
// National outlets cover a city mainly when something dramatic happens, so the
// section kept LEADING with crime/accidents while the real civic front page
// (often a local or vernacular masthead) was dropped by the whitelist. The
// editorial-safety regex also missed plain phrasings like "dies in accident".
//
// Sprint 14.7 replaces the single call with a two-stage hybrid:
//   1. Perplexity sonar-pro RETRIEVES candidates, domain-filtered to that
//      city's local + vernacular mastheads (REGIONAL_BY_CITY), recency=day.
//   2. Claude (Sonnet) SELECTS the 1-3 most consequential CIVIC stories, writes
//      them, and orders them as editorial judgment: crime/tragedy never leads
//      when civic news exists; a child death / suicide / sexual violence never
//      leads. It uses ONLY the retrieved candidates and never invents a URL.
// applyCitySafety() from editorial-safety.ts stays as a deterministic backstop.

// Stage 1 — Perplexity sonar-pro: retrieve candidate local stories, domain-
// filtered to the city's local/vernacular mastheads, last 24-36h.
// ─── Sprint 14.7c: soft domain filter + broad fallback ──────────────────────
// The first post-deploy run showed Perplexity returning 0 candidates for ALL
// four cities when search_domain_filter was restricted to local/vernacular
// mastheads at 24h recency — even Delhi with HT/TOI/IE in the list. The hard
// filter is too restrictive against Perplexity's index. We now (a) widen to a
// 1-week window and (b) treat the masthead list as a PREFERENCE: try it first,
// and if it returns little, retry with a broad search. Claude + the expanded
// whitelist keep quality and demote tragedy either way.
// ════════════════════════════════════════════════════════════════════════════
// Sprint 22 (Stage 4) — RSS personalisation. When PERSONAL_RSS is on, city and
// interest candidates come from real RSS feeds (the existing fetchStoriesFromFeeds
// engine) instead of Perplexity. The Claude selection + finalise layers below are
// unchanged — they just receive a real, non-hallucinated candidate set. Cities use
// the validated IE city pattern; interests use their taxonomy selector (dedicated
// feed and/or the standard section's feeds, keyword-filtered). Default off.
// NOTE: this is the DIRECT path (USE_TAIL_BRIEFS=false). On the tail path the
// source lives in generate-brief mode=tail-fetch (Stage 3b), so set
// USE_TAIL_BRIEFS=false for PERSONAL_RSS to take effect.
// ════════════════════════════════════════════════════════════════════════════
const PERSONAL_RSS = (process.env.PERSONAL_RSS || '').toLowerCase() === 'on';

// RssStory already carries { headline, body, source, source_url, published_at } —
// exactly the candidate shape the Claude selectors consume.
function rssToCandidate(s: any): any {
  return {
    headline: s?.headline,
    summary: s?.body,
    body: s?.body,
    source: s?.source,
    source_url: s?.source_url,
    published_at: s?.published_at,
  };
}

async function rssCityCandidates(city: string): Promise<any[]> {
  try {
    const { stories, reachability } = await fetchStoriesFromFeeds([cityFeed(city)], { secs: ['india'], concurrency: 2 });
    console.log(`[city:${city}] RSS ${reachability}`);
    return stories.map(rssToCandidate).filter((c) => c.headline && c.source_url);
  } catch (e: any) {
    console.warn(`[city:${city}] RSS fetch error: ${e?.message || e}`);
    return [];
  }
}

// Look up an interest's taxonomy def (case-insensitive); null if not in the list
// (those interests fall back to Perplexity so nothing silently goes missing).
function interestDef(interest: string): PersonalSectionDef | null {
  const map = INTEREST_SECTIONS as Record<string, PersonalSectionDef>;
  if (map[interest]) return map[interest];
  const lc = String(interest || '').toLowerCase().trim();
  for (const k of Object.keys(map)) if (k.toLowerCase() === lc) return map[k];
  return null;
}

// Resolve a selector to the SECTION_FEEDS urls that back it: its dedicated feed
// tag and/or the standard section's feeds.
function feedUrlsForDef(def: PersonalSectionDef): string[] {
  const urls = new Set<string>();
  for (const f of SECTION_FEEDS) {
    if (!f?.url) continue;
    const tags = f.tags || [];
    const secs = (f.sections || []) as any[];
    if (def.feedTag && tags.includes(def.feedTag)) urls.add(f.url);
    if (def.section && secs.includes(def.section)) urls.add(f.url);
  }
  return Array.from(urls);
}

function matchesKeywords(s: any, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;
  const hay = `${s?.headline || ''} ${s?.body || s?.summary || ''}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

async function rssInterestCandidates(interest: string, def: PersonalSectionDef): Promise<any[]> {
  const urls = feedUrlsForDef(def);
  if (urls.length === 0) {
    console.log(`[interest:${interest}] no RSS feeds resolved for selector — empty (will fall through).`);
    return [];
  }
  try {
    const { stories, reachability } = await fetchStoriesFromFeeds(urls, { secs: [(def.section as any) || 'india'], concurrency: 4 });
    const filtered = stories.filter((s) => matchesKeywords(s, def.keywords));
    console.log(`[interest:${interest}] RSS ${reachability}; ${filtered.length} after keyword filter.`);
    return filtered.map(rssToCandidate).filter((c) => c.headline && c.source_url).slice(0, 8);
  } catch (e: any) {
    console.warn(`[interest:${interest}] RSS fetch error: ${e?.message || e}`);
    return [];
  }
}

async function pplxCandidates(
  label: string,
  costPhase: 'city' | 'interest',
  costDetail: string,
  prompt: string,
  recency: 'day' | 'week',
  domains: string[],
): Promise<any[]> {
  if (!PERPLEXITY_API_KEY) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const body: any = {
      model: PERPLEXITY_MODEL,
      messages: [
        { role: 'system', content: 'You are a news retrieval engine. Return ONLY valid JSON. No markdown, no preamble.' },
        { role: 'user', content: prompt },
      ],
      search_recency_filter: recency,
      return_citations: true,
      temperature: 0.2,
      max_tokens: 2500,
    };
    if (domains.length) body.search_domain_filter = domains.slice(0, 20);

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PERPLEXITY_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const b = await response.text().catch(() => '');
      console.warn(`[${label}] Perplexity HTTP ${response.status}: ${b.slice(0, 200)}`);
      return [];
    }
    const data: any = await response.json();
    const usage = data?.usage || {};
    void logOpenAICost({
      phase: costPhase,
      model: PERPLEXITY_MODEL,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      detail: costDetail,
    });
    const text = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(text);
    const arr = Array.isArray(parsed?.candidates)
      ? parsed.candidates
      : (Array.isArray(parsed?.stories) ? parsed.stories : []);
    return Array.isArray(arr) ? arr : [];
  } catch (e: any) {
    clearTimeout(timer);
    console.warn(`[${label}] Perplexity error: ${e?.message || e}`);
    return [];
  }
}

async function perplexityCityCandidates(city: string): Promise<any[]> {
  if (!PERPLEXITY_API_KEY) {
    console.warn(`[city:${city}] PERPLEXITY_API_KEY not set — skipping city retrieval.`);
    return [];
  }
  const today = getISTDate();
  const domains = (REGIONAL_BY_CITY[cityKey(city)] || []).slice(0, 20);
  const sourceLine = domains.length
    ? `Prioritise these LOCAL outlets for ${city} (they carry civic stories national papers miss): ${domains.map((d) => publisherLabel(`https://${d}/`) || d).join(', ')}. Vernacular-language outlets are welcome — summarise in English.`
    : `Use established local and national Indian outlets covering ${city}.`;

  const prompt = `You are retrieving local news for ${city}, India. Today is ${today}.
Find up to 8 stories from ${city} in roughly the last week. Favour civic and everyday-life news (water, power, transport, civic governance, infrastructure, housing, local economy, weather, major local events) — the kind of thing on a ${city} newspaper's front page — not only dramatic incidents.
${sourceLine}
Return ONLY this JSON, no markdown, no commentary:
{"candidates":[{"headline":"...","summary":"1-2 sentences","source":"publication name","source_url":"https://direct-article-link","published_at":"${today}"}]}`;

  // Soft domain filter: try the local mastheads first, fall back to a broad
  // search if Perplexity's index returns little for the restricted set.
  let arr = await pplxCandidates(`city:${city}`, 'city', `${city} (retrieve)`, prompt, 'week', domains);
  let mode = domains.length ? `domain-filtered: ${domains.length}` : 'broad';
  if (arr.length < 2 && domains.length) {
    const broad = await pplxCandidates(`city:${city}`, 'city', `${city} (retrieve-broad)`, prompt, 'week', []);
    if (broad.length > arr.length) { arr = broad; mode = 'broad-fallback'; }
  }
  console.log(`[city:${city}] retrieved ${arr.length} candidate(s) via ${PERPLEXITY_MODEL} (${mode}).`);
  return arr;
}

async function claudeSelectCityStories(city: string, candidates: any[]): Promise<CityStory[]> {
  if (candidates.length === 0) return [];
  if (!ANTHROPIC_API_KEY) {
    console.warn(`[city:${city}] ANTHROPIC_API_KEY not set — using retrieved candidates directly (no editorial pass).`);
    return coerceCandidates(city, candidates);
  }
  const today = getISTDate();
  const prompt = `You are the city editor for a calm, premium Indian morning brief. City: ${city}. Date: ${today}.

Below are candidate local stories retrieved from ${city}'s news sources (JSON). Choose the 1-3 MOST CONSEQUENTIAL stories for a resident of ${city} and write them for the brief.

SELECTION
- Prioritise civic and everyday-life impact: water, power, transport, civic governance, infrastructure, housing, local economy, weather, major local events.
- A single crime or accident is rarely the most consequential thing in a city of millions. Include such a story only if it is genuinely among the biggest local developments of the day.

SENSITIVITY (editorial judgment, not a word filter)
- A city section must NOT lead with crime, an accident, a death, or any tragedy when a civic/everyday story is available. Put civic news first; a tragedy, if included, comes last and is capped to one.
- Write any tragedy plainly and with restraint — never sensational, never graphic.
- A story about a child's death, a suicide, or sexual violence must NEVER lead, and belongs only if it is genuinely one of the day's most consequential local stories.

RULES
- Use ONLY the candidates below. Copy "source" and "source_url" VERBATIM from the candidate you choose. NEVER invent a URL or a source name.
- Headline: describes today's development, max 120 chars. Body: 2-3 plain sentences, paraphrased (no long quotes). why_it_matters: ONE concrete sentence on the impact to a ${city} resident (commute, costs, safety, civic services, local economy).
- If none of the candidates is genuinely newsworthy for ${city}, return an empty "stories" array. Do not pad with national stories.

CANDIDATES
${JSON.stringify(candidates).slice(0, 12000)}

Return ONLY this JSON, ordered most-consequential first (civic before any tragedy), no markdown, no commentary:
{"stories":[{"headline":"...","body":"...","why_it_matters":"...","source":"...","source_url":"https://...","published_at":"${today}"}]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_CITY_MODEL,
        max_tokens: 1500,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const b = await response.text().catch(() => '');
      console.warn(`[city:${city}] Claude select HTTP ${response.status}: ${b.slice(0, 200)} — using candidates directly.`);
      return coerceCandidates(city, candidates);
    }
    const data: any = await response.json();
    const usage = data?.usage || {};
    void logOpenAICost({
      phase: 'city',
      model: ANTHROPIC_CITY_MODEL,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      detail: `${city} (select)`,
    });
    const text = Array.isArray(data?.content)
      ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
      : '';
    const parsed = extractJsonObject(text);
    const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
    const finals = finaliseCityStories(city, raw);
    console.log(`[city:${city}] editor kept ${finals.length} story(ies) via ${ANTHROPIC_CITY_MODEL}.`);
    return finals;
  } catch (e: any) {
    clearTimeout(timer);
    console.warn(`[city:${city}] Claude select error: ${e?.message || e} — using candidates directly.`);
    return coerceCandidates(city, candidates);
  }
}

// Validate, whitelist-recheck, apply the deterministic safety backstop, cap to 3.
function finaliseCityStories(city: string, raw: any[]): CityStory[] {
  const out: CityStory[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s.headline !== 'string' || typeof s.source !== 'string') continue;
    const body = typeof s.body === 'string' && s.body.trim()
      ? s.body
      : (typeof s.summary === 'string' ? s.summary : '');
    if (!body) continue;
    if (!isWhitelistedSource(s.source_url)) {
      console.warn(`City story dropped (source not whitelisted) — ${city}: ${s.source_url}`);
      continue;
    }
    out.push({
      headline: s.headline,
      body,
      source: s.source,
      source_url: s.source_url,
      published_at: typeof s.published_at === 'string' ? s.published_at : getISTDate(),
      why_it_matters: typeof s.why_it_matters === 'string' && s.why_it_matters.trim()
        ? s.why_it_matters
        : `A local development relevant to ${city} residents.`,
    });
  }
  // Deterministic backstop on top of Claude's judgment: crime/tragedy never leads.
  return applyCitySafety(out).slice(0, 3);
}

// Fallback when Claude is unavailable: use the retrieved candidates directly.
function coerceCandidates(city: string, candidates: any[]): CityStory[] {
  return finaliseCityStories(city, candidates);
}

async function fetchCityStories(city: string): Promise<CityStory[]> {
  const candidates = PERSONAL_RSS
    ? await rssCityCandidates(city)
    : await perplexityCityCandidates(city);
  if (candidates.length === 0) return [];
  return claudeSelectCityStories(city, candidates);
}

// Sprint 11: track which city/interest fetches errored vs returned empty.
// Errored = network/parse failure (worth flagging to user). Empty = the
// model just didn't find news today (not a failure — could be a quiet day).
export interface TailFailureSets {
  cityErrors: Set<string>;     // keys of cities whose fetch THREW (not just returned empty)
  interestErrors: Set<string>; // names of interests whose fetch THREW
}

async function buildCityCache(
  uniqueCities: string[],
  failures: TailFailureSets,
): Promise<Map<string, CityStory[]>> {
  const cache = new Map<string, CityStory[]>();
  if (uniqueCities.length === 0) return cache;

  const results = await Promise.all(
    uniqueCities.map(async (city) => {
      try {
        const stories = await fetchCityStories(city);
        return [cityKey(city), stories] as const;
      } catch (e: any) {
        console.warn(`City fetch error for ${city}:`, e?.message || e);
        failures.cityErrors.add(cityKey(city));
        return [cityKey(city), [] as CityStory[]] as const;
      }
    }),
  );
  for (const [key, stories] of results) cache.set(key, stories);
  return cache;
}

// ─── Phase 2.6: Interest topic fetch ────────────────────────────────────────
//
// Only fetches for interests that don't map to a standard section.
// E.g. "Renewable Energy", "Classical Music", "Indian History", "Parenting" etc.

interface InterestStory extends CityStory {}

// ─── Phase 2.6: Interest topics (Sprint 14.7b — Perplexity retrieve → Claude) ─
//
// Interests are TOPICAL, not local. The old gpt-4o + web_search_preview fetch
// returned legitimate topical outlets (Condé Nast Traveller, National
// Geographic, Forbes India, The Conversation, ScienceDaily) that the
// India-news whitelist then dropped, leaving several interests empty. Sprint
// 14.7b uses the same hybrid as cities: Perplexity retrieves (recency-aware,
// domain-filtered to TOPIC_SOURCES[interest] where defined), Claude selects the
// 1-3 most consequential + credible stories (India-relevant where it matters)
// and writes them. Genuinely quiet niches still return empty — that is fine.

async function perplexityInterestCandidates(interest: string): Promise<any[]> {
  if (!PERPLEXITY_API_KEY) {
    console.warn(`[interest:${interest}] PERPLEXITY_API_KEY not set — skipping retrieval.`);
    return [];
  }
  const today = getISTDate();
  const domains = (TOPIC_SOURCES[interest.toLowerCase().trim()] || []).slice(0, 20);
  const sourceLine = domains.length
    ? `Prefer these quality outlets for ${interest}: ${domains.map((d) => publisherLabel(`https://${d}/`) || d).join(', ')}.`
    : `Use established, credible outlets covering ${interest}.`;

  const prompt = `You are retrieving news about "${interest}" for an India-focused daily brief. Today is ${today}.
Find up to 8 candidate stories on ${interest} from roughly the last week. Prefer concrete developments (announcements, policy, milestones, notable analysis). An India angle is preferred where one exists; include globally significant items too.
${sourceLine}
Return ONLY this JSON, no markdown, no commentary:
{"candidates":[{"headline":"...","summary":"1-2 sentences","source":"publication name","source_url":"https://direct-article-link","published_at":"${today}"}]}`;

  let arr = await pplxCandidates(`interest:${interest}`, 'interest', `${interest} (retrieve)`, prompt, 'week', domains);
  let mode = domains.length ? `domain-filtered: ${domains.length}` : 'broad';
  if (arr.length < 2 && domains.length) {
    const broad = await pplxCandidates(`interest:${interest}`, 'interest', `${interest} (retrieve-broad)`, prompt, 'week', []);
    if (broad.length > arr.length) { arr = broad; mode = 'broad-fallback'; }
  }
  console.log(`[interest:${interest}] retrieved ${arr.length} candidate(s) (${mode}).`);
  return arr;
}

async function claudeSelectInterestStories(interest: string, candidates: any[], framing?: string): Promise<InterestStory[]> {
  if (candidates.length === 0) return [];
  if (!ANTHROPIC_API_KEY) {
    console.warn(`[interest:${interest}] ANTHROPIC_API_KEY not set — using retrieved candidates directly.`);
    return coerceInterestCandidates(interest, candidates);
  }
  const today = getISTDate();
  const prompt = `You are an editor for a calm, premium India-focused morning brief. Topic: ${interest}. Date: ${today}.

Below are candidate stories about ${interest} (JSON). Choose the 1-3 MOST CONSEQUENTIAL and CREDIBLE for a reader who follows ${interest}, and write them for the brief.

SELECTION
- Prefer concrete, recent developments and genuinely insightful analysis over thin or promotional pieces.
- Favour an India angle where a meaningful one exists; keep globally significant items too.
- Drop tabloid, celebrity-gossip, SEO-filler, or press-release content.

RULES
- Use ONLY the candidates below. Copy "source" and "source_url" VERBATIM from the candidate you choose. NEVER invent a URL or a source name.
- Headline: your own factual summary (max 120 chars), not the original title verbatim. Body: 2-3 plain, paraphrased sentences (no long quotes). why_it_matters: ONE concrete sentence naming the specific stake for someone who follows ${interest}${framing ? ` — frame it around: ${framing}` : ''}.
- If none of the candidates is genuinely newsworthy for ${interest}, return an empty "stories" array. Do not pad.

CANDIDATES
${JSON.stringify(candidates).slice(0, 12000)}

Return ONLY this JSON, most-consequential first, no markdown, no commentary:
{"stories":[{"headline":"...","body":"...","why_it_matters":"...","source":"...","source_url":"https://...","published_at":"${today}"}]}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_CITY_MODEL,
        max_tokens: 1500,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const b = await response.text().catch(() => '');
      console.warn(`[interest:${interest}] Claude select HTTP ${response.status}: ${b.slice(0, 200)} — using candidates directly.`);
      return coerceInterestCandidates(interest, candidates);
    }
    const data: any = await response.json();
    const usage = data?.usage || {};
    void logOpenAICost({
      phase: 'interest',
      model: ANTHROPIC_CITY_MODEL,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      detail: `${interest} (select)`,
    });
    const text = Array.isArray(data?.content)
      ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
      : '';
    const parsed = extractJsonObject(text);
    const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
    const finals = finaliseInterestStories(interest, raw);
    console.log(`[interest:${interest}] editor kept ${finals.length} story(ies) via ${ANTHROPIC_CITY_MODEL}.`);
    return finals;
  } catch (e: any) {
    clearTimeout(timer);
    console.warn(`[interest:${interest}] Claude select error: ${e?.message || e} — using candidates directly.`);
    return coerceInterestCandidates(interest, candidates);
  }
}

// Validate, whitelist-recheck, cap to 3. (No city-safety reorder — interests
// are topical, not a "your city" section.)
function finaliseInterestStories(interest: string, raw: any[]): InterestStory[] {
  const out: InterestStory[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s.headline !== 'string' || typeof s.source !== 'string') continue;
    const body = typeof s.body === 'string' && s.body.trim()
      ? s.body
      : (typeof s.summary === 'string' ? s.summary : '');
    if (!body) continue;
    if (!isWhitelistedSource(s.source_url)) {
      console.warn(`Interest story dropped (source not whitelisted) — "${interest}": ${s.source_url}`);
      continue;
    }
    out.push({
      headline: s.headline,
      body,
      source: s.source,
      source_url: s.source_url,
      published_at: typeof s.published_at === 'string' ? s.published_at : getISTDate(),
      why_it_matters: typeof s.why_it_matters === 'string' && s.why_it_matters.trim()
        ? s.why_it_matters
        : `A development relevant to people who follow ${interest}.`,
    });
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

// Fallback when Claude is unavailable: use the retrieved candidates directly.
function coerceInterestCandidates(interest: string, candidates: any[]): InterestStory[] {
  return finaliseInterestStories(interest, candidates);
}

async function fetchInterestStories(interest: string): Promise<InterestStory[]> {
  const def = PERSONAL_RSS ? interestDef(interest) : null;
  const candidates = def
    ? await rssInterestCandidates(interest, def)
    : await perplexityInterestCandidates(interest);
  if (candidates.length === 0) return [];
  return claudeSelectInterestStories(interest, candidates, def?.why);
}

async function buildInterestCache(
  uniqueInterests: string[],
  failures: TailFailureSets,
): Promise<Map<string, InterestStory[]>> {
  const cache = new Map<string, InterestStory[]>();
  const nonStandard = uniqueInterests.filter((i) => !STANDARD_INTEREST_MAP[i]);
  if (nonStandard.length === 0) return cache;

  const results = await Promise.all(
    nonStandard.map(async (interest) => {
      try {
        const stories = await fetchInterestStories(interest);
        return [interest, stories] as const;
      } catch (e: any) {
        console.warn(`Interest fetch error for "${interest}":`, e?.message || e);
        failures.interestErrors.add(interest);
        return [interest, [] as InterestStory[]] as const;
      }
    }),
  );
  for (const [interest, stories] of results) cache.set(interest, stories);
  return cache;
}

// ─── Sprint 12: Read-path from tail_briefs table ────────────────────────────
//
// When USE_TAIL_BRIEFS=true, this replaces buildCityCache + buildInterestCache.
// Reads rows previously written by generate-brief mode=tail-fetch and shapes
// them into the same Map<key, stories> structures the legacy code uses.
// Also reads industry rows (new in Sprint 12).
//
// Failures here mean missing data, not OpenAI errors. We treat a missing tail
// row the same as an empty fetch — log it, mark tailStatus accordingly.

interface TailBriefsCaches {
  cityCache: Map<string, CityStory[]>;
  interestCache: Map<string, InterestStory[]>;
  industryCache: Map<string, InterestStory[]>;
}

async function loadFromTailBriefs(
  uniqueCities: string[],
  uniqueInterests: string[],
  uniqueIndustries: string[],
  failures: TailFailureSets,
): Promise<TailBriefsCaches> {
  const today = getISTDate();
  const cityCache = new Map<string, CityStory[]>();
  const interestCache = new Map<string, InterestStory[]>();
  const industryCache = new Map<string, InterestStory[]>();

  const { data, error } = await supabase
    .from('tail_briefs')
    .select('tail_type, tail_key, stories, status, reason')
    .eq('date', today);

  if (error) {
    console.error(`[tail-read] tail_briefs read failed: ${error.message}. Falling back to empty caches.`);
    // All cities + interests + industries marked as failed.
    uniqueCities.forEach((c) => failures.cityErrors.add(cityKey(c)));
    uniqueInterests.forEach((i) => { if (!STANDARD_INTEREST_MAP[i]) failures.interestErrors.add(i); });
    return { cityCache, interestCache, industryCache };
  }

  const byKey = new Map<string, any>();
  for (const row of data || []) {
    byKey.set(`${row.tail_type}|${row.tail_key}`, row);
  }

  // Cities
  for (const city of uniqueCities) {
    const key = cityKey(city);
    const row = byKey.get(`city|${key}`);
    if (!row) {
      console.warn(`[tail-read] city "${city}" missing from tail_briefs for ${today}.`);
      failures.cityErrors.add(key);
      cityCache.set(key, []);
      continue;
    }
    if (row.status === 'failed') {
      console.warn(`[tail-read] city "${city}" status=failed: ${row.reason}`);
      failures.cityErrors.add(key);
      cityCache.set(key, []);
      continue;
    }
    const stories = Array.isArray(row.stories) ? row.stories : [];
    // Defensive whitelist re-check.
    const kept = stories.filter((s: any) => s?.source_url && isWhitelistedSource(s.source_url));
    // Sprint 14.5: same city-safety ordering for tail-sourced city stories.
    cityCache.set(key, applyCitySafety(kept) as CityStory[]);
  }

  // Interests (non-standard only — standard ones map to brief sections)
  for (const interest of uniqueInterests) {
    if (STANDARD_INTEREST_MAP[interest]) continue;
    const key = interest.toLowerCase().trim();
    const row = byKey.get(`interest|${key}`);
    if (!row) {
      console.warn(`[tail-read] interest "${interest}" missing from tail_briefs for ${today}.`);
      failures.interestErrors.add(interest);
      interestCache.set(interest, []);
      continue;
    }
    if (row.status === 'failed') {
      console.warn(`[tail-read] interest "${interest}" status=failed: ${row.reason}`);
      failures.interestErrors.add(interest);
      interestCache.set(interest, []);
      continue;
    }
    const stories = Array.isArray(row.stories) ? row.stories : [];
    const kept = stories.filter((s: any) => s?.source_url && isWhitelistedSource(s.source_url));
    interestCache.set(interest, kept as InterestStory[]);
  }

  // Industries (Sprint 12 — new)
  for (const industry of uniqueIndustries) {
    const key = industry.toLowerCase().trim();
    const row = byKey.get(`industry|${key}`);
    if (!row) {
      console.warn(`[tail-read] industry "${industry}" missing from tail_briefs for ${today}.`);
      industryCache.set(industry, []);
      continue;
    }
    if (row.status === 'failed') {
      console.warn(`[tail-read] industry "${industry}" status=failed: ${row.reason}`);
      industryCache.set(industry, []);
      continue;
    }
    const stories = Array.isArray(row.stories) ? row.stories : [];
    const kept = stories.filter((s: any) => s?.source_url && isWhitelistedSource(s.source_url));
    industryCache.set(industry, kept as InterestStory[]);
  }

  console.log(`[tail-read] loaded — cities: ${cityCache.size}, interests: ${interestCache.size}, industries: ${industryCache.size}`);
  return { cityCache, interestCache, industryCache };
}

// Splice industry section into a personal_sections array (used by both 5min
// and 10min builders). Sprint 12: industry sections work like interest
// sections — single industry per user, 1-2 stories.
function makeIndustrySection(
  industry: string,
  industryCache: Map<string, InterestStory[]>,
  shape: 'micro' | 'full',
  storiesPerSection: number,
): PersonalSection | null {
  if (!industry) return null;
  const stories = industryCache.get(industry) || [];
  if (stories.length === 0) return null;
  const sliced = stories.slice(0, storiesPerSection);
  const shaped: any[] = shape === 'micro'
    ? sliced.map((s) => interestToMicro(s, industry, 'sector'))
    : sliced.map((s) => interestToFull(s, industry, 'sector'));
  return {
    id: `industry_${industry.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    label: `${industry} sector`,
    icon: '🏢',
    kind: 'list',
    stories: shaped,
  };
}

// ─── Story → MicroStory / FullStory adapters ────────────────────────────────
//
// City and interest fetches return body-style stories. The Brief / The Daily
// need them shaped to their formats. We adapt minimally — the writer prompts
// aren't called again, so these conversions are mechanical.

function cityToMicro(s: CityStory) {
  // Build a micro-item by splitting body on the first sentence.
  // body is 2-3 sentences; first sentence = what_happened.
  const sentences = s.body.split(/(?<=[.!?])\s+/);
  const what = sentences[0] || s.body;
  const derivedWhy = sentences.slice(1).join(' ') || 'Relevant local development for readers in your city.';
  const why = (s.why_it_matters && s.why_it_matters.trim()) || derivedWhy;
  return {
    headline: s.headline,
    what_happened: what.trim(),
    why_it_matters: why.trim(),
    source: s.source,
    source_url: s.source_url,
    industries: [],
    interests: [],
    city_tags: [],
    topic_tags: [],
    must_include: false,
  };
}

function cityToFull(s: CityStory) {
  // Use the full body as facts; derive why_it_matters from the story's own
  // content (Sprint 14.5) instead of a flat template, and prefer the model's
  // why_it_matters when the fetch supplied one.
  const sentences = String(s.body || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const derivedWhy = sentences.slice(1).join(' ').trim();
  return {
    headline: s.headline,
    facts: s.body,
    background: 'A development from your city.',
    why_it_matters: (s.why_it_matters && s.why_it_matters.trim()) || derivedWhy || 'Local news worth knowing as a resident.',
    what_happens_next: 'Watch for follow-up coverage and official updates.',
    analysis: 'Included because it is local to your city.',
    source: s.source,
    source_url: s.source_url,
    industries: [],
    interests: [],
    city_tags: [],
    topic_tags: [],
    must_include: false,
  };
}

// Sprint 14.4: interest-aware builders. Previously non-standard interests
// (e.g. "Law & Policy") were rendered through cityToFull / cityToMicro, so an
// interest story carried the line "Selected for you based on your city
// preference." — a mislabel a reader notices immediately. These mirror the
// city builders' SHAPE (so the renderer is unaffected) but with honest,
// interest-correct framing, and derive why_it_matters from the story body
// instead of a flat template.
function interestToMicro(s: any, topic: string, kind: 'interest' | 'sector' = 'interest') {
  const body = String(s?.body || '');
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  const what = sentences[0] || body;
  const derivedWhy = sentences.slice(1).join(' ').trim();
  const fallbackWhy = kind === 'sector'
    ? `Relevant to your sector, ${topic}.`
    : `Relevant to your interest in ${topic}.`;
  return {
    headline: s.headline,
    what_happened: what.trim(),
    why_it_matters: (s?.why_it_matters && String(s.why_it_matters).trim()) || derivedWhy || fallbackWhy,
    source: s.source,
    source_url: s.source_url,
    industries: [],
    interests: [],
    city_tags: [],
    topic_tags: [],
    must_include: false,
  };
}

function interestToFull(s: any, topic: string, kind: 'interest' | 'sector' = 'interest') {
  const body = String(s?.body || '');
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  const derivedWhy = sentences.slice(1).join(' ').trim();
  const fallbackWhy = kind === 'sector'
    ? `Relevant to your sector, ${topic}.`
    : `Relevant to your interest in ${topic}.`;
  const analysis = kind === 'sector'
    ? `Included because ${topic} is your industry.`
    : `Included because ${topic} is one of your interests.`;
  const background = kind === 'sector'
    ? `Recent development in the ${topic} sector.`
    : `Recent development in ${topic}.`;
  return {
    headline: s.headline,
    facts: body,
    background,
    why_it_matters: (s?.why_it_matters && String(s.why_it_matters).trim()) || derivedWhy || fallbackWhy,
    what_happens_next: 'Watch for follow-up coverage and official updates.',
    analysis,
    source: s.source,
    source_url: s.source_url,
    industries: [],
    interests: [],
    city_tags: [],
    topic_tags: [],
    must_include: false,
  };
}

// ─── Profile scoring (for ordering) ─────────────────────────────────────────
//
// Each story gets a relevance score against the profile. Higher = closer to
// the top of its section. We never drop stories; we just reorder.

function scoreStory(story: any, profile: any): number {
  let s = 0;
  if (story?.must_include) s += 1000;

  const interestsP = (profile?.interests || []) as string[];
  const interestsS = (story?.interests || []) as string[];
  const interestSet = new Set(interestsP.map((x) => x.toLowerCase()));
  for (const i of interestsS) {
    if (interestSet.has((i || '').toLowerCase())) s += 12;
  }

  const industryP = (profile?.industry || '').toLowerCase();
  const industriesS = (story?.industries || []) as string[];
  if (industryP) {
    for (const i of industriesS) {
      if ((i || '').toLowerCase() === industryP) s += 10;
    }
  }

  const cityCurrent = (profile?.city_current || '').toLowerCase();
  const cityHome = (profile?.city_home || '').toLowerCase();
  const cityTags = (story?.city_tags || []) as string[];
  for (const c of cityTags) {
    const cl = (c || '').toLowerCase();
    if (cl && cityCurrent && (cl === cityCurrent || cityCurrent.includes(cl) || cl.includes(cityCurrent))) s += 8;
    if (cl && cityHome && (cl === cityHome || cityHome.includes(cl) || cl.includes(cityHome))) s += 4;
  }

  // Standard topic interests bias the topic sections too.
  const topicTags = (story?.topic_tags || []) as string[];
  for (const t of topicTags) {
    if (interestSet.has(t.toLowerCase())) s += 4;
  }

  return s;
}

function reorderByScore<T>(arr: T[], scorer: (x: T) => number): T[] {
  // Stable sort: items with equal scores keep their original order.
  return arr
    .map((x, i) => ({ x, i, s: scorer(x) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ x }) => x);
}

// ─── Personalised brief construction (per user × edition) ───────────────────

type PersonalSection = {
  id: string;
  label: string;
  icon: string;
  kind: 'list';
  stories: any[]; // shape matches the edition (Micro for 5min, Full for 10min)
};

interface BuildResult {
  content: any;
  stats: {
    sectionsKept: number;
    sectionsDropped: number;
    personalSectionsAdded: number;
    citySpliced: boolean;
    homeCitySpliced: boolean;
    interestSectionsAdded: number;
    relevanceParagraph: boolean;
  };
}

// ─── Sprint 22 — per-user FLOOR budget (PLACEMENT_V2, personalised side) ─────
//
// Replaces the old greedy "keep major/world/india in full, then add personal
// sections until the budget runs out" assembly. The greedy version was order-
// dependent (late interest sections got 0) and never deduped personal sections
// against the standard spine. This allocator:
//   • guarantees a FLOOR (minimum) for every section the user actually sees,
//     capped only by how many stories truly exist for it (no padding);
//   • shares the remaining budget up to PERSONAL_TARGET round-robin in the
//     per-user PRECEDENCE order — so a user with few sections gets MORE in each,
//     and a user with many gets ~floor in each, both landing at ~20 (floors, not
//     ceilings);
//   • caps major_events at MAJOR_CAP (the front page);
//   • dedups personal sections against the standard spine, then within personal.
//
// Wired into the 5-min and 10-min builders behind PERSONAL_FLOORS (default off so
// it ships dark — flip on for one test user/edition, verify the distribution in
// the [personalise:*:floors] log line, then make it the default). Deep is a
// synthesis edition, so floors do not apply there.
const PERSONAL_FLOORS = (process.env.PERSONAL_FLOORS || '').toLowerCase() === 'on';

const PERSONAL_TARGET = 20;       // story total we aim each personalised brief at
const MAJOR_CAP = 5;              // front-page capacity (Sprint 22 decision)

// Per-section FLOORS. Every section the user has is guaranteed at least this many
// (capped by real availability). Tune here — these sum low enough that the
// round-robin surplus does the real shaping.
const SECTION_FLOORS: Record<string, number> = {
  major_events: 3, india: 3, world: 2,
  your_city: 1, your_home_city: 1, industry: 1, interest: 1,
};

// Per-user precedence (Sprint 22 decision): drives BOTH surplus distribution and
// cross-section dedup priority. Personal sections are woven in by relevance.
//   major_events → india → your_city → world → your_home_city → industry → interests
// Interest sections keep the user's own listed order (their stated priority).

const FLOOR_STOP = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','but','with','by','from',
  'as','is','are','was','were','be','been','has','have','had','will','would','new',
  'says','said','after','before','amid','over','india','indian','today','live','updates',
]);
function floorSigWords(h: string): Set<string> {
  return new Set(
    String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 4 && !FLOOR_STOP.has(w)),
  );
}
function floorSameStory(a: string, b: string): boolean {
  const A = floorSigWords(a), B = floorSigWords(b);
  let n = 0; for (const w of Array.from(A)) if (B.has(w)) n++;
  const small = Math.max(1, Math.min(A.size, B.size));
  return n >= 4 || (n >= 3 && n / small >= 0.6);
}

// Remove personal-section stories that duplicate a story already in the standard
// spine (major/world/india). URL match first, then headline word-overlap (the
// Perplexity-sourced personal story usually has a different URL for the same event).
function dropPersonalDupesOfStandard(personalSecs: PersonalSection[], standardStories: any[]): number {
  const stdUrls = new Set(
    standardStories.map((s) => (s?.source_url || '').toLowerCase().split('?')[0]).filter(Boolean),
  );
  const stdHeads = standardStories.map((s) => s?.headline || '').filter(Boolean);
  let removed = 0;
  for (const sec of personalSecs) {
    sec.stories = (sec.stories || []).filter((st: any) => {
      const u = (st?.source_url || '').toLowerCase().split('?')[0];
      if (u && stdUrls.has(u)) { removed++; return false; }
      for (const h of stdHeads) if (floorSameStory(st?.headline || '', h)) { removed++; return false; }
      return true;
    });
  }
  return removed;
}

// Round-robin floor allocator. Floors first (capped by availability), then share
// the surplus up to `target` by walking the candidate list (already in precedence
// order) one slot at a time. No ceilings — only real availability stops a section.
function allocateFloors(cands: { key: string; floor: number; avail: number }[], target: number): Record<string, number> {
  const alloc: Record<string, number> = {};
  let total = 0;
  for (const c of cands) { alloc[c.key] = Math.min(c.floor, c.avail); total += alloc[c.key]; }
  let guard = 0;
  while (total < target && guard++ < 1000) {
    let progressed = false;
    for (const c of cands) {
      if (total >= target) break;
      if (alloc[c.key] < c.avail) { alloc[c.key] += 1; total += 1; progressed = true; }
    }
    if (!progressed) break;
  }
  return alloc;
}

// The floor-budget assembly, shared by the 5-min and 10-min builders.
function buildWithFloors(
  shared: any,
  profile: any,
  edition: '5min' | '10min',
  cityStories: CityStory[],
  homeCityStories: CityStory[],
  interestCache: Map<string, InterestStory[]>,
  industryCache: Map<string, InterestStory[]>,
): BuildResult {
  const shape: 'micro' | 'full' = edition === '5min' ? 'micro' : 'full';
  const cityMap = shape === 'micro' ? cityToMicro : cityToFull;
  const scorer = (s: any) => scoreStory(s, profile);

  // Standard spine — full available, score-ordered; major capped at MAJOR_CAP.
  const major = reorderByScore(shared.major_events || [], scorer).slice(0, MAJOR_CAP);
  const world = reorderByScore(shared.world || [], scorer);
  const india = reorderByScore(shared.india || [], scorer);

  // Personal candidate sections — built with FULL availability; sliced later.
  const personal: PersonalSection[] = [];
  const usersCity = normaliseStr(profile?.city_current);
  if (usersCity && cityStories.length > 0) {
    personal.push({ id: 'your_city', label: usersCity, icon: '📍', kind: 'list', stories: cityStories.map(cityMap) });
  }
  const usersHome = normaliseStr(profile?.city_home);
  if (usersHome && usersHome.toLowerCase() !== usersCity.toLowerCase() && homeCityStories.length > 0) {
    personal.push({ id: 'your_home_city', label: `${usersHome} (home)`, icon: '🏡', kind: 'list', stories: homeCityStories.map(cityMap) });
  }
  const usersIndustry = normaliseStr(profile?.industry);
  if (usersIndustry) {
    const indSec = makeIndustrySection(usersIndustry, industryCache, shape, 3);
    if (indSec) personal.push(indSec);
  }
  for (const interest of (profile?.interests || []) as string[]) {
    const sec = makeInterestSection(interest, shared, interestCache, shape, 3);
    if (sec) personal.push(sec);
  }

  // Cross-pool dedup: personal must not repeat the spine, then dedup within personal.
  const spine = [...major, ...world, ...india];
  const crossRemoved = dropPersonalDupesOfStandard(personal, spine);
  const dd = dedupPersonalSections(personal.filter((p) => (p.stories || []).length > 0));
  if (crossRemoved > 0 || dd.removed > 0) {
    console.log(`[personalise:${edition}:floors] dedup — vs-spine ${crossRemoved}, within-personal ${dd.removed}`);
  }
  let live = dd.sections.filter((p) => (p.stories || []).length > 0);

  // Sprint 13.2 parity: a Markets-mapped interest gets the real markets grid, not
  // the flattened "Markets today" pseudo-story — drop that pseudo section here too.
  const hasMarketsInterest = ((profile?.interests || []) as string[])
    .some((i) => STANDARD_INTEREST_MAP[i]?.section === 'markets');
  if (hasMarketsInterest) {
    live = live.filter((sec) => !(
      sec.id.startsWith('interest_') && sec.stories.length === 1 &&
      (sec.stories[0] as any)?.headline === 'Markets today'
    ));
  }

  const citySec = live.find((p) => p.id === 'your_city');
  const homeSec = live.find((p) => p.id === 'your_home_city');
  const indSecLive = live.find((p) => p.id.startsWith('industry_'));
  const interestSecs = live.filter((p) => p.id.startsWith('interest_'));

  // Candidate list in PRECEDENCE order with floors + availability.
  const cands: { key: string; floor: number; avail: number }[] = [];
  cands.push({ key: 'major_events', floor: SECTION_FLOORS.major_events, avail: major.length });
  cands.push({ key: 'india', floor: SECTION_FLOORS.india, avail: india.length });
  if (citySec) cands.push({ key: 'your_city', floor: SECTION_FLOORS.your_city, avail: citySec.stories.length });
  cands.push({ key: 'world', floor: SECTION_FLOORS.world, avail: world.length });
  if (homeSec) cands.push({ key: 'your_home_city', floor: SECTION_FLOORS.your_home_city, avail: homeSec.stories.length });
  if (indSecLive) cands.push({ key: indSecLive.id, floor: SECTION_FLOORS.industry, avail: indSecLive.stories.length });
  for (const isec of interestSecs) cands.push({ key: isec.id, floor: SECTION_FLOORS.interest, avail: isec.stories.length });

  const alloc = allocateFloors(cands, PERSONAL_TARGET);

  // Slice to allocation.
  const majorF = major.slice(0, alloc['major_events'] ?? major.length);
  const worldF = world.slice(0, alloc['world'] ?? world.length);
  const indiaF = india.slice(0, alloc['india'] ?? india.length);

  // Re-emit personal sections in precedence order, sliced to their allocation.
  const personalOut: PersonalSection[] = [];
  const emit = (sec?: PersonalSection) => {
    if (!sec) return;
    const n = alloc[sec.id] ?? sec.stories.length;
    const sliced = { ...sec, stories: sec.stories.slice(0, n) };
    if (sliced.stories.length > 0) personalOut.push(sliced);
  };
  emit(citySec);
  emit(homeSec);
  emit(indSecLive);
  for (const isec of interestSecs) emit(isec);

  const total = majorF.length + worldF.length + indiaF.length +
    personalOut.reduce((n, p) => n + p.stories.length, 0);
  console.log(`[personalise:${edition}:floors] total=${total}/${PERSONAL_TARGET} ` +
    `major=${majorF.length} india=${indiaF.length} world=${worldF.length} ` +
    `city=${alloc['your_city'] || 0} home=${alloc['your_home_city'] || 0} ` +
    `industry=${indSecLive ? (alloc[indSecLive.id] || 0) : 0} interests=${interestSecs.length}`);

  const picks: string[] = [];
  if (majorF[0]?.headline) picks.push(majorF[0].headline);
  if (indiaF[0]?.headline) picks.push(indiaF[0].headline);
  if (personalOut[0]?.stories?.[0]?.headline) picks.push(personalOut[0].stories[0].headline);

  const content: any = {
    edition,
    date: shared.date,
    major_events: majorF,
    world: worldF,
    india: indiaF,
    personal_sections: personalOut,
  };
  if (edition === '10min') {
    content.closer = shared.closer;
    content.quick_personal_relevance = buildQuickPersonalRelevance(profile, picks);
    if (hasMarketsInterest && shared.markets) content.markets = shared.markets;
  }

  return {
    content,
    stats: {
      sectionsKept: 3,
      sectionsDropped: edition === '10min' ? 6 : 1,
      personalSectionsAdded: personalOut.length,
      citySpliced: !!citySec,
      homeCitySpliced: !!homeSec,
      interestSectionsAdded: interestSecs.length,
      relevanceParagraph: edition === '10min',
    },
  };
}

function buildQuickPersonalRelevance(profile: any, picks: string[]): string {
  // Template — no LLM. Picks are 2-3 headlines we surface.
  const name = (profile?.full_name || '').split(' ')[0] || '';
  const city = profile?.city_current || '';
  const focus = picks.length > 0
    ? `Today's stories most relevant to you: ${picks.slice(0, 3).join('; ')}.`
    : `Today's brief has been ordered for your priorities.`;
  const tailParts: string[] = [];
  if (profile?.profession || profile?.industry) {
    tailParts.push(`shape your professional context`);
  }
  if (city) {
    tailParts.push(`affect ${city}'s rhythm`);
  }
  if ((profile?.interests || []).length > 0) {
    tailParts.push(`touch areas you follow closely`);
  }
  const tail = tailParts.length > 0
    ? `Together, they ${tailParts.join(', ')}.`
    : ``;
  const open = name ? `For you, ${name} — ` : `For you — `;
  return `${open}${focus} ${tail}`.trim();
}

function buildQuickPersonalised(
  shared: any,
  profile: any,
  cityStories: CityStory[],
  homeCityStories: CityStory[],
  interestCache: Map<string, InterestStory[]>,
  industryCache: Map<string, InterestStory[]> = new Map(),
): BuildResult {
  if (PERSONAL_FLOORS) return buildWithFloors(shared, profile, '5min', cityStories, homeCityStories, interestCache, industryCache);

  // The Brief (5min) personalised shape — per Sprint 9 spec:
  //  - major_events (universal, reordered) — KEEP ALL
  //  - world (universal, reordered) — KEEP ALL
  //  - india (universal, reordered) — KEEP ALL
  //  - your_city (1 micro story)
  //  - your_industry (Sprint 12 — 1 micro story if industry tail has content)
  //  - your_interests (interest sections, 1 story per section)
  //  - NO `topics` section (replaced by personal sections)
  // Total story cap: 20. If universal + personal exceeds 20, trim from the
  // lowest-priority interest sections first.
  const TOTAL_CAP = 20;
  const scorer = (s: any) => scoreStory(s, profile);

  const major = reorderByScore(shared.major_events || [], scorer);
  const world = reorderByScore(shared.world || [], scorer);
  const india = reorderByScore(shared.india || [], scorer);

  const universalCount = major.length + world.length + india.length;
  let personalBudget = Math.max(0, TOTAL_CAP - universalCount);

  const personal: PersonalSection[] = [];

  // Your city — 1 story, highest personal priority.
  const usersCity = normaliseStr(profile?.city_current);
  if (usersCity && cityStories.length > 0 && personalBudget > 0) {
    personal.push({
      id: 'your_city',
      label: usersCity,
      icon: '📍',
      kind: 'list',
      stories: [cityToMicro(cityStories[0])],
    });
    personalBudget -= 1;
  }

  // Your industry (Sprint 12) — 1 story slot in 5min.
  const usersIndustry = normaliseStr(profile?.industry);
  if (usersIndustry && personalBudget > 0) {
    const indSec = makeIndustrySection(usersIndustry, industryCache, 'micro', 1);
    if (indSec) {
      personal.push(indSec);
      personalBudget -= indSec.stories.length;
    }
  }

  // Your interests — fill remaining personal budget. 1 story per section.
  const userInterests = (profile?.interests || []) as string[];
  for (const interest of userInterests) {
    if (personalBudget <= 0) break;
    const section = makeInterestSection(interest, shared, interestCache, 'micro', 1);
    if (section) {
      personal.push(section);
      personalBudget -= section.stories.length;
    }
  }

  // Sprint 20 Drop #4 — fill the 5-min edition to its 20-story cap. The shared
  // 5-min brief carries a `topics` bucket (business/tech/climate/sport/culture)
  // that the personalised shape previously discarded, leaving the brief thin
  // (~13/20). Backfill the remaining budget with the highest-scored topical
  // stories as one "More today" section. It rides personal_sections (already
  // rendered + deduped), so no frontend change is needed and duplicates of a
  // topic already surfaced as an interest are stripped below. Gated by
  // FIVE_MIN_FILL (default on; 'off' restores the old drop-topics behaviour).
  if (FIVE_MIN_FILL && personalBudget > 0) {
    const topicPool = reorderByScore((shared.topics || []) as any[], scorer);
    const fill = topicPool.slice(0, personalBudget);
    if (fill.length > 0) {
      personal.push({
        id: 'more_today',
        label: 'More today',
        icon: '🗞️',
        kind: 'list',
        stories: fill,
      });
      personalBudget -= fill.length;
    }
  }

  // Sprint 13 · Defect A: strip duplicate stories across personal sections.
  const dedupQ = dedupPersonalSections(personal);
  if (dedupQ.removed > 0) console.log(`[personalise:5min] dedup removed ${dedupQ.removed} duplicate personal-section stories.`);

  console.log(`[personalise:5min] universal=${universalCount}, personal=${TOTAL_CAP - universalCount - personalBudget}, total=${TOTAL_CAP - personalBudget}, cap=${TOTAL_CAP}`);

  const picks: string[] = [];
  if (major[0]?.headline) picks.push(major[0].headline);
  if (world[0]?.headline) picks.push(world[0].headline);
  if (dedupQ.sections[0]?.stories?.[0]?.headline) picks.push(dedupQ.sections[0].stories[0].headline);

  const content = {
    edition: '5min',
    date: shared.date,
    major_events: major,
    world,
    india,
    // topics section deliberately dropped for personalised users — replaced by personal_sections.
    personal_sections: dedupQ.sections,
  };

  return {
    content,
    stats: {
      sectionsKept: 3,
      sectionsDropped: 1, // topics
      personalSectionsAdded: personal.length,
      citySpliced: personal.some((p) => p.id === 'your_city'),
      homeCitySpliced: false,
      interestSectionsAdded: personal.filter((p) => p.id.startsWith('interest_')).length,
      relevanceParagraph: false,
    },
  };
}

function buildDailyPersonalised(
  shared: any,
  profile: any,
  cityStories: CityStory[],
  homeCityStories: CityStory[],
  interestCache: Map<string, InterestStory[]>,
  industryCache: Map<string, InterestStory[]> = new Map(),
): BuildResult {
  if (PERSONAL_FLOORS) return buildWithFloors(shared, profile, '10min', cityStories, homeCityStories, interestCache, industryCache);

  // The Daily (10min) personalised shape — per Sprint 9 spec:
  //  - major_events (universal, reordered) — KEEP ALL
  //  - world (universal, reordered) — KEEP ALL
  //  - india (universal, reordered) — KEEP ALL
  //  - your_city (max 2 full stories)
  //  - your_home_city (max 1 full story if different from current)
  //  - your_interests (interest sections filling remaining budget)
  //  - closer (universal, verbatim)
  //  - quick_personal_relevance (templated)
  // Total story cap: 20. Standard topic sections (business/markets/technology/
  // climate_health/sport/culture) are DROPPED — each may surface as an interest
  // section if user has it in their interests array.
  const TOTAL_CAP = 20;
  const scorer = (s: any) => scoreStory(s, profile);

  const major = reorderByScore(shared.major_events || [], scorer);
  const world = reorderByScore(shared.world || [], scorer);
  const india = reorderByScore(shared.india || [], scorer);

  const universalCount = major.length + world.length + india.length;
  let personalBudget = Math.max(0, TOTAL_CAP - universalCount);

  const personal: PersonalSection[] = [];

  const usersCity = normaliseStr(profile?.city_current);
  if (usersCity && cityStories.length > 0 && personalBudget > 0) {
    const slots = Math.min(2, personalBudget, cityStories.length);
    personal.push({
      id: 'your_city',
      label: usersCity,
      icon: '📍',
      kind: 'list',
      stories: cityStories.slice(0, slots).map(cityToFull),
    });
    personalBudget -= slots;
  }

  const usersHome = normaliseStr(profile?.city_home);
  if (usersHome && usersHome.toLowerCase() !== usersCity.toLowerCase() && homeCityStories.length > 0 && personalBudget > 0) {
    personal.push({
      id: 'your_home_city',
      label: `${usersHome} (home)`,
      icon: '🏡',
      kind: 'list',
      stories: homeCityStories.slice(0, 1).map(cityToFull),
    });
    personalBudget -= 1;
  }

  // Your industry (Sprint 12) — up to 2 full stories in 10min.
  const usersIndustry = normaliseStr(profile?.industry);
  if (usersIndustry && personalBudget > 0) {
    const slots = Math.min(2, personalBudget);
    const indSec = makeIndustrySection(usersIndustry, industryCache, 'full', slots);
    if (indSec) {
      personal.push(indSec);
      personalBudget -= indSec.stories.length;
    }
  }

  // Interest sections — fill remaining budget. Up to 2 stories per section.
  const userInterests = (profile?.interests || []) as string[];
  for (const interest of userInterests) {
    if (personalBudget <= 0) break;
    const slotsPerSection = Math.min(2, personalBudget);
    const sec = makeInterestSection(interest, shared, interestCache, 'full', slotsPerSection);
    if (sec) {
      personal.push(sec);
      personalBudget -= sec.stories.length;
    }
  }

  console.log(`[personalise:10min] universal=${universalCount}, personal=${TOTAL_CAP - universalCount - personalBudget}, total=${TOTAL_CAP - personalBudget}, cap=${TOTAL_CAP}`);

  // Templated paragraph
  const picks: string[] = [];
  if (major[0]?.headline) picks.push(major[0].headline);
  if (india[0]?.headline) picks.push(india[0].headline);
  if (personal[0]?.stories?.[0]?.headline) picks.push(personal[0].stories[0].headline);
  const quick_personal_relevance = buildQuickPersonalRelevance(profile, picks);

  // Closer — verbatim from shared
  const closer = shared.closer;

  // Sprint 13 · Defect A: strip duplicate stories across personal sections.
  const dedupD = dedupPersonalSections(personal);
  if (dedupD.removed > 0) console.log(`[personalise:10min] dedup removed ${dedupD.removed} duplicate personal-section stories.`);

  // Sprint 13.2: users with a Markets-mapped interest get the REAL markets
  // section (summary + indices grid) instead of the flattened pseudo-story.
  // The pseudo-story carried only the summary text, so the indices grid
  // vanished from personalised Dailies. The pseudo-story is identifiable by
  // its fixed headline written in makeInterestSection.
  const hasMarketsInterest = ((profile?.interests || []) as string[])
    .some((i) => STANDARD_INTEREST_MAP[i]?.section === 'markets');
  const personalFinal = hasMarketsInterest
    ? dedupD.sections.filter((sec) => !(
        sec.id.startsWith('interest_') &&
        sec.stories.length === 1 &&
        (sec.stories[0] as any)?.headline === 'Markets today'
      ))
    : dedupD.sections;

  const content: any = {
    edition: '10min',
    date: shared.date,
    major_events: major,
    world,
    india,
    ...(hasMarketsInterest && shared.markets ? { markets: shared.markets } : {}),
    personal_sections: personalFinal,
    closer,
    quick_personal_relevance,
  };
  // Standard topic sections (business/markets/technology/climate_health/sport/
  // culture) are deliberately dropped for personalised users. They reach the
  // user only as interest-mapped sections (if the user opted in).

  return {
    content,
    stats: {
      sectionsKept: 3,
      sectionsDropped: 6,
      personalSectionsAdded: personal.length,
      citySpliced: personal.some((p) => p.id === 'your_city'),
      homeCitySpliced: personal.some((p) => p.id === 'your_home_city'),
      interestSectionsAdded: personal.filter((p) => p.id.startsWith('interest_')).length,
      relevanceParagraph: true,
    },
  };
}

function buildEditorialPersonalised(
  shared: any,
  profile: any,
): BuildResult {
  // The Editorial (deep) personalised shape:
  //  - three_patterns (universal, verbatim)
  //  - long_read: pick from candidates by profile (otherwise keep main)
  //  - watching_this_week (reordered)
  //  - signature (universal)
  //  - quick_personal_relevance (templated)
  // No your_city, no your_home_city. Editorial is synthesis, not local news.

  // Long Read theme selection — keep the default unless a candidate is more
  // relevant to the profile based on tag matching.
  const interests = ((profile?.interests || []) as string[]).map((x) => x.toLowerCase());
  const industry = (profile?.industry || '').toLowerCase();
  const city = (profile?.city_current || '').toLowerCase();

  const candidates: string[] = Array.isArray(shared?.long_read?.candidate_themes)
    ? shared.long_read.candidate_themes
    : [];
  // Pick the candidate with the most lowercase substring matches against interests/industry/city tokens.
  function themeScore(theme: string): number {
    const t = theme.toLowerCase();
    let s = 0;
    for (const i of interests) if (i && t.includes(i)) s += 3;
    if (industry && t.includes(industry)) s += 2;
    if (city && t.includes(city)) s += 2;
    return s;
  }
  const original = shared.long_read;
  let selectedLongRead = original;
  if (candidates.length > 0) {
    const scored = candidates
      .map((t) => ({ t, s: themeScore(t) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (scored.length > 0) {
      // We don't have a full per-candidate body — we mark it as the theme
      // the reader would have preferred, but keep the original body. The UI
      // can show this as "Today's long read could also be: <theme>" hint.
      // OR we just keep the original — simpler. Keeping original.
      // (When budget allows a per-user LLM call this is where Sonnet would
      // expand the chosen theme. For now we surface the original.)
      selectedLongRead = {
        ...original,
        personalised_theme_hint: scored[0].t,
      };
    }
  }

  // Watching reorder by profile.
  const watching = reorderByScore(shared.watching_this_week || [], (w: any) => {
    let s = 0;
    const iSet = new Set(interests);
    for (const i of (w?.interests || [])) if (iSet.has(String(i).toLowerCase())) s += 6;
    if (industry) for (const i of (w?.industries || [])) if (String(i).toLowerCase() === industry) s += 4;
    return s;
  });

  // Templated relevance paragraph for Editorial — slightly different framing.
  const picks: string[] = [];
  if (shared.three_patterns?.[0]?.title) picks.push(shared.three_patterns[0].title);
  if (selectedLongRead?.title) picks.push(selectedLongRead.title);
  if (watching?.[0]?.title) picks.push(watching[0].title);
  const quick_personal_relevance = buildQuickPersonalRelevance(profile, picks);

  const content: any = {
    edition: 'deep',
    date: shared.date,
    three_patterns: shared.three_patterns,
    long_read: selectedLongRead,
    watching_this_week: watching,
    signature: shared.signature,
    quick_personal_relevance,
  };

  return {
    content,
    stats: {
      sectionsKept: 4,
      sectionsDropped: 0,
      personalSectionsAdded: 0,
      citySpliced: false,
      homeCitySpliced: false,
      interestSectionsAdded: 0,
      relevanceParagraph: true,
    },
  };
}

// ─── Interest section pickers ───────────────────────────────────────────────

function pickFirstInterestSection(
  profile: any,
  shared: any,
  interestCache: Map<string, InterestStory[]>,
  shape: 'micro' | 'full',
  storiesPerSection: number,
): PersonalSection | null {
  const interests = (profile?.interests || []) as string[];
  if (interests.length === 0) return null;

  // Pick the user's first interest that has actual content.
  for (const interest of interests) {
    const sec = makeInterestSection(interest, shared, interestCache, shape, storiesPerSection);
    if (sec) return sec;
  }
  return null;
}

function pickInterestSections(
  interests: string[],
  shared: any,
  interestCache: Map<string, InterestStory[]>,
  shape: 'micro' | 'full',
  maxSections: number,
  storiesPerSection: number,
): PersonalSection[] {
  const out: PersonalSection[] = [];
  for (const interest of interests) {
    if (out.length >= maxSections) break;
    const sec = makeInterestSection(interest, shared, interestCache, shape, storiesPerSection);
    if (sec) out.push(sec);
  }
  return out;
}

function makeInterestSection(
  interest: string,
  shared: any,
  interestCache: Map<string, InterestStory[]>,
  shape: 'micro' | 'full',
  storiesPerSection: number,
): PersonalSection | null {
  const id = `interest_${interest.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  const mapped = STANDARD_INTEREST_MAP[interest];

  if (mapped) {
    // Standard-section interest. Pull stories from shared brief's section.
    const sec = mapped.section;
    let stories: any[] = [];

    if (sec === 'markets') {
      // Markets is special — no story list, just summary + indices. Render as
      // a single "story" so the UI can treat it uniformly.
      const m = shared.markets;
      if (!m || !m.summary) return null;
      if (shape === 'micro') {
        stories = [{
          headline: 'Markets today',
          what_happened: m.summary,
          why_it_matters: 'Selected because Markets is in your interests.',
          source: 'Markets summary',
          source_url: '',
          industries: [], interests: [], city_tags: [], topic_tags: ['markets'],
          must_include: false,
        }];
      } else {
        stories = [{
          headline: 'Markets today',
          facts: m.summary,
          background: 'Daily markets snapshot from the standard brief.',
          why_it_matters: 'You opted into Markets coverage in your profile.',
          what_happens_next: 'Watch for index moves and major sector news.',
          analysis: 'See the indices below the summary.',
          source: 'Markets summary',
          source_url: '',
          industries: [], interests: [], city_tags: [], topic_tags: ['markets'],
          must_include: false,
        }];
      }
      // Limit
      stories = stories.slice(0, storiesPerSection);
      // Sprint 14.2: append dedicated markets/finance ARTICLES (markets_news)
      // after the snapshot, so Markets-interested readers get real stories,
      // not just the index summary. Keeps the widget; adds depth.
      const mNews = Array.isArray(shared.markets_news) ? shared.markets_news : [];
      if (mNews.length > 0) {
        const extra = (shape === 'micro' ? mNews.map(fullToMicro) : mNews).slice(0, storiesPerSection);
        stories = stories.concat(extra);
      }
    } else if (sec === 'sport' || sec === 'culture') {
      // Sport/culture are arrays of 2-4 stories as of Sprint 9.
      const arr = Array.isArray(shared[sec]) ? shared[sec] : [];
      if (arr.length === 0) return null;
      stories = (shape === 'micro' ? arr.map(fullToMicro) : arr).slice(0, storiesPerSection);
    } else if (sec === 'world' || sec === 'india') {
      // Skip — already in standard slot for personalised users.
      return null;
    } else {
      const raw = Array.isArray(shared[sec]) ? shared[sec] : [];
      if (raw.length === 0) return null;
      stories = (shape === 'micro' ? raw.map(fullToMicro) : raw).slice(0, storiesPerSection);
    }

    if (stories.length === 0) return null;
    return {
      id,
      label: mapped.label,
      icon: mapped.icon,
      kind: 'list',
      stories,
    };
  }

  // Non-standard interest — fetched separately into interestCache.
  const fetched = interestCache.get(interest) || [];
  if (fetched.length === 0) return null;
  // Branch the map so TypeScript sees a single concrete callback per call.
  // (A conditional `.map(shape === 'micro' ? ... : ...)` fails type-check
  // because the two return shapes don't unify.)
  const sliced = fetched.slice(0, storiesPerSection);
  const stories: any[] = shape === 'micro'
    ? sliced.map((s) => interestToMicro(s, interest))
    : sliced.map((s) => interestToFull(s, interest));

  return {
    id,
    label: interest,
    icon: '🎯',
    kind: 'list',
    stories,
  };
}

function fullToMicro(s: any) {
  // Adapter for cases where The Daily's FullStory needs to render in The Brief.
  // (Used when a single-story section like sport is surfaced in 5min via interests.)
  return {
    headline: s?.headline || '',
    what_happened: s?.facts || s?.body || '',
    why_it_matters: s?.why_it_matters || 'Relevant for your interests.',
    source: s?.source || '',
    source_url: s?.source_url || '',
    industries: s?.industries || [],
    interests: s?.interests || [],
    city_tags: s?.city_tags || [],
    topic_tags: s?.topic_tags || [],
    must_include: !!s?.must_include,
  };
}

// ─── Sprint 13 · Defect A: personal-sections dedup ──────────────────────────
//
// The same story (by source_url) could appear in two interest sections for
// one user (e.g. a Bollywood story under both film_ott AND music). Fix:
// walk sections in array order (= interest priority order), first occurrence
// wins, later occurrences are stripped. Sections left empty are dropped.
// Key: source_url when present, else normalised headline.

function dedupPersonalSections(personal: PersonalSection[]): { sections: PersonalSection[]; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const out: PersonalSection[] = [];
  for (const sec of personal) {
    const stories = (sec.stories || []).filter((s: any) => {
      const key = (s?.source_url && String(s.source_url).trim())
        || String(s?.headline || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key) return true;
      if (seen.has(key)) { removed++; return false; }
      seen.add(key);
      return true;
    });
    if (stories.length > 0) out.push({ ...sec, stories });
  }
  return { sections: out, removed };
}

// ─── Sprint 13 · Defect B: tail_briefs fallback for 0-hit fetches ───────────
//
// Legacy path (USE_TAIL_BRIEFS=false): when an in-handler fetch errors OR
// returns 0 stories, fall back to today's tail_briefs row for that key. This
// is the painful failure for low-interest-count users (2 interests → 1 hits
// 0 → half their personalisation silently vanishes). It is also the gateway
// to eventually flipping USE_TAIL_BRIEFS=true.

async function fillEmptyFromTailBriefs(
  uniqueCities: string[],
  uniqueInterests: string[],
  cityCache: Map<string, CityStory[]>,
  interestCache: Map<string, InterestStory[]>,
  failures: TailFailureSets,
): Promise<{ interestsFilled: string[]; citiesFilled: string[] }> {
  const today = getISTDate();
  const interestsFilled: string[] = [];
  const citiesFilled: string[] = [];

  const needyInterests = uniqueInterests.filter(
    (i) => !STANDARD_INTEREST_MAP[i] && ((interestCache.get(i) || []).length === 0),
  );
  const needyCities = uniqueCities.filter(
    (c) => ((cityCache.get(cityKey(c)) || []).length === 0),
  );
  if (needyInterests.length === 0 && needyCities.length === 0) {
    return { interestsFilled, citiesFilled };
  }

  const { data, error } = await supabase
    .from('tail_briefs')
    .select('tail_type, tail_key, stories, status')
    .eq('date', today);
  if (error || !data) {
    console.warn(`[tail-fallback] tail_briefs read failed: ${error?.message || 'no data'} — fallback unavailable.`);
    return { interestsFilled, citiesFilled };
  }
  const byKey = new Map<string, any>();
  for (const row of data) byKey.set(`${row.tail_type}|${row.tail_key}`, row);

  for (const interest of needyInterests) {
    const row = byKey.get(`interest|${interest.toLowerCase().trim()}`);
    const stories = Array.isArray(row?.stories)
      ? row.stories.filter((s: any) => s?.source_url && isWhitelistedSource(s.source_url))
      : [];
    if (row?.status !== 'failed' && stories.length > 0) {
      interestCache.set(interest, stories as InterestStory[]);
      failures.interestErrors.delete(interest);
      interestsFilled.push(interest);
      console.log(`[tail-fallback] interest "${interest}" filled from tail_briefs (${stories.length} stories).`);
    } else {
      console.warn(`[tail-fallback] interest "${interest}" has 0 stories in-handler AND no usable tail_briefs row — section will be absent.`);
    }
  }

  for (const city of needyCities) {
    const key = cityKey(city);
    const row = byKey.get(`city|${key}`);
    const stories = Array.isArray(row?.stories)
      ? row.stories.filter((s: any) => s?.source_url && isWhitelistedSource(s.source_url))
      : [];
    if (row?.status !== 'failed' && stories.length > 0) {
      // Sprint 14.7: same safety backstop for tail-sourced city fills.
      cityCache.set(key, applyCitySafety(stories) as CityStory[]);
      failures.cityErrors.delete(key);
      citiesFilled.push(city);
      console.log(`[tail-fallback] city "${city}" filled from tail_briefs (${stories.length} stories).`);
    }
  }

  return { interestsFilled, citiesFilled };
}

// ─── Save ────────────────────────────────────────────────────────────────────

// Sprint 17: the personalised path does its OWN legacy in-handler fetch for
// non-standard interests (USE_TAIL_BRIEFS=false), so those stories never pass
// through the brief's dead-link check in generate-brief.tsx — a dead cntraveller
// travel link shipped this way. Run the SAME hardened liveness check (shared
// @/lib/liveness) over every personal_sections story before save. Scoped to the
// few personalised stories that actually ship; conservative (only 404/410 drop),
// with the 30% circuit breaker. NOTE: this runs per (user × edition); at current
// user counts that is cheap. If personalised users grow, move the check up to the
// city/interest CACHE build so each unique URL is checked once for all users.
async function pruneDeadPersonalLinks(content: any, label: string): Promise<number> {
  if (!content || !Array.isArray(content.personal_sections)) return 0;
  let removed = 0;
  const TRUST_RSS_TAILS = (process.env.TRUST_RSS_TAILS || 'true').toLowerCase() !== 'false';
  for (const sec of content.personal_sections) {
    if (!sec || !Array.isArray(sec.stories) || sec.stories.length === 0) continue;
    // Sprint 19 — city and interest tails are now RSS-sourced (real publisher
    // URLs, not LLM-fabricated), so the liveness check is counterproductive here:
    // with the checker frequently blocked from Vercel it false-positives "dead"
    // on real articles and trips the circuit breaker for nothing. Skip those;
    // keep the check only for industry (still Perplexity-sourced).
    const secId = String(sec.id || '').toLowerCase();
    if (TRUST_RSS_TAILS && !secId.startsWith('industry')) continue;
    const r = await dropDeadStories(sec.stories, (s: any) => s?.source_url, { label: `${label}:${sec.id || 'section'}` });
    if (!r.circuitBroken && r.dead.length > 0) { sec.stories = r.kept; removed += r.dead.length; }
  }
  return removed;
}

async function savePersonalised(
  userId: string,
  date: string,
  edition: Edition,
  content: any,
  lens: any,
): Promise<{ ok: boolean; error?: string }> {
  // Sprint 8: lens lives inside the content JSONB (no DB migration needed).
  const contentWithLens = content
    ? { ...content, lens: lens ?? content?.lens ?? null }
    : content;
  // Sprint 17: drop dead personalised links before they reach the reader.
  if (contentWithLens) {
    const removed = await pruneDeadPersonalLinks(contentWithLens, `personalise:liveness ${edition}`);
    if (removed > 0) console.warn(`[personalise:liveness] ${userId} ${edition}: dropped ${removed} dead personalised link(s).`);
  }
  const { error } = await supabase
    .from('personalised_briefs')
    .upsert(
      {
        user_id: userId,
        date,
        edition,
        status: 'ready',
        content: contentWithLens,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,date,edition' },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  attachLogCapture(res); // Sprint 14.5: tee server logs into the JSON response
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Optional cron secret. Sprint 13: also accepts a logged-in user's supabase
  // session token (the /admin page attaches it), matching generate-brief.tsx.
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers['authorization'] || '';
    const provided = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const bearer = provided.replace(/^Bearer\s+/i, '').trim();
    const alt =
      (req.headers['x-cron-secret'] as string) ||
      (req.body && (req.body as any).secret) ||
      (req.query.secret as string);
    let authorised = bearer === expectedSecret || alt === expectedSecret;
    if (!authorised && bearer) {
      try {
        const { data, error } = await supabase.auth.getUser(bearer);
        if (!error && data?.user) authorised = true;
      } catch { /* fall through */ }
    }
    if (!authorised) {
      return res.status(401).json({ success: false, error: 'Unauthorised' });
    }
  }

  const body = req.body && typeof req.body === 'object' ? (req.body as any) : {};
  const onlyUserId: string | undefined = body.userId || (req.query.userId as string) || undefined;
  const dryRun: boolean = body.dryRun === true || req.query.dryRun === 'true';

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ success: false, error: 'Missing OPENAI_API_KEY' });
  }

  const date = getISTDate();

  // 1) Load shared briefs (lens now lives inside content JSONB)
  const { data: briefRows, error: briefErr } = await supabase
    .from('briefs')
    .select('edition, status, content')
    .eq('date', date);
  if (briefErr) {
    return res.status(500).json({ success: false, error: `Failed to load briefs: ${briefErr.message}` });
  }
  const briefByEdition: Record<string, any> = {};
  let sharedLens: any = null;
  for (const row of briefRows || []) {
    briefByEdition[row.edition] = row;
    const rowLens = (row as any).content?.lens;
    if (!sharedLens && rowLens) sharedLens = rowLens;
  }

  // 2) Load personalised users
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('brief_type', 'personalised');
  if (profErr) {
    return res.status(500).json({ success: false, error: `Failed to load profiles: ${profErr.message}` });
  }

  let users = profiles || [];
  if (onlyUserId) {
    users = users.filter((p: any) => (p.user_id || p.id) === onlyUserId);
  }

  // 3) Collect unique cities + interests + industries across all users
  const allCities = new Set<string>();
  const allInterests = new Set<string>();
  const allIndustries = new Set<string>();
  for (const u of users) {
    if (normaliseStr(u.city_current)) allCities.add(normaliseStr(u.city_current));
    if (normaliseStr(u.city_home)) allCities.add(normaliseStr(u.city_home));
    if (Array.isArray(u.interests)) {
      for (const i of u.interests) if (typeof i === 'string' && i.trim()) allInterests.add(i.trim());
    }
    if (normaliseStr(u.industry)) allIndustries.add(normaliseStr(u.industry));
  }
  const uniqueCities = Array.from(allCities);
  const uniqueInterests = Array.from(allInterests);
  const uniqueIndustries = Array.from(allIndustries);
  console.log(`Unique cities: ${uniqueCities.length} — ${uniqueCities.join(', ')}`);
  console.log(`Unique interests: ${uniqueInterests.length} (${uniqueInterests.filter((i) => !STANDARD_INTEREST_MAP[i]).length} non-standard need fetch)`);
  console.log(`Unique industries (Sprint 12): ${uniqueIndustries.length} — ${uniqueIndustries.join(', ')}`);
  console.log(`USE_TAIL_BRIEFS flag: ${USE_TAIL_BRIEFS ? 'true (read from tail_briefs)' : 'false (legacy in-handler fetch)'}`);

  // 4) Build caches.
  // Sprint 12: when USE_TAIL_BRIEFS=true, read from tail_briefs table — no OpenAI calls.
  // When false, fall back to legacy in-handler fetches (Sprint 11 behaviour).
  const failures: TailFailureSets = {
    cityErrors: new Set<string>(),
    interestErrors: new Set<string>(),
  };

  let cityCache: Map<string, CityStory[]>;
  let interestCache: Map<string, InterestStory[]>;
  let industryCache: Map<string, InterestStory[]> = new Map();

  if (USE_TAIL_BRIEFS) {
    const caches = await loadFromTailBriefs(uniqueCities, uniqueInterests, uniqueIndustries, failures);
    cityCache = caches.cityCache;
    interestCache = caches.interestCache;
    industryCache = caches.industryCache;
  } else {
    // Legacy path — Sprint 11 behaviour preserved verbatim.
    [cityCache, interestCache] = await Promise.all([
      buildCityCache(uniqueCities, failures),
      buildInterestCache(uniqueInterests, failures),
    ]);
    // Sprint 13 · Defect B: any key that errored OR returned 0 stories gets a
    // second chance from today's tail_briefs rows (written by mode=tail-fetch
    // earlier in the cron sequence). This is the gateway to USE_TAIL_BRIEFS=true.
    const filled = await fillEmptyFromTailBriefs(uniqueCities, uniqueInterests, cityCache, interestCache, failures);
    if (filled.interestsFilled.length + filled.citiesFilled.length > 0) {
      console.log(`[tail-fallback] filled from tail_briefs — interests: [${filled.interestsFilled.join(', ')}], cities: [${filled.citiesFilled.join(', ')}]`);
    }
  }

  if (failures.cityErrors.size > 0) {
    console.warn(`[tail] city errors: ${Array.from(failures.cityErrors).join(', ')}`);
  }
  if (failures.interestErrors.size > 0) {
    console.warn(`[tail] interest errors: ${Array.from(failures.interestErrors).join(', ')}`);
  }

  const results: any[] = [];

  // 5) Per user — editions run in parallel within a user
  for (const profile of users) {
    const userId = profile.user_id || profile.id;
    const userResult: any = {
      userId,
      fullName: profile.full_name ?? null,
      city: profile.city_current ?? null,
      editions: {},
    };

    if (!userId) {
      userResult.error = 'profile row has no user_id/id';
      results.push(userResult);
      continue;
    }

    const userCityKey = cityKey(normaliseStr(profile.city_current));
    const userHomeKey = cityKey(normaliseStr(profile.city_home));
    const cityStories = userCityKey ? (cityCache.get(userCityKey) || []) : [];
    const homeStories = userHomeKey && userHomeKey !== userCityKey ? (cityCache.get(userHomeKey) || []) : [];

    // Sprint 11: per-user tail_status derived from this user's specific
    // city/interest needs vs which fetches errored. We DON'T flag empty-but-
    // successful fetches — those represent quiet news days, not failures.
    const userInterestList = (profile.interests || []) as string[];
    const userNonStdInterests = userInterestList.filter((i) => !STANDARD_INTEREST_MAP[i]);
    const cityFailed =
      (userCityKey && failures.cityErrors.has(userCityKey)) ||
      (userHomeKey && userHomeKey !== userCityKey && failures.cityErrors.has(userHomeKey));
    const interestFailed = userNonStdInterests.some((i) => failures.interestErrors.has(i));

    let tailStatus: 'ok' | 'partial_city_failed' | 'partial_interest_failed' | 'partial_both';
    if (cityFailed && interestFailed)      tailStatus = 'partial_both';
    else if (cityFailed)                   tailStatus = 'partial_city_failed';
    else if (interestFailed)               tailStatus = 'partial_interest_failed';
    else                                   tailStatus = 'ok';

    userResult.tailStatus = tailStatus;

    try {
      await Promise.all(
        EDITIONS.map(async (edition) => {
          const source = briefByEdition[edition];
          if (!source || source.status === 'failed' || !source.content) {
            userResult.editions[edition] = { status: 'skipped', reason: 'no source brief today' };
            return;
          }

          const shared = asObject(source.content);
          let built: BuildResult;
          if (edition === '5min') {
            built = buildQuickPersonalised(shared, profile, cityStories, homeStories, interestCache, industryCache);
          } else if (edition === '10min') {
            built = buildDailyPersonalised(shared, profile, cityStories, homeStories, interestCache, industryCache);
          } else {
            built = buildEditorialPersonalised(shared, profile);
          }

          // Sprint 13 · Defect C instrumentation: one compact fingerprint line
          // per user per edition so cross-user homogeneity can be diagnosed
          // from Vercel logs (compare order of first 3 stories per section
          // across users with different mood_preference).
          if (edition === '10min') {
            const fp = (arr: any[]) => (arr || []).slice(0, 3).map((s: any) => String(s?.headline || '').slice(0, 40)).join(' | ');
            console.log(`[homogeneity] user=${userId} mood=${profile.mood_preference || '-'} major=[${fp((built.content as any).major_events)}] india=[${fp((built.content as any).india)}] world=[${fp((built.content as any).world)}]`);
          }

          // Sprint 11: write tail_status into content JSONB so admin
          // dashboard can read it without a new column.
          (built.content as any).tail_status = tailStatus;

          if (dryRun) {
            userResult.editions[edition] = { status: 'dry_run', tail_status: tailStatus, ...built.stats };
            return;
          }

          const saved = await savePersonalised(userId, date, edition, built.content, shared?.lens || sharedLens);
          if (!saved.ok) {
            userResult.editions[edition] = { status: 'db_error', reason: saved.error };
            return;
          }
          userResult.editions[edition] = { status: 'ready', tail_status: tailStatus, ...built.stats };
        }),
      );
    } catch (e: any) {
      userResult.error = `unexpected: ${e?.message || e}`;
    }

    results.push(userResult);
  }

  const editionsReady = results.reduce(
    (n, r) => n + Object.values(r.editions || {}).filter((e: any) => e.status === 'ready').length,
    0,
  );

  // Sprint 11: per-status counts so admin dashboard can show degradation.
  const tailStatusCounts = results.reduce((acc: Record<string, number>, r) => {
    const k = r.tailStatus || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return res.status(200).json({
    success: true,
    date,
    dryRun,
    useTailBriefs: USE_TAIL_BRIEFS,
    uniqueCities,
    uniqueInterests,
    uniqueIndustries,
    cityHits: Object.fromEntries(Array.from(cityCache.entries()).map(([c, s]) => [c, s.length])),
    interestHits: Object.fromEntries(Array.from(interestCache.entries()).map(([i, s]) => [i, s.length])),
    industryHits: Object.fromEntries(Array.from(industryCache.entries()).map(([i, s]) => [i, s.length])),
    tailFailures: {
      cityErrors: Array.from(failures.cityErrors),
      interestErrors: Array.from(failures.interestErrors),
    },
    tailStatusCounts,
    processed: results.length,
    editionsReady,
    results,
  });
}
