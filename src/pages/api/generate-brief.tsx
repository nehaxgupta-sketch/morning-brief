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
// Sprint 11: shared whitelist module. Source-of-truth for all source-URL
// validation across generate-brief and personalise-briefs.
import {
  isWhitelistedSource,
  publisherKey,
} from '@/lib/whitelist';
// Sprint 11: per-call cost capture.
import {
  logOpenAICost,
  extractUsageFromChatCompletion,
  extractUsageFromResponses,
} from '@/lib/cost-log';

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

// ─── Source whitelist ───────────────────────────────────────────────────────
// Sprint 11: moved to @/lib/whitelist (shared with personalise-briefs.tsx).
// TIER_1_DOMAINS, extractHostname, isWhitelistedSource, publisherKey are
// imported at the top of this file.

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

  // Sprint 11: cost log.
  const usage = extractUsageFromResponses(data);
  void logOpenAICost({
    phase: 'lens',
    model: 'gpt-4o-mini',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail: 'fallback lens',
  });

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
  reasoningEffort: 'low' | 'medium' | 'high' = 'low',
  costPhase: 'fetch' | 'lens' = 'fetch',
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

  // Sprint 11: log cost. Fire-and-forget — never blocks the pipeline.
  const usage = extractUsageFromResponses(data);
  void logOpenAICost({
    phase: costPhase,
    model: 'gpt-5',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail: `effort=${reasoningEffort}`,
  });

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

// ─── Two-phase parallel fetch prompt ─────────────────────────────────────────
//
// Single gpt-5 call was bumping into Vercel's 300s function limit, especially
// after over-fetching counts went up in Sprint 9. We split into two parallel
// gpt-5 calls; wall-clock = max(phase1, phase2) ≈ 120-150s. Total cost is
// roughly 2x prompt token cost (prompt sent twice) for similar output tokens.
//
// Phase 'universal': major_events + world + india + lens
// Phase 'topical':   business + technology + climate_health + sport + culture + markets
//
// Each phase enforces ≤3 stories per publisher within its scope. Across the
// full brief that theoretically allows up to 6 per publisher, but per-section
// caps keep it well under that in practice.
function buildGpt5FetchPrompt(today: string, universe: Universe, phase: 'universal' | 'topical-a' | 'topical-b' = 'universal'): string {
  const sharedHeader = `You are the fetcher for Morning Brief, India's daily news digest for thoughtful urban professionals (25-45, urban, English-reading). Today is ${today} (IST).

Your job: search the web aggressively for today's most consequential news and return ONE JSON object. Use the web_search tool. Perform AT LEAST 10-12 distinct searches across the sections you've been assigned.

═══════════════════════════════════════════════
RECENCY — STRICT 24-HOUR RULE
═══════════════════════════════════════════════

Every story must represent a development WITHIN THE LAST 24 HOURS. This applies to EVERY section.

This is about NARRATIVE freshness, not just publish date.
- For a one-off event (election result, court ruling, earnings report): the event itself must have happened in the last 24 hours, AND the article must be published in the last 24 hours.
- For a sustained narrative (war, IPL season, RBI policy cycle): there MUST be a FRESH development today (new strike, today's match, follow-up policy move, retirement, welcome ceremony, controversy, post-match analysis published today). If only the underlying event from days ago exists with no fresh angle in the last 24h, OMIT the story.

Concrete examples:
- IPL final 2 days ago, no follow-up today → OMIT.
- IPL final 2 days ago, today's news has the team's welcome ceremony → INCLUDE the follow-up.
- War story from 3 days ago with no new development today → OMIT.
- Same war story with a new strike, casualty figure, or diplomatic move today → INCLUDE the today's development.

If you cannot find a story with a 24-hour development for a section, return fewer or leave it empty. Reasoning: if a story is big enough to matter, there is always a 24-hour development.`;

  const sharedFooterRules = `═══════════════════════════════════════════════
SOURCING — STRICT WHITELIST
═══════════════════════════════════════════════

${sourceWhitelistBlock()}

═══════════════════════════════════════════════
STORY FIELDS (per story object)
═══════════════════════════════════════════════

- headline: ≤16 words, factual, lead with the subject (country, company, person, number) — not the verb.
- body: 2-3 factual sentences. Specific numbers, names, dates, locations. NO opinion or framing — just facts.
- source: publisher name (e.g. "Reuters", "The Hindu").
- source_url: DIRECT article URL on the publisher's domain. NEVER a homepage, never an aggregator wrapper, never a redirect. Must include the article slug/ID.
- published_at: ISO date (today's date is acceptable if you can't find the exact published_at).
- industries, interests, city_tags, topic_tags: see TAGGING block below.
- must_include: boolean. Set true ONLY for stories that are absolutely critical today (1-3 across the fetch — RBI rate decisions, major war escalations, big India policy announcements, IPL final, major disasters). Default false.

${tagsBlockFor(universe)}`;

  if (phase === 'universal') {
    return `${sharedHeader}

═══════════════════════════════════════════════
SECTIONS — UNIVERSAL PHASE
═══════════════════════════════════════════════

You are responsible for THREE sections (major_events, world, india) plus the lens. Another fetcher handles business, technology, climate_health, sport, culture and markets in parallel — do NOT include those.

OVER-FETCHING IS REQUIRED. Downstream filters will drop stories that fail the whitelist, recency check, or semantic-dedup. Aim for the upper bound below.

- major_events: 4-5 stories. SUSTAINED, multi-day themes (ongoing wars, IPL playoffs/finals, election cycles, major policy rollouts, multi-day disasters). Each MUST have a fresh 24-hour development.

- world: 7-8 stories. 24-hour global news from OUTSIDE India. Spread across regions. Cover US politics, major elections abroad, big government decisions, international relations, cross-border business, climate/disaster events, major court rulings, big tech moves abroad.

- india: 7-8 stories. 24-hour national news. Government actions, court rulings, state developments of national significance (Bengaluru, Mumbai, Delhi, Chennai, Hyderabad, Pune, Kolkata, Ahmedabad qualify), business deals, accidents/disasters, social/political events. Include RBI rate decisions, monsoon updates, major Indian corporate news.

- lens: ONE object with 4 short sentences (≤14 words each):
  • world: most important world development today
  • india: most important India development today
  • markets: best-effort one-line summary (the topical fetcher has full markets details; your line is fine as a rough indicator)
  • watch: what to track in the coming days

${sharedFooterRules}

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════

1. WHITELIST: every source_url MUST be from a whitelisted publisher. OMIT stories you can't source.
2. NO FABRICATION: never invent headlines, URLs, quotes, facts. If a section quota can't be filled from whitelisted sources, return fewer.
3. SEARCH DEPTH: at least 10 distinct searches across the three sections.
4. PUBLISHER DIVERSITY within this fetch: NO publisher may contribute more than 3 stories. A brief dominated by one publisher fails our quality rubric.
5. DEDUP — STRICT.
   a) major_events owns ALL sustained narratives. If a 24-hour development belongs to one of these, EMBED it into the major_events story body — do NOT also list it under world or india.
   b) An Indian business/macro story belongs in india.
   c) Story could fit two sections → pick ONE, order: major_events > india > world.
   d) Self-check: read every world and india headline — "is this an update on a major_events story?" If yes, remove from world/india and fold the key fact into the major_events body.
6. JSON ONLY: output ONE JSON object. No markdown, no preamble. Start with { and end with }.

═══════════════════════════════════════════════
OUTPUT SHAPE
═══════════════════════════════════════════════

{
  "major_events": [ ${storyShape(today)}, ... ],
  "world":        [ ${storyShape(today)}, ... ],
  "india":        [ ${storyShape(today)}, ... ],
  "lens": {
    "world":   "≤14 words",
    "india":   "≤14 words",
    "markets": "≤14 words (best-effort)",
    "watch":   "≤14 words"
  }
}

Begin now. Search aggressively. Return ONLY the JSON object.`;
  }

  // Sprint 12: TWO topical phases run in parallel, splitting the work to
  // give gpt-5 a smaller search budget per call. Sprint 11 with a single
  // topical phase across 6 sections produced under-fetched output (typical
  // 7 stories vs target 16). Splitting business+tech+climate (A) from
  // sport+culture+markets (B) lets each phase iterate searches more
  // aggressively for fewer sections.

  if (phase === 'topical-a') {
    return `${sharedHeader}

═══════════════════════════════════════════════
SECTIONS — TOPICAL PHASE A (business + technology + climate_health)
═══════════════════════════════════════════════

You are responsible for THREE sections: business, technology, climate_health. Other fetchers handle universal (major/world/india/lens) AND topical-B (sport, culture, markets) in parallel — do NOT include those.

OVER-FETCHING IS REQUIRED. Downstream filters will drop stories that fail the whitelist or recency check. Aim for the upper bound below.

EMPTY ARRAYS ARE A LAST RESORT. Business, technology, and climate/health news happen every single day globally. Returning an empty array signals that your search did not find the right angle — not that nothing happened. Before returning empty for any section, run AT LEAST 2 distinct searches for that section with different keywords.

- business: 5-6 stories. Corporate news, earnings, M&A, regulatory actions, major financial moves. Indian AND global. Skip pure markets summaries (markets is owned by phase B).

- technology: 4-5 stories. Significant product launches, major AI developments, big-tech regulation, cybersecurity events. Skip rumour/speculation. RECENCY: 24h preferred, 48h acceptable if no fresh 24h development exists today.

- climate_health: 4-5 stories. Climate disasters, environmental policy, major health stories (outbreaks, drug approvals, research with real implications). Concrete real-world impact.

${sharedFooterRules}

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════

1. WHITELIST: every source_url MUST be from a whitelisted publisher.
2. NO FABRICATION: never invent. If a section quota can't be filled, return fewer.
3. SEARCH DEPTH: at least 8 distinct searches across the three sections.
4. PUBLISHER DIVERSITY: NO publisher may contribute more than 3 stories within this fetch.
5. DEDUP: each story in ONE section only (business > technology > climate_health).
6. JSON ONLY: output ONE JSON object. No markdown, no preamble.

═══════════════════════════════════════════════
OUTPUT SHAPE
═══════════════════════════════════════════════

{
  "business":       [ ${storyShape(today)}, ... ],
  "technology":     [ ${storyShape(today)}, ... ],
  "climate_health": [ ${storyShape(today)}, ... ]
}

Begin now. Search aggressively. Return ONLY the JSON object.`;
  }

  // phase === 'topical-b'
  return `${sharedHeader}

═══════════════════════════════════════════════
SECTIONS — TOPICAL PHASE B (sport + culture + markets)
═══════════════════════════════════════════════

You are responsible for THREE sections: sport, culture, markets. Other fetchers handle universal (major/world/india/lens) AND topical-A (business, technology, climate_health) in parallel — do NOT include those.

OVER-FETCHING IS REQUIRED. Downstream filters will drop stories that fail the whitelist or recency check.

EMPTY ARRAYS ARE A LAST RESORT for sport and culture. These categories produce news every single day globally. Returning an empty array signals that your search did not find the right angle — not that nothing happened. Before returning empty, run AT LEAST 2 distinct searches with different keywords. Examples: for sport, try "cricket news today", "IPL today", "tennis today", "football news today" — not just one generic "sport news" query.

- sport: 4-5 stories ACROSS DIFFERENT SPORTS. Cricket, football, tennis, F1, badminton, hockey, kabaddi, Olympics, athletics, golf, esports — pick the day's biggest from as many different sports as the day's news supports. Do NOT submit 4 cricket stories; aim for breadth. RECENCY: 24h preferred, 48h acceptable. Mid-week and off-season days often only have 24-48h-old developments — INCLUDE them rather than returning empty.

- culture: 4-5 stories ACROSS DIFFERENT CULTURE TYPES. Films, OTT, music, books, theatre, visual arts, awards. Don't submit 4 film stories; aim for breadth. RECENCY: 24h preferred, 48h acceptable. A 36h-old film release or award is fine if it's still the freshest available.

- markets: ONE object with summary + indices. Find the MOST RECENT closing values for Sensex, Nifty 50, Dow Jones, Nasdaq Composite. IMPORTANT: This brief runs at ~6:38 AM IST. At that hour, Indian markets have NOT opened yet (they open 9:15 AM IST and close 3:30 PM IST) — so use YESTERDAY's close for Sensex and Nifty. US markets close around 1:30 AM IST — use the most recent US session close. NEVER return empty indices because "today's close doesn't exist yet"; use the most recent available session close in every case. Write a 2-3 sentence India-anchored summary covering yesterday's Indian session and the overnight US session.

${sharedFooterRules}

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════

1. WHITELIST: every source_url MUST be from a whitelisted publisher.
2. NO FABRICATION: never invent.
3. SEARCH DEPTH: at least 6 distinct searches across the three sections.
4. PUBLISHER DIVERSITY: NO publisher may contribute more than 3 stories within this fetch.
5. SPORT AND CULTURE ARE ARRAYS of 3-5 story objects. Never fabricate to pad.
6. MARKETS INDICES: ARRAY of objects shaped [{"name":"Sensex","value":"74243","change":"-0.16%"}, ...]. Never a single object or string.
7. JSON ONLY: output ONE JSON object. No markdown, no preamble.

═══════════════════════════════════════════════
OUTPUT SHAPE
═══════════════════════════════════════════════

{
  "sport":   [ ${storyShape(today)}, ... ],
  "culture": [ ${storyShape(today)}, ... ],
  "markets": {
    "summary": "2-3 sentence India-anchored summary of yesterday's session + overnight US",
    "indices": [
      { "name": "Sensex",   "value": "...", "change": "+0.5%" },
      { "name": "Nifty 50", "value": "...", "change": "+0.4%" },
      { "name": "Dow Jones","value": "...", "change": "-0.2%" },
      { "name": "Nasdaq",   "value": "...", "change": "+0.1%" }
    ]
  }
}

Begin now. Search aggressively. Return ONLY the JSON object.`;
}

async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  // Sprint 12: THREE parallel gpt-5 calls. Wall-clock = max(phase1, phase2,
  // phase3) ≈ 100-130s on 'low' effort. Splitting topical into A/B halved
  // each call's search budget but increased total stories fetched from ~13
  // to ~25-30 in early testing.
  console.log('[fetch] Starting three-phase parallel gpt-5 fetch (Sprint 12)...');
  const universalPrompt  = buildGpt5FetchPrompt(today, universe, 'universal');
  const topicalAPrompt   = buildGpt5FetchPrompt(today, universe, 'topical-a');
  const topicalBPrompt   = buildGpt5FetchPrompt(today, universe, 'topical-b');

  const [universalText, topicalAText, topicalBText] = await Promise.all([
    callGpt5Reasoning(universalPrompt, 'low').catch((err) => {
      console.error('[fetch:universal] gpt-5 failed:', err.message);
      return '';
    }),
    callGpt5Reasoning(topicalAPrompt, 'low').catch((err) => {
      console.error('[fetch:topical-a] gpt-5 failed:', err.message);
      return '';
    }),
    callGpt5Reasoning(topicalBPrompt, 'low').catch((err) => {
      console.error('[fetch:topical-b] gpt-5 failed:', err.message);
      return '';
    }),
  ]);

  const safeParse = (text: string, label: string): any => {
    if (!text) {
      console.error(`[fetch:${label}] EMPTY response text — call either errored (see prior log) or model returned no text. Returning {}.`);
      return {};
    }
    // Diagnostic: log a preview of any suspiciously short response.
    if (text.length < 600) {
      console.warn(`[fetch:${label}] SHORT response (${text.length} chars). Preview: ${text.slice(0, 600)}`);
    }
    try {
      return extractJsonObject(text);
    } catch (err: any) {
      console.error(`[fetch:${label}] JSON parse failed. Length=${text.length}. First 800 chars:`, text.slice(0, 800));
      console.error(`[fetch:${label}] JSON parse failed. Last 400 chars:`, text.slice(-400));
      return {};
    }
  };

  const universalParsed = safeParse(universalText, 'universal');
  const topicalAParsed  = safeParse(topicalAText,  'topical-a');
  const topicalBParsed  = safeParse(topicalBText,  'topical-b');

  // Diagnostic: warn loudly if either topical phase came back empty.
  const topicalAStoryCount =
    (topicalAParsed.business?.length || 0) +
    (topicalAParsed.technology?.length || 0) +
    (topicalAParsed.climate_health?.length || 0);
  const topicalBStoryCount =
    (topicalBParsed.sport?.length || 0) +
    (topicalBParsed.culture?.length || 0);
  const topicalBIndicesCount = topicalBParsed.markets?.indices?.length || 0;

  if (topicalAStoryCount === 0) {
    console.error(`[fetch:topical-a] ALL SECTIONS EMPTY (0 stories). Topical A produced nothing. Raw text length=${topicalAText.length}. Investigate the response preview logged above.`);
  }
  if (topicalBStoryCount === 0 && topicalBIndicesCount === 0) {
    console.error(`[fetch:topical-b] ALL SECTIONS EMPTY (0 stories, 0 indices). Topical B produced nothing. Raw text length=${topicalBText.length}. Investigate the response preview logged above.`);
  } else if (topicalBStoryCount === 0) {
    console.warn(`[fetch:topical-b] sport+culture empty (markets indices=${topicalBIndicesCount}). Investigate.`);
  }

  // Merge into single RawStories shape. Empty arrays for missing sections.
  const merged: any = {
    major_events:   universalParsed.major_events || [],
    world:          universalParsed.world        || [],
    india:          universalParsed.india        || [],
    business:       topicalAParsed.business      || [],
    technology:     topicalAParsed.technology    || [],
    climate_health: topicalAParsed.climate_health|| [],
    sport:          topicalBParsed.sport         || [],
    culture:        topicalBParsed.culture       || [],
    markets:        topicalBParsed.markets       || { summary: '', indices: [] },
    lens:           universalParsed.lens         || null,
  };

  console.log(`[fetch] gpt-5 merged raw section counts (Sprint 12 three-phase): ` +
    `major=${merged.major_events.length}, world=${merged.world.length}, india=${merged.india.length}, ` +
    `biz=${merged.business.length}, tech=${merged.technology.length}, climate=${merged.climate_health.length}, ` +
    `sport=${merged.sport.length}, culture=${merged.culture.length}, indices=${merged.markets?.indices?.length || 0}`);

  // Run through dedup + whitelist + recency enforcement pipeline.
  const cleaned = enforceQualityRules(merged);

  // Lens: universal phase should have produced one. If it didn't, or it's
  // malformed, fall back to the standalone lens synthesiser.
  const lensFromModel = merged.lens;
  if (lensFromModel && lensFromModel.world && lensFromModel.india && lensFromModel.markets && lensFromModel.watch) {
    cleaned.lens = lensFromModel;
  } else {
    console.warn('[fetch] universal lens missing/invalid; falling back to fetchLens.');
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

  // ─── Sprint 11: publisher diversity cap ─────────────────────────────────
  // Cap at max 3 stories from any one publisher across the FULL fetch (not
  // per section). Applied AFTER recency + whitelist + dedup filters so we
  // only drop excess stories, never quality stories. must_include stories
  // are exempt (they're flagged as undroppable upstream — 1-3 per fetch).
  //
  // Risk: on heavy days dominated by one publisher, post-cap count can dip
  // below 15 stories. That's logged but accepted — the prompt-level rule
  // ("no more than 3 from any one publisher in the final fetch") addresses
  // root cause. This cap is the safety net.
  const PUBLISHER_CAP = 3;
  const publisherCount = new Map<string, number>();
  let publisherDropped = 0;

  function applyPublisherCap(arr: any[], section: string): RawStory[] {
    const out: RawStory[] = [];
    for (const story of arr) {
      const key = publisherKey(story?.source_url) || 'unknown';
      const used = publisherCount.get(key) || 0;
      if (!story?.must_include && used >= PUBLISHER_CAP) {
        console.log(`[publisher-cap] dropping ${section} story (publisher ${key} already at cap=${PUBLISHER_CAP}): "${(story?.headline || '').slice(0, 70)}"`);
        publisherDropped++;
        dropped.push({
          section,
          reason: `publisher diversity cap (${key} at ${PUBLISHER_CAP})`,
          headline: story.headline,
          url: story.source_url,
        });
        continue;
      }
      publisherCount.set(key, used + 1);
      out.push(story);
    }
    return out;
  }

  // Walk in priority order — higher-priority sections claim publisher slots
  // first, lower-priority sections lose excess.
  for (const sec of priority) {
    (cleaned as any)[sec] = applyPublisherCap((cleaned as any)[sec] || [], sec);
  }

  if (publisherDropped > 0) {
    const distribution = Array.from(publisherCount.entries())
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    console.log(`[publisher-cap] dropped ${publisherDropped} stories to enforce max ${PUBLISHER_CAP}/publisher. Final distribution: ${distribution}`);
  }

  // Final story-count check — warn if cap dropped us below 15 (the 5min cap).
  const totalKept = priority.reduce(
    (n, sec) => n + ((cleaned as any)[sec]?.length || 0), 0,
  );
  if (totalKept < 15) {
    console.warn(`[publisher-cap] post-cap story count ${totalKept} below the 15-story 5min target. Consider relaxing the cap if this recurs.`);
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

  return callOpenAIChat('gpt-4o', prompt, 6000, 'The Brief (5min)', '5min');
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
  "sport":   [
    { "headline": "story 1 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false },
    { "headline": "story 2 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false },
    { "headline": "story 3 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false },
    { "headline": "story 4 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }
  ],
  "culture": [
    { "headline": "story 1 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false },
    { "headline": "story 2 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false },
    { "headline": "story 3 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false },
    { "headline": "story 4 — same shape", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }
  ],
  "closer": {
    "headlines_to_remember": ["...", "...", "...", "...", "..."],
    "things_to_watch": ["...", "...", "..."],
    "conversation_insight": "..."
  }
}

IMPORTANT FOR SPORT AND CULTURE: the output shape above shows 4 slots for clarity. If raw has 4 sport stories, output ALL 4. If raw has 3, output 3. If raw has 2, output 2. Do NOT compress 4 raw stories down to 1 — that drops content the reader paid for. Same rule for culture.

Raw stories:
${JSON.stringify(rawStoriesForWriter(raw))}`;

  return callOpenAIChat('gpt-4o-mini', prompt, 14000, 'The Daily (10min)', '10min');
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

  return callOpenAIChat('gpt-4o', prompt, 12000, 'The Editorial (deep)', 'deep');
}

async function callOpenAIChat(
  model: string,
  prompt: string,
  maxTokens: number,
  label: string,
  costPhase?: '5min' | '10min' | 'deep' | 'score',
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

  // Sprint 11: log cost. Fire-and-forget.
  if (costPhase) {
    const usage = extractUsageFromChatCompletion(data);
    void logOpenAICost({
      phase: costPhase,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      detail: label,
    });
  }

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

// ─── Mode: score (Sprint 11) ────────────────────────────────────────────────
//
// LLM-based 7-dimension quality scoring against the Sprint 10 rubric.
// Reads all three ready briefs for today and writes one row per edition to
// brief_scores. Costs ~$0.005 per run with gpt-4o-mini.
//
// Trigger: cron #7 at 6:50 IST (after writes finish ~6:41) OR manual button
// from /admin/ops. Re-running on the same day overwrites previous score
// (UNIQUE constraint on date+edition).
//
// Output: { date, perEdition: { '5min': {...scores}, '10min': {...}, 'deep': {...} } }

async function scoreBriefWithLLM(
  edition: Edition,
  content: any,
): Promise<{
  dim_coverage: number;
  dim_field_completeness: number;
  dim_india_anchor: number;
  dim_source_quality: number;
  dim_editorial_sharpness: number;
  dim_currentness: number;
  dim_relevance: number;
  total: number;
  notes: string;
}> {
  // Prepare a compact representation of the brief for the scorer. Strip
  // fields the scorer doesn't need (tags, must_include flags) to keep input
  // tokens low. The scorer reads headlines, bodies, sources, and structure.
  const compact = JSON.stringify(content, null, 0).slice(0, 28000);

  const prompt = `You are the quality auditor for Morning Brief, a daily news digest for thoughtful urban Indian professionals (25-45). You score one edition against a 7-dimension rubric. Be honest and discerning. Most production briefs score 50-62/70. A score of 70/70 is rare and reserved for exceptional days.

EDITION SCORED: ${edition === '5min' ? 'The Brief (5min commute skim)' : edition === '10min' ? 'The Daily (10min full edition)' : 'The Editorial (deep synthesis)'}

RUBRIC — score each dimension 0-10:

1. COVERAGE: Does the brief cover the day's most consequential stories? Are there any glaring omissions (e.g. RBI rate decision, major war development, big election result that other outlets are leading with)? Higher = more comprehensive.

2. FIELD COMPLETENESS: Are all required fields populated on every story? For 10min: headline, facts, background, why_it_matters, what_happens_next, analysis. For 5min: headline, what_happened, why_it_matters. For deep: title, body, stories_connected. Empty/null/placeholder text on any field reduces this score significantly.

3. INDIA ANCHOR: Do stories — even global ones — explicitly connect to India? "Oil prices spike" should mention rupee/CAD/inflation impact. "US Fed decision" should mention RBI implications. Higher = stronger Indian transmission channels named in every story.

4. SOURCE QUALITY: Are sources diverse (no single publisher dominating) and authoritative (Tier-1 wires, papers of record, specialist outlets)? Penalise heavy dependence on ONE publisher (e.g. >40% from Indian Express alone). Penalise weak sources (aggregators, blogs, press releases dressed as news).

5. EDITORIAL SHARPNESS: Is the voice intelligent and specific? Or does it read like rewritten wire copy? Sharp analysis, specific names/numbers/dates, calibrated uncertainty score high. Generic phrases ("amid rising tensions", "stay tuned for more") score low.

6. CURRENTNESS: Do headlines describe today's DEVELOPMENT, not the underlying narrative? "Tehran signals back-channel talks" (good) vs "Iran-US tensions continue" (bad). Any story that feels like yesterday's news drops this score.

7. RELEVANCE: Is the brief well-targeted at urban Indian professionals (25-45)? Is the mix of world/India/business/tech/sport/culture right for that audience? Or does it over-index on a niche topic, miss obvious appeal, or skew too foreign / too political?

BRIEF CONTENT:
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
  "notes": "<2-3 sentence overall assessment naming the brief's strongest dimension and its weakest>"
}`;

  const parsed = await callOpenAIChat(
    'gpt-4o-mini',
    prompt,
    1500,
    `score-${edition}`,
    'score',
  );

  const clamp = (n: any) => {
    const v = typeof n === 'number' ? Math.round(n) : parseInt(String(n || 0), 10);
    if (isNaN(v)) return 0;
    return Math.max(0, Math.min(10, v));
  };

  const dim_coverage            = clamp(parsed?.dim_coverage);
  const dim_field_completeness  = clamp(parsed?.dim_field_completeness);
  const dim_india_anchor        = clamp(parsed?.dim_india_anchor);
  const dim_source_quality      = clamp(parsed?.dim_source_quality);
  const dim_editorial_sharpness = clamp(parsed?.dim_editorial_sharpness);
  const dim_currentness         = clamp(parsed?.dim_currentness);
  const dim_relevance           = clamp(parsed?.dim_relevance);

  const total =
    dim_coverage + dim_field_completeness + dim_india_anchor +
    dim_source_quality + dim_editorial_sharpness + dim_currentness + dim_relevance;

  return {
    dim_coverage,
    dim_field_completeness,
    dim_india_anchor,
    dim_source_quality,
    dim_editorial_sharpness,
    dim_currentness,
    dim_relevance,
    total,
    notes: typeof parsed?.notes === 'string' ? parsed.notes.slice(0, 800) : '',
  };
}

async function modeScore() {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('briefs')
    .select('edition, content, status')
    .eq('date', today)
    .eq('status', 'ready');

  if (error) {
    return { ok: false as const, error: `Read failed: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { ok: false as const, error: 'No ready briefs for today; nothing to score.' };
  }

  const editions: Edition[] = ['5min', '10min', 'deep'];
  const results: Record<string, any> = {};

  await Promise.all(
    editions.map(async (ed) => {
      const row = data.find((r) => r.edition === ed);
      if (!row || !row.content) {
        results[ed] = { status: 'skipped', reason: 'no ready brief' };
        return;
      }
      try {
        const scored = await scoreBriefWithLLM(ed, row.content);
        const { error: insErr } = await supabase
          .from('brief_scores')
          .upsert(
            {
              date: today,
              edition: ed,
              ...scored,
              max_score: 70,
            },
            { onConflict: 'date,edition' },
          );
        if (insErr) {
          results[ed] = { status: 'db_error', reason: insErr.message };
          return;
        }
        results[ed] = { status: 'ready', total: scored.total, notes: scored.notes };
      } catch (e: any) {
        results[ed] = { status: 'failed', reason: e?.message || String(e) };
      }
    }),
  );

  return { ok: true as const, date: today, results };
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

// ─── Sprint 12: Tail fetch (city / interest / industry) ─────────────────────
//
// New mode=tail-fetch. Fetches per-city, per-interest, per-industry stories
// using gpt-4o-mini-search-preview (cheap web-search-enabled model) and
// writes one row per (date, tail_type, tail_key) to the `tail_briefs` table.
// personalise-briefs.tsx reads from there instead of doing its own fetches.
//
// Key features:
//   - 7-day dedup: tail_used_urls tracks every URL surfaced; future fetches
//     receive the recent URLs as an exclude list (sent to the model in the
//     prompt). Prevents repeating the same thought piece within a week.
//   - City regional priority: REGIONAL_BY_CITY (in lib/whitelist) maps each
//     city to its preferred regional outlets; the prompt names them.
//   - Interest 7-day window: interest tail allows pieces up to 7 days old
//     when no fresh 24h development exists (per Q4-C decision).
//   - All tail fetches happen in parallel; cap per type is 3 stories.

import {
  isRegionalSource,
  REGIONAL_BY_CITY,
  publisherLabel as wlPublisherLabel,
} from '@/lib/whitelist';

interface TailStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
}

const TAIL_MODEL = 'gpt-4o-mini-search-preview';

// Sprint 12 — exposed for admin override. Defaults to the cheap mini model;
// flip via env var TAIL_FETCH_MODEL='gpt-4o' to test the quality/cost trade-off.
function getTailModel(): string {
  const envModel = process.env.TAIL_FETCH_MODEL;
  return envModel && envModel.trim() ? envModel.trim() : TAIL_MODEL;
}

async function callTailFetch(
  prompt: string,
  label: string,
  costPhase: 'city' | 'interest' | 'industry',
  costDetail: string,
): Promise<TailStory[]> {
  const model = getTailModel();

  // gpt-4o-mini-search-preview uses /v1/chat/completions with web_search_options.
  // gpt-4o (fallback / override) uses /v1/responses with tools: [{type: 'web_search_preview'}].
  // We support both paths so TAIL_FETCH_MODEL can switch between them.

  let text = '';
  try {
    if (model === 'gpt-4o-mini-search-preview') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          web_search_options: {},
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2500,
        }),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = extractUsageFromChatCompletion(data);
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        detail: costDetail,
      });
      text = data?.choices?.[0]?.message?.content || '';
    } else {
      // gpt-4o via /v1/responses path (existing pattern from personalise-briefs).
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          tools: [{ type: 'web_search_preview' }],
          tool_choice: { type: 'web_search_preview' },
          input: prompt,
          max_output_tokens: 2500,
        }),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = extractUsageFromResponses(data);
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        detail: costDetail,
      });
      text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text || '';
    }
  } catch (err: any) {
    console.warn(`[tail:${label}] network/api error: ${err?.message || err}`);
    return [];
  }

  if (!text) {
    console.warn(`[tail:${label}] empty text in response`);
    return [];
  }

  let parsed: any;
  try {
    parsed = extractJsonObject(text);
  } catch (err: any) {
    console.warn(`[tail:${label}] JSON parse failed: ${err.message}. Preview: ${text.slice(0, 300)}`);
    return [];
  }

  const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
  const kept: TailStory[] = [];
  for (const s of raw) {
    if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string' || typeof s.source !== 'string') continue;
    if (!isWhitelistedSource(s.source_url)) {
      console.warn(`[tail:${label}] dropping non-whitelisted source: ${s.source_url}`);
      continue;
    }
    kept.push(s as TailStory);
    if (kept.length >= 3) break;
  }
  return kept;
}

// 7-day used-URL lookup for cross-day dedup.
async function loadRecentUsedUrls(tailType: string, tailKey: string): Promise<string[]> {
  const today = getISTDate();
  const sevenDaysAgo = getISTDate(-7);
  const { data, error } = await supabase
    .from('tail_used_urls')
    .select('source_url')
    .eq('tail_type', tailType)
    .eq('tail_key', tailKey)
    .gte('date', sevenDaysAgo)
    .lte('date', today);
  if (error) {
    console.warn(`[tail:dedup] used-url lookup failed for ${tailType}/${tailKey}: ${error.message}`);
    return [];
  }
  return (data || []).map((r: any) => r.source_url).filter(Boolean);
}

function formatExcludeBlock(urls: string[]): string {
  if (urls.length === 0) return '';
  const trimmed = urls.slice(0, 30); // cap prompt size
  return `\nEXCLUDE — these URLs were already surfaced in the last 7 days; do NOT include them again:\n${trimmed.map((u) => `- ${u}`).join('\n')}\n`;
}

async function fetchCityTail(city: string): Promise<{ stories: TailStory[]; usedRegional: boolean }> {
  const today = getISTDate();
  const cityNormalised = city.toLowerCase().trim();
  const regional = REGIONAL_BY_CITY[cityNormalised] || [];
  const regionalLabels = regional
    .map((d) => wlPublisherLabel(`https://${d}/`) || d)
    .join(', ');

  const excludeUrls = await loadRecentUsedUrls('city', cityNormalised);

  const regionalBlock = regional.length > 0
    ? `\nPREFERRED REGIONAL SOURCES for ${city} — search these FIRST: ${regionalLabels}. These local outlets typically have stories that national papers' city editions miss.\n`
    : '';

  const prompt = `You are sourcing local news for ${city}, India. Today is ${today}.

Search the web for the 1-3 most consequential stories from ${city} in the last 24-36 hours. Civic and municipal news, major events in the city, notable incidents, local policy changes, transport, business openings/closures, urban issues, weather.

If nothing genuinely newsworthy happened, return an empty array. Do not pad with national stories.
${regionalBlock}${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from these publishers:
National: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Times of India, Deccan Herald, The Wire, NDTV, Moneycontrol, India Today, The Quint, Outlook India.
Regional: Telegraph India (East), Tribune India (North), The News Minute (South), New Indian Express, Mid-Day (Mumbai/Pune), Free Press Journal (Mumbai/MP), Bangalore Mirror, DT Next (Chennai), Telangana Today, Ahmedabad Mirror, Onmanorama (Kerala).
Wires: PTI, ANI.
No aggregators, no social media, no Google News redirects.

Return ONLY a JSON object — no markdown, no commentary:
{
  "stories": [
    {
      "headline": "clear factual headline (max 120 chars)",
      "body": "2-3 sentence factual summary — paraphrase, do not quote at length",
      "source": "publication name",
      "source_url": "https://... direct article link",
      "published_at": "${today}"
    }
  ]
}`;

  const stories = await callTailFetch(prompt, `city:${city}`, 'city', city);
  const usedRegional = stories.some((s) => isRegionalSource(s.source_url));
  return { stories, usedRegional };
}

async function fetchInterestTail(interest: string): Promise<TailStory[]> {
  const today = getISTDate();
  const interestKey = interest.toLowerCase().trim();
  const excludeUrls = await loadRecentUsedUrls('interest', interestKey);

  // Q4-C: 7-day window for interest tails. Allow features, analyses, and
  // trend pieces from the last week when no fresh 24h news exists.
  const prompt = `You are sourcing content about "${interest}" for an India-focused daily brief. Today is ${today}.

Two-pass strategy:
1. FIRST PASS — search for 24-48h news developments on ${interest}. Major announcements, policy moves, milestones, events. India focus preferred but global if globally significant.
2. SECOND PASS (only if first pass yields fewer than 3 stories) — search for recent feature articles, analyses, trend pieces, or thoughtful explainers published in the LAST 7 DAYS on ${interest}. Recent developments, current trends, important shifts. Still from whitelisted publishers only.

Return 1-3 total stories combining both passes. Paraphrase content into 2-3 factual sentences — do NOT quote at length. Headlines should be your own factual summary, not the original article's title verbatim.
${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from these publishers:
Global: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist, Al Jazeera, ABC News Australia.
India national: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Deccan Herald, The Wire, NDTV, India Today, The Quint, Outlook India, Caravan, Moneycontrol, Financial Express, Business Today, Economic Times, New Indian Express, Telegraph India, Tribune India, The News Minute.
India wires: PTI, ANI.
India specialist: Live Law, Bar & Bench (law), Down To Earth (environment/health).
Government primary: PIB, RBI, SEBI, MoSPI.
Specialist (where general sources don't cover): Nature, Science, STAT, TechCrunch, The Verge, Wired, Variety, Hollywood Reporter, ESPNCricinfo, ESPN.

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "your factual summary headline", "body": "2-3 sentence paraphrased summary", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
  ]
}`;

  return callTailFetch(prompt, `interest:${interest}`, 'interest', interest);
}

async function fetchIndustryTail(industry: string): Promise<TailStory[]> {
  const today = getISTDate();
  const industryKey = industry.toLowerCase().trim();
  const excludeUrls = await loadRecentUsedUrls('industry', industryKey);

  const prompt = `You are sourcing industry news about "${industry}" for an India-focused daily brief targeting working professionals. Today is ${today}.

Two-pass strategy:
1. FIRST PASS — search for 24-48h developments specifically affecting the ${industry} sector. Earnings, deals, regulations, hires, major company moves, sector-wide trends. India focus preferred; include major global moves that affect Indian operators.
2. SECOND PASS (only if first pass yields fewer than 3 stories) — search for feature articles, analyses, or trend pieces published in the LAST 7 DAYS on ${industry}. Industry shifts, regulatory trajectories, market shifts.

Return 1-3 total stories. Paraphrase into 2-3 factual sentences — do NOT quote at length.
${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from:
Global wires/papers: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist.
India national & business: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, Financial Express, Moneycontrol, Business Today, The Hindu BusinessLine, NDTV, India Today.
India digital: The Print, Scroll, The Wire, Caravan.
India wires: PTI, ANI.
Government primary: RBI, SEBI, MoSPI, PIB.
Specialist: TechCrunch, The Verge, Wired (tech), Nature/Science/STAT (health/pharma), Variety/Hollywood Reporter (media), ESPN/ESPNCricinfo (sport).

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "your factual summary headline", "body": "2-3 sentence paraphrased summary", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
  ]
}`;

  return callTailFetch(prompt, `industry:${industry}`, 'industry', industry);
}

interface TailFetchResult {
  tail_type: 'city' | 'interest' | 'industry';
  tail_key: string;
  display_name: string;
  stories: TailStory[];
  status: 'ready' | 'empty' | 'failed';
  reason?: string;
  usedRegional?: boolean;
}

async function modeTailFetch() {
  const today = getISTDate();
  const universe = await loadPersonalisationUniverse();

  console.log(`[tail-fetch] Universe — cities: ${universe.cities.length}, interests: ${universe.interests.length}, industries: ${universe.industries.length}`);

  if (universe.cities.length + universe.interests.length + universe.industries.length === 0) {
    return {
      ok: true as const,
      date: today,
      summary: { cities: 0, interests: 0, industries: 0 },
      results: [],
      note: 'No personalised users; nothing to fetch.',
    };
  }

  // All fetches in parallel — each is independent.
  const cityPromises = universe.cities.map(async (city): Promise<TailFetchResult> => {
    try {
      const { stories, usedRegional } = await fetchCityTail(city);
      const tail_key = city.toLowerCase().trim();
      return {
        tail_type: 'city',
        tail_key,
        display_name: city,
        stories,
        status: stories.length > 0 ? 'ready' : 'empty',
        usedRegional,
      };
    } catch (e: any) {
      return {
        tail_type: 'city',
        tail_key: city.toLowerCase().trim(),
        display_name: city,
        stories: [],
        status: 'failed',
        reason: e?.message || String(e),
      };
    }
  });

  const interestPromises = universe.interests.map(async (interest): Promise<TailFetchResult> => {
    try {
      const stories = await fetchInterestTail(interest);
      return {
        tail_type: 'interest',
        tail_key: interest.toLowerCase().trim(),
        display_name: interest,
        stories,
        status: stories.length > 0 ? 'ready' : 'empty',
      };
    } catch (e: any) {
      return {
        tail_type: 'interest',
        tail_key: interest.toLowerCase().trim(),
        display_name: interest,
        stories: [],
        status: 'failed',
        reason: e?.message || String(e),
      };
    }
  });

  const industryPromises = universe.industries.map(async (industry): Promise<TailFetchResult> => {
    try {
      const stories = await fetchIndustryTail(industry);
      return {
        tail_type: 'industry',
        tail_key: industry.toLowerCase().trim(),
        display_name: industry,
        stories,
        status: stories.length > 0 ? 'ready' : 'empty',
      };
    } catch (e: any) {
      return {
        tail_type: 'industry',
        tail_key: industry.toLowerCase().trim(),
        display_name: industry,
        stories: [],
        status: 'failed',
        reason: e?.message || String(e),
      };
    }
  });

  const allResults = await Promise.all([
    ...cityPromises,
    ...interestPromises,
    ...industryPromises,
  ]);

  // Write to tail_briefs (upsert per row).
  const upsertRows = allResults.map((r) => ({
    date: today,
    tail_type: r.tail_type,
    tail_key: r.tail_key,
    display_name: r.display_name,
    stories: r.stories,
    status: r.status,
    reason: r.reason || null,
    story_count: r.stories.length,
    used_regional: !!r.usedRegional,
  }));

  if (upsertRows.length > 0) {
    const { error } = await supabase
      .from('tail_briefs')
      .upsert(upsertRows, { onConflict: 'date,tail_type,tail_key' });
    if (error) {
      console.error(`[tail-fetch] tail_briefs upsert failed: ${error.message}`);
      return { ok: false as const, error: `tail_briefs upsert failed: ${error.message}` };
    }
  }

  // Append to tail_used_urls for dedup tracking on future runs.
  const usedUrlRows: any[] = [];
  for (const r of allResults) {
    for (const s of r.stories) {
      if (s.source_url) {
        usedUrlRows.push({
          date: today,
          tail_type: r.tail_type,
          tail_key: r.tail_key,
          source_url: s.source_url,
          headline: s.headline?.slice(0, 300) || null,
        });
      }
    }
  }

  if (usedUrlRows.length > 0) {
    const { error } = await supabase.from('tail_used_urls').insert(usedUrlRows);
    if (error) {
      console.warn(`[tail-fetch] tail_used_urls insert failed (non-fatal): ${error.message}`);
    } else {
      console.log(`[tail-fetch] Logged ${usedUrlRows.length} URLs to tail_used_urls.`);
    }
  }

  // Summary
  const summary = {
    cities: { total: universe.cities.length, ready: 0, empty: 0, failed: 0 },
    interests: { total: universe.interests.length, ready: 0, empty: 0, failed: 0 },
    industries: { total: universe.industries.length, ready: 0, empty: 0, failed: 0 },
  };
  for (const r of allResults) {
    const bucket =
      r.tail_type === 'city' ? summary.cities :
      r.tail_type === 'interest' ? summary.interests : summary.industries;
    (bucket as any)[r.status] = ((bucket as any)[r.status] || 0) + 1;
  }

  console.log(`[tail-fetch] Done. Cities: ${summary.cities.ready}/${summary.cities.total} ready. Interests: ${summary.interests.ready}/${summary.interests.total}. Industries: ${summary.industries.ready}/${summary.industries.total}.`);

  return {
    ok: true as const,
    date: today,
    model: getTailModel(),
    summary,
    results: allResults.map((r) => ({
      tail_type: r.tail_type,
      tail_key: r.tail_key,
      display_name: r.display_name,
      story_count: r.stories.length,
      status: r.status,
      used_regional: !!r.usedRegional,
      reason: r.reason,
    })),
  };
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

    if (mode === 'tail-fetch') {
      const result = await modeTailFetch();
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

    if (mode === 'score') {
      const result = await modeScore();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'full') {
      const result = await modeFull(skipPush);
      return res.status(200).json(result);
    }

    return res.status(400).json({
      ok: false,
      error: `Unknown mode: ${mode}. Use 'fetch', 'tail-fetch', 'write', 'push', 'score', or 'full'.`,
    });
  } catch (error: any) {
    console.error('Top-level error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
