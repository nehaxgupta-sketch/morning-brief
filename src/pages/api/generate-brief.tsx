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
}

interface MarketIndex {
  name: string;
  change: string;
}

interface RawStories {
  world: Story[];
  india: Story[];
  markets: {
    summary: string;
    indices: MarketIndex[];
  };
  sport: Story;
  culture: Story;
}

interface BriefContent {
  edition: Edition;
  date: string;
  world: { headline: string; body: string; source: string }[];
  india: { headline: string; body: string; source: string }[];
  markets: { summary: string; indices: MarketIndex[] };
  sport: { headline: string; body: string; source: string };
  culture: { headline: string; body: string; source: string };
}

// Profile shape we need for personalisation
interface PersonalisedUser {
  id: string;
  full_name: string | null;
  city_current: string | null;
  city_home: string | null;
  profession: string | null;
  industry: string | null;
  interests: string[] | null;
  mood_preference: string | null;
  edition_preference: string | null;
}

// ─── Step 2: Fetch news via OpenAI ──────────────────────────────────────────

async function fetchNewsFromOpenAI(): Promise<RawStories> {
  const prompt = `You are a news editor. Search the web and summarise today's top stories across these categories. Return ONLY a JSON object, no markdown, no backticks, no extra text.

Return this exact structure:
{
  "world": [
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" }
  ],
  "india": [
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
    { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" }
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
  "sport": { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" },
  "culture": { "headline": "...", "body": "2-3 sentence summary", "source": "publication name" }
}

Use only real news from today. Be factual and neutral.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: prompt,
    }),
  });

  const data = await response.json();
  console.log('OpenAI raw response:', JSON.stringify(data));
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) throw new Error(`No response from OpenAI. Raw: ${JSON.stringify(data)}`);

  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ─── Step 3: Write brief with Claude ────────────────────────────────────────

async function writeBriefWithClaude(rawStories: RawStories, edition: Edition): Promise<BriefContent> {

  const depthGuide = {
    '5min': `Write each story in 2 short sentences — punchy, warm, essential facts only. Markets in 1 sentence. Total reading time: 5 minutes.`,
    '10min': `Write each story in 3–4 sentences — include one piece of context or background. Markets in 2 sentences with brief explanation of what's driving moves. Total reading time: 10 minutes.`,
    'deep': `Write each story in 5–6 sentences — include context, history, why it matters, and what to watch next. Markets in 3–4 sentences with analysis. Total reading time: 15–20 minutes.`,
  };

  const prompt = `You are the voice of Morning Brief — a daily news digest for thoughtful, curious Indian readers. Your tone is warm, intelligent, and conversational — like a well-read friend briefing you over coffee. Never sensational, never dry. Write in plain English. Use active voice. Avoid jargon.

Edition: ${edition.toUpperCase()}
${depthGuide[edition]}

Here are today's raw stories. Rewrite them in the Morning Brief voice. Return ONLY a JSON object — no markdown, no backticks, no extra text.

Raw stories:
${JSON.stringify(rawStories, null, 2)}

Return this exact JSON structure:
{
  "edition": "${edition}",
  "date": "${new Date().toISOString().split('T')[0]}",
  "world": [
    { "headline": "rewritten headline", "body": "rewritten body in Morning Brief voice", "source": "source name" },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." }
  ],
  "india": [
    { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." }
  ],
  "markets": {
    "summary": "rewritten markets summary in Morning Brief voice",
    "indices": [
      { "name": "Sensex", "change": "+0.4%" },
      { "name": "Nifty", "change": "-0.1%" },
      { "name": "S&P 500", "change": "+0.6%" },
      { "name": "Nasdaq", "change": "+1.1%" }
    ]
  },
  "sport": { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" },
  "culture": { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" }
}

Keep all source names exactly as they appear in the raw data. Only rewrite headlines and body text.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: prompt }
      ],
    }),
  });

  const data = await response.json();
  console.log('Claude raw response:', JSON.stringify(data).slice(0, 500));

  const text = data.content?.[0]?.text;
  if (!text) throw new Error(`No response from Claude. Raw: ${JSON.stringify(data)}`);

  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
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
  console.log(`Brief saved to Supabase — ${edition} edition for ${today}`);
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
      // Send to all subscribed users
      included_segments: ['All'],
      // Notification content
      headings: { en: '☕ Your Morning Brief is ready' },
      contents: { en: topHeadline },
      // Deep link into the brief page on tap
      url: 'https://morning-brief-liart.vercel.app/brief',
      // Small icon for Android
      small_icon: 'ic_stat_onesignal_default',
      // Delivery timing — send immediately when this function is called
      // (cron-job.org handles the 6:45 AM IST schedule)
    }),
  });

  const data = await response.json();

  if (data.errors) {
    throw new Error(`OneSignal error: ${JSON.stringify(data.errors)}`);
  }

  console.log(`Push notification sent. Recipients: ${data.recipients ?? 'unknown'}, ID: ${data.id}`);
  return data;
}

// ─── Step 7: Personalised briefs ─────────────────────────────────────────────
//
// After the shared standard brief is built, we write a custom version for each
// user who chose "personalised" during onboarding. Each one is a separate Claude
// call that re-writes the SAME raw news through the lens of that person's city,
// profession, interests and preferred tone. Results go in the personalised_briefs
// table, which the frontend reads first (falling back to the standard brief).
//
// NOTE: this makes one Claude API call PER personalised user, at their preferred
// edition only. Cost and time both scale with the number of personalised users.

async function getPersonalisedUsers(): Promise<PersonalisedUser[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, city_current, city_home, profession, industry, interests, mood_preference, edition_preference')
    .eq('brief_type', 'personalised')
    .eq('onboarding_complete', true);

  if (error) throw new Error(`Failed to fetch personalised users: ${error.message}`);
  return (data as PersonalisedUser[]) ?? [];
}

async function writePersonalisedBrief(
  rawStories: RawStories,
  edition: Edition,
  user: PersonalisedUser
): Promise<BriefContent> {

  const depthGuide = {
    '5min': `Write each story in 2 short sentences — punchy, warm, essential facts only. Markets in 1 sentence.`,
    '10min': `Write each story in 3–4 sentences — include one piece of context or background. Markets in 2 sentences.`,
    'deep': `Write each story in 5–6 sentences — context, history, why it matters, what to watch next. Markets in 3–4 sentences with analysis.`,
  };

  const interestsList = Array.isArray(user.interests) && user.interests.length
    ? user.interests.join(', ')
    : 'general news';
  const firstName = user.full_name?.split(' ')[0] || 'there';
  const cityLine = user.city_current || user.city_home || 'India';

  const prompt = `You are the voice of Morning Brief — a daily news digest for thoughtful, curious Indian readers. Your tone is warm, intelligent, and conversational — like a well-read friend briefing you over coffee. Never sensational, never dry. Plain English, active voice, no jargon.

You are writing a PERSONALISED edition for one specific reader:
- Name: ${user.full_name || 'the reader'} (you may greet them as "${firstName}" once, naturally, in the very first world story only)
- City: ${cityLine}
- Profession: ${user.profession || 'not specified'}
- Industry: ${user.industry || 'not specified'}
- Interests: ${interestsList}
- Preferred tone lens: ${user.mood_preference || 'Neutral'}

How to personalise (keep it subtle and natural — never robotic):
- When a story connects to ${user.industry || 'their field'} or their interests (${interestsList}), add one short sentence drawing out why it matters to them.
- If a story touches ${cityLine} specifically, note the local angle.
- Apply the tone lens: Hopeful = emphasise progress and opportunity; Critical = surface tensions and who benefits; Neutral = balanced and factual; Calm = steady, reassuring, no alarmism; Curious = lead with the most surprising angle.

Edition: ${edition.toUpperCase()}
${depthGuide[edition]}

Here are today's raw stories. Rewrite them in the Morning Brief voice, personalised as above. Return ONLY a JSON object — no markdown, no backticks, no extra text.

Raw stories:
${JSON.stringify(rawStories, null, 2)}

Return this exact JSON structure:
{
  "edition": "${edition}",
  "date": "${new Date().toISOString().split('T')[0]}",
  "world": [
    { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." }
  ],
  "india": [
    { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" },
    { "headline": "...", "body": "...", "source": "..." },
    { "headline": "...", "body": "...", "source": "..." }
  ],
  "markets": {
    "summary": "rewritten markets summary",
    "indices": [
      { "name": "Sensex", "change": "+0.4%" },
      { "name": "Nifty", "change": "-0.1%" },
      { "name": "S&P 500", "change": "+0.6%" },
      { "name": "Nasdaq", "change": "+1.1%" }
    ]
  },
  "sport": { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" },
  "culture": { "headline": "rewritten headline", "body": "rewritten body", "source": "source name" }
}

Keep all source names exactly as they appear in the raw data. Keep the market index names and change values exactly as given. Only rewrite headlines, body text, and the markets summary.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error(`No response from Claude (personalised). Raw: ${JSON.stringify(data)}`);

  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function savePersonalisedBrief(userId: string, edition: Edition, content: BriefContent) {
  const today = new Date().toISOString().split('T')[0];
  const { error } = await supabase
    .from('personalised_briefs')
    .upsert(
      {
        user_id: userId,
        date: today,
        edition,
        status: 'ready',
        content,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,date,edition' }
    );
  if (error) throw new Error(`Personalised save failed for ${userId}: ${error.message}`);
}

async function generatePersonalisedBriefs(rawStories: RawStories) {
  const users = await getPersonalisedUsers();
  console.log(`Personalised users found: ${users.length}`);
  if (users.length === 0) return { attempted: 0, succeeded: 0, errors: [] as string[] };

  let succeeded = 0;
  const errors: string[] = [];

  for (const user of users) {
    const pref = (user.edition_preference || '5min') as string;
    const edition: Edition = (['5min', '10min', 'deep'].includes(pref) ? pref : '5min') as Edition;
    try {
      const content = await writePersonalisedBrief(rawStories, edition, user);
      await savePersonalisedBrief(user.id, edition, content);
      succeeded++;
      console.log(`Personalised brief saved for user ${user.id} (${edition})`);
    } catch (err: any) {
      // One user's failure must never break the rest of the pipeline
      const msg = `User ${user.id}: ${err.message}`;
      errors.push(msg);
      console.error('Personalised brief failed —', msg);
    }
  }

  return { attempted: users.length, succeeded, errors };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { edition, skipPush, skipPersonalised } = req.body || {};
  const editions: Edition[] = edition ? [edition] : ['5min', '10min', 'deep'];

  try {
    // Step 2: Fetch news once — reuse for all editions
    console.log('Fetching news from OpenAI...');
    const rawStories = await fetchNewsFromOpenAI();
    console.log('News fetched successfully');

    const results: Record<string, any> = {};

    for (const ed of editions) {
      console.log(`Writing ${ed} brief with Claude...`);
      const content = await writeBriefWithClaude(rawStories, ed);
      console.log(`${ed} brief written`);

      console.log(`Saving ${ed} brief to Supabase...`);
      await saveBriefToSupabase(ed, rawStories, content);

      results[ed] = content;
    }

    // Step 6: Send push notification once all briefs are saved
    if (!skipPush) {
      console.log('Sending push notification...');
      const topHeadline = results['5min']?.world?.[0]?.headline
        ?? results['10min']?.world?.[0]?.headline
        ?? 'Today\'s stories are waiting for you.';
      await sendPushNotification(topHeadline);
      console.log('Push notification sent');
    } else {
      console.log('Push notification skipped (skipPush: true)');
    }

    // Step 7: Generate personalised briefs (after standard + push)
    // Wrapped so it can never break the core pipeline.
    let personalised = { attempted: 0, succeeded: 0, errors: [] as string[] };
    if (!skipPersonalised) {
      try {
        console.log('Generating personalised briefs...');
        personalised = await generatePersonalisedBriefs(rawStories);
        console.log('Personalised briefs done:', JSON.stringify(personalised));
      } catch (err: any) {
        console.error('Personalised generation failed entirely:', err.message);
        personalised.errors.push(err.message);
      }
    } else {
      console.log('Personalised briefs skipped (skipPersonalised: true)');
    }

    return res.status(200).json({
      success: true,
      editions,
      personalised,
      results,
    });

  } catch (error: any) {
    console.error('Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
