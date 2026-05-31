// src/pages/api/personalise-briefs.tsx
//
// Personalisation layer. Sprint 7b architecture:
//   1. Load today's shared briefs (all editions).
//   2. Load every personalised profile.
//   3. Collect unique cities (profile.city_current). Fetch each city's news
//      ONCE per run via OpenAI, with an in-memory cache so 100 users in Pune
//      share one fetch.
//   4. For each user × edition (in parallel within a user):
//        - Ask Claude Haiku for: a reorder plan, ≤4 personal "For you" notes,
//          and (for 10min/deep) a rewritten closer.conversation_insight
//          framed in second person for this reader.
//        - Apply the plan in code:
//            • reorder each section's stories
//            • append "For you — …" notes into story bodies
//            • splice in a `personal_sections` entry for the reader's city
//              (only if their city had stories today)
//            • swap closer.conversation_insight with the personalised one
//              (only if it passes a light validity check)
//        - Upsert to personalised_briefs.
//
// Uses service-role Supabase key (server cron, RLS-protected tables).
// Each user is in its own try/catch — one bad profile can't break the run.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const EDITIONS = ['5min', '10min', 'deep'] as const;
type Edition = (typeof EDITIONS)[number];

const MAX_NOTES_PER_BRIEF = 4;

// Never reorder/annotate these — they aren't story arrays of the right shape.
const SKIP_KEYS = new Set(['closer', 'markets', 'personal_sections', 'edition', 'date']);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false } }
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function getISTDate(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

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
    mood_preference: p.mood_preference ?? null,
  };
}

function isValidOrder(order: any, len: number): order is number[] {
  if (!Array.isArray(order) || order.length !== len) return false;
  const seen = new Set<number>();
  for (const i of order) {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= len) return false;
    if (seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

function appendNote(story: any, note: string) {
  const clean = String(note).trim();
  if (!clean) return;
  const body = typeof story.body === 'string' ? story.body : '';
  story.body = body ? `${body}\n\nFor you — ${clean}` : `For you — ${clean}`;
}

// Light validity check on the rewritten conversation_insight.
function isValidInsight(s: any): s is string {
  return typeof s === 'string' && s.trim().length >= 50 && s.trim().length <= 600;
}

// ─── Step 1: City news fetch (per-run cache) ────────────────────────────────

interface CityStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
}

async function fetchCityStories(city: string): Promise<CityStory[]> {
  const today = getISTDate();
  const prompt = `You are sourcing local news for ${city}, India. Search the web for the 1-3 most consequential stories from ${city} in the last 24-36 hours.

Look for: civic and municipal news, major events in the city, notable incidents or accidents, local policy changes, transportation, business openings/closures, urban issues, weather alerts.

If nothing genuinely news-worthy from ${city} happened today, return an empty array. Do not pad with national stories.

Return ONLY a JSON object — no markdown, no commentary:
{
  "stories": [
    {
      "headline": "clear factual headline (max 120 chars)",
      "body": "2-3 sentence factual summary",
      "source": "publication name (e.g. The Hindu, Times of India)",
      "source_url": "https://... real direct link",
      "published_at": "${today}"
    }
  ]
}`;

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
      max_output_tokens: 3000,
    }),
  });

  if (!response.ok) {
    console.warn(`City fetch failed for ${city}: HTTP ${response.status}`);
    return [];
  }
  const data = await response.json();
  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) return [];

  // Tolerant JSON extraction
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const stories = Array.isArray(parsed?.stories) ? parsed.stories : [];
    return stories
      .filter((s: any) =>
        s && typeof s.headline === 'string' &&
        typeof s.body === 'string' &&
        typeof s.source === 'string'
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}

async function buildCityCache(uniqueCities: string[]): Promise<Map<string, CityStory[]>> {
  const cache = new Map<string, CityStory[]>();
  if (uniqueCities.length === 0) return cache;

  // Parallel — each city fetch is independent and ~5-10s.
  const results = await Promise.all(
    uniqueCities.map(async (city) => {
      try {
        const stories = await fetchCityStories(city);
        return [city, stories] as const;
      } catch (e: any) {
        console.warn(`City fetch error for ${city}:`, e?.message || e);
        return [city, [] as CityStory[]] as const;
      }
    })
  );
  for (const [city, stories] of results) cache.set(city, stories);
  return cache;
}

// ─── Step 2: Haiku — reorder plan + notes + rewritten insight ──────────────

function buildSystemPrompt(includeInsight: boolean): string {
  return `You personalise a daily news brief for one specific reader.
You receive: the reader's profile, today's brief content as JSON, and (sometimes) today's stories from the reader's city.

Your job:
- For each news section (the keys whose values are arrays of stories), decide the best order to show that section's stories for THIS reader. Use the reader's profession, industry, work_area, interests, and cities. Stories carry optional "industries" and "interests" tag arrays — use them as strong hints when present.
- Across the ENTIRE brief, pick AT MOST ${MAX_NOTES_PER_BRIEF} stories that are especially relevant to this reader and write a single short note (max ~18 words, addressed to "you") explaining why. Most stories get no note.${includeInsight ? `
- The shared brief includes a "closer" object with a "conversation_insight" — a short editorial observation. Rewrite that insight for THIS reader: keep the analytical point intact, but frame it through their world (profession, city, interests). 2 to 4 sentences. Written in the second person ("you", "your"). If the original already lands well and no meaningful personalisation is possible, return the empty string and we'll keep the original.` : ''}

Hard rules:
- Re-order stories WITHIN a section only. Never invent, merge, drop, or rewrite stories.
- Do not touch markets, edition, date, or any non-array field except (when applicable) the conversation_insight rewrite via "personalised_insight".
- Refer to original 0-based positions within each section.

Output ONLY one JSON object — no prose, no markdown fences — in EXACTLY this shape:
{
  "<sectionKey>": { "order": [<original indices, every index exactly once>], "notes": { "<originalIndex>": "<short note>" } }${includeInsight ? `,
  "personalised_insight": "<rewritten insight | empty string>"` : ''}
}
Include one entry per array-valued section. "order" must list every original index of that section exactly once. "notes" may be {}. Across all sections combined, include no more than ${MAX_NOTES_PER_BRIEF} notes.`;
}

async function getPlanFromHaiku(
  profile: any,
  editionContent: any,
  cityStories: CityStory[],
  edition: Edition
): Promise<{ plan: any | null; error?: string }> {
  const includeInsight = edition !== '5min' && !!editionContent?.closer?.conversation_insight;

  const userPrompt =
    `READER PROFILE:\n${JSON.stringify(profileForPrompt(profile), null, 2)}\n\n` +
    `TODAY'S BRIEF (edition: ${edition}):\n${JSON.stringify(editionContent)}\n\n` +
    (cityStories.length
      ? `TODAY'S STORIES FROM YOUR READER'S CITY (${profile.city_current}):\n${JSON.stringify(cityStories, null, 2)}\n\n`
      : '') +
    `Return the personalisation plan now.`;

  let resp: Response;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 3000,
        system: buildSystemPrompt(includeInsight),
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (e: any) {
    return { plan: null, error: `fetch_failed: ${e?.message || e}` };
  }

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { plan: null, error: `anthropic_${resp.status}: ${data?.error?.message || 'unknown'}` };
  }

  const text = Array.isArray(data?.content)
    ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
    : '';

  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return { plan: JSON.parse(cleaned) };
  } catch {
    return { plan: null, error: 'parse_failed' };
  }
}

// ─── Step 3: Apply plan to the brief content ────────────────────────────────

function applyPlan(
  original: any,
  plan: any,
  cityStories: CityStory[],
  cityLabel: string | null
) {
  const content = JSON.parse(JSON.stringify(original));
  let sectionsReordered = 0;
  let notesAdded = 0;
  let insightRewritten = false;
  let citySectionAdded = false;

  if (plan && typeof plan === 'object') {
    for (const key of Object.keys(content)) {
      if (SKIP_KEYS.has(key)) continue;
      const arr = content[key];
      if (!Array.isArray(arr) || arr.length === 0) continue;

      const sectionPlan = plan[key];
      if (!sectionPlan || typeof sectionPlan !== 'object') continue;

      // 1) Notes by ORIGINAL index, capped globally.
      const notes = sectionPlan.notes;
      if (notes && typeof notes === 'object') {
        for (const idxStr of Object.keys(notes)) {
          if (notesAdded >= MAX_NOTES_PER_BRIEF) break;
          const idx = Number(idxStr);
          if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) continue;
          const note = notes[idxStr];
          if (typeof note !== 'string' || !note.trim()) continue;
          appendNote(arr[idx], note);
          notesAdded++;
        }
      }

      // 2) Reorder if plan is a clean permutation.
      if (isValidOrder(sectionPlan.order, arr.length)) {
        content[key] = sectionPlan.order.map((i: number) => arr[i]);
        const changed = sectionPlan.order.some((i: number, pos: number) => i !== pos);
        if (changed) sectionsReordered++;
      }
    }

    // 3) Rewritten insight — only swap if it passes the validity check.
    if (
      content.closer &&
      typeof content.closer === 'object' &&
      isValidInsight(plan.personalised_insight)
    ) {
      content.closer.conversation_insight = plan.personalised_insight.trim();
      insightRewritten = true;
    }
  }

  // 4) Splice in personal_sections (currently: Your City). Only if there are
  //    actual city stories today.
  if (cityStories.length > 0 && cityLabel) {
    content.personal_sections = [
      {
        id: 'your_city',
        label: cityLabel,
        icon: '📍',
        kind: 'list',
        stories: cityStories.map((s) => ({
          headline: s.headline,
          body: s.body,
          source: s.source,
          source_url: s.source_url || '',
        })),
      },
    ];
    citySectionAdded = true;
  }

  return { content, sectionsReordered, notesAdded, insightRewritten, citySectionAdded };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Optional shared-secret guard.
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const authHeader = req.headers['authorization'] || '';
    const provided = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const bearer = provided.replace(/^Bearer\s+/i, '').trim();
    const alt =
      (req.headers['x-cron-secret'] as string) ||
      (req.body && (req.body as any).secret) ||
      (req.query.secret as string);
    if (bearer !== expectedSecret && alt !== expectedSecret) {
      return res.status(401).json({ success: false, error: 'Unauthorised' });
    }
  }

  const body = req.body && typeof req.body === 'object' ? (req.body as any) : {};
  const onlyUserId: string | undefined = body.userId || (req.query.userId as string) || undefined;
  const dryRun: boolean = body.dryRun === true || req.query.dryRun === 'true';

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ success: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY env var' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ success: false, error: 'Missing ANTHROPIC_API_KEY env var' });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ success: false, error: 'Missing OPENAI_API_KEY env var' });
  }

  const date = getISTDate();

  // 1) Load today's shared briefs once.
  const { data: briefRows, error: briefErr } = await supabase
    .from('briefs')
    .select('edition, status, content')
    .eq('date', date);
  if (briefErr) {
    return res.status(500).json({ success: false, error: `Failed to load briefs: ${briefErr.message}` });
  }
  const briefByEdition: Record<string, any> = {};
  for (const row of briefRows || []) briefByEdition[row.edition] = row;

  // 2) Load personalised users.
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

  // 3) Build the unique-cities set. Trim, dedup (case-insensitive label).
  const cityNorm = (s: any) => (typeof s === 'string' ? s.trim() : '');
  const uniqueCities = Array.from(new Set(
    users
      .map((u: any) => cityNorm(u.city_current))
      .filter(Boolean)
  ));
  console.log(`Unique cities to fetch: ${uniqueCities.length} — ${uniqueCities.join(', ')}`);

  // 4) Build the city cache in parallel.
  const cityCache = await buildCityCache(uniqueCities);

  const results: any[] = [];

  // 5) Per user — editions run in parallel within a user.
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

    const usersCity = cityNorm(profile.city_current);
    const cityStories = usersCity ? (cityCache.get(usersCity) || []) : [];

    try {
      await Promise.all(
        EDITIONS.map(async (edition) => {
          const source = briefByEdition[edition];
          if (!source || source.status === 'failed' || !source.content) {
            userResult.editions[edition] = { status: 'skipped', reason: 'no source brief today' };
            return;
          }

          const editionContent = asObject(source.content);
          const { plan, error } = await getPlanFromHaiku(profile, editionContent, cityStories, edition);

          if (error || !plan) {
            userResult.editions[edition] = { status: 'fallback', reason: error || 'no plan' };
            return;
          }

          const applied = applyPlan(editionContent, plan, cityStories, usersCity || null);

          if (dryRun) {
            userResult.editions[edition] = {
              status: 'dry_run',
              sectionsReordered: applied.sectionsReordered,
              notesAdded: applied.notesAdded,
              insightRewritten: applied.insightRewritten,
              citySectionAdded: applied.citySectionAdded,
              cityStoryCount: cityStories.length,
            };
            return;
          }

          const { error: upsertErr } = await supabase
            .from('personalised_briefs')
            .upsert(
              {
                user_id: userId,
                date,
                edition,
                status: 'ready',
                content: applied.content,
                generated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id,date,edition' }
            );

          if (upsertErr) {
            userResult.editions[edition] = { status: 'db_error', reason: upsertErr.message };
            return;
          }

          userResult.editions[edition] = {
            status: 'ready',
            sectionsReordered: applied.sectionsReordered,
            notesAdded: applied.notesAdded,
            insightRewritten: applied.insightRewritten,
            citySectionAdded: applied.citySectionAdded,
            cityStoryCount: cityStories.length,
          };
        })
      );
    } catch (e: any) {
      userResult.error = `unexpected: ${e?.message || e}`;
    }

    results.push(userResult);
  }

  const editionsReady = results.reduce(
    (n, r) => n + Object.values(r.editions || {}).filter((e: any) => e.status === 'ready').length,
    0
  );

  return res.status(200).json({
    success: true,
    date,
    dryRun,
    uniqueCities,
    cityHits: Object.fromEntries(Array.from(cityCache.entries()).map(([c, s]) => [c, s.length])),
    processed: results.length,
    editionsReady,
    results,
  });
}
