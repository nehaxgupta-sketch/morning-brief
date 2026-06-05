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

export const config = { maxDuration: 60 };

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
  // India-focused
  'thehindu.com',
  'thehindubusinessline.com',
  'indianexpress.com',
  'newindianexpress.com',
  'hindustantimes.com',
  'livemint.com',
  'business-standard.com',
  'economictimes.indiatimes.com',
  'financialexpress.com',
  'theprint.in',
  'scroll.in',
  'timesofindia.indiatimes.com',
  'ndtv.com',
  'deccanherald.com',
  'thewire.in',
  'moneycontrol.com',
  'businesstoday.in',
  // Tier-2 (allowed for specialist topics)
  'espncricinfo.com',
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
    return u.hostname.toLowerCase().replace(/^www\./, '');
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
  sport?: RawStory;
  culture?: RawStory;
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

const CloserSchema = z.object({
  headlines_to_remember: z.array(z.string().min(5)).length(5),
  things_to_watch: z.array(z.string().min(5)).length(3),
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
    indices: z.array(MarketIndexSchema).min(2).max(6),
  }),
  technology: z.array(FullStorySchema),
  climate_health: z.array(FullStorySchema),
  // sport/culture optional — when OpenAI can't source a story from a whitelisted publisher,
  // we omit the section entirely rather than fail the whole brief.
  sport: FullStorySchema.optional(),
  culture: FullStorySchema.optional(),
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
GLOBAL: Reuters, Associated Press, Bloomberg, Financial Times, Wall Street Journal, New York Times, Washington Post, BBC, The Guardian, The Economist, Al Jazeera.
INDIA (general news): The Hindu, Indian Express, Hindustan Times, NDTV, New Indian Express, The Print, Scroll, Times of India, Deccan Herald, The Wire.
INDIA (business / markets): Economic Times, LiveMint (Mint), Business Standard, Financial Express, The Hindu BusinessLine, Moneycontrol, Business Today.
SPECIALIST (only where general sources don't cover): ESPNCricinfo (sport — especially IPL), Variety / Hollywood Reporter (entertainment), Nature / Science / STAT (health/science), TechCrunch / The Verge / Ars Technica / Wired (tech).

NOT ALLOWED — drop the story rather than cite from here:
- Aggregators (Google News, MSN, Yahoo News)
- Social media (X/Twitter, Reddit, YouTube)
- Opinion blogs, listicle sites, anonymous/no-byline pieces
- Domain you don't recognise

SOURCE_URL must be a direct article URL on the publisher's domain. No redirects, no homepage URLs, no aggregator wrappers. If you can't find a whitelisted article, leave the section empty rather than fabricate.`;
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
): Promise<any[]> {
  const prompt = `You are a senior news editor for an India-based daily brief. Today is ${today}.

Your job: produce the "${section}" section. Use the web_search_preview tool to find real articles. Run multiple searches if needed — do not stop at the first roundup page.

${guidance}

TARGET COUNT: ${count} stories. If genuine news doesn't support the full count, return fewer — never fabricate to fill quota.

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

async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
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

function enforceQualityRules(raw: any): RawStories {
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
    sport: undefined,
    culture: undefined,
    markets: raw?.markets || { summary: '', indices: [] },
    lens: raw?.lens || { world: '', india: '', markets: '', watch: '' },
  };

  // Walk priority order so dedup picks the highest-priority section first.
  for (const sec of priority) {
    if (sec === 'sport') {
      cleaned.sport = processSingle('sport', raw?.sport);
    } else if (sec === 'culture') {
      cleaned.culture = processSingle('culture', raw?.culture);
    } else {
      const arr = raw?.[sec];
      (cleaned as any)[sec] = processList(sec, Array.isArray(arr) ? arr : []);
    }
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

async function writeQuickEdition(raw: RawStories): Promise<BriefQuick> {
  const today = getISTDate();
  const prompt = `You are writing THE BRIEF — the 5-minute commute edition of Morning Brief, a daily news digest for thoughtful Indian readers (urban, professional, 25-45). Today is ${today}.

VOICE: calm, analytical, newspaper-like — the register of an Economist briefing or an FT lex card. Declarative, sober sentences. Active voice. Plain English. No clickbait, no sensationalism, no conversational fluff ("plus", "also", "by the way"). Explain jargon when used.

FORMAT — each story is a MICRO-ITEM with three short fields:
- headline: clear, factual (≤ 14 words). Lead with the subject (country, company, person, number) — not the verb.
- what_happened: ONE sentence (≤ 22 words). State the news plainly. Use specific numbers, names, dates where they sharpen the story.
- why_it_matters: ONE sentence (≤ 22 words). ANCHOR TO INDIA. Acceptable hooks: inflation, the rupee, food prices, RBI policy, EMIs, household budgets, jobs, urban life, India's strategic position, or sector impact on Indian companies/markets. A purely global takeaway is NOT enough — make the Indian connection visible. Example to emulate: "Higher oil prices directly affect India's inflation, rupee, and household budgets."

SELECTION — be ruthless. This is the skim edition.
- major_events: TOP 2 — sustained, multi-day themes with the largest real-world consequence (think monsoon, oil shock, war escalation, election outcome, RBI policy).
- world:        TOP 3 — distinct stories from different regions. Pick consequence over novelty.
- india:        TOP 2 — national stories with material impact on policy, business, or daily life.
- topics:       exactly 5 — the most consequential developments across business, markets, technology, climate, health, sport, culture. Pick stories that connect to inflation, the rupee, jobs, urban India, or sectors that move Indian household economics or daily life. Skip filler.

ORDER WITHIN EACH SECTION: most consequential first. Index 0 is what a newscast would lead with.

NO DUPLICATION ACROSS SECTIONS: a story belongs in ONLY ONE section across the whole brief. If you place it in major_events, do NOT also list it in world or india or topics. Use the most appropriate single section.

HARD RULES:
- USE ONLY THE STORIES PROVIDED IN THE RAW STORIES BELOW. Do not invent, infer, or recall stories from your own knowledge. Every story you output must correspond to a raw story; every source_url must appear VERBATIM in the raw stories. If a section has no usable raw stories, output an empty array — do NOT pad with fabricated entries.
- ALWAYS include every story flagged must_include: true. If a must_include sits in topics-territory (business/tech/etc.), surface it in topics. Never drop a must_include.
- Pass through source, source_url, industries, interests, city_tags, topic_tags, must_include UNCHANGED on every story you keep.
- Output ONLY JSON. No markdown, no commentary.

OUTPUT SHAPE:
{
  "edition": "5min",
  "date": "${today}",
  "major_events": [{ "headline": "...", "what_happened": "...", "why_it_matters": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }],
  "world":   [ /* 3 */ ],
  "india":   [ /* 2 */ ],
  "topics":  [ /* 5 */ ]
}

Raw stories:
${JSON.stringify(rawStoriesForWriter(raw))}`;

  return callOpenAIChat('gpt-4o-mini', prompt, 6000, 'The Brief (5min)');
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

SELECTION: Include EVERY story from the raw stories. Do not drop anything. Maintain the ordering from the raw stories within each section (raw is already impact-ordered). If raw stories has no "sport" or "culture" key (or the value is empty/missing), OMIT that field from your output entirely — do NOT fabricate a story.

NO DUPLICATION ACROSS SECTIONS: a story belongs in ONLY ONE section. If raw stories has duplicate-feeling entries across sections, pick the section that fits best and skip the others.

CLOSER — include a "closer" object at the end with:
- headlines_to_remember: EXACTLY 5 single-line memory anchors covering today's biggest developments. Each ≤ 14 words, factual, scannable. Drawn from across the brief's most consequential stories.
- things_to_watch: EXACTLY 3 forward-looking developments to track this week. Each ONE sentence (≤ 24 words). Specific — name the event/release/decision and when.
- conversation_insight: ONE intelligent observation that CONNECTS MULTIPLE STORIES into a single pattern — the kind of remark that lands at a dinner table. 2-3 sentences. The bar: when read aloud, it should sound like a synthesis, not a restated headline. Example pattern to emulate: "The most important story in India right now is not a single headline — it is the combination of oil uncertainty, a weak monsoon outlook, and inflation risk. Individually they are manageable, but together they can influence everything from grocery bills and EMIs to market performance and government policy."

HARD RULES:
- USE ONLY THE STORIES PROVIDED IN THE RAW STORIES BELOW. Do not invent, infer, or recall stories from your own knowledge. Every story you output must correspond to a raw story; every source_url must appear VERBATIM in the raw stories. If a section has no usable raw stories, output an empty array — do NOT pad with fabricated entries.
- Carry source, source_url, industries, interests, city_tags, topic_tags, must_include UNCHANGED through every story.
- Keep markets indices values EXACTLY as in raw data. You may rewrite the markets summary in your voice (2 sentences, India-anchored).
- Output ONLY JSON. No markdown, no commentary.

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
  "sport":   { /* single story, same shape */ },
  "culture": { /* single story, same shape */ },
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
    // sport/culture are single-story optional fields — delete if non-whitelisted.
    if (content.sport && !isWhitelistedSource(content.sport?.source_url)) {
      dropped++;
      console.warn(
        `[${edition}] Post-write strip — dropping sport: "${content.sport?.headline}" | url: ${content.sport?.source_url}`,
      );
      delete content.sport;
    }
    if (content.culture && !isWhitelistedSource(content.culture?.source_url)) {
      dropped++;
      console.warn(
        `[${edition}] Post-write strip — dropping culture: "${content.culture?.headline}" | url: ${content.culture?.source_url}`,
      );
      delete content.culture;
    }
  }
  // 'deep' has no story-level source_urls — three_patterns/long_read are pure
  // synthesis. Nothing to strip here.

  return { content, dropped };
}

// ─── Fallback fetch ─────────────────────────────────────────────────────────

async function fetchPreviousBrief(edition: Edition): Promise<{ content: BriefContent; lens: any } | null> {
  for (let daysAgo = 1; daysAgo <= 2; daysAgo++) {
    const date = getISTDate(-daysAgo);
    const { data, error } = await supabase
      .from('briefs')
      .select('content, status')
      .eq('date', date)
      .eq('edition', edition)
      .in('status', ['ready', 'fallback'])
      .maybeSingle();

    if (!error && data?.content) {
      console.log(`Fallback: using ${edition} brief from ${date} (status ${data.status})`);
      const content = data.content as any;
      // Lens lives inside content JSONB since Sprint 8.
      const lens = content?.lens ?? null;
      return { content: content as BriefContent, lens };
    }
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
  try {
    console.log(`Writing ${ed}...`);
    const writer =
      ed === '5min'  ? writeQuickEdition
    : ed === '10min' ? writeDailyEdition
    :                  writeEditorialEdition;

    const content = await writer(rawStories);
    const validation = validateBrief(content, ed);
    if (validation.ok) {
      // Post-write source-URL guard: drop any story whose source_url isn't
      // from a Tier-1 whitelisted publisher (catches writer hallucinations).
      const { content: stripped, dropped } = stripNonWhitelistedFromContent(validation.data, ed);
      if (dropped > 0) {
        console.log(`[${ed}] Post-write strip removed ${dropped} non-whitelisted stories.`);
      }
      await saveBriefToSupabase(ed, rawStories, stripped, lens, 'ready');
      return { status: 'ready', content: stripped };
    }
    const prev = await fetchPreviousBrief(ed);
    if (prev) {
      await saveBriefToSupabase(ed, rawStories, prev.content, prev.lens, 'fallback');
      return { status: 'fallback', reason: validation.errors, content: prev.content };
    }
    await saveBriefToSupabase(ed, rawStories, null, lens, 'failed');
    return { status: 'failed', reason: validation.errors };
  } catch (err: any) {
    console.error(`Error writing ${ed}:`, err.message);
    const prev = await fetchPreviousBrief(ed);
    if (prev) {
      await saveBriefToSupabase(ed, rawStories, prev.content, prev.lens, 'fallback');
      return { status: 'fallback', reason: err.message, content: prev.content };
    }
    await saveBriefToSupabase(ed, rawStories, null, lens, 'failed');
    return { status: 'failed', reason: err.message };
  }
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
      sport:         rawStories.sport   ? 1 : 0,
      culture:       rawStories.culture ? 1 : 0,
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
    if (prev) {
      await saveBriefToSupabase(edition, null, prev.content, prev.lens, 'fallback');
      return {
        ok: true as const,
        edition,
        status: 'fallback' as const,
        reason: 'No raw_stories for today; restored previous brief. Run mode=fetch first to get fresh news.',
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
        if (prev) {
          await saveBriefToSupabase(ed, null, prev.content, prev.lens, 'fallback');
          r = { status: 'fallback', reason: 'OpenAI fetch failed', content: prev.content };
        } else {
          await saveBriefToSupabase(ed, null, null, lens, 'failed');
          r = { status: 'failed', reason: 'OpenAI fetch failed and no previous brief' };
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
