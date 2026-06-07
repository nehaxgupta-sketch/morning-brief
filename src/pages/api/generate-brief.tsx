// src/pages/api/generate-brief.tsx
//
// Sprint 8 — generate-brief.
//
// Architecture (one nightly cron run):
//   1. Read personalisation universe (cities + interests + industries) from
//      every profile with brief_type = 'personalised'. Cheap — one Supabase
//      query.
//   2. Single shared OpenAI fetch with web search (gpt-4o + web_search_preview)
//      that returns:
//        - raw stories across all standard sections (major_events, world,
//          india, business, markets, technology, climate_health, sport,
//          culture), with story-level tags for downstream personalisation
//        - "must_include" flags on stories the model judged the day cannot
//          legitimately omit (in-prompt Pass-A guarantee)
//        - the four-line "lens" — used by the home-screen flash card
//      Hard source whitelist enforced in-prompt AND post-fetch via hostname
//      validation. Dedup enforced in-prompt AND post-fetch via fingerprint.
//   3. Three parallel writes:
//        - The Brief (5min): gpt-4o-mini, micro-item format
//        - The Daily (10min): gpt-4o-mini, full 5-field stories
//        - The Editorial (deep): gpt-4o, synthesis only (no story-level entries)
//   4. Validate (Zod), save to briefs, push.
//
// City and interest news are NOT fetched here — they live in personalise-
// briefs.tsx, which runs as a follow-up cron.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

// 300s = 5min. Vercel Pro caps at 300; Hobby with Fluid Compute enabled also
// reaches 300. gpt-5 with reasoning web_search at 'low' effort runs ~150-200s.
// REQUIRES Fluid Compute toggle in Vercel project settings → Functions.
export const config = { maxDuration: 300 };

// ─── Env / clients ──────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Date helpers (IST) ─────────────────────────────────────────────────────

function getISTDate(offsetDays = 0): string {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

function isWeekend(): boolean {
  // IST day of week — used to flex the Editorial's Long Read length.
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const dow = new Date(istMs).getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

// ─── Source whitelist (Tier 1) ──────────────────────────────────────────────

// Tier-1 hostnames the post-fetch validator accepts. Everything else gets
// flagged and the story is dropped before the brief is written. Keep this
// in sync with the in-prompt whitelist (sourcing instructions in fetchNews).
const TIER_1_DOMAINS = new Set<string>([
  // Global wires + papers of record
  'reuters.com',
  'apnews.com',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'bbc.com',
  'bbc.co.uk',
  'economist.com',
  'theguardian.com',
  'aljazeera.com',
  'abc.net.au',
  // India — wires + papers of record
  'ptinews.com',          // Press Trust of India (wire)
  'aninews.in',           // Asian News International
  'thehindu.com',
  'thehindubusinessline.com',
  'indianexpress.com',
  'newindianexpress.com',
  'hindustantimes.com',
  'ndtv.com',
  'timesofindia.indiatimes.com',
  'deccanherald.com',
  'telegraphindia.com',   // Kolkata/East India
  'tribuneindia.com',     // Punjab/Haryana/Himachal strong
  // India — business / markets
  'livemint.com',
  'business-standard.com',
  'economictimes.indiatimes.com',
  'financialexpress.com',
  'moneycontrol.com',
  'businesstoday.in',
  // India — digital + magazine journalism
  'theprint.in',
  'scroll.in',
  'thewire.in',
  'indiatoday.in',
  'outlookindia.com',
  'thequint.com',
  'caravanmagazine.in',
  'thenewsminute.com',    // South India regional
  // India — specialist (legal, environment)
  'livelaw.in',           // Court/legal news
  'barandbench.com',      // Court/legal news
  'downtoearth.org.in',   // Environment / public health
  // Government / institutional primary sources
  'rbi.org.in',
  'sebi.gov.in',
  'mospi.gov.in',         // Ministry of Statistics
  'pib.gov.in',           // Press Information Bureau
  'bls.gov',              // US Bureau of Labor Statistics
  'treasury.gov',
  'federalreserve.gov',
  'imf.org',
  'worldbank.org',
  'who.int',
  // Specialist (allowed where general sources don't cover)
  'espncricinfo.com',
  'espn.com',
  'variety.com',
  'hollywoodreporter.com',
  'nature.com',
  'science.org',
  'statnews.com',
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
]);

function extractHostname(url: string): string | null {
  try {
    const u = new URL(url);
    // Strip www./m./amp. prefixes — mobile and AMP subdomains of whitelisted
    // publishers (e.g. m.economictimes.com) should pass whitelist check.
    return u.hostname.toLowerCase()
      .replace(/^www\./, '')
      .replace(/^m\./, '')
      .replace(/^amp\./, '');
  } catch {
    return null;
  }
}

function isWhitelistedSource(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const host = extractHostname(url);
  if (!host) return false;
  // Accept exact match or any subdomain of a whitelisted domain.
  // Array.from() avoids downlevel-iteration error on Set<string>.
  for (const allowed of Array.from(TIER_1_DOMAINS)) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Edition = '5min' | '10min' | 'deep';

interface RawStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  // Tagging for downstream personalisation:
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  // Day-of must-include flag:
  must_include?: boolean;
}

interface MarketIndex { name: string; change: string; }

interface RawStories {
  // Stories first, by section:
  major_events: RawStory[];
  world: RawStory[];
  india: RawStory[];
  business: RawStory[];
  technology: RawStory[];
  climate_health: RawStory[];
  sport: RawStory[];      // Was single; now array (Sprint 9) — 2-4 stories across different sports.
  culture: RawStory[];    // Was single; now array (Sprint 9) — 2-4 stories across different culture types.
  markets: { summary: string; indices: MarketIndex[] };
  // Lens — the four-line summary used by the home flash card.
  lens: {
    world: string;
    india: string;
    markets: string;
    watch: string;
  };
}

// ─── Output shapes (one per edition) ────────────────────────────────────────

interface MicroStory {
  headline: string;
  what_happened: string;
  why_it_matters: string;
  source: string;
  source_url: string;
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  must_include?: boolean;
}

interface FullStory {
  headline: string;
  facts: string;
  background: string;
  why_it_matters: string;
  what_happens_next: string;
  analysis: string;
  source: string;
  source_url: string;
  industries?: string[];
  interests?: string[];
  city_tags?: string[];
  topic_tags?: string[];
  must_include?: boolean;
}

interface Closer {
  headlines_to_remember: string[];  // exactly 5
  things_to_watch: string[];         // exactly 3
  conversation_insight: string;
}

interface BriefQuick {
  edition: '5min';
  date: string;
  major_events: MicroStory[];
  world: MicroStory[];
  india: MicroStory[];
  topics: MicroStory[];  // cross-topic mix (~5 items)
}

interface BriefDaily {
  edition: '10min';
  date: string;
  major_events: FullStory[];
  world: FullStory[];
  india: FullStory[];
  business: FullStory[];
  markets: { summary: string; indices: MarketIndex[] };
  technology: FullStory[];
  climate_health: FullStory[];
  sport?: FullStory;
  culture?: FullStory;
  closer: Closer;
}

interface Pattern {
  title: string;
  body: string;
  stories_connected: string[];  // headlines this pattern synthesises
}

interface LongRead {
  title: string;
  body: string;
  candidate_themes?: string[];  // alt themes for personalisation
}

interface WatchItem {
  title: string;
  body: string;
  interests?: string[];
  industries?: string[];
  topic_tags?: string[];
}

interface BriefEditorial {
  edition: 'deep';
  date: string;
  three_patterns: Pattern[];
  long_read: LongRead;
  watching_this_week: WatchItem[];
  signature: {
    one_number: { value: string; context: string };
    one_chart: { title: string; description: string };
    one_quote?: { quote: string; attribution: string; context: string } | null;
  };
}

type BriefContent = BriefQuick | BriefDaily | BriefEditorial;

// ─── Zod schemas ────────────────────────────────────────────────────────────

const TagsSchema = z.object({
  industries: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  city_tags: z.array(z.string()).optional(),
  topic_tags: z.array(z.string()).optional(),
  must_include: z.boolean().optional(),
});

const MicroStorySchema = TagsSchema.extend({
  headline: z.string().min(5).max(200),
  what_happened: z.string().min(8),
  why_it_matters: z.string().min(8),
  source: z.string().min(1),
  source_url: z.string().startsWith('https://'),
});

const FullStorySchema = TagsSchema.extend({
  headline: z.string().min(5).max(200),
  facts: z.string().min(15),
  background: z.string().min(15),
  why_it_matters: z.string().min(15),
  what_happens_next: z.string().min(15),
  analysis: z.string().min(15),
  source: z.string().min(1),
  source_url: z.string().startsWith('https://'),
});

const MarketIndexSchema = z.object({
  name: z.string().min(1),
  change: z.string().min(1),
});

// Closer schema: permissive on counts so the entire 10min brief doesn't fail
// when gpt-4o-mini returns 4 or 6 headlines instead of exactly 5. The writer
// prompt still asks for "exactly 5" / "exactly 3" — the schema just stops
// strict counts from being a brief-killer on quiet news days.
const CloserSchema = z.object({
  headlines_to_remember: z.array(z.string().min(5)).min(3).max(7),
  things_to_watch: z.array(z.string().min(5)).min(2).max(5),
  conversation_insight: z.string().min(20),
});

const BriefQuickSchema = z.object({
  edition: z.literal('5min'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Sections can be empty on quiet news days — UI shows "no stories" rather than failing the whole brief.
  major_events: z.array(MicroStorySchema),
  world: z.array(MicroStorySchema),
  india: z.array(MicroStorySchema),
  topics: z.array(MicroStorySchema),
});

const BriefDailySchema = z.object({
  edition: z.literal('10min'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Sections can be empty on quiet news days — UI shows "no stories" rather than failing the whole brief.
  major_events: z.array(FullStorySchema),
  world: z.array(FullStorySchema),
  india: z.array(FullStorySchema),
  business: z.array(FullStorySchema),
  markets: z.object({
    summary: z.string().min(10),
    indices: z.array(MarketIndexSchema).min(1).max(6),
  }),
  technology: z.array(FullStorySchema),
  climate_health: z.array(FullStorySchema),
  // sport/culture became arrays in Sprint 9 to support breadth across multiple
  // sports/culture types. Permissive on count — empty on quiet days is fine.
  sport: z.array(FullStorySchema).max(6),
  culture: z.array(FullStorySchema).max(6),
  closer: CloserSchema,
});

const PatternSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(100),
  stories_connected: z.array(z.string()).min(2),
});

const LongReadSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(200),
  candidate_themes: z.array(z.string()).optional(),
});

const WatchItemSchema = z.object({
  title: z.string().min(5),
  body: z.string().min(20),
  interests: z.array(z.string()).optional(),
  industries: z.array(z.string()).optional(),
  topic_tags: z.array(z.string()).optional(),
});

const BriefEditorialSchema = z.object({
  edition: z.literal('deep'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  three_patterns: z.array(PatternSchema).length(3),
  long_read: LongReadSchema,
  watching_this_week: z.array(WatchItemSchema).min(3).max(6),
  signature: z.object({
    one_number: z.object({
      value: z.string().min(1),
      context: z.string().min(10),
    }),
    one_chart: z.object({
      title: z.string().min(3),
      description: z.string().min(15),
    }),
    one_quote: z.object({
      quote: z.string().min(10),
      attribution: z.string().min(3),
      context: z.string().min(10),
    }).nullish(),
  }),
});

const LensSchema = z.object({
  world: z.string().min(8),
  india: z.string().min(8),
  markets: z.string().min(8),
  watch: z.string().min(8),
});

// ─── JSON extraction helper ─────────────────────────────────────────────────

function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    throw new Error(`JSON truncated. Length=${cleaned.length}, last 200: ${cleaned.slice(-200)}`);
  }
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (e: any) {
    throw new Error(`JSON parse failed: ${e.message}. Near end: ${candidate.slice(-300)}`);
  }
}

// ─── Phase 1: Personalisation universe ──────────────────────────────────────

interface Universe {
  industries: string[];
  interests: string[];
  cities: string[];
}

async function loadPersonalisationUniverse(): Promise<Universe> {
  const { data, error } = await supabase
    .from('profiles')
    .select('industry, interests, city_current, city_home')
    .eq('brief_type', 'personalised');

  if (error) {
    console.warn('Universe lookup failed:', error.message);
    return { industries: [], interests: [], cities: [] };
  }

  const industries = new Set<string>();
  const interests = new Set<string>();
  const cities = new Set<string>();

  for (const row of data || []) {
    const r = row as any;
    if (typeof r.industry === 'string' && r.industry.trim()) {
      industries.add(r.industry.trim());
    }
    if (Array.isArray(r.interests)) {
      for (const i of r.interests) {
        if (typeof i === 'string' && i.trim()) interests.add(i.trim());
      }
    }
    if (typeof r.city_current === 'string' && r.city_current.trim()) {
      cities.add(r.city_current.trim());
    }
    if (typeof r.city_home === 'string' && r.city_home.trim()) {
      cities.add(r.city_home.trim());
    }
  }

  return {
    industries: Array.from(industries).sort(),
    interests: Array.from(interests).sort(),
    cities: Array.from(cities).sort(),
  };
}

// ─── Phase 2: Shared news fetch ─────────────────────────────────────────────
//
// Architecture: parallel per-section fetches. One large prompt covering 8
// sections was unreliable — gpt-4o would do a single web search, land on a
// roundup page, and return 1-2 stories. Section-scoped prompts (each with
// one clear job) get the model to actually iterate searches per section.
// Trade-off: 8 API calls instead of 1, slightly higher cost. Wall-clock
// time stays similar because they run in parallel via Promise.allSettled.

// ─── Shared prompt fragments ────────────────────────────────────────────────

function sourceWhitelistBlock(): string {
  return `SOURCE WHITELIST — cite ONLY from these publishers:
GLOBAL WIRES & PAPERS OF RECORD: Reuters, Associated Press, Bloomberg, Financial Times, Wall Street Journal, New York Times, Washington Post, BBC, The Guardian, The Economist, Al Jazeera, ABC News (Australia).
INDIA NATIONAL DAILIES & WIRES: PTI (Press Trust of India), ANI, The Hindu, Indian Express, Hindustan Times, NDTV, New Indian Express, Times of India, Deccan Herald, Telegraph India, Tribune India.
INDIA BUSINESS / MARKETS: Economic Times, LiveMint (Mint), Business Standard, Financial Express, The Hindu BusinessLine, Moneycontrol, Business Today.
INDIA DIGITAL & MAGAZINES: The Print, Scroll, The Wire, India Today, Outlook India, The Quint, Caravan Magazine, The News Minute (South India regional).
INDIA SPECIALIST: Live Law / Bar and Bench (courts), Down To Earth (environment, health).
GOVT / INSTITUTIONAL PRIMARY SOURCES (use when more authoritative than press): RBI, SEBI, MoSPI, PIB, US Bureau of Labor Statistics, US Treasury, Federal Reserve, IMF, World Bank, WHO.
SPECIALIST (only where general sources don't cover): ESPNCricinfo / ESPN (sport — especially IPL), Variety / Hollywood Reporter (entertainment), Nature / Science / STAT (health/science), TechCrunch / The Verge / Ars Technica / Wired (tech).

NOT ALLOWED — drop the story rather than cite from here:
- Aggregators (Google News, MSN, Yahoo News)
- Social media (X/Twitter, Reddit, YouTube)
- Vendor / corporate blogs (openai.com/blog, microsoft.com/blog, etc.) — these are PR, not journalism
- Opinion blogs, listicle sites, anonymous/no-byline pieces
- Domain you don't recognise

SOURCE_URL must be a direct article URL on the publisher's domain. No redirects, no homepage URLs, no aggregator wrappers. Mobile (m.) and AMP subdomains of whitelisted publishers are acceptable. If you can't find a whitelisted article, leave the section empty rather than fabricate.

For Tier-2 Indian cities (Lucknow, Pune, Punjab cities, etc.) where major papers have thin coverage, prefer Tribune India (Punjab), Telegraph India (East), News Minute (South), or Hindustan Times / Times of India city editions. If none have today's local story, leave that city section empty.`;
}

function tagsBlockFor(universe: Universe): string {
  if (!universe.industries.length && !universe.interests.length) {
    return `TAGGING: No personalisation vocabulary yet. Skip the tag fields.`;
  }
  return `TAGGING (for downstream personalisation):
On every story, include zero or more tags from these EXACT vocabularies (case-sensitive):
- "industries": ${JSON.stringify(universe.industries)}
- "interests":  ${JSON.stringify(universe.interests)}
- "city_tags":  ${JSON.stringify(universe.cities)} (only if materially relevant)
- "topic_tags": from { "business", "markets", "technology", "climate", "health", "sport", "culture", "policy", "education", "infrastructure", "energy" }

Only tag where relevance is real and direct. Better to leave a tag array empty than to over-tag.`;
}

function storyShape(today: string): string {
  return `{ "headline": "...", "body": "2-3 factual sentences", "source": "Publisher Name", "source_url": "https://...", "published_at": "ISO date or ${today}", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }`;
}

// ─── Generic per-section fetch ──────────────────────────────────────────────

async function callOpenAISection(prompt: string, sectionName: string, maxTokens = 4000): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      tools: [{ type: 'web_search_preview' }],
      // 'auto' lets the model iterate searches naturally (which it does in a
      // small, focused prompt — and didn't in the old monolithic one).
      tool_choice: 'auto',
      input: prompt,
      max_output_tokens: maxTokens,
    }),
  });

  const data = await response.json();
  console.log(`[fetch:${sectionName}] status ${response.status}, items ${data.output?.length}`);
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) throw new Error(`[fetch:${sectionName}] No text in response. Raw: ${JSON.stringify(data).slice(0, 500)}`);
  return extractJsonObject(text);
}

// ─── Per-section fetchers ───────────────────────────────────────────────────

async function fetchListSection(
  section: string,
  guidance: string,
  count: string,
  universe: Universe,
  today: string,
  excludeContext?: string,
): Promise<any[]> {
  const exclusionBlock = excludeContext
    ? `\n${excludeContext}\n`
    : '';

  const prompt = `You are a senior news editor for an India-based daily brief. Today is ${today}.

Your job: produce the "${section}" section. Use the web_search_preview tool to find real articles. Run multiple searches if needed — do not stop at the first roundup page.

${guidance}

TARGET COUNT: ${count} stories. If genuine news doesn't support the full count, return fewer — never fabricate to fill quota.
${exclusionBlock}
${sourceWhitelistBlock()}

RECENCY: every story published within the last 48 hours (major_events allows up to 7 days for sustained themes).

MUST_INCLUDE: if a story is one of the day's 5 dominant stories that any responsible Indian brief would be embarrassed to omit (national election result, IPL final, major policy ruling, geopolitical event with India impact, market-moving event), set "must_include": true. Otherwise false.

ORDER stories within the array by consequence — index 0 most important.

${tagsBlockFor(universe)}

OUTPUT — return ONLY this JSON, no markdown:
{ "stories": [ ${storyShape(today)} ] }`;

  const parsed = await callOpenAISection(prompt, section);
  return Array.isArray(parsed?.stories) ? parsed.stories : [];
}

async function fetchSingleSection(
  section: 'sport' | 'culture',
  universe: Universe,
  today: string,
): Promise<any | null> {
  const guidance = section === 'sport'
    ? `Find THE single biggest sport story of the day in India or globally. On Indian summer days (April-June), this is very often an IPL match — especially a final or playoff (cricket is the dominant Indian sport story). Tour matches, major tennis/football fixtures, world records also qualify. ESPNCricinfo and the sports sections of whitelisted papers (Times of India, NDTV, Indian Express) are good sources for cricket.`
    : `Find THE single biggest culture/entertainment story of the day. This could be a film release, an arts award, a major book/music release, a death of a notable cultural figure, or a viral cultural moment.`;

  const prompt = `You are a senior news editor for an India-based daily brief. Today is ${today}.

Your job: produce the single "${section}" story for today. Use the web_search_preview tool — run multiple searches if needed.


${guidance}

${sourceWhitelistBlock()}

CRITICAL OUTPUT RULE: You MUST output VALID JSON and nothing else. No prose, no preamble, no markdown explanations. If you cannot find a suitable story from a whitelisted source, output EXACTLY: { "story": null }
Do NOT write apologies. Do NOT explain your search. Do NOT say "I couldn't find...". The ONLY allowed output is the JSON object below.

${tagsBlockFor(universe)}

OUTPUT — return ONLY this JSON, no markdown, no other text:
{ "story": ${storyShape(today)} }

OR, if no suitable whitelisted story exists:
{ "story": null }`;

  const parsed = await callOpenAISection(prompt, section, 2500).catch((err) => {
    // Model returned prose instead of JSON, or the call itself failed. Either
    // way: treat as "no story today" rather than crashing the parent fetch.
    console.warn(`[fetch:${section}] parse failed, treating as null:`, err.message);
    return null;
  });
  return parsed?.story && typeof parsed.story === 'object' && parsed.story.headline ? parsed.story : null;
}

async function fetchMarkets(today: string): Promise<{ summary: string; indices: MarketIndex[] }> {
  const prompt = `You are a markets desk reporter. Today is ${today}. Use web_search_preview to fetch TODAY's closing values (or most recent if markets are open) for:
- Sensex (BSE)
- Nifty 50 (NSE)
- S&P 500
- Nasdaq Composite

Search multiple sources if needed. Return ONLY this JSON, no markdown:
{
  "summary": "2-3 sentences on today's market direction and drivers, India-focused",
  "indices": [
    { "name": "Sensex",  "change": "+0.4%" },
    { "name": "Nifty",   "change": "-0.1%" },
    { "name": "S&P 500", "change": "+0.6%" },
    { "name": "Nasdaq",  "change": "+1.1%" }
  ]
}

Use real values — if you cannot confirm, use a neutral 0.0% rather than fabricate a number.`;

  const parsed = await callOpenAISection(prompt, 'markets', 2000);
  return {
    summary: parsed?.summary || '',
    indices: Array.isArray(parsed?.indices) ? parsed.indices : [],
  };
}

async function fetchLens(rawStories: RawStories, today: string): Promise<{ world: string; india: string; markets: string; watch: string }> {
  // Synthesised once we have all sections back. Doesn't need its own web search;
  // the input is the already-fetched stories.
  const summary = {
    world: rawStories.world.slice(0, 3).map((s) => s.headline),
    india: rawStories.india.slice(0, 3).map((s) => s.headline),
    major_events: rawStories.major_events.slice(0, 3).map((s) => s.headline),
    markets_summary: rawStories.markets.summary,
  };

  const prompt = `You are writing the four-line "lens" that appears on the home screen of an India daily brief on ${today}. Each line is ONE short sentence (max 14 words), written in clear neutral English.

Stories fetched today:
${JSON.stringify(summary, null, 2)}

Return ONLY this JSON, no markdown:
{
  "world": "the single biggest theme in global news today",
  "india": "the single biggest theme in Indian news today",
  "markets": "a one-liner on markets direction and what's driving it",
  "watch": "the single most important development to watch this week"
}`;

  // No web search needed — pure synthesis.
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      input: prompt,
      max_output_tokens: 600,
    }),
  });
  const data = await response.json();
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) return { world: '', india: '', markets: '', watch: '' };
  try {
    const parsed = extractJsonObject(text);
    return {
      world: parsed?.world || '',
      india: parsed?.india || '',
      markets: parsed?.markets || '',
      watch: parsed?.watch || '',
    };
  } catch {
    return { world: '', india: '', markets: '', watch: '' };
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

// ─── PATH B: Single gpt-5 reasoning + web_search call ───────────────────────
// Replaces the per-section parallel fetchers. The legacy helpers below
// (fetchListSection, fetchSingleSection, fetchMarkets) remain in the file
// as dead code for quick rollback via git.

async function callGpt5Reasoning(
  prompt: string,
  reasoningEffort: 'low' | 'medium' | 'high' = 'medium',
): Promise<string> {
  const t0 = Date.now();
  console.log(`[gpt-5] Starting reasoning fetch (effort=${reasoningEffort}). This typically takes 60-180s.`);

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: prompt }],
      reasoning: { effort: reasoningEffort },
      tools: [{ type: 'web_search' }],
      max_output_tokens: 32000,
    }),
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const data = await response.json();
  console.log(`[gpt-5] Response received in ${elapsed}s, status=${response.status}.`);

  if (response.status !== 200) {
    throw new Error(`gpt-5 returned status ${response.status}. Body: ${JSON.stringify(data).slice(0, 600)}`);
  }

  // Count what happened for visibility in Vercel logs.
  const items = Array.isArray(data.output) ? data.output : [];
  const searchCount = items.filter((o: any) => o.type === 'web_search_call' || o.type === 'tool_use').length;
  const reasoningCount = items.filter((o: any) => o.type === 'reasoning').length;
  console.log(`[gpt-5] output items=${items.length}, web_searches=${searchCount}, reasoning_blocks=${reasoningCount}`);

  // Extract the final assistant message text. Walk through any 'message' or
  // 'output_text' items and concatenate. Defensive — the Responses API can
  // return text in slightly different shapes.
  let text = '';
  for (const item of items) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' || c.type === 'text') {
          text += (c.text || '');
        }
      }
    } else if (item.type === 'output_text' && typeof item.text === 'string') {
      text += item.text;
    }
  }

  if (!text) {
    throw new Error(`gpt-5 returned no text. Raw: ${JSON.stringify(data).slice(0, 600)}`);
  }
  return text;
}

function buildGpt5FetchPrompt(today: string, universe: Universe): string {
  return `You are the fetcher for Morning Brief, India's daily news digest for thoughtful urban professionals (25-45, urban, English-reading). Today is ${today} (IST).

Your job: search the web aggressively for today's most consequential news and return ONE JSON object with all sections filled. Use the web_search tool. Perform AT LEAST 15-20 distinct searches across topics — depth matters; do not stop early.

═══════════════════════════════════════════════
RECENCY — STRICT 24-HOUR RULE
═══════════════════════════════════════════════

Every story must represent a development WITHIN THE LAST 24 HOURS. This applies to EVERY section including major_events.

This is about NARRATIVE freshness, not just publish date. Specifically:

- For a one-off event (election result, court ruling, earnings report): the event itself must have happened in the last 24 hours, AND the article must be published in the last 24 hours.

- For a sustained narrative (war, IPL season, RBI policy cycle): there MUST be a FRESH development today (new strike, today's match, follow-up policy move, retirement, welcome ceremony, controversy, post-match analysis published today). If only the underlying event from days ago exists with no fresh angle in the last 24h, OMIT the story — do NOT report stale news.

═══════════════════════════════════════════════
HEADLINE SHAPE — DESCRIBE TODAY'S DEVELOPMENT
═══════════════════════════════════════════════

When a sustained narrative does have a fresh 24h development, the HEADLINE must describe today's development — NOT the underlying narrative.

The underlying narrative is context. The development is the news. Get this wrong and the brief reads like yesterday's paper.

GOOD vs BAD examples:
- ✅ "RCB victory parade draws lakhs to Bengaluru streets" (Day +2: parade is the fresh development)
- ❌ "RCB wins maiden IPL title" (Day +2: this is old news pretending to be today's)
- ✅ "US strikes Iranian drone facility in Bandar Abbas overnight" (fresh military action)
- ✅ "Tehran signals openness to back-channel talks via Oman" (fresh diplomatic move)
- ❌ "Iran-US tensions continue" (no actual development — status, not news)
- ❌ "Russia-Ukraine war enters fourth year" (no fresh development — anniversary framing)
- ✅ "Ukraine signs new $50bn EU defence pact" (fresh policy move in ongoing war)
- ✅ "RBI holds repo rate at 6.5%, signals neutral stance" (fresh policy decision)
- ❌ "RBI continues to fight inflation" (no event today)

═══════════════════════════════════════════════
ONE-SHOT EVENTS — NATURAL DECAY
═══════════════════════════════════════════════

Events that climax and end (finals, summits, launches, weddings, funerals, product unveilings) get major_events real estate ONLY while they're producing genuinely new developments.

- Day of event → include (the event itself is the development).
- Day +1 → include only if there's real follow-on news (a parade, a controversy, a policy consequence, an analytical reframing by a credible outlet). Not "people are still talking about it."
- Day +2 onwards → drop, unless a substantial new chapter has opened (e.g. a player's retirement announcement triggered by the win, a summit-driven sanctions package signed, a launch revealing a fatal flaw).

A story that was huge yesterday but generated no real follow-on today does NOT belong in today's brief. Empty section beats stale story.

═══════════════════════════════════════════════
DEAD-NEWS TEST (apply to every story before including it)
═══════════════════════════════════════════════

Ask: "If a reader saw this brief but already read yesterday's news, would the headline tell them something new?"

If yes → include.
If no → omit, even if the underlying story is important. Importance ≠ recency.

If you cannot find a section's quota of stories that pass this test, return fewer stories. Better to under-fill a section than pad with stale narrative.

═══════════════════════════════════════════════
SECTIONS TO COLLECT — OVER-FETCH
═══════════════════════════════════════════════

OVER-FETCHING IS REQUIRED. After your output, downstream filters drop stories that fail the source whitelist, recency check, or semantic-dedup against major_events. The final brief targets 20 surviving stories. Aim for the upper bound of every range below.

- major_events: 4-5 stories. SUSTAINED, multi-day themes shaping the week — ongoing wars, IPL playoffs/finals (only while still producing genuine follow-on news), election cycles, major policy rollouts (RBI policy, budget, big regulatory moves), multi-day disasters. Each entry MUST have a fresh 24-hour development AND the headline must describe that development (e.g. "Tehran signals openness to back-channel talks" — NOT "Iran-US tensions continue"). Apply the dead-news test. A theme without a today-development does NOT belong here. Empty beats stale.

- world: 7-8 stories. 24-hour global news from OUTSIDE India. Spread across regions — avoid all 7 from one country unless it's a genuinely dominant news day there. Cover: US politics, major elections abroad, big government decisions, international relations, cross-border business moves, climate/disaster events, major court rulings, big tech moves abroad.

- india: 7-8 stories. 24-hour national news. Government actions, court rulings, state-level developments of national significance (Bengaluru, Mumbai, Delhi, Chennai, Hyderabad, Pune, Kolkata, Ahmedabad all qualify), business deals, accidents/disasters, social/political events. Include RBI rate decisions, monsoon updates, major Indian corporate news.

- business: 4-5 stories. Corporate news, earnings, M&A, regulatory actions, major financial moves. Indian AND global. Skip pure markets summaries (handled separately).

- technology: 3-4 stories. Significant product launches, major AI developments, big-tech regulation, cybersecurity events. Skip rumour/speculation.

- climate_health: 3-4 stories. Climate disasters, environmental policy, major health stories (outbreaks, drug approvals, research with real implications). Stories with concrete real-world impact.

- sport: 3-4 stories ACROSS DIFFERENT SPORTS. Cricket, football, tennis, F1, badminton, hockey, kabaddi, Olympics, athletics, golf, esports — pick the day's biggest from as many different sports as the day's news supports. Do NOT submit 4 cricket stories; if cricket has the biggest story, include ONE cricket story and fill the rest from other sports.

- culture: 3-4 stories ACROSS DIFFERENT CULTURE TYPES. Films, OTT, music, books, theatre, visual arts, awards — AND viral trends or internet phenomena WHEN they've crossed into mainstream coverage (covered by The Hindu, Mint, India Today, Indian Express, The Print, Reuters, BBC etc., not just social media) and have a fresh 24h development. The headline must describe today's development (a deal, a controversy, a milestone, a brand collaboration), not the underlying trend's existence — e.g. "Vada Pav Girl signs Netflix reality TV deal" NOT "Vada Pav Girl is famous." Like sport, aim for breadth across culture types where the day's news supports it. Most days the slot will be film/OTT/music/books; viral moments qualify only when genuinely dominant.

- markets: ONE object with summary + indices. Find today's closing values for Sensex, Nifty 50, Dow Jones, Nasdaq Composite. Write a 2-3 sentence India-anchored summary of today's market action.

- lens: ONE object with 4 short sentences (≤14 words each), each summarising the day's most important development:
  • world: the most important world development today
  • india: the most important India development today
  • markets: the headline market move today
  • watch: what to track in the coming days

═══════════════════════════════════════════════
SOURCING — STRICT WHITELIST
═══════════════════════════════════════════════

${sourceWhitelistBlock()}

═══════════════════════════════════════════════
STORY FIELDS (per story object)
═══════════════════════════════════════════════

- headline: ≤16 words, factual, lead with the subject (country, company, person, number) — not the verb.
- body: 2-3 factual sentences. Specific numbers, names, dates, locations. NO opinion or framing — just facts.
- source: publisher name (e.g. "Reuters", "The Hindu")
- source_url: DIRECT article URL on the publisher's domain. NEVER a homepage, never an aggregator wrapper, never a redirect. Must include the article slug/ID.
- published_at: ISO date (today's date is acceptable if you can't find the exact published_at).
- industries, interests, city_tags, topic_tags: see TAGGING block below.
- must_include: boolean. Set true ONLY for stories that are absolutely critical today (1-3 across the whole fetch — RBI rate decisions, major war escalations, big India policy announcements, IPL final, major disasters). Default false.

${tagsBlockFor(universe)}

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════

1. WHITELIST: every source_url MUST be from a whitelisted publisher domain. Verify by checking the hostname. If you found a great story but can't find it on a whitelisted source, OMIT it — don't fabricate.
2. NO FABRICATION: do not invent headlines, URLs, quotes, or facts. If you can't find a section's quota of stories from whitelisted sources, return fewer stories — never pad.
3. SEARCH DEPTH: do at least 15 distinct searches across topics. The model that fails this task fails by stopping after 1-2 searches. Don't be that model.
4. DEDUP — STRICT. No two stories may cover the same underlying event, even from different publishers. Specifically:
   a) major_events owns ALL sustained narratives (wars, RBI policy cycles, ongoing elections, IPL playoffs, multi-day disasters). If a 24-hour news development belongs to one of these narratives, EMBED it into that major_events story's body — do NOT also list it as a world or india entry. world/india are reserved for stories OUTSIDE the major_events set.
   b) An Indian business story belongs in india (not business) if it has national-policy or macro significance. Pure corporate news (earnings, M&A) belongs in business.
   c) If a story could fit two sections, pick ONE — the higher-priority section by this order: major_events > india > world > business > technology > climate_health > sport > culture.
   d) Run a self-check before returning: read every world and india headline, ask "is this an update on a story I already listed in major_events?" If yes, remove it from world/india and fold its key fact into the major_events story body.
5. SPORT AND CULTURE: each is an ARRAY of 3-4 story objects with all fields populated (headline, body, source, source_url, published_at, must_include). NEVER undefined fields. If fewer real whitelisted stories are available, return a shorter array. If none are available, return an empty array — do NOT omit the key.
6. MARKETS INDICES: must be an ARRAY of objects shaped like: [{"name":"Sensex","value":"74243","change":"-0.16%"}, {"name":"Nifty 50","value":"23366","change":"-0.21%"}, {"name":"Dow Jones","value":"...","change":"..."}, {"name":"Nasdaq","value":"...","change":"..."}]. Never a single object, never a string. Use today's actual closing values.
7. JSON ONLY: output a single JSON object. No markdown, no preamble, no explanation. Start with { and end with }.

═══════════════════════════════════════════════
OUTPUT SHAPE
═══════════════════════════════════════════════

{
  "major_events": [ ${storyShape(today)}, ... ],
  "world":        [ ${storyShape(today)}, ... ],
  "india":        [ ${storyShape(today)}, ... ],
  "business":     [ ${storyShape(today)}, ... ],
  "technology":   [ ${storyShape(today)}, ... ],
  "climate_health": [ ${storyShape(today)}, ... ],
  "sport":   [ ${storyShape(today)}, ... ],
  "culture": [ ${storyShape(today)}, ... ],
  "markets": {
    "summary": "2-3 sentence India-anchored summary of today's market action",
    "indices": [
      { "name": "Sensex", "change": "+0.5%" },
      { "name": "Nifty 50", "change": "+0.4%" },
      { "name": "Dow Jones", "change": "-0.2%" },
      { "name": "Nasdaq", "change": "+0.1%" }
    ]
  },
  "lens": {
    "world": "one short sentence ≤14 words",
    "india": "one short sentence ≤14 words",
    "markets": "one short sentence ≤14 words",
    "watch": "one short sentence ≤14 words on what to watch next"
  }
}

Begin now. Search the web aggressively. Return only the JSON object.`;
}

async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  // Single big call to gpt-5 with reasoning + web_search.
  // 'medium' effort: 'low' was returning only ~8 searches against a 15-20
  // search instruction, producing near-empty section arrays. 'medium' pushes
  // the model to actually do the over-fetch the prompt requires. Latency
  // rises from ~65s to ~120-180s, still well under Vercel's 300s cap.
  const prompt = buildGpt5FetchPrompt(today, universe);
  const text = await callGpt5Reasoning(prompt, 'medium');

  // Parse the JSON. extractJsonObject handles markdown fences + extra prose
  // around the JSON if the model misbehaves.
  let parsed: any;
  try {
    parsed = extractJsonObject(text);
  } catch (err: any) {
    console.error('[gpt-5] JSON parse failed. First 600 chars of output:', text.slice(0, 600));
    throw new Error(`gpt-5 output not parseable as JSON: ${err.message}`);
  }

  console.log(`[fetch] gpt-5 raw section counts: ` +
    `major=${parsed.major_events?.length || 0}, world=${parsed.world?.length || 0}, india=${parsed.india?.length || 0}, ` +
    `biz=${parsed.business?.length || 0}, tech=${parsed.technology?.length || 0}, climate=${parsed.climate_health?.length || 0}, ` +
    `sport=${parsed.sport?.length || 0}, culture=${parsed.culture?.length || 0}, indices=${parsed.markets?.indices?.length || 0}`);

  // Run through the existing dedup + whitelist enforcement pipeline.
  // (This catches any non-whitelisted URLs gpt-5 may have slipped through.)
  const cleaned = enforceQualityRules(parsed);

  // Lens: gpt-5 should have produced one in the same call. If it didn't, or
  // if it's malformed, fall back to the standalone lens synthesiser.
  const lensFromModel = parsed?.lens;
  if (lensFromModel && lensFromModel.world && lensFromModel.india && lensFromModel.markets && lensFromModel.watch) {
    cleaned.lens = lensFromModel;
  } else {
    console.warn('[fetch] gpt-5 lens missing/invalid; falling back to fetchLens.');
    cleaned.lens = await fetchLens(cleaned, today).catch((err) => {
      console.warn('[fetch:lens] fallback also failed:', err.message);
      return { world: '', india: '', markets: '', watch: '' };
    });
  }

  return cleaned;
}

// ─── LEGACY (Path A) per-section fetcher — kept for rollback ────────────────
// To revert: rename this function to `fetchNewsFromOpenAI` (and rename the
// gpt-5 version above to `fetchNewsFromOpenAI_pathB_legacy` or similar).
// All downstream code (writers, enforcement, save) is untouched.

async function fetchNewsFromOpenAI_legacy(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  // Section-specific guidance. The prompt is small and focused enough that the
  // model actually performs targeted searches instead of giving up after one.
  const sectionDefs: Array<{ section: string; guidance: string; count: string }> = [
    {
      section: 'major_events',
      count: '3 to 4',
      guidance: `MAJOR EVENTS are sustained, multi-day themes shaping the week — ongoing wars, election cycles, IPL season at finals stage, major policy rollouts, multi-day disasters. DISTINCT from 24-hour news (which goes into world/india). Pick the dominant narratives that someone reading this brief should be aware of even if today's headline is small.`,
    },
    {
      section: 'world',
      count: 'exactly 5',
      guidance: `WORLD is 24-hour global news outside India. Major government decisions, international relations, foreign elections, big-tech moves abroad, global economic actions, climate/disaster events, major court rulings. Spread across regions — don't put all 5 from one country unless it's a genuinely dominant news day there.`,
    },
    {
      section: 'india',
      count: 'exactly 5',
      guidance: `INDIA is 24-hour national news. Government actions, court rulings, state-level developments of national significance, business deals, accidents/disasters, social/political events. Significant CITY developments (Mumbai, Bengaluru, Chennai, Hyderabad, Delhi, Kolkata, Pune, Ahmedabad, Ahmedabad, etc.) belong here too. If today is an IPL final day or other major sport-but-national-event day, the sport story can ALSO appear in india if its national significance is large — that's fine, dedup happens downstream.`,
    },
    {
      section: 'business',
      count: '2 to 3',
      guidance: `BUSINESS — corporate news, earnings, M&A, major financial moves, regulatory actions. Indian and global. Skip pure markets summaries (handled separately).`,
    },
    {
      section: 'technology',
      count: '1 to 2',
      guidance: `TECHNOLOGY — product launches with real significance, major AI developments, big-tech regulation, cybersecurity events. Skip rumour or speculation pieces.`,
    },
    {
      section: 'climate_health',
      count: '1 to 2',
      guidance: `CLIMATE & HEALTH — climate disasters, environmental policy, major health stories (outbreaks, drug approvals, research findings with real implications). Pick stories with concrete real-world impact, not speculative research.`,
    },
  ];

  console.log(`[fetch] Starting parallel section fetch for ${today}. Sections: ${sectionDefs.map((s) => s.section).join(', ')}, sport, culture, markets.`);

  // Kick everything off in parallel.
  const listPromises = sectionDefs.map((def) =>
    fetchListSection(def.section, def.guidance, def.count, universe, today)
      .catch((err) => {
        console.warn(`[fetch:${def.section}] failed:`, err.message);
        return [] as any[];
      }),
  );
  const sportPromise = fetchSingleSection('sport', universe, today).catch((err) => {
    console.warn(`[fetch:sport] failed:`, err.message);
    return null;
  });
  const culturePromise = fetchSingleSection('culture', universe, today).catch((err) => {
    console.warn(`[fetch:culture] failed:`, err.message);
    return null;
  });
  const marketsPromise = fetchMarkets(today).catch((err) => {
    console.warn(`[fetch:markets] failed:`, err.message);
    return { summary: '', indices: [] };
  });

  const [listResults, sport, culture, markets] = await Promise.all([
    Promise.all(listPromises),
    sportPromise,
    culturePromise,
    marketsPromise,
  ]);

  // Stitch into the raw shape that enforceQualityRules expects.
  const stitched: any = {
    major_events: listResults[0],
    world: listResults[1],
    india: listResults[2],
    business: listResults[3],
    technology: listResults[4],
    climate_health: listResults[5],
    sport,
    culture,
    markets,
  };

  console.log(`[fetch] Section counts pre-enforcement: ` +
    `major=${stitched.major_events.length}, world=${stitched.world.length}, india=${stitched.india.length}, ` +
    `biz=${stitched.business.length}, tech=${stitched.technology.length}, climate=${stitched.climate_health.length}, ` +
    `sport=${sport ? 1 : 0}, culture=${culture ? 1 : 0}, indices=${markets.indices.length}`);

  // Run existing dedup + whitelist + fingerprinting pipeline.
  const cleaned = enforceQualityRules(stitched);

  // Synthesise the lens from what we got. (Lens isn't a fetch — it's a summary.)
  cleaned.lens = await fetchLens(cleaned, today).catch((err) => {
    console.warn('[fetch:lens] failed:', err.message);
    return { world: '', india: '', markets: '', watch: '' };
  });

  return cleaned;
}

// ─── Post-fetch enforcement ─────────────────────────────────────────────────
// Source-whitelist + dedup + must_include count, applied to fetched raw stories.

// ─── Recency window check ───────────────────────────────────────────────────
//
// Returns true if a story's published_at is within the last 24 hours (or 72h
// for major_events, which are explicitly sustained narratives — but their
// LATEST development must still be within the last 24h, enforced in the
// prompt). We're permissive on parse failures: if published_at is missing or
// unparseable, keep the story rather than drop on a date format issue. The
// LLM is instructed to use today's date if it can't determine actual
// published_at, so missing dates trend "fresh".
const RECENCY_HOURS_DEFAULT = 24;
const RECENCY_HOURS_MAJOR = 72;

function isWithinRecencyWindow(publishedAt: any, section: string): boolean {
  if (!publishedAt || typeof publishedAt !== 'string') return true; // permissive on missing
  // Date-only strings (YYYY-MM-DD) must be parsed as end-of-day IST, not
  // midnight UTC. Without this, "2026-06-06" parses as 5:30 AM IST on 6 June,
  // which at any IST morning cron run (e.g. 6:38 AM on 7 June) lands ~25h
  // old and gets dropped from the 24h-window sections — killing every story
  // gpt-5 dates as "yesterday" even if the event was actually 8 PM yesterday.
  let normalized = publishedAt.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T23:59:59+05:30`;
  }
  const ts = Date.parse(normalized);
  if (isNaN(ts)) return true; // permissive on unparseable
  const hours = section === 'major_events' ? RECENCY_HOURS_MAJOR : RECENCY_HOURS_DEFAULT;
  const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
  return ageHours <= hours;
}

// ─── Semantic dedup: major_events ↔ world/india ─────────────────────────────
//
// gpt-5 sometimes returns the same underlying story in both major_events and
// world/india with different headlines or sources. Fingerprint dedup catches
// only exact URL matches; this catches semantic duplicates by comparing
// significant-word overlap between headlines. Keep in major_events (higher
// priority), drop from world/india.
const STOPWORDS = new Set([
  'a','an','the','of','in','on','at','to','for','and','or','but','with','by',
  'from','as','is','are','was','were','be','been','being','has','have','had',
  'do','does','did','will','would','could','should','may','might','must','can',
  'this','that','these','those','it','its','their','his','her','our','your',
  'over','under','into','out','up','down','off','about','than','then','also',
  'new','says','said','set','vs','v','amid','after','before','today','yesterday',
]);

function significantWords(headline: string): Set<string> {
  if (!headline || typeof headline !== 'string') return new Set();
  const tokens = headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

const SEMANTIC_DEDUP_THRESHOLD = 3;

function semanticOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of Array.from(a)) if (b.has(w)) n++;
  return n;
}

function dropSemanticDuplicatesAgainstMajor(raw: any): { kept: any; droppedCount: number } {
  const majorSets = (raw.major_events || []).map((s: any) => significantWords(s?.headline || ''));
  if (majorSets.length === 0) return { kept: raw, droppedCount: 0 };

  let droppedCount = 0;
  const filterSection = (arr: any[], sectionName: string): any[] => {
    if (!Array.isArray(arr)) return arr;
    return arr.filter((story) => {
      const set = significantWords(story?.headline || '');
      for (const mset of majorSets) {
        if (semanticOverlap(set, mset) >= SEMANTIC_DEDUP_THRESHOLD) {
          console.log(`[semantic-dedup] dropping ${sectionName} story (overlaps major_events): "${(story?.headline || '').slice(0, 80)}"`);
          droppedCount++;
          return false;
        }
      }
      return true;
    });
  };

  const kept = {
    ...raw,
    world: filterSection(raw.world, 'world'),
    india: filterSection(raw.india, 'india'),
  };
  return { kept, droppedCount };
}

function enforceQualityRules(raw: any): RawStories {
  // First pass: semantic dedup of world/india against major_events.
  const { kept: rawAfterSemanticDedup, droppedCount: semanticDropped } =
    dropSemanticDuplicatesAgainstMajor(raw);
  if (semanticDropped > 0) {
    console.log(`[enforce] Semantic dedup dropped ${semanticDropped} world/india stories overlapping major_events.`);
  }
  raw = rawAfterSemanticDedup;

  const dropped: { section: string; reason: string; headline?: string; url?: string }[] = [];
  const seenFingerprints = new Set<string>();

  function fingerprint(s: any): string {
    const h = (s?.headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const u = (s?.source_url || '').toLowerCase().split('?')[0];
    return `${h}|${u}`;
  }

  // Priority for dedup — earlier wins.
  const priority = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];

  function processList(section: string, list: any[]): RawStory[] {
    const kept: RawStory[] = [];
    for (const story of list || []) {
      if (!story || typeof story !== 'object') continue;

      // Source whitelist check
      if (!isWhitelistedSource(story.source_url)) {
        dropped.push({ section, reason: 'non-whitelisted source', headline: story.headline, url: story.source_url });
        continue;
      }

      // Recency check — 24h default, 72h for major_events
      if (!isWithinRecencyWindow(story.published_at, section)) {
        console.log(`[recency] dropping ${section} story (older than window): "${(story.headline || '').slice(0, 80)}" published_at=${story.published_at}`);
        dropped.push({ section, reason: 'outside recency window', headline: story.headline });
        continue;
      }

      // Dedup
      const fp = fingerprint(story);
      if (seenFingerprints.has(fp)) {
        dropped.push({ section, reason: 'duplicate of higher-priority section', headline: story.headline });
        continue;
      }
      seenFingerprints.add(fp);

      kept.push(story as RawStory);
    }
    return kept;
  }

  function processSingle(section: string, story: any): RawStory | undefined {
    // Graceful degradation: if the section is missing, malformed, or sourced from
    // a non-whitelisted publisher, return undefined. The 10min schema marks
    // sport/culture as optional, so the brief publishes without them on those days.
    if (!story || typeof story !== 'object') {
      console.warn(`Single-section ${section} missing or malformed; omitting.`);
      dropped.push({ section, reason: 'missing from fetch' });
      return undefined;
    }
    if (!isWhitelistedSource(story.source_url)) {
      console.warn(`Single-section ${section} dropped (non-whitelisted source): ${story.source_url}`);
      dropped.push({ section, reason: 'non-whitelisted source', headline: story.headline, url: story.source_url });
      return undefined;
    }
    if (!isWithinRecencyWindow(story.published_at, section)) {
      console.warn(`Single-section ${section} dropped (outside recency window): published_at=${story.published_at}`);
      dropped.push({ section, reason: 'outside recency window', headline: story.headline });
      return undefined;
    }
    const fp = fingerprint(story);
    if (seenFingerprints.has(fp)) {
      console.warn(`Single-section ${section} duplicated a higher-priority story; keeping anyway.`);
    } else {
      seenFingerprints.add(fp);
    }
    return story as RawStory;
  }

  const cleaned: RawStories = {
    major_events: [],
    world: [],
    india: [],
    business: [],
    technology: [],
    climate_health: [],
    sport: [],
    culture: [],
    markets: raw?.markets || { summary: '', indices: [] },
    lens: raw?.lens || { world: '', india: '', markets: '', watch: '' },
  };

  // Walk priority order so dedup picks the highest-priority section first.
  // All sections including sport/culture are arrays as of Sprint 9.
  for (const sec of priority) {
    const arr = raw?.[sec];
    (cleaned as any)[sec] = processList(sec, Array.isArray(arr) ? arr : []);
  }

  // Markets indices sanity
  if (!cleaned.markets.indices || cleaned.markets.indices.length !== 4) {
    console.warn('Markets indices count off — got', cleaned.markets.indices?.length);
  }

  // Count must_include flags
  let mustCount = 0;
  for (const sec of priority) {
    if (sec === 'sport' || sec === 'culture') {
      if ((cleaned as any)[sec]?.must_include) mustCount++;
    } else {
      for (const s of (cleaned as any)[sec]) if (s.must_include) mustCount++;
    }
  }
  console.log(`Quality enforcement complete. Must-includes: ${mustCount}/5. Dropped: ${dropped.length}`);
  if (dropped.length > 0) console.log('Dropped:', JSON.stringify(dropped, null, 2).slice(0, 1500));

  return cleaned;
}

// ─── Phase 3: Edition writers (three different prompts) ─────────────────────

function rawStoriesForWriter(raw: RawStories) {
  // Strip `lens` — it's a four-line home-screen summary, not source material.
  // Previously the deep writer was treating lens lines as available headlines
  // and putting them in three_patterns.stories_connected. Writers see stories
  // and markets only.
  const { lens, ...storiesOnly } = raw;
  return storiesOnly;
}

// ─── Deterministic post-filter subset builder ───────────────────────────────
//
// After enforceQualityRules drops non-whitelisted, stale, and semantically-
// duplicate stories, we still typically have more raw stories than each
// edition wants. This builder walks raw in priority order and takes the
// top-N stories overall (cap). Per Sprint 9 spec: 5min cap=15, 10min cap=20.
// The 5min set is a strict subset of the 10min set by construction.
//
// Priority order: major_events → india → world → business → technology →
// climate_health → sport → culture. Sport and culture are arrays of 2-4
// stories across different sports/culture types; they're consumed in order.
function buildSubset(raw: RawStories, cap: number): RawStories {
  let used = 0;
  const room = () => Math.max(0, cap - used);

  const take = (arr: RawStory[] | undefined): RawStory[] => {
    if (!arr || arr.length === 0) return [];
    const r = room();
    if (r <= 0) return [];
    const slice = arr.slice(0, r);
    used += slice.length;
    return slice;
  };

  // Priority order, highest first.
  const major_events = take(raw.major_events);
  const india        = take(raw.india);
  const world        = take(raw.world);
  const business     = take(raw.business);
  const technology   = take(raw.technology);
  const climate      = take(raw.climate_health);
  const sport        = take(raw.sport);
  const culture      = take(raw.culture);

  console.log(`[subset:cap=${cap}] picked ${used} stories — ` +
    `major=${major_events.length}, india=${india.length}, world=${world.length}, ` +
    `biz=${business.length}, tech=${technology.length}, climate=${climate.length}, ` +
    `sport=${sport.length}, culture=${culture.length}`);

  return {
    major_events,
    india,
    world,
    business,
    technology,
    climate_health: climate,
    sport,
    culture,
    markets: raw.markets,
    lens: raw.lens,
  };
}

async function writeQuickEdition(raw: RawStories): Promise<BriefQuick> {
  const today = getISTDate();

  // The 5min writer receives a pre-selected subset built by buildQuickSubset.
  // Its only job is to rewrite each story in MicroStory shape — same set of
  // stories that appear in the 10min edition, just shorter prose. This
  // guarantees 5min ⊆ 10min by construction.
  const prompt = `You are writing THE BRIEF — the 5-minute commute edition of Morning Brief, a daily news digest for thoughtful Indian readers (urban, professional, 25-45). Today is ${today}.

VOICE: calm, analytical, newspaper-like — the register of an Economist briefing or an FT lex card. Declarative, sober sentences. Active voice. Plain English. No clickbait, no sensationalism, no conversational fluff ("plus", "also", "by the way"). Explain jargon when used.

YOUR JOB: rewrite EVERY story from the raw stories below in MICRO-ITEM shape. Do NOT select, drop, or reorder. The selection has already been done; you are a rewriter, not an editor. One raw story in → one micro-item out.

FORMAT — each micro-item has the following fields:

Editorial fields (you write these):
- headline: clear, factual (≤ 14 words). Lead with the subject (country, company, person, number) — not the verb.
- what_happened: ONE sentence (≤ 22 words). State the news plainly. Use specific numbers, names, dates where they sharpen the story.
- why_it_matters: ONE sentence (≤ 22 words) — REQUIRED, never omit. ANCHOR TO INDIA. Acceptable hooks: inflation, the rupee, food prices, RBI policy, EMIs, household budgets, jobs, urban life, India's strategic position, or sector impact on Indian companies/markets. A purely global takeaway is acceptable ONLY if no Indian angle exists; never drop the field. Example to emulate: "Higher oil prices directly affect India's inflation, rupee, and household budgets."

Passthrough fields (copy from raw stories UNCHANGED):
- source, source_url, industries, interests, city_tags, topic_tags, must_include

SECTION MAPPING — output sections are derived from raw sections as follows:
- raw.major_events  → 5min.major_events  (preserve order, 1:1)
- raw.world         → 5min.world         (preserve order, 1:1)
- raw.india         → 5min.india         (preserve order, 1:1)
- raw.business + raw.technology + raw.climate_health + raw.sport + raw.culture → 5min.topics
  (concatenate IN THAT ORDER. business stories first, then technology, then climate_health, then sport (if present), then culture (if present). Do NOT reorder.)

HARD RULES:
- 1:1 MAPPING. If raw has 12 stories, output 12 stories. If raw has 15, output 15. Never add, never drop. Stories already passed source-whitelist and selection upstream.
- Every output story's source_url MUST appear verbatim in the raw stories below — never invent.
- Pass through source, source_url, industries, interests, city_tags, topic_tags, must_include UNCHANGED on every story.
- EVERY editorial field (headline, what_happened, why_it_matters) is REQUIRED. Empty arrays ([]) for tag fields are fine; null/missing/undefined values for text fields are NOT acceptable and will cause the brief to fail.
- Output ONLY JSON. No markdown fences, no commentary, no preamble. Start the response with { and end with }.

OUTPUT SHAPE:
{
  "edition": "5min",
  "date": "${today}",
  "major_events": [{ "headline": "...", "what_happened": "...", "why_it_matters": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }],
  "world":   [ /* 1:1 from raw.world */ ],
  "india":   [ /* 1:1 from raw.india */ ],
  "topics":  [ /* business → technology → climate_health → sport → culture, concatenated */ ]
}

Raw stories:
${JSON.stringify(rawStoriesForWriter(raw))}`;

  return callOpenAIChat('gpt-4o', prompt, 6000, 'The Brief (5min)');
}

async function writeDailyEdition(raw: RawStories): Promise<BriefDaily> {
  const today = getISTDate();
  const prompt = `You are writing THE DAILY — the 10-minute main edition of Morning Brief, a daily news digest for thoughtful Indian readers (urban, professional, 25-45). Today is ${today}.

VOICE: calm, analytical, newspaper-like — the register of a serious Indian daily front page mixed with an Economist briefing. Declarative, sober sentences. Active voice. Plain English. Separate fact from interpretation. Where facts are developing, uncertain, or disputed, say so explicitly ("early reports", "officials have not yet confirmed", "analysts disagree"). No clickbait, no sensationalism, no conversational filler. Explain jargon simply when used.

FORMAT — each story has FIVE labelled fields:
- headline: clear, factual (≤ 16 words). Lead with the subject (country, company, person, number) — not the verb.
- facts: 1-2 sentences. What happened. Specific numbers, names, dates, locations. Source-attributable.
- background: 1-2 sentences. What led to this. Why the story is relevant beyond the immediate headline.
- why_it_matters: 1-2 sentences. ANCHOR TO INDIA — household budgets, inflation, the rupee, RBI policy, jobs, urban life, healthcare, sector impact on Indian companies/markets, or India's strategic position. A purely global or generic takeaway is NOT enough. Even for world stories, name the Indian transmission channel. Example to emulate: "India imports most of its oil. Any sustained increase feeds into inflation and current account pressures."
- what_happens_next: 1-2 sentences. The SPECIFIC developments to track this week (named hearings, policy decisions, data releases, fixtures). Avoid "stay tuned" generalities.
- analysis: 1-2 sentences. Concise interpretation, clearly marked as opinion. Acknowledge uncertainty where appropriate. Make a point rather than restating facts.

SELECTION: Include EVERY story from the raw stories. Do not drop anything. Maintain the ordering from the raw stories within each section (raw is already impact-ordered). If raw stories has empty "sport" or "culture" arrays, output empty arrays for those keys — do NOT fabricate stories to fill them.

NO DUPLICATION ACROSS SECTIONS: a story belongs in ONLY ONE section. If raw stories has duplicate-feeling entries across sections, pick the section that fits best and skip the others.

CLOSER — include a "closer" object at the end with:
- headlines_to_remember: EXACTLY 5 single-line memory anchors covering today's biggest developments. Each ≤ 14 words, factual, scannable. Drawn from across the brief's most consequential stories.
- things_to_watch: EXACTLY 3 forward-looking developments to track this week. Each ONE sentence (≤ 24 words). Specific — name the event/release/decision and when.
- conversation_insight: ONE intelligent observation that CONNECTS MULTIPLE STORIES into a single pattern — the kind of remark that lands at a dinner table. 2-3 sentences. The bar: when read aloud, it should sound like a synthesis, not a restated headline. Example pattern to emulate: "The most important story in India right now is not a single headline — it is the combination of oil uncertainty, a weak monsoon outlook, and inflation risk. Individually they are manageable, but together they can influence everything from grocery bills and EMIs to market performance and government policy."

HARD RULES:
- USE ONLY THE STORIES PROVIDED IN THE RAW STORIES BELOW. Do not invent, infer, or recall stories from your own knowledge. Every story you output must correspond to a raw story; every source_url must appear VERBATIM in the raw stories. If a section has no usable raw stories, output an empty array — do NOT pad with fabricated entries.
- Carry source, source_url, industries, interests, city_tags, topic_tags, must_include UNCHANGED through every story.
- Keep markets indices values EXACTLY as in raw data. You may rewrite the markets summary in your voice (2 sentences, India-anchored).
- EVERY field on EVERY story is REQUIRED: headline, facts, background, why_it_matters, what_happens_next, analysis, source, source_url. Do not omit any of these on any story. Empty arrays ([]) for tag fields are fine; null/missing/undefined values for text fields are NOT acceptable and will cause the brief to fail.
- Output ONLY JSON. No markdown fences, no commentary, no preamble. Start the response with { and end with }.

OUTPUT SHAPE:
{
  "edition": "10min",
  "date": "${today}",
  "major_events": [{ "headline": "...", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }],
  "world":          [ /* same shape */ ],
  "india":          [ /* same shape */ ],
  "business":       [ /* same shape */ ],
  "markets":        { "summary": "rewritten 2-sentence India-anchored summary", "indices": [ /* unchanged */ ] },
  "technology":     [ /* same shape */ ],
  "climate_health": [ /* same shape */ ],
  "sport":   [ /* array of 2-4 stories across different sports, same shape */ ],
  "culture": [ /* array of 2-4 stories across different culture types, same shape */ ],
  "closer": {
    "headlines_to_remember": ["...", "...", "...", "...", "..."],
    "things_to_watch": ["...", "...", "..."],
    "conversation_insight": "..."
  }
}

Raw stories:
${JSON.stringify(rawStoriesForWriter(raw))}`;

  return callOpenAIChat('gpt-4o-mini', prompt, 14000, 'The Daily (10min)');
}

async function writeEditorialEdition(raw: RawStories): Promise<BriefEditorial> {
  const today = getISTDate();
  const longReadTarget = isWeekend() ? '450-550 words' : '300-400 words';
  const prompt = `You are the voice of Morning Brief — writing THE EDITORIAL, the analytical Sunday-coffee read. This is the most distinctive edition and the one a thoughtful reader actively chooses for synthesis, not for re-reading the day's news.

VOICE: like an FT Lex column or an Economist leader. Calm, intelligent, sharp. Not academic, not sensational. Plain English. Active voice. Acknowledge uncertainty where it exists.

THIS EDITION HAS NO STORY-LEVEL ENTRIES. The reader has (or will) read The Daily for that. The Editorial is pure synthesis.

═══════════════════════════════════════════════
SECTIONS REQUIRED
═══════════════════════════════════════════════

1. three_patterns — exactly 3 patterns connecting multiple of today's stories.
   Each pattern: 130-180 words. Format:
     - title: a sharp, distinctive label (≤ 10 words). Not a recap.
     - body: explain WHAT connects the stories, WHY the connection matters, and WHAT it reveals about the broader direction (of the world, India, markets, governance, culture). Reference specific stories by their substance, not their headlines.
     - stories_connected: list 3-5 headlines of stories this pattern draws from.

2. long_read — ONE editorial essay of ${longReadTarget} on the single most important theme of the day.
     - title: distinctive (≤ 12 words). Not a headline. An angle.
     - body: flowing prose, ${longReadTarget}. This is a HARD requirement — do not stop short. Pick ONE thread (e.g. "India's inflation-energy-monsoon triangle", "What the Karnataka transition reveals about urban governance"). Go deep: bring history, scale, second-order implications, named figures or institutions where relevant. Where facts are disputed, hedge explicitly. End with a forward-looking sentence. If you find yourself wrapping up before the word count, you have not gone deep enough — add a paragraph on consequences or counter-arguments.
     - candidate_themes: 2-3 alternative themes you could have chosen instead (for downstream personalisation that may pick a different one).

3. watching_this_week — exactly 5 forward-looking items. Each:
     - title: short (≤ 10 words)
     - body: 35-65 words. Why this matters, what to watch, when. Specific and concrete.
     - tag fields (interests, industries, topic_tags) where natural.

4. signature — three small editorial set pieces:
     - one_number: a single number that captures something important today. value is the number with units (e.g. "$87/barrel" or "12%"). context is 1-2 sentences on why this number matters today.
     - one_chart: a chart description (we render it client-side if at all). title is the chart's subject (e.g. "Brent crude, last 30 days"). description is 1-2 sentences on what the chart would show and why it's the right cut today.
     - one_quote: a quote from THIS WEEK worth sitting with. ONLY use a quote if it appears verbatim in the raw stories below or is a well-documented public statement by a named figure. Do NOT paraphrase a story and attribute it as a quote. Do NOT invent quotes. If no real quote is available, return null for this field — omission is correct. quote is the quote itself (≤ 40 words). attribution is who said it (name, role, publication). context is 1-2 sentences on why it lands.

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════
- Use the raw stories below as your source material. Do not invent stories, quotes, or facts. Every headline you reference in three_patterns.stories_connected must appear in the raw stories. The one_quote must be from a real raw-story figure or a real public figure — do not fabricate quotes.
- Do not duplicate The Daily's content. This is synthesis, not repetition.
- Output ONLY JSON. No markdown, no commentary.

OUTPUT SHAPE:
{
  "edition": "deep",
  "date": "${today}",
  "three_patterns": [
    { "title": "...", "body": "...", "stories_connected": ["...", "...", "..."] },
    { "title": "...", "body": "...", "stories_connected": ["...", "...", "..."] },
    { "title": "...", "body": "...", "stories_connected": ["...", "...", "..."] }
  ],
  "long_read": {
    "title": "...",
    "body": "${longReadTarget} of flowing prose.",
    "candidate_themes": ["...", "...", "..."]
  },
  "watching_this_week": [
    { "title": "...", "body": "...", "interests": [], "industries": [], "topic_tags": [] }
  ],
  "signature": {
    "one_number": { "value": "...", "context": "..." },
    "one_chart": { "title": "...", "description": "..." },
    "one_quote": { "quote": "...", "attribution": "...", "context": "..." }  // or null if no real quote available
  }
}

Raw stories:
${JSON.stringify(rawStoriesForWriter(raw))}`;

  return callOpenAIChat('gpt-4o', prompt, 12000, 'The Editorial (deep)');
}

async function callOpenAIChat(
  model: string,
  prompt: string,
  maxTokens: number,
  label: string,
): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });

  const data = await response.json();
  console.log(`${label} status:`, response.status, 'model:', model);

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`No response writing ${label}. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  }
  return extractJsonObject(text);
}

// ─── Pre-validation repair ──────────────────────────────────────────────────
//
// gpt-4o-mini occasionally drops the `markets` object on the 10min edition
// when the story payload is large (~20+ stories). The writer is forbidden
// from modifying market indices anyway (must carry from raw verbatim), so
// re-attaching from raw when the writer omits it is safe and zero-risk.
// Without this, the brief fails validation and the whole 10min edition is
// lost, cascading to all personalised 10min editions being skipped.

function repairCommonOmissions(content: any, edition: Edition, raw: RawStories): any {
  if (!content || typeof content !== 'object') return content;

  // 10min: re-attach markets if dropped or malformed.
  if (edition === '10min') {
    const hasMarkets =
      content.markets &&
      typeof content.markets === 'object' &&
      typeof content.markets.summary === 'string' &&
      Array.isArray(content.markets.indices);
    if (!hasMarkets) {
      console.warn('[10min] Writer dropped/malformed markets — re-attaching from raw.');
      content.markets = {
        summary: content.markets?.summary || raw.markets?.summary || 'Markets summary unavailable today.',
        indices: raw.markets?.indices || [],
      };
    } else {
      // Writer kept the object but may have mutated indices. Force indices
      // back to raw (prompt requires this anyway) to prevent drift.
      content.markets.indices = raw.markets?.indices || content.markets.indices;
    }
  }

  return content;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateBrief(content: any, edition: Edition):
  | { ok: true; data: BriefContent }
  | { ok: false; errors: string } {
  const schema =
    edition === '5min' ? BriefQuickSchema
    : edition === '10min' ? BriefDailySchema
    : BriefEditorialSchema;

  const result = schema.safeParse(content);
  if (result.success) return { ok: true, data: result.data as BriefContent };

  const errors = result.error.issues
    .map((i: any) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  console.error(`Validation failed for ${edition}: ${errors}`);
  return { ok: false, errors };
}

function validateLens(lens: any): boolean {
  return LensSchema.safeParse(lens).success;
}

// ─── Post-write source-URL guard ────────────────────────────────────────────
//
// The writers (LLMs) sometimes invent stories when raw is sparse, complete with
// plausible-looking headlines and homepage URLs. Zod can't catch this because
// any https URL passes the schema. This walks the WRITTEN brief and drops any
// story whose source_url isn't from a Tier-1 whitelisted publisher. Acts as a
// safety net on top of the fetch-time enforcement in enforceQualityRules.

function stripNonWhitelistedFromContent(
  content: any,
  edition: Edition,
): { content: any; dropped: number } {
  if (!content || typeof content !== 'object') return { content, dropped: 0 };
  let dropped = 0;

  const filterArr = (arr: any[], section: string): any[] => {
    if (!Array.isArray(arr)) return arr;
    return arr.filter((s) => {
      if (isWhitelistedSource(s?.source_url)) return true;
      dropped++;
      console.warn(
        `[${edition}] Post-write strip — section "${section}" dropping story: "${(s?.headline || '').slice(0, 80)}" | url: ${s?.source_url}`,
      );
      return false;
    });
  };

  if (edition === '5min') {
    content.major_events = filterArr(content.major_events, 'major_events');
    content.world = filterArr(content.world, 'world');
    content.india = filterArr(content.india, 'india');
    content.topics = filterArr(content.topics, 'topics');
  } else if (edition === '10min') {
    content.major_events = filterArr(content.major_events, 'major_events');
    content.world = filterArr(content.world, 'world');
    content.india = filterArr(content.india, 'india');
    content.business = filterArr(content.business, 'business');
    content.technology = filterArr(content.technology, 'technology');
    content.climate_health = filterArr(content.climate_health, 'climate_health');
    // sport/culture are arrays as of Sprint 9 — filter same as other sections.
    content.sport = filterArr(content.sport, 'sport');
    content.culture = filterArr(content.culture, 'culture');
  }
  // 'deep' has no story-level source_urls — three_patterns/long_read are pure
  // synthesis. Nothing to strip here.

  return { content, dropped };
}

// ─── Fallback fetch ─────────────────────────────────────────────────────────

async function fetchPreviousBrief(edition: Edition): Promise<{ content: BriefContent; lens: any; status: string } | null> {
  // Only look back ONE day. If yesterday's brief is itself a fallback, we
  // refuse to use it — we want fresh content or none at all. The runWriter
  // caller checks status === 'ready' before using.
  const date = getISTDate(-1);
  const { data, error } = await supabase
    .from('briefs')
    .select('content, status')
    .eq('date', date)
    .eq('edition', edition)
    .in('status', ['ready', 'fallback'])
    .maybeSingle();

  if (!error && data?.content) {
    console.log(`Previous-day ${edition} brief from ${date} found (status=${data.status}).`);
    const content = data.content as any;
    // Lens lives inside content JSONB since Sprint 8.
    const lens = content?.lens ?? null;
    return { content: content as BriefContent, lens, status: data.status };
  }
  return null;
}

// ─── Save ────────────────────────────────────────────────────────────────────

async function saveBriefToSupabase(
  edition: Edition,
  rawStories: RawStories | null,
  content: BriefContent | null,
  lens: any,
  status: 'ready' | 'fallback' | 'failed' | 'pending',
) {
  const today = getISTDate();
  // Sprint 8: lens lives inside the content JSONB (no DB migration needed).
  // We merge it in here at save time so writers don't need to know about it.
  const contentWithLens = content
    ? { ...content, lens: lens ?? (content as any).lens ?? null }
    : null;
  const { error } = await supabase
    .from('briefs')
    .upsert(
      {
        date: today,
        edition,
        status,
        raw_stories: rawStories,
        content: contentWithLens,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'date,edition' },
    );
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
  console.log(`Saved ${edition} for ${today} — status ${status}`);
}

// ─── Push notification ──────────────────────────────────────────────────────

async function sendPushNotification(topHeadline: string) {
  const response = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      included_segments: ['All'],
      headings: { en: '☕ Your Morning Brief is ready' },
      contents: { en: topHeadline },
      url: 'https://morning-brief-liart.vercel.app/brief',
      small_icon: 'ic_stat_onesignal_default',
    }),
  });

  const data = await response.json();
  if (data.errors) throw new Error(`OneSignal error: ${JSON.stringify(data.errors)}`);
  console.log(`Push sent. Recipients: ${data.recipients ?? 'unknown'}, ID: ${data.id}`);
  return data;
}

// ─── Mode-based architecture ────────────────────────────────────────────────
//
// Why modes exist: Vercel Hobby plan caps serverless functions at 60s. The
// original "do everything in one call" flow (fetch news + lens + 3 writers +
// save + push) couldn't fit. It would TIMEOUT (504 / FUNCTION_INVOCATION_TIMEOUT),
// which the admin page would then fail to parse as JSON. So we split:
//
//   mode='fetch' — fetch news (parallel sections) + synthesise lens, save raw
//                  to 3 'pending' brief rows. ~35-45s, fits in 60s.
//   mode='write' — needs `edition`. Read raw_stories from today's pending row,
//                  write that one edition, save as 'ready'. ~15-30s.
//   mode='push'  — send OneSignal push using today's top ready headline.
//   mode='full'  — LEGACY single-call flow. Kept only for emergencies on light
//                  news days; will timeout on busy days. Do not use from cron.
//
// Default when no mode is provided: 'fetch'. This makes the admin page and
// cron sensible: hit the endpoint with no body, you get the fetch phase,
// then chain writes from the caller.

// ─── Per-edition writer pipeline ────────────────────────────────────────────
//
// Pure function: takes raw stories, returns a saved result. Shared by 'write'
// mode and 'full' mode below.

type EditionOutcome = {
  status: 'ready' | 'fallback' | 'failed';
  reason?: string;
  content?: BriefContent;
};

async function runWriterForEdition(
  ed: Edition,
  rawStories: RawStories,
  lens: any | null,
): Promise<EditionOutcome> {
  const writer =
    ed === '5min'  ? writeQuickEdition
  : ed === '10min' ? writeDailyEdition
  :                  writeEditorialEdition;

  // Per Sprint 9 spec: 5min capped at 15 stories, 10min capped at 20. Both
  // are deterministic subsets of the raw pool, computed in code (not LLM) so
  // 5min ⊆ 10min by construction. Deep gets the full raw pool unchanged.
  const writerInput =
    ed === '5min'  ? buildSubset(rawStories, 15)
  : ed === '10min' ? buildSubset(rawStories, 20)
  :                  rawStories;

  // Two attempts. gpt-4o-mini occasionally returns non-JSON or drops required
  // fields; one retry catches most of these. We only fall back to yesterday's
  // brief if BOTH attempts fail.
  let lastError: string = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Writing ${ed}${attempt === 2 ? ' (retry)' : ''}...`);
      const content = await writer(writerInput);
      const repaired = repairCommonOmissions(content, ed, writerInput);
      const validation = validateBrief(repaired, ed);
      if (validation.ok) {
        // Post-write source-URL guard: drop any story whose source_url isn't
        // from a Tier-1 whitelisted publisher (catches writer hallucinations).
        const { content: stripped, dropped } = stripNonWhitelistedFromContent(validation.data, ed);
        if (dropped > 0) {
          console.log(`[${ed}] Post-write strip removed ${dropped} non-whitelisted stories.`);
        }
        // Save the FULL rawStories (not the subset) into the brief row so
        // downstream consumers see the same raw for every edition.
        await saveBriefToSupabase(ed, rawStories, stripped, lens, 'ready');
        return { status: 'ready', content: stripped };
      }
      // Narrowed: validation is the failure branch here.
      const errMsg = (validation as { ok: false; errors: string }).errors;
      lastError = errMsg;
      console.warn(`[${ed}] Attempt ${attempt} validation failed: ${errMsg}`);
    } catch (err: any) {
      lastError = err.message;
      console.warn(`[${ed}] Attempt ${attempt} threw: ${err.message}`);
    }
  }

  // Both attempts failed — fall back to yesterday's brief, but only if
  // yesterday's brief is itself fresh (status='ready'). If yesterday was
  // already a fallback, we'd be inheriting stale content from days ago — stop
  // the chain and mark today 'failed' so the UI shows "no fresh brief today"
  // instead of week-old stories.
  console.error(`[${ed}] Both attempts failed. Last error: ${lastError}`);
  const prev = await fetchPreviousBrief(ed);
  if (prev && prev.status === 'ready') {
    await saveBriefToSupabase(ed, rawStories, prev.content, prev.lens, 'fallback');
    return { status: 'fallback', reason: lastError, content: prev.content };
  }
  if (prev && prev.status !== 'ready') {
    console.warn(`[${ed}] Previous brief was status=${prev.status}, not 'ready'. Refusing to chain-fallback; marking today as failed.`);
  }
  await saveBriefToSupabase(ed, rawStories, null, lens, 'failed');
  return { status: 'failed', reason: lastError };
}

// ─── Mode: fetch ────────────────────────────────────────────────────────────
//
// Phase 1 of the daily flow. Loads personalisation universe, fetches news +
// lens from OpenAI, saves raw_stories to three pending brief rows (one per
// edition). Lens lives inside raw_stories.lens — the writers read it from
// there in the write phase.

async function modeFetch() {
  const universe = await loadPersonalisationUniverse();
  console.log(`Universe — industries: ${universe.industries.length}, interests: ${universe.interests.length}, cities: ${universe.cities.length}`);

  let rawStories: RawStories;
  try {
    console.log('Fetching news from OpenAI...');
    rawStories = await fetchNewsFromOpenAI(universe);
    console.log('News fetched.');
  } catch (err: any) {
    console.error('OpenAI fetch failed:', err.message);
    return { ok: false as const, error: `OpenAI fetch failed: ${err.message}` };
  }

  const lensOk = !!rawStories.lens && validateLens(rawStories.lens);
  if (!lensOk) console.warn('Lens missing or invalid in fetch response.');

  const today = getISTDate();
  const editions: Edition[] = ['5min', '10min', 'deep'];

  // Save 3 pending rows in parallel. raw_stories carries the lens, so write
  // mode can pick it up from there. content stays null until write runs.
  await Promise.all(editions.map(async (ed) => {
    const { error } = await supabase
      .from('briefs')
      .upsert(
        {
          date: today,
          edition: ed,
          status: 'pending',
          raw_stories: rawStories,
          content: null,
          generated_at: new Date().toISOString(),
        },
        { onConflict: 'date,edition' },
      );
    if (error) throw new Error(`Pending save failed (${ed}): ${error.message}`);
    console.log(`Saved pending raw for ${ed} on ${today}.`);
  }));

  return {
    ok: true as const,
    date: today,
    universe,
    lens_ok: lensOk,
    sections: {
      major_events:  rawStories.major_events.length,
      world:         rawStories.world.length,
      india:         rawStories.india.length,
      business:      rawStories.business.length,
      technology:    rawStories.technology.length,
      climate_health: rawStories.climate_health.length,
      sport:         rawStories.sport.length,
      culture:       rawStories.culture.length,
      markets_indices: rawStories.markets.indices.length,
    },
    next: "POST { mode: 'write', edition: '5min' | '10min' | 'deep' } in parallel for each edition.",
  };
}

// ─── Mode: write ────────────────────────────────────────────────────────────
//
// Phase 2. Read raw_stories from today's pending row for one edition, run
// the writer, validate, strip, save as 'ready'. If no pending row exists,
// fall back to yesterday's brief and mark 'fallback'.

async function modeWrite(edition: Edition) {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('briefs')
    .select('raw_stories, status')
    .eq('date', today)
    .eq('edition', edition)
    .maybeSingle();

  if (error) {
    console.warn(`modeWrite read failed (${edition}):`, error.message);
  }

  const raw = (data?.raw_stories ?? null) as RawStories | null;

  if (!raw) {
    console.warn(`modeWrite: no raw_stories for ${edition} on ${today}. Did fetch run?`);
    const prev = await fetchPreviousBrief(edition);
    if (prev && prev.status === 'ready') {
      await saveBriefToSupabase(edition, null, prev.content, prev.lens, 'fallback');
      return {
        ok: true as const,
        edition,
        status: 'fallback' as const,
        reason: 'No raw_stories for today; restored previous ready brief. Run mode=fetch first to get fresh news.',
      };
    }
    await saveBriefToSupabase(edition, null, null, null, 'failed');
    return {
      ok: false as const,
      edition,
      status: 'failed' as const,
      error: 'No raw_stories for today and no previous brief to fall back to. Run mode=fetch first.',
    };
  }

  const lens = raw.lens && validateLens(raw.lens) ? raw.lens : null;
  const outcome = await runWriterForEdition(edition, raw, lens);
  return {
    ok: outcome.status !== 'failed',
    edition,
    status: outcome.status,
    reason: outcome.reason,
  };
}

// ─── Mode: push ─────────────────────────────────────────────────────────────
//
// Phase 3 (optional). Picks today's best top headline across ready briefs
// and sends a OneSignal push. Idempotent-ish: safe to call again, but you'll
// get a second push.

async function modePush() {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('briefs')
    .select('content, edition')
    .eq('date', today)
    .eq('status', 'ready');

  if (error) {
    return { ok: false as const, error: `Read failed: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { ok: false as const, error: 'No ready briefs for today; not pushing.' };
  }

  // Prefer 5min → 10min top headline. major_events first, then world.
  const byEd: Record<string, any> = {};
  for (const row of data) byEd[row.edition] = row.content;

  const top =
    (byEd['5min']  as any)?.major_events?.[0]?.headline ??
    (byEd['10min'] as any)?.major_events?.[0]?.headline ??
    (byEd['5min']  as any)?.world?.[0]?.headline ??
    (byEd['10min'] as any)?.world?.[0]?.headline ??
    "Today's stories are waiting for you.";

  try {
    const result = await sendPushNotification(top);
    return { ok: true as const, headline: top, recipients: result?.recipients ?? null };
  } catch (err: any) {
    console.error('Push failed:', err.message);
    return { ok: false as const, error: err.message };
  }
}

// ─── Mode: full (LEGACY) ────────────────────────────────────────────────────
//
// Old behaviour. Will TIMEOUT on Vercel Hobby (60s cap) on most days. Kept
// here only as an emergency single-call path. Production should use the
// fetch → write → push chain instead.

async function modeFull(skipPush: boolean | undefined) {
  console.warn('mode=full is deprecated and likely to timeout on Vercel Hobby (60s cap). Use mode=fetch → mode=write → mode=push instead.');

  const universe = await loadPersonalisationUniverse();
  console.log(`Universe — industries: ${universe.industries.length}, interests: ${universe.interests.length}, cities: ${universe.cities.length}`);

  let rawStories: RawStories | null = null;
  let lens: any = null;
  try {
    console.log('Fetching news from OpenAI...');
    rawStories = await fetchNewsFromOpenAI(universe);
    if (rawStories.lens && validateLens(rawStories.lens)) lens = rawStories.lens;
  } catch (err: any) {
    console.error('OpenAI fetch failed:', err.message);
  }

  const editions: Edition[] = ['5min', '10min', 'deep'];
  const results: Record<string, { status: string; reason?: string }> = {};
  const writtenBriefs: Record<string, BriefContent> = {};

  // Capture into a const so TypeScript narrows correctly inside the async map below.
  const raw = rawStories;

  const editionPairs = await Promise.all(
    editions.map(async (ed) => {
      let r: EditionOutcome;
      if (!raw) {
        const prev = await fetchPreviousBrief(ed);
        if (prev && prev.status === 'ready') {
          await saveBriefToSupabase(ed, null, prev.content, prev.lens, 'fallback');
          r = { status: 'fallback', reason: 'OpenAI fetch failed', content: prev.content };
        } else {
          await saveBriefToSupabase(ed, null, null, lens, 'failed');
          r = { status: 'failed', reason: 'OpenAI fetch failed and no previous ready brief' };
        }
      } else {
        r = await runWriterForEdition(ed, raw, lens);
      }
      if (r.content) writtenBriefs[ed] = r.content;
      const { content, ...rest } = r;
      return [ed, rest] as const;
    }),
  );
  for (const [ed, r] of editionPairs) results[ed] = r;

  if (!skipPush) {
    const anyFresh = Object.values(results).some((r) => r.status === 'ready');
    if (anyFresh) {
      try { await modePush(); } catch (err: any) { console.error('Push failed:', err.message); }
    }
  }

  return { ok: true as const, results, lens };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Default mode is 'fetch'. This means a bare POST (e.g. legacy cron-job.org
  // hit with no body) does the fetch phase only — never the full thing, which
  // would timeout.
  const { mode = 'fetch', edition, skipPush } = req.body || {};

  try {
    if (mode === 'fetch') {
      const result = await modeFetch();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'write') {
      if (!edition || !['5min', '10min', 'deep'].includes(edition)) {
        return res.status(400).json({ ok: false, error: "mode=write requires edition: '5min' | '10min' | 'deep'" });
      }
      const result = await modeWrite(edition as Edition);
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'push') {
      const result = await modePush();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'full') {
      const result = await modeFull(skipPush);
      return res.status(200).json(result);
    }

    return res.status(400).json({
      ok: false,
      error: `Unknown mode: ${mode}. Use 'fetch', 'write', 'push', or 'full'.`,
    });
  } catch (error: any) {
    console.error('Top-level error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
