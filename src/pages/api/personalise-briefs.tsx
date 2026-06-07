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
import { isWhitelistedSource } from '@/lib/whitelist';
// Sprint 11: per-call cost capture.
import { logOpenAICost, extractUsageFromResponses } from '@/lib/cost-log';

export const config = { maxDuration: 60 };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EDITIONS = ['5min', '10min', 'deep'] as const;
type Edition = (typeof EDITIONS)[number];

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
  'Indian Politics':      { section: 'india',          label: 'India',                icon: '🇮🇳' },
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
}

async function fetchCityStories(city: string): Promise<CityStory[]> {
  const today = getISTDate();
  const prompt = `You are sourcing local news for ${city}, India. Search the web for the 1-3 most consequential stories from ${city} in the last 24-36 hours.

Look for: civic and municipal news, major events in the city, notable incidents, local policy changes, transport, business openings/closures, urban issues, weather.

If nothing genuinely newsworthy happened, return an empty array. Do not pad with national stories.

SOURCE RULES — use ONLY direct article links from these whitelisted Tier-1 publishers:
National papers: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Times of India, Deccan Herald, The Wire, NDTV, Moneycontrol, India Today, The Quint, Outlook India.
Regional: Telegraph India (East), Tribune India (North), The News Minute (South), New Indian Express.
Wires: PTI, ANI.
No aggregators, no social media, no Google News redirects.

Return ONLY a JSON object — no markdown, no commentary:
{
  "stories": [
    {
      "headline": "clear factual headline (max 120 chars)",
      "body": "2-3 sentence factual summary",
      "source": "publication name",
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

  // Sprint 11: cost capture.
  const usage = extractUsageFromResponses(data);
  void logOpenAICost({
    phase: 'city',
    model: 'gpt-4o',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail: city,
  });

  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) return [];

  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
    const kept: CityStory[] = [];
    for (const s of raw) {
      if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string' || typeof s.source !== 'string') continue;
      if (!isWhitelistedSource(s.source_url)) {
        console.warn(`City story dropped (source not whitelisted) — ${city}: ${s.source_url}`);
        continue;
      }
      kept.push(s as CityStory);
      if (kept.length >= 3) break;
    }
    return kept;
  } catch {
    return [];
  }
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

async function fetchInterestStories(interest: string): Promise<InterestStory[]> {
  const today = getISTDate();

  // Sprint 11: topic-specific source hints. Some interests benefit from
  // specialist publishers. Law & Policy is the canonical example — without
  // naming Live Law and Bar & Bench explicitly, gpt-4o tends to look only at
  // mainstream papers and miss the actual legal news. This was the root of
  // Sprint 10's "Law & Policy returned 0 hits" issue, alongside the
  // (separate) whitelist drift that also dropped these sources.
  const interestLower = interest.toLowerCase();
  let specialistHint = '';
  if (interestLower.includes('law') || interestLower.includes('policy') || interestLower.includes('legal')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: Live Law (livelaw.in) and Bar & Bench (barandbench.com) are THE primary sources for Indian court rulings, legal news, and law-and-policy developments. Search there FIRST. Also check The Hindu Legal, Indian Express, The Wire, and Caravan for policy analysis. PIB (pib.gov.in) for official government notifications.`;
  } else if (interestLower.includes('parenting') || interestLower.includes('education')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: The Hindu, Indian Express, and Hindustan Times education desks. Scroll and The Wire for analytical takes. Down To Earth for child-health stories.`;
  } else if (interestLower.includes('environment') || interestLower.includes('climate') || interestLower.includes('sustain')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: Down To Earth (downtoearth.org.in), Reuters Climate, Nature, BBC environment desk, plus The Hindu, Mint, and Scroll for India-specific environmental policy and pollution stories.`;
  } else if (interestLower.includes('health') || interestLower.includes('medic') || interestLower.includes('wellness')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: STAT News, Nature, Science.org for research and drug approvals. The Hindu, Indian Express, NDTV health desks for India angles. WHO for outbreak updates.`;
  } else if (interestLower.includes('startup') || interestLower.includes('entrepren')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: TechCrunch, The Verge, Wired for global. Moneycontrol, Mint, Economic Times, Business Standard, Inc42-adjacent reporting from mainstream papers for Indian startups.`;
  } else if (interestLower.includes('film') || interestLower.includes('ott') || interestLower.includes('music') || interestLower.includes('book') || interestLower.includes('art') || interestLower.includes('cultur')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: Variety, Hollywood Reporter for global film/TV. The Hindu, Indian Express, Mint Lounge, Caravan, Outlook India, The Quint, India Today, Scroll for Indian cultural reporting.`;
  } else if (interestLower.includes('sport') || interestLower.includes('cricket') || interestLower.includes('football') || interestLower.includes('formula')) {
    specialistHint = `\nSPECIALIST PRIORITY for this topic: ESPNCricinfo, ESPN.com, plus the sports desks of The Hindu, Times of India, NDTV, Indian Express.`;
  }

  const prompt = `You are sourcing news stories specifically about "${interest}". Search the web for the 1-3 most consequential stories on this topic from the last 24-72 hours. Include both India-focused and global stories where relevant.

If nothing genuinely newsworthy happened in this niche, return an empty array. Do not pad.
${specialistHint}

SOURCE RULES — only direct article links from Tier-1 publishers:
Global: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist, Al Jazeera, ABC News Australia.
India national: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Deccan Herald, The Wire, NDTV, India Today, The Quint, Outlook India, Caravan, Moneycontrol, Financial Express, Business Today, Economic Times, New Indian Express, Telegraph India, Tribune India, The News Minute.
India wires: PTI, ANI.
India legal: Live Law, Bar & Bench.
India environment/health: Down To Earth.
Government primary: PIB, RBI, SEBI, MOSPI.
Specialist (only where general sources don't cover): Nature, Science, STAT, TechCrunch, The Verge, Wired, Variety, Hollywood Reporter, ESPNCricinfo, ESPN.

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "...", "body": "2-3 sentences", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
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
    console.warn(`Interest fetch failed for "${interest}": HTTP ${response.status}`);
    return [];
  }
  const data = await response.json();

  // Sprint 11: cost capture.
  const usage = extractUsageFromResponses(data);
  void logOpenAICost({
    phase: 'interest',
    model: 'gpt-4o',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail: interest,
  });

  const text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text;
  if (!text) return [];

  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
    const kept: InterestStory[] = [];
    for (const s of raw) {
      if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string' || typeof s.source !== 'string') continue;
      if (!isWhitelistedSource(s.source_url)) {
        console.warn(`Interest story dropped (source not whitelisted) — "${interest}": ${s.source_url}`);
        continue;
      }
      kept.push(s as InterestStory);
      if (kept.length >= 3) break;
    }
    return kept;
  } catch {
    return [];
  }
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
  const why = sentences.slice(1).join(' ') || 'Relevant local development for readers in your city.';
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
  // Use the full body as facts; leave other fields populated with derived text.
  return {
    headline: s.headline,
    facts: s.body,
    background: 'A development from your city today.',
    why_it_matters: 'Local news worth knowing as a resident.',
    what_happens_next: 'Watch for follow-up coverage and official updates.',
    analysis: 'Selected for you based on your city preference.',
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
): BuildResult {
  // The Brief (5min) personalised shape — per Sprint 9 spec:
  //  - major_events (universal, reordered) — KEEP ALL
  //  - world (universal, reordered) — KEEP ALL
  //  - india (universal, reordered) — KEEP ALL
  //  - your_city (1 micro story)
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

  console.log(`[personalise:5min] universal=${universalCount}, personal=${TOTAL_CAP - universalCount - personalBudget}, total=${TOTAL_CAP - personalBudget}, cap=${TOTAL_CAP}`);

  const picks: string[] = [];
  if (major[0]?.headline) picks.push(major[0].headline);
  if (world[0]?.headline) picks.push(world[0].headline);
  if (personal[0]?.stories?.[0]?.headline) picks.push(personal[0].stories[0].headline);

  const content = {
    edition: '5min',
    date: shared.date,
    major_events: major,
    world,
    india,
    // topics section deliberately dropped for personalised users — replaced by personal_sections.
    personal_sections: personal,
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
): BuildResult {
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

  const content: any = {
    edition: '10min',
    date: shared.date,
    major_events: major,
    world,
    india,
    personal_sections: personal,
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
  // (A conditional `.map(shape === 'micro' ? cityToMicro : cityToFull)` fails
  // type-check because the two return shapes don't unify.)
  const sliced = fetched.slice(0, storiesPerSection);
  const stories: any[] = shape === 'micro'
    ? sliced.map(cityToMicro)
    : sliced.map(cityToFull);

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

// ─── Save ────────────────────────────────────────────────────────────────────

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
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Optional cron secret
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

  // 3) Collect unique cities + interests across all users
  const allCities = new Set<string>();
  const allInterests = new Set<string>();
  for (const u of users) {
    if (normaliseStr(u.city_current)) allCities.add(normaliseStr(u.city_current));
    if (normaliseStr(u.city_home)) allCities.add(normaliseStr(u.city_home));
    if (Array.isArray(u.interests)) {
      for (const i of u.interests) if (typeof i === 'string' && i.trim()) allInterests.add(i.trim());
    }
  }
  const uniqueCities = Array.from(allCities);
  const uniqueInterests = Array.from(allInterests);
  console.log(`Unique cities to fetch: ${uniqueCities.length} — ${uniqueCities.join(', ')}`);
  console.log(`Unique interests: ${uniqueInterests.length} (${uniqueInterests.filter((i) => !STANDARD_INTEREST_MAP[i]).length} non-standard need fetch)`);

  // 4) Build caches in parallel — cities and non-standard interests.
  // Sprint 11: track which fetches threw (vs returned empty). Errored fetches
  // affect that user's tail_status; empty-but-not-errored is normal.
  const failures: TailFailureSets = {
    cityErrors: new Set<string>(),
    interestErrors: new Set<string>(),
  };
  const [cityCache, interestCache] = await Promise.all([
    buildCityCache(uniqueCities, failures),
    buildInterestCache(uniqueInterests, failures),
  ]);
  if (failures.cityErrors.size > 0) {
    console.warn(`[tail] city fetch errors: ${Array.from(failures.cityErrors).join(', ')}`);
  }
  if (failures.interestErrors.size > 0) {
    console.warn(`[tail] interest fetch errors: ${Array.from(failures.interestErrors).join(', ')}`);
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
            built = buildQuickPersonalised(shared, profile, cityStories, homeStories, interestCache);
          } else if (edition === '10min') {
            built = buildDailyPersonalised(shared, profile, cityStories, homeStories, interestCache);
          } else {
            built = buildEditorialPersonalised(shared, profile);
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
    uniqueCities,
    uniqueInterests,
    cityHits: Object.fromEntries(Array.from(cityCache.entries()).map(([c, s]) => [c, s.length])),
    interestHits: Object.fromEntries(Array.from(interestCache.entries()).map(([i, s]) => [i, s.length])),
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
