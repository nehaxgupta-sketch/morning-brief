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
  'indianexpress.com',
  'hindustantimes.com',
  'livemint.com',
  'business-standard.com',
  'theprint.in',
  'scroll.in',
  'timesofindia.indiatimes.com',
  'deccanherald.com',
  'thewire.in',
  'moneycontrol.com',
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
    one_quote: { quote: string; attribution: string; context: string };
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
    }),
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

async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  const tagsBlock = (universe.industries.length || universe.interests.length)
    ? `
DOWNSTREAM TAGGING (for personalisation):
On every story, include zero or more tags from these EXACT vocabularies:
- "industries": ${JSON.stringify(universe.industries)}
- "interests":  ${JSON.stringify(universe.interests)}
- "city_tags":  ${JSON.stringify(universe.cities)} (only if the story is materially relevant to that city)
- "topic_tags": from { "business", "markets", "technology", "climate", "health", "sport", "culture", "policy", "education", "infrastructure", "energy" } (multiple allowed; "climate" and "health" are listed separately even though the section is climate_health)

Tagging rules:
- Use EXACT spelling from the vocabularies (case-sensitive).
- Only tag where the relevance is real and direct. Better to leave a tag array empty than to over-tag.
- Sport, culture, markets stories do not need industry/interest tags unless materially relevant.`
    : `
DOWNSTREAM TAGGING: No personalisation vocabulary yet. Skip the tag fields.`;

  const prompt = `You are a senior news editor for an India-based daily brief read by educated, curious readers. Today is ${today}. Search the web for the day's most consequential stories and return ONLY a JSON object — no markdown, no commentary.

═══════════════════════════════════════════════
PART 1 — MUST-INCLUDE SCAN (do this FIRST, in your head)
═══════════════════════════════════════════════
Before you fetch anything, identify the 5 stories that any responsible Indian daily brief on ${today} would be embarrassed to omit. These are the day's dominant stories — what every major paper is leading with, what is unavoidable in conversation. Examples of what makes a story must-include:
- A national-scale event (election result, major policy decision, large protest, major accident, major court ruling)
- A dominant ongoing series at its peak (IPL final, World Cup final, election day, major hearing day)
- A market-moving event of broad significance
- A geopolitical event with direct India impact

For each of these 5 stories, you will set "must_include": true on the corresponding story object you produce in Part 2. These MUST be in the output — no exceptions, no substitutes.

═══════════════════════════════════════════════
PART 2 — FETCH (web search required)
═══════════════════════════════════════════════
You MUST use the web_search_preview tool for EVERY story. Do not write any story from memory. If web search does not return a real article for a category, leave that category empty rather than fabricate.

SOURCE WHITELIST — cite ONLY from these publishers:
GLOBAL: Reuters, Associated Press, Bloomberg, Financial Times, Wall Street Journal, New York Times, Washington Post, BBC, The Guardian, The Economist, Al Jazeera.
INDIA: The Hindu, Indian Express, Hindustan Times, LiveMint (Mint), Business Standard, The Print, Scroll, Times of India, Deccan Herald, The Wire, Moneycontrol.
SPECIALIST (only when general sources don't cover): ESPNCricinfo (sport), Variety / Hollywood Reporter (entertainment), Nature / Science / STAT (health/science), TechCrunch / The Verge / Ars Technica / Wired (tech).

ABSOLUTELY NOT ALLOWED — drop the story if you can only source it from here:
- Aggregators: Google News, MSN, Yahoo News
- Social media: X/Twitter, Reddit, YouTube
- Opinion blogs, listicle sites
- Anonymous / no-byline pieces
- Domain you don't recognise

SOURCE_URL must be a direct article URL on the publisher's domain. No redirect links, no homepage URLs, no aggregator wrappers.

RECENCY: every story's published_at must be within the last 48 hours, unless it is in major_events (sustained themes can reference up to 7 days).

DEDUPLICATION — each story appears in EXACTLY ONE section. Priority order:
1. major_events takes precedence over everything
2. world / india take precedence over topic sections (business, technology, etc.)
3. topic sections only get stories not already classified above
If a story could fit two sections (e.g. IPL final = sport AND a major_event AND a Bengaluru/Ahmedabad story), pick the HIGHEST-priority section by the order above. Do not duplicate.

CITIES INSIDE INDIA: significant city-level developments (Mumbai, Bengaluru, Chennai, Hyderabad, Delhi, Kolkata, Pune, Ahmedabad, etc.) belong in the "india" section. There are no separate city sections in the output. Do not bias toward any one city — select by news significance.

═══════════════════════════════════════════════
PART 3 — SECTIONS & COUNTS
═══════════════════════════════════════════════
- major_events: 3 to 4 stories — sustained, multi-day themes or dominant narratives shaping the week (ongoing wars, election cycles, IPL season, major policy rollouts). DISTINCT from world/india (which are 24-hour news).
- world: exactly 5 stories — 24-hour global news.
- india: exactly 5 stories — 24-hour national news. Significant city stories fold in here.
- business: 2 to 3 stories.
- technology: 1 to 2 stories.
- climate_health: 1 to 2 stories (climate, environment, or health).
- sport: 1 single story (the day's biggest sport story).
- culture: 1 single story (the day's biggest culture/entertainment story).
- markets: a one-paragraph summary + exactly 4 indices: Sensex, Nifty, S&P 500, Nasdaq.

Order stories within each array by consequence — index 0 is the most important. (The 5-minute edition only keeps the top items from each section, so the ordering matters.)

═══════════════════════════════════════════════
PART 4 — LENS (four one-liners at the top)
═══════════════════════════════════════════════
At the start of your output, include a "lens" object with four lines that summarise the day at a glance. Each line is ONE short sentence (max 14 words). These appear on the app's home screen as a flash card before the reader picks an edition.

- world: the single biggest theme in global news today
- india: the single biggest theme in Indian news today
- markets: a one-liner on markets direction and what's driving it
- watch: the single most important development to watch this week

${tagsBlock}

═══════════════════════════════════════════════
PART 5 — REQUIRED OUTPUT SHAPE
═══════════════════════════════════════════════
{
  "lens": {
    "world": "...",
    "india": "...",
    "markets": "...",
    "watch": "..."
  },
  "major_events": [
    { "headline": "...", "body": "2-3 sentence factual summary", "source": "Publisher Name", "source_url": "https://...", "published_at": "ISO date or ${today}", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }
  ],
  "world":   [ /* 5 stories, same shape */ ],
  "india":   [ /* 5 stories, same shape */ ],
  "business":      [ /* 2-3 */ ],
  "technology":    [ /* 1-2 */ ],
  "climate_health":[ /* 1-2 */ ],
  "sport":   { /* single story */ },
  "culture": { /* single story */ },
  "markets": {
    "summary": "2-3 sentences capturing today's market direction and drivers",
    "indices": [
      { "name": "Sensex",  "change": "+0.4%" },
      { "name": "Nifty",   "change": "-0.1%" },
      { "name": "S&P 500", "change": "+0.6%" },
      { "name": "Nasdaq",  "change": "+1.1%" }
    ]
  }
}

Use real markets data from today if available; otherwise neutral best estimates clearly grounded in the day's news. Be factual and neutral throughout — no opinion. Keep each story body to 2-3 sentences strictly.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      tools: [{ type: 'web_search_preview' }],
      tool_choice: { type: 'web_search_preview' },
      input: prompt,
      max_output_tokens: 14000,
    }),
  });

  const data = await response.json();
  console.log('OpenAI fetch status:', response.status, 'items:', data.output?.length);
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) throw new Error(`No response from OpenAI fetch. Raw: ${JSON.stringify(data).slice(0, 800)}`);

  const parsed = extractJsonObject(text);
  return enforceQualityRules(parsed);
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
  // Compact representation passed to writers. We pass the full thing — the
  // writers need to see every story they might select from.
  return raw;
}

async function writeQuickEdition(raw: RawStories): Promise<BriefQuick> {
  const today = getISTDate();
  const prompt = `You are the voice of Morning Brief — a daily news digest for thoughtful Indian readers. The reader is opening THE BRIEF, the 5-minute commute read.

VOICE: warm, intelligent, conversational. Plain English. Active voice. No jargon. No sensationalism.

FORMAT: each story is a MICRO-ITEM with three short fields:
- headline: clear and factual (≤ 14 words)
- what_happened: ONE sentence (≤ 22 words). State the news plainly.
- why_it_matters: ONE sentence (≤ 22 words). The reader takeaway. Avoid generic filler.

SELECTION (be ruthless — this is the skim edition):
- major_events: TOP 2 most significant
- world: TOP 3 most consequential
- india: TOP 2 most consequential
- topics: pick 5 micro-items total mixed across business, markets, technology, climate_health, sport, culture — choose the most important across them. (Do not include the markets index table here — just one micro-item if a market story warrants it.)

HARD RULES:
- ALWAYS include every story flagged must_include: true (in major_events, world, india). If a must_include sits in topics-territory (business/tech/etc.), surface it in topics. Never drop a must_include.
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
  const prompt = `You are the voice of Morning Brief — a daily news digest for thoughtful Indian readers. The reader is opening THE DAILY, the main 10-minute read.

VOICE: warm, intelligent, conversational. Plain English. Active voice. Separate fact from interpretation. Hedge where uncertain ("likely", "may", "early signs suggest"). No jargon. No sensationalism.

FORMAT: each story has FIVE labelled fields:
- headline: clear, factual (≤ 16 words)
- facts: 1-2 sentences. What happened. Numbers, names, dates, locations.
- background: 1-2 sentences. What led to this. Why the story is relevant beyond the immediate headline.
- why_it_matters: 1-2 sentences. The impact — on people, policy, markets, society, governance.
- what_happens_next: 1-2 sentences. The specific developments to track (hearings, decisions, releases, fixtures).
- analysis: 1-2 sentences. Concise interpretation, clearly separate from the facts. Acknowledge uncertainty where appropriate.

SELECTION: Include EVERY story from the raw stories. Do not drop anything. Maintain the ordering from the raw stories within each section. If raw stories has no "sport" or "culture" key (or the value is empty/missing), OMIT that field from your output entirely — do NOT fabricate a story.

CLOSER: Include a "closer" object at the end with:
- headlines_to_remember: EXACTLY 5 single-line memory anchors covering today's most important stories. Each short, factual, scannable (≤ 14 words).
- things_to_watch: EXACTLY 3 forward-looking developments to track this week. Each ONE sentence (≤ 24 words).
- conversation_insight: ONE intelligent observation a reader could naturally raise in conversation — a synthesis across multiple stories, not a restated headline. 2-3 sentences. Insightful, not gimmicky.

HARD RULES:
- Carry source, source_url, industries, interests, city_tags, topic_tags, must_include UNCHANGED through every story.
- Keep markets indices values EXACTLY as in raw data. You may rewrite the markets summary in your voice (2 sentences).
- Output ONLY JSON. No markdown, no commentary.

OUTPUT SHAPE:
{
  "edition": "10min",
  "date": "${today}",
  "major_events": [{ "headline": "...", "facts": "...", "background": "...", "why_it_matters": "...", "what_happens_next": "...", "analysis": "...", "source": "...", "source_url": "...", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }],
  "world":          [ /* same shape */ ],
  "india":          [ /* same shape */ ],
  "business":       [ /* same shape */ ],
  "markets":        { "summary": "rewritten 2-sentence summary", "indices": [ /* unchanged */ ] },
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
     - body: flowing prose. Pick ONE thread (e.g. "India's inflation-energy-monsoon triangle", "What the Karnataka transition reveals about urban governance"). Go deep. Bring history, scale, second-order implications. Where facts are disputed, hedge. End with a forward-looking sentence.
     - candidate_themes: 2-3 alternative themes you could have chosen instead (for downstream personalisation that may pick a different one).

3. watching_this_week — exactly 5 forward-looking items. Each:
     - title: short (≤ 10 words)
     - body: 35-65 words. Why this matters, what to watch, when. Specific and concrete.
     - tag fields (interests, industries, topic_tags) where natural.

4. signature — three small editorial set pieces:
     - one_number: a single number that captures something important today. value is the number with units (e.g. "$87/barrel" or "12%"). context is 1-2 sentences on why this number matters today.
     - one_chart: a chart description (we render it client-side if at all). title is the chart's subject (e.g. "Brent crude, last 30 days"). description is 1-2 sentences on what the chart would show and why it's the right cut today.
     - one_quote: a quote from THIS WEEK worth sitting with. quote is the quote itself (≤ 40 words). attribution is who said it (name, role, publication). context is 1-2 sentences on why it lands.

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════
- Use the raw stories below as your source material. Do not invent stories or quotes.
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
    "one_quote": { "quote": "...", "attribution": "...", "context": "..." }
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
  status: 'ready' | 'fallback' | 'failed',
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

// ─── Per-edition processor ──────────────────────────────────────────────────

type EditionOutcome = {
  status: 'ready' | 'fallback' | 'failed';
  reason?: string;
  content?: BriefContent;
};

async function processEdition(
  ed: Edition,
  rawStories: RawStories | null,
  lens: any | null,
): Promise<EditionOutcome> {
  if (!rawStories) {
    const prev = await fetchPreviousBrief(ed);
    if (prev) {
      await saveBriefToSupabase(ed, null, prev.content, prev.lens, 'fallback');
      return { status: 'fallback', reason: 'OpenAI fetch failed', content: prev.content };
    }
    await saveBriefToSupabase(ed, null, null, lens, 'failed');
    return { status: 'failed', reason: 'OpenAI fetch failed and no previous brief' };
  }

  try {
    console.log(`Writing ${ed}...`);
    const writer =
      ed === '5min'  ? writeQuickEdition
    : ed === '10min' ? writeDailyEdition
    :                  writeEditorialEdition;

    const content = await writer(rawStories);
    const validation = validateBrief(content, ed);
    if (validation.ok) {
      await saveBriefToSupabase(ed, rawStories, validation.data, lens, 'ready');
      return { status: 'ready', content: validation.data };
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { edition, skipPush } = req.body || {};
  const editions: Edition[] = edition ? [edition] : ['5min', '10min', 'deep'];

  const results: Record<string, { status: string; reason?: string }> = {};

  try {
    // Step 1: universe
    const universe = await loadPersonalisationUniverse();
    console.log(`Universe — industries: ${universe.industries.length}, interests: ${universe.interests.length}, cities: ${universe.cities.length}`);

    // Step 2: fetch news
    let rawStories: RawStories | null = null;
    let lens: any = null;
    try {
      console.log('Fetching news from OpenAI...');
      rawStories = await fetchNewsFromOpenAI(universe);
      console.log('News fetched.');
      // Lens validation — if invalid, leave null and the writers' fallbacks
      // will surface yesterday's lens (or none).
      if (rawStories.lens && validateLens(rawStories.lens)) {
        lens = rawStories.lens;
      } else {
        console.warn('Lens missing or invalid in fetch response.');
      }
    } catch (err: any) {
      console.error('OpenAI fetch failed:', err.message);
    }

    // Step 3: process editions in parallel
    const writtenBriefs: Record<string, BriefContent> = {};
    const editionPairs = await Promise.all(
      editions.map(async (ed) => {
        const r = await processEdition(ed, rawStories, lens);
        if (r.content) writtenBriefs[ed] = r.content;
        const { content, ...rest } = r;
        return [ed, rest] as const;
      }),
    );
    for (const [ed, r] of editionPairs) results[ed] = r;

    // Step 4: push (only if at least one fresh-ready edition)
    const anyFresh = Object.values(results).some((r) => r.status === 'ready');
    if (!skipPush && anyFresh) {
      const top =
        (writtenBriefs['5min']  as BriefQuick | undefined)?.major_events?.[0]?.headline ??
        (writtenBriefs['10min'] as BriefDaily | undefined)?.major_events?.[0]?.headline ??
        (writtenBriefs['5min']  as BriefQuick | undefined)?.world?.[0]?.headline ??
        (writtenBriefs['10min'] as BriefDaily | undefined)?.world?.[0]?.headline ??
        "Today's stories are waiting for you.";
      try {
        await sendPushNotification(top);
      } catch (err: any) {
        console.error('Push failed (briefs already saved):', err.message);
      }
    } else if (!skipPush && !anyFresh) {
      console.log('Push skipped — no fresh briefs (all fallbacks or failed)');
    } else {
      console.log('Push skipped (skipPush: true)');
    }

    return res.status(200).json({ success: true, editions, universe, lens, results });
  } catch (error: any) {
    console.error('Top-level error:', error.message);
    return res.status(500).json({ success: false, error: error.message, results });
  }
}
