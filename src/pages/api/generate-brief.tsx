// src/pages/api/generate-brief.tsx
//
// Daily brief generator. Sprint 7a architecture:
//   1. Read personalisation universe (unique industries + interests from
//      profiles where brief_type = 'personalised') BEFORE fetching news,
//      so OpenAI can tag stories with applicable industries/interests.
//   2. OpenAI universal fetch — fixed sections only (no city sections).
//      Includes the new "major_events" section (sustained / trending themes).
//   3. Claude writes 3 editions in parallel from the same raw stories.
//   4. Validate (Zod) → save to briefs → push.
//
// City news no longer lives here — that moves into personalise-briefs.tsx,
// where it's fetched per unique city once per run.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const config = { maxDuration: 60 };

// ─── Clients ────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

// ─── Date helpers (IST) ─────────────────────────────────────────────────────

function getISTDate(offsetDays = 0): string {
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Edition = '5min' | '10min' | 'deep';

interface Story {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at: string;
  industries?: string[];
  interests?: string[];
}

interface MarketIndex {
  name: string;
  change: string;
}

interface RawStories {
  major_events: Story[];     // NEW — sustained / trending themes
  world: Story[];
  india: Story[];
  markets: { summary: string; indices: MarketIndex[] };
  business: Story[];
  technology: Story[];
  climate_health: Story[];
  sport: Story;
  culture: Story;
}

interface WrittenStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  industries?: string[];
  interests?: string[];
}

interface Closer {
  headlines_to_remember: string[];  // 5
  things_to_watch: string[];        // 3
  conversation_insight: string;     // 1
}

interface BriefContent {
  edition: Edition;
  date: string;
  major_events: WrittenStory[];   // NEW
  world: WrittenStory[];
  india: WrittenStory[];
  markets: { summary: string; indices: MarketIndex[] };
  business: WrittenStory[];
  technology: WrittenStory[];
  climate_health: WrittenStory[];
  sport: WrittenStory;
  culture: WrittenStory;
  // Legacy fields — accepted from very old saved briefs but not written by 7a:
  bengaluru?: WrittenStory[];
  delhi?: WrittenStory[];
  closer?: Closer;
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const StorySchema = z.object({
  headline: z.string().min(5).max(200),
  body: z.string().min(20),
  source: z.string().min(1),
  source_url: z.union([z.string().startsWith('https://'), z.literal('')]),
  industries: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
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

const BriefContentSchema = z.object({
  edition: z.enum(['5min', '10min', 'deep']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  major_events: z.array(StorySchema).min(1),
  world: z.array(StorySchema).min(1),
  india: z.array(StorySchema).min(1),
  business: z.array(StorySchema).min(1),
  technology: z.array(StorySchema).min(1),
  climate_health: z.array(StorySchema),
  markets: z.object({
    summary: z.string().min(10),
    indices: z.array(MarketIndexSchema).length(4),
  }),
  sport: StorySchema,
  culture: StorySchema,
  // Tolerated but not required for new writes:
  bengaluru: z.array(StorySchema).optional(),
  delhi: z.array(StorySchema).optional(),
  closer: CloserSchema.optional(),
}).refine(
  (b) => b.edition === '5min' || b.closer !== undefined,
  { message: 'closer is required for 10min and deep editions', path: ['closer'] }
);

// ─── Edition configuration ──────────────────────────────────────────────────

interface EditionConfig {
  model: string;
  maxTokens: number;
  selectionRules: string;
  depthRules: string;
  marketsRules: string;
  closerRules: string;
  readingTime: string;
}

const EDITION_CONFIG: Record<Edition, EditionConfig> = {
  '5min': {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 8000,
    readingTime: '5 minutes',
    selectionRules: `
SELECTION (this is the skimmable edition — be ruthless):
- major_events: keep TOP 2 most significant ongoing themes.
- world: keep TOP 3 most consequential stories.
- india: keep TOP 2 most consequential stories.
- business: keep TOP 2.
- technology: keep TOP 1.
- climate_health: keep TOP 1.
- sport: keep as single story.
- culture: keep as single story.
- markets: keep all 4 indices, summary becomes 1 punchy sentence.
Total target: ~12 stories. A reader skimming on their commute should finish in 5 minutes.`,
    depthRules: `
DEPTH:
- 2 short sentences per story. Punchy. Essential facts only.
- No background, no "why it matters", no "what's next". Just the news, warmly written.
- Headlines stay clear and factual — no clickbait.`,
    marketsRules: `
MARKETS: 1 sentence summary capturing the day's direction.`,
    closerRules: `
CLOSER: Do NOT include a closer for the 5-minute edition. Omit the "closer" field from the JSON entirely.`,
  },

  '10min': {
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
    readingTime: '10 minutes',
    selectionRules: `
SELECTION: Include EVERY story from the raw stories. Do not drop anything.
If a raw section's array is empty, return an empty array for it.`,
    depthRules: `
DEPTH:
- 3 to 4 sentences per story.
- Lead with what happened, then add ONE piece of context or background that makes the reader understand why it matters.
- Avoid generic filler. Be specific.`,
    marketsRules: `
MARKETS: 2 sentences. First the numbers/direction, second a brief explanation of what's driving the moves.`,
    closerRules: `
CLOSER: Include a "closer" object at the end with three fields:
- "headlines_to_remember": EXACTLY 5 single-line memory anchors covering today's most important stories. Each one short, factual, scannable.
- "things_to_watch": EXACTLY 3 forward-looking developments to track over the coming week. Each one a single sentence.
- "conversation_insight": ONE sharp, intelligent observation a reader could naturally bring up in conversation — a synthesis or pattern across today's stories, not a restated headline. Two to three sentences. Insightful, not gimmicky.`,
  },

  'deep': {
    model: 'claude-sonnet-4-6',
    maxTokens: 16000,
    readingTime: '15 to 20 minutes',
    selectionRules: `
SELECTION: Include EVERY story from the raw stories. Do not drop anything.
If a raw section's array is empty, return an empty array for it.`,
    depthRules: `
DEPTH (this is the analytical edition — depth and synthesis matter):
- 5 to 7 sentences per story, written as flowing prose (no bullet points, no headers within body).
- Each story should naturally cover: what happened, the relevant background or historical context, why it matters (direct and second-order implications), and what to watch next.
- Where facts are disputed or outcomes uncertain, use hedged language ("likely", "may", "early signs suggest") rather than presenting speculation as fact.
- Where helpful, draw connections to broader patterns or related stories — but don't force this.
- Tone: like an Economist briefing or an FT lex column. Intelligent, calm, sharp. Never academic, never sensational.`,
    marketsRules: `
MARKETS: 3 to 4 sentences with genuine analysis. Cover the numbers, the drivers, and what they signal about broader sentiment or upcoming events.`,
    closerRules: `
CLOSER: Include a "closer" object at the end with three fields:
- "headlines_to_remember": EXACTLY 5 single-line memory anchors covering today's most important stories. Each one short, factual, scannable.
- "things_to_watch": EXACTLY 3 forward-looking developments to track over the coming week. Each one a single sentence with a brief reason it matters.
- "conversation_insight": ONE sharp, analytical observation a reader could bring up in informed conversation — a genuine synthesis or pattern across today's news, drawing connections others might miss. Three to four sentences. Should feel like an FT or Economist editor's note, not a recap.`,
  },
};

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

// ─── Step 1: Build personalisation universe ─────────────────────────────────
// Read every personalised user's industry + interests so OpenAI can tag stories
// against that exact vocabulary. If the universe is empty (no personalised
// users yet), we skip tagging entirely — that's fine, the rest still works.

interface Universe {
  industries: string[];
  interests: string[];
}

async function loadPersonalisationUniverse(): Promise<Universe> {
  const { data, error } = await supabase
    .from('profiles')
    .select('industry, interests')
    .eq('brief_type', 'personalised');

  if (error) {
    console.warn('Personalisation universe lookup failed:', error.message);
    return { industries: [], interests: [] };
  }

  const industries = new Set<string>();
  const interests = new Set<string>();
  for (const row of data || []) {
    const ind = (row as any).industry;
    const ints = (row as any).interests;
    if (ind && typeof ind === 'string' && ind.trim()) industries.add(ind.trim());
    if (Array.isArray(ints)) {
      for (const i of ints) {
        if (typeof i === 'string' && i.trim()) interests.add(i.trim());
      }
    }
  }
  return {
    industries: [...industries].sort(),
    interests: [...interests].sort(),
  };
}

// ─── Step 2: Fetch news via OpenAI ──────────────────────────────────────────

async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  const taggingBlock = (universe.industries.length || universe.interests.length)
    ? `
TAGGING (for downstream personalisation):
For each story, add two OPTIONAL arrays:
- "industries": pick zero or more from this vocabulary that the story is materially relevant to. Vocabulary: ${JSON.stringify(universe.industries)}
- "interests": pick zero or more from this vocabulary the story is materially relevant to. Vocabulary: ${JSON.stringify(universe.interests)}
Rules:
- Only tag a story if relevance is real and direct. Better to leave both arrays empty than to over-tag.
- Use the EXACT spelling from the vocabulary above (case-sensitive).
- Sport, culture, and markets do not need tags — leave them empty arrays or omit.`
    : `
TAGGING: No personalisation vocabulary defined yet. Skip the "industries" and "interests" fields entirely.`;

  const prompt = `You are a news editor for an India-based daily brief. Search the web for today's (${today}) most consequential stories across the categories below. Return ONLY a JSON object — no markdown, no backticks, no commentary.

For EVERY story you MUST include:
- "headline": clear, factual headline (max 120 chars)
- "body": 2-3 sentence factual summary
- "source": publication name only (e.g. "Reuters", "The Hindu")
- "source_url": full direct URL to the actual article (must start with https://, real working link to the specific story)
- "published_at": ISO date or datetime if available, otherwise today's date (${today})
${taggingBlock}

Rules:
- You MUST use the web_search_preview tool to find each story. Do not write any story from memory. If web search does not return a real article for a category, omit that story.
- Use only real stories from the last 24-36 hours. Prefer original publishers (Reuters, AP, Bloomberg, The Hindu, Indian Express, BBC, FT) over aggregators.
- Try to use distinct URLs for distinct stories where possible.
- Be factual and neutral. No opinion.
- Keep each body to 2-3 sentences. Do not exceed.
- IMPORTANT: Order stories within each array by consequence — most important first. The downstream 5-minute edition only keeps the top 1-3 per section, so the most important story must be at index 0.

SECTION DEFINITIONS — read carefully, they are different:
- "major_events": 2 to 4 stories representing SUSTAINED OR TRENDING themes — multi-day developments, ongoing series, or dominant narratives that continue to shape the news cycle this week. Examples: an ongoing IPL or election series, a multi-week geopolitical situation (e.g. ongoing war, summit aftermath), a sustained cultural or social movement. These are DISTINCT from World/India which capture 24-hour breaking news. Do not duplicate World/India headlines here.
- "world": 5 stories of 24-hour global news — wars, diplomacy, elections, global economy, major incidents.
- "india": 5 stories of 24-hour national news — politics, policy, regulation, courts, governance. SIGNIFICANT city-level stories (Bengaluru airport, Mumbai bank fraud, Delhi smog policy) BELONG HERE, not in their own section.

Return this exact structure:
{
  "major_events": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "...", "industries": [], "interests": [] }
  ],
  "world": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "...", "industries": [], "interests": [] }
  ],
  "india": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "...", "industries": [], "interests": [] }
  ],
  "markets": {
    "summary": "2-3 sentence overview of markets today",
    "indices": [
      { "name": "Sensex", "change": "+0.4%" },
      { "name": "Nifty", "change": "-0.1%" },
      { "name": "S&P 500", "change": "+0.6%" },
      { "name": "Nasdaq", "change": "+1.1%" }
    ]
  },
  "business": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "...", "industries": [], "interests": [] }
  ],
  "technology": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "...", "industries": [], "interests": [] }
  ],
  "climate_health": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "...", "industries": [], "interests": [] }
  ],
  "sport": { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." },
  "culture": { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
}

Use real markets data from today if available; otherwise neutral best estimates.`;

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
      max_output_tokens: 12000,
    }),
  });

  const data = await response.json();
  console.log('OpenAI status:', response.status, 'output items:', data.output?.length);
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) throw new Error(`No response from OpenAI. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  console.log('OpenAI text length:', text.length);

  return extractJsonObject(text);
}

// ─── Step 3: Write brief with Claude ────────────────────────────────────────

async function writeBriefWithClaude(rawStories: RawStories, edition: Edition): Promise<BriefContent> {
  const config = EDITION_CONFIG[edition];

  const prompt = `You are the voice of Morning Brief — a daily news digest for thoughtful, curious Indian readers. Your tone is warm, intelligent, and conversational — like a well-read friend briefing you over coffee. Never sensational, never dry. Write in plain English. Use active voice. Avoid jargon. Separate fact from interpretation; use hedged language for anything uncertain.

EDITION: ${edition.toUpperCase()} (target reading time: ${config.readingTime})

${config.selectionRules}

${config.depthRules}

${config.marketsRules}

${config.closerRules}

Here are today's raw stories. Rewrite the selected stories in the Morning Brief voice following the rules above. Return ONLY a JSON object — no markdown, no backticks, no extra text.

Raw stories:
${JSON.stringify(rawStories, null, 2)}

Return this exact JSON structure:

{
  "edition": "${edition}",
  "date": "${getISTDate()}",
  "major_events": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "...", "industries": [], "interests": [] }
  ],
  "world": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "...", "industries": [], "interests": [] }
  ],
  "india": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "...", "industries": [], "interests": [] }
  ],
  "markets": {
    "summary": "rewritten markets summary in Morning Brief voice",
    "indices": [
      { "name": "Sensex", "change": "..." },
      { "name": "Nifty", "change": "..." },
      { "name": "S&P 500", "change": "..." },
      { "name": "Nasdaq", "change": "..." }
    ]
  },
  "business": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "...", "industries": [], "interests": [] }
  ],
  "technology": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "...", "industries": [], "interests": [] }
  ],
  "climate_health": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "...", "industries": [], "interests": [] }
  ],
  "sport": { "headline": "...", "body": "...", "source": "...", "source_url": "..." },
  "culture": { "headline": "...", "body": "...", "source": "...", "source_url": "..." }${edition === '5min' ? '' : `,
  "closer": {
    "headlines_to_remember": ["...", "...", "...", "...", "..."],
    "things_to_watch": ["...", "...", "..."],
    "conversation_insight": "..."
  }`}
}

CRITICAL:
- Follow the SELECTION rules for this edition — for 5min, drop stories; for 10min and deep, include every raw story.
- Carry source, source_url, industries, and interests through unchanged from the raw data for every story you keep.
- Keep markets indices values exactly as in raw data.
- Only rewrite headline, body, and markets summary.
- For 5min: do NOT include a "closer" field.
- For 10min and deep: the "closer" field is REQUIRED, with exactly 5 headlines_to_remember and exactly 3 things_to_watch.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  console.log(`Claude (${edition}) status:`, response.status, 'model:', config.model);

  const text = data.content?.[0]?.text;
  if (!text) throw new Error(`No response from Claude for ${edition}. Raw: ${JSON.stringify(data).slice(0, 800)}`);

  return extractJsonObject(text);
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateBrief(content: any, edition: Edition):
  | { ok: true; data: BriefContent }
  | { ok: false; errors: string }
{
  const result = BriefContentSchema.safeParse(content);
  if (result.success) {
    return { ok: true, data: result.data as BriefContent };
  }
  const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  console.error(`Validation failed for ${edition}: ${errors}`);
  return { ok: false, errors };
}

// ─── Fallback fetch ─────────────────────────────────────────────────────────

async function fetchPreviousBrief(edition: Edition): Promise<BriefContent | null> {
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
      console.log(`Fallback: using ${edition} brief from ${date} (was ${data.status})`);
      return data.content as BriefContent;
    }
  }
  return null;
}

// ─── Save ────────────────────────────────────────────────────────────────────

async function saveBriefToSupabase(
  edition: Edition,
  rawStories: RawStories | null,
  content: BriefContent | null,
  status: 'ready' | 'fallback' | 'failed'
) {
  const today = getISTDate();
  const { error } = await supabase
    .from('briefs')
    .upsert(
      {
        date: today,
        edition,
        status,
        raw_stories: rawStories,
        content,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'date,edition' }
    );
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
  console.log(`Brief saved — ${edition} for ${today} (status: ${status})`);
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
  rawStories: RawStories | null
): Promise<EditionOutcome> {
  if (!rawStories) {
    const previous = await fetchPreviousBrief(ed);
    if (previous) {
      await saveBriefToSupabase(ed, null, previous, 'fallback');
      return { status: 'fallback', reason: 'OpenAI fetch failed', content: previous };
    }
    await saveBriefToSupabase(ed, null, null, 'failed');
    return { status: 'failed', reason: 'OpenAI fetch failed and no previous brief' };
  }

  try {
    console.log(`Writing ${ed}...`);
    const content = await writeBriefWithClaude(rawStories, ed);
    const validation = validateBrief(content, ed);
    if (validation.ok) {
      await saveBriefToSupabase(ed, rawStories, validation.data, 'ready');
      return { status: 'ready', content: validation.data };
    }
    const previous = await fetchPreviousBrief(ed);
    if (previous) {
      await saveBriefToSupabase(ed, rawStories, previous, 'fallback');
      return { status: 'fallback', reason: validation.errors, content: previous };
    }
    await saveBriefToSupabase(ed, rawStories, null, 'failed');
    return { status: 'failed', reason: validation.errors };
  } catch (err: any) {
    console.error(`Error writing ${ed}:`, err.message);
    const previous = await fetchPreviousBrief(ed);
    if (previous) {
      await saveBriefToSupabase(ed, rawStories, previous, 'fallback');
      return { status: 'fallback', reason: err.message, content: previous };
    }
    await saveBriefToSupabase(ed, rawStories, null, 'failed');
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
    // Step 1: personalisation universe (cheap — one Supabase select).
    const universe = await loadPersonalisationUniverse();
    console.log(`Universe — industries: ${universe.industries.length}, interests: ${universe.interests.length}`);

    // Step 2: fetch news. If OpenAI throws, we still serve yesterday's briefs.
    let rawStories: RawStories | null = null;
    try {
      console.log('Fetching news from OpenAI...');
      rawStories = await fetchNewsFromOpenAI(universe);
      console.log('News fetched.');
    } catch (err: any) {
      console.error('OpenAI fetch failed:', err.message);
    }

    // Step 3: process all editions IN PARALLEL.
    const writtenBriefs: Record<string, BriefContent> = {};
    const editionPairs = await Promise.all(
      editions.map(async (ed) => {
        const r = await processEdition(ed, rawStories);
        if (r.content) writtenBriefs[ed] = r.content;
        const { content, ...rest } = r;
        return [ed, rest] as const;
      })
    );
    for (const [ed, r] of editionPairs) results[ed] = r;

    // Step 4: push only if at least one edition is fresh-ready.
    const anyFresh = Object.values(results).some((r) => r.status === 'ready');
    if (!skipPush && anyFresh) {
      const topHeadline =
        writtenBriefs['5min']?.major_events?.[0]?.headline ??
        writtenBriefs['5min']?.world?.[0]?.headline ??
        writtenBriefs['10min']?.world?.[0]?.headline ??
        "Today's stories are waiting for you.";
      try {
        await sendPushNotification(topHeadline);
      } catch (err: any) {
        console.error('Push failed (briefs already saved):', err.message);
      }
    } else if (!skipPush && !anyFresh) {
      console.log('Push skipped — no fresh briefs today (all fallbacks or failed)');
    } else {
      console.log('Push skipped (skipPush: true)');
    }

    return res.status(200).json({ success: true, editions, universe, results });
  } catch (error: any) {
    console.error('Top-level error:', error.message);
    return res.status(500).json({ success: false, error: error.message, results });
  }
}
