import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

// ─── Clients ────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

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
}

// ─── Edition configuration ──────────────────────────────────────────────────
// Each edition has its own model, selection rules, and depth guidance.
// JSON output shape is identical across editions — only content differs.

interface EditionConfig {
  model: string;
  maxTokens: number;
  selectionRules: string;
  depthRules: string;
  marketsRules: string;
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
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  const today = new Date().toISOString().split('T')[0];

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

Here are today's raw stories. Rewrite the selected stories in the Morning Brief voice following the rules above. Return ONLY a JSON object — no markdown, no backticks, no extra text.

Raw stories:
${JSON.stringify(rawStories, null, 2)}

Return this exact JSON structure:

{
  "edition": "${edition}",
  "date": "${new Date().toISOString().split('T')[0]}",
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
  "culture": { "headline": "...", "body": "...", "source": "...", "source_url": "..." }
}

CRITICAL:
- Follow the SELECTION rules for this edition — for 5min, drop stories; for 10min and deep, include every raw story.
- Carry source and source_url through unchanged from the raw data.
- Keep markets indices values exactly as in raw data.
- Only rewrite headline, body, and markets summary.`;

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

// ─── Step 4: Save to Supabase ────────────────────────────────────────────────

async function saveBriefToSupabase(
  edition: Edition,
  rawStories: RawStories,
  content: BriefContent
) {
  const today = new Date().toISOString().split('T')[0];

  const { error } = await supabase
    .from('briefs')
    .upsert(
      {
        date: today,
        edition,
        status: 'ready',
        raw_stories: rawStories,
        content,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'date,edition' }
    );

  if (error) throw new Error(`Supabase save failed: ${error.message}`);
  console.log(`Brief saved — ${edition} for ${today}`);
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { edition, skipPush } = req.body || {};
  const editions: Edition[] = edition ? [edition] : ['5min', '10min', 'deep'];

  try {
    console.log('Fetching news from OpenAI...');
    const rawStories = await fetchNewsFromOpenAI();
    console.log('News fetched.');

    const results: Record<string, any> = {};

    for (const ed of editions) {
      console.log(`Writing ${ed}...`);
      const content = await writeBriefWithClaude(rawStories, ed);
      console.log(`${ed} written. Saving...`);
      await saveBriefToSupabase(ed, rawStories, content);
      results[ed] = content;
    }

    if (!skipPush) {
      const topHeadline = results['5min']?.world?.[0]?.headline
        ?? results['10min']?.world?.[0]?.headline
        ?? 'Today\'s stories are waiting for you.';
      await sendPushNotification(topHeadline);
    } else {
      console.log('Push skipped (skipPush: true)');
    }

    return res.status(200).json({ success: true, editions, results });

  } catch (error: any) {
    console.error('Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
