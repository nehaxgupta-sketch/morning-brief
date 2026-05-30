import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

// Give the function the full Hobby-plan budget. With editions running in
// parallel below, total wall-time is ~max(OpenAI, Claude) ≈ 30-45s, well under 60.
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
// Vercel runs in UTC. We want the brief's date to be "today in India" because
// the cron fires at 6:45 AM IST and users read it as their morning paper.

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
}

interface MarketIndex {
  name: string;
  change: string;
}

interface RawStories {
  world: Story[];
  india: Story[];
  bengaluru: Story[];
  delhi: Story[];
  markets: {
    summary: string;
    indices: MarketIndex[];
  };
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
}

interface Closer {
  headlines_to_remember: string[];  // 5
  things_to_watch: string[];        // 3
  conversation_insight: string;     // 1
}

interface BriefContent {
  edition: Edition;
  date: string;
  world: WrittenStory[];
  india: WrittenStory[];
  bengaluru: WrittenStory[];
  delhi: WrittenStory[];
  markets: { summary: string; indices: MarketIndex[] };
  business: WrittenStory[];
  technology: WrittenStory[];
  climate_health: WrittenStory[];
  sport: WrittenStory;
  culture: WrittenStory;
  closer?: Closer;
}

// ─── Zod schemas ────────────────────────────────────────────────────────────
// These guard against malformed AI output. A brief that fails this schema is
// not allowed to overwrite today's row — we fall back to yesterday's brief.

const StorySchema = z.object({
  headline: z.string().min(5).max(200),
  body: z.string().min(20),
  source: z.string().min(1),
  source_url: z.union([
    z.string().startsWith('https://'),
    z.literal(''),
  ]),
});

const MarketIndexSchema = z.object({
  name: z.string().min(1),
  change: z.string().min(1),
});

// Closer sections (only on 10min and deep editions; 5min stays skimmable)
const CloserSchema = z.object({
  headlines_to_remember: z.array(z.string().min(5)).length(5),
  things_to_watch: z.array(z.string().min(5)).length(3),
  conversation_insight: z.string().min(20),
});

const BriefContentSchema = z.object({
  edition: z.enum(['5min', '10min', 'deep']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  world: z.array(StorySchema).min(1),
  india: z.array(StorySchema).min(1),
  bengaluru: z.array(StorySchema),         // may be empty
  delhi: z.array(StorySchema),             // may be empty
  business: z.array(StorySchema).min(1),
  technology: z.array(StorySchema).min(1),
  climate_health: z.array(StorySchema),    // may be empty
  markets: z.object({
    summary: z.string().min(10),
    indices: z.array(MarketIndexSchema).length(4),
  }),
  sport: StorySchema,
  culture: StorySchema,
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
  closerRules: string;       // empty string = no closer for this edition
  readingTime: string;
}

const EDITION_CONFIG: Record<Edition, EditionConfig> = {
  '5min': {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 8000,
    readingTime: '5 minutes',
    selectionRules: `
SELECTION (this is the skimmable edition — be ruthless):
- world: keep TOP 3 most consequential stories only. Drop the rest.
- india: keep TOP 2 most consequential stories only.
- bengaluru: keep TOP 1 if any exist, else empty array.
- delhi: keep TOP 1 if any exist, else empty array.
- business: keep TOP 2.
- technology: keep TOP 1.
- climate_health: keep TOP 1.
- sport: keep as single story (it's already one).
- culture: keep as single story (it's already one).
- markets: keep all 4 indices, summary becomes 1 punchy sentence.
Total target: ~10 stories. A reader skimming on their commute should finish in 5 minutes.`,
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

// ─── Step 2: Fetch news via OpenAI ──────────────────────────────────────────

async function fetchNewsFromOpenAI(): Promise<RawStories> {
  const today = getISTDate();

  const prompt = `You are a news editor for an India-based daily brief. Search the web for today's (${today}) most consequential stories across the categories below. Return ONLY a JSON object — no markdown, no backticks, no commentary.

For EVERY story, you MUST include:
- "headline": clear, factual headline (max 120 chars)
- "body": 2-3 sentence factual summary
- "source": publication name only (e.g. "Reuters", "The Hindu")
- "source_url": full direct URL to the actual article (must start with https://, real working link to the specific story)
- "published_at": ISO date or datetime if available, otherwise today's date (${today})

Rules:
- You MUST use the web_search_preview tool to find each story. Do not write any story from memory. If web search does not return a real article for a category, omit that story.
- Use only real stories from the last 24-36 hours. Prefer original publishers (Reuters, AP, Bloomberg, The Hindu, Indian Express, BBC, FT) over aggregators.
- Try to use distinct URLs for distinct stories where possible.
- Be factual and neutral. No opinion.
- For Bengaluru and Delhi, only include stories if there is genuine material news. Returning fewer stories than the target is OK.
- Keep each body to 2-3 sentences. Do not exceed.
- IMPORTANT: Order stories within each array by consequence — most important first. The downstream 5-minute edition will only keep the top 1-3 per section, so the most important story must be at index 0.

Return this exact structure:
{
  "world": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 5 stories: wars, diplomacy, elections, global economy, major incidents
  ],
  "india": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 5 stories: politics, policy, regulation, courts, governance
  ],
  "bengaluru": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 0-3 stories
  ],
  "delhi": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 0-2 stories
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
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 3 stories
  ],
  "technology": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 2 stories
  ],
  "climate_health": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "https://...", "published_at": "..." }
    // 1-2 stories
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
  "world": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
  ],
  "india": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
  ],
  "bengaluru": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
  ],
  "delhi": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
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
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
  ],
  "technology": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
  ],
  "climate_health": [
    { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
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
- Carry source and source_url through unchanged from the raw data.
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
      messages: [
        { role: 'user', content: prompt }
      ],
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
  const errors = result.error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  console.error(`Validation failed for ${edition}: ${errors}`);
  return { ok: false, errors };
}

// ─── Fallback fetch ─────────────────────────────────────────────────────────
// Try yesterday first, then the day before. Returns null if nothing usable.

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

// ─── Step 4: Save to Supabase ────────────────────────────────────────────────

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

// ─── Step 6: Send OneSignal push notification ────────────────────────────────

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
// Runs the full save path for one edition. If rawStories is null (OpenAI
// failed earlier), goes straight to yesterday's brief instead of calling Claude.

type EditionOutcome = {
  status: 'ready' | 'fallback' | 'failed';
  reason?: string;
  content?: BriefContent;
};

async function processEdition(
  ed: Edition,
  rawStories: RawStories | null
): Promise<EditionOutcome> {
  // No fresh stories → straight to fallback.
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
    // Step 1: fetch news. If OpenAI throws, we still serve yesterday's briefs
    // instead of returning a 500 with nothing saved.
    let rawStories: RawStories | null = null;
    try {
      console.log('Fetching news from OpenAI...');
      rawStories = await fetchNewsFromOpenAI();
      console.log('News fetched.');
    } catch (err: any) {
      console.error('OpenAI fetch failed:', err.message);
    }

    // Step 2: process all editions IN PARALLEL.
    // Sequential was ~70-135s and tripped Vercel's 60s maxDuration on Hobby.
    // Parallel total ≈ max(any single edition) ≈ 30-45s, comfortably under.
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

    // Step 3: push only if at least one edition is fresh-ready.
    const anyFresh = Object.values(results).some((r) => r.status === 'ready');

    if (!skipPush && anyFresh) {
      const topHeadline =
        writtenBriefs['5min']?.world?.[0]?.headline ??
        writtenBriefs['10min']?.world?.[0]?.headline ??
        "Today's stories are waiting for you.";
      try {
        await sendPushNotification(topHeadline);
      } catch (err: any) {
        // A OneSignal hiccup shouldn't take down the whole job — briefs are already saved.
        console.error('Push failed (briefs already saved):', err.message);
      }
    } else if (!skipPush && !anyFresh) {
      console.log('Push skipped — no fresh briefs today (all fallbacks or failed)');
    } else {
      console.log('Push skipped (skipPush: true)');
    }

    return res.status(200).json({ success: true, editions, results });
  } catch (error: any) {
    console.error('Top-level error:', error.message);
    return res.status(500).json({ success: false, error: error.message, results });
  }
}
