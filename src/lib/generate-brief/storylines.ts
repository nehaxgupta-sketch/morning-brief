// src/lib/generate-brief/storylines.ts
//
// Modularization stage 8 (final) - Follow-a-Story logic, moved verbatim: flatten
// the daily brief, tag/detect storylines, insert events, backfill the 'story so
// far', and lifecycle (§27). The modeStorylines entry point stays in the route
// and calls this. Only `export` added to top-level declarations.

import {
  getISTDate,
  extractJsonObject,
  significantWords,
  SEMANTIC_DEDUP_THRESHOLD,
  semanticOverlap,
} from '@/lib/generate-brief/utils';
import {
  OPENAI_API_KEY,
  supabase,
} from '@/lib/generate-brief/env';
import {
  callOpenAIChat,
} from '@/lib/generate-brief/writers';
import {
  isWhitelistedSource,
} from '@/lib/whitelist';
import {
  logOpenAICost,
  extractUsageFromChatCompletion,
} from '@/lib/cost-log';

// ============================================================================
// SECTION 27:  STORYLINES (Follow a Story)
// ----------------------------------------------------------------------------
// mode=storylines: flattens the daily brief, tags/detects storylines, inserts
// storyline events, backfills the 'story so far', and manages active/dormant/
// concluded lifecycle. Runs after write.
// Fns:   storylineTagAndDetect, insertStorylineEvent, fallbackFetchStoryline, regenStorySoFar, modeStorylines
// Flags: STORYLINE_MAX_* / _AFTER_DAYS consts
// ============================================================================
export const STORYLINE_MAX_ACTIVE = 25;
export const STORYLINE_MAX_NEW_PER_DAY = 5;
export const STORYLINE_FALLBACK_CAP = 10;
export const STORYLINE_FALLBACK_CONCURRENCY = 3;
export const STORYLINE_DORMANT_AFTER_DAYS = 7;
export const STORYLINE_CONCLUDE_AFTER_DAYS = 30;

export interface StorylineRow {
  id: string;
  slug: string;
  title: string;
  story_so_far: string | null;
  confidence: string;
  status: string;
  origin: string;
  last_event_at: string | null;
}

export interface FlatStory {
  idx: number;
  section: string;
  headline: string;
  summary: string;
  source: string;
  source_url: string;
}

export function flattenDailyContent(content: any): FlatStory[] {
  const sections = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  const out: FlatStory[] = [];
  for (const sec of sections) {
    for (const s of (content?.[sec] || [])) {
      if (!s?.headline) continue;
      out.push({
        idx: out.length,
        section: sec,
        headline: String(s.headline),
        summary: String(s.facts || s.what_happened || '').slice(0, 280),
        source: String(s.source || ''),
        source_url: String(s.source_url || ''),
      });
    }
  }
  return out;
}

export function slugifyTitle(t: string): string {
  const s = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || `storyline-${Date.now()}`;
}

// Generic search-model call returning parsed JSON. Mirrors callTailFetch's
// gpt-4o-mini-search-preview path but with a free-form JSON contract.
export async function callSearchModelJson(prompt: string, label: string): Promise<any | null> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-search-preview',
        web_search_options: {},
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      }),
    });
    const data = await response.json();
    if (response.status !== 200) {
      console.warn(`[storyline:${label}] search model returned ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return null;
    }
    const usage = extractUsageFromChatCompletion(data);
    void logOpenAICost({
      phase: 'storyline',
      model: 'gpt-4o-mini-search-preview',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      detail: label,
    });
    const text = data?.choices?.[0]?.message?.content || '';
    return text ? extractJsonObject(text) : null;
  } catch (err: any) {
    console.warn(`[storyline:${label}] network/api error: ${err?.message || err}`);
    return null;
  }
}

// One gpt-4o-mini call: match today's stories to storylines + detect new ones.
export async function storylineTagAndDetect(
  stories: FlatStory[],
  existing: StorylineRow[],
  today: string,
): Promise<{ matches: any[]; proposals: any[] }> {
  const storyList = stories
    .map((s) => `${s.idx}. [${s.section}] ${s.headline} — ${s.summary.slice(0, 140)}`)
    .join('\n');
  const lineList = existing.length
    ? existing.map((l) => `- id:${l.id} | ${l.title} | status:${l.status} | so-far: ${(l.story_so_far || '').slice(0, 120)}`).join('\n')
    : '(none yet)';

  const prompt = `You maintain "storylines" for Morning Brief — named, ongoing news narratives (e.g. "US–Iran nuclear standoff", "RBI rate-cut cycle") that accumulate updates over days or weeks. Today is ${today}.

TODAY'S STORIES:
${storyList}

EXISTING STORYLINES (active + dormant):
${lineList}

TASK 1 — MATCH: for each story that is a development WITHIN an existing storyline, record the match. A match means the story advances that named narrative — same conflict, same policy arc, same case, same recurring entities. Be strict; never force a match.

TASK 2 — DETECT: among stories that match nothing, decide if any deserve a NEW storyline. Qualifying test (ALL must hold):
- Multi-day arc: clearly a chapter in a continuing situation, not a self-contained event
- Expected future developments: a reader would plausibly ask "what happened next?" in the coming days or weeks
- Recurring named entities: specific actors/institutions that will keep appearing in coverage
One-off events (accidents, match results, product launches, weather) do NOT qualify even if big. An election RESULT is an event; an election SEASON is a storyline. Propose at most ${STORYLINE_MAX_NEW_PER_DAY}. Set confidence "high" ONLY when the narrative is unmistakably ongoing and broadly followed; otherwise "normal".

Return ONLY this JSON, no markdown:
{
  "matches": [ { "story_idx": <int>, "storyline_id": "<id from list above>" } ],
  "proposals": [ { "story_idx": <int>, "title": "<crisp 3-7 word storyline title>", "confidence": "high" | "normal", "rationale": "<one line>" } ]
}`;

  const parsed = await callOpenAIChat('gpt-4o-mini', prompt, 1500, 'storyline-tag', 'storyline');
  return {
    matches: Array.isArray(parsed?.matches) ? parsed.matches : [],
    proposals: Array.isArray(parsed?.proposals) ? parsed.proposals : [],
  };
}

// Insert one event with two-layer dedup. Touches last_event_at (forward-only,
// so historical backfill events never drag it backwards) and revives dormant
// storylines on a hit.
export async function insertStorylineEvent(
  line: { id: string },
  ev: { date: string; headline: string; summary: string; source: string; source_url: string; origin: string },
): Promise<'inserted' | 'duplicate' | 'error'> {
  // Layer 1 — exact URL already attached to this storyline.
  if (ev.source_url) {
    const { data: urlHit } = await supabase
      .from('storyline_events')
      .select('id')
      .eq('storyline_id', line.id)
      .eq('source_url', ev.source_url)
      .limit(1);
    if (urlHit && urlHit.length > 0) return 'duplicate';
  }
  // Layer 2 — semantic: same development worded differently. For tag/fallback
  // events: compare vs the last 3 days. For BACKFILL milestones: compare vs
  // ALL events of the storyline — historical milestones are dated in the past
  // and slipped through the 3-day window (2026-06-12: the NEET storyline got
  // the same "computer-based from 2027" milestone twice, via BS and TOI).
  let recentQuery = supabase
    .from('storyline_events')
    .select('headline')
    .eq('storyline_id', line.id);
  if (ev.origin !== 'backfill') {
    recentQuery = recentQuery.gte('date', getISTDate(-3));
  }
  const { data: recent } = await recentQuery;
  const evWords = significantWords(ev.headline);
  for (const r of recent || []) {
    if (semanticOverlap(evWords, significantWords(String(r.headline || ''))) >= SEMANTIC_DEDUP_THRESHOLD) {
      return 'duplicate';
    }
  }

  const { error } = await supabase.from('storyline_events').insert({
    storyline_id: line.id,
    date: ev.date,
    headline: ev.headline.slice(0, 300),
    summary: ev.summary ? ev.summary.slice(0, 800) : null,
    source: ev.source || null,
    source_url: ev.source_url || null,
    origin: ev.origin,
  });
  if (error) {
    // The DB partial unique index is the final backstop — a violation here is
    // a duplicate, not a failure.
    if (String(error.message || '').toLowerCase().includes('duplicate')) return 'duplicate';
    console.warn(`[storyline] event insert failed: ${error.message}`);
    return 'error';
  }

  // Forward-only touch + revival. The .or filter ensures a backfill event
  // dated in the past never moves last_event_at backwards.
  await supabase
    .from('storylines')
    .update({ last_event_at: ev.date, status: 'active', updated_at: new Date().toISOString() })
    .eq('id', line.id)
    .neq('status', 'concluded')
    .or(`last_event_at.is.null,last_event_at.lte.${ev.date}`);
  return 'inserted';
}

export function buildBackfillPrompt(title: string, seed: FlatStory, today: string): string {
  return `You are building the "how we got here" context for a news storyline titled "${title}". The latest development: "${seed.headline} — ${seed.summary}". Today is ${today}.

Search the web for the KEY PRIOR MILESTONES of this storyline (the 2-4 moments a new reader needs to understand the arc), and write a neutral 3-4 sentence "story so far" in a calm, analytical register (Economist/FT), ending with why it matters for Indian readers where relevant.

WRITING RULES for story_so_far: plain prose only — NO markdown links, NO URLs, NO citation brackets, NO "([domain](url))" references. Sources belong in the milestones array, never in the prose.

SOURCE RULES: milestone source_urls must be direct article URLs from major reputable outlets (Reuters, AP, Bloomberg, FT, BBC, The Guardian, Al Jazeera, The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, NDTV, Times of India).

Return ONLY this JSON, no markdown:
{
  "story_so_far": "<3-4 sentences>",
  "milestones": [ { "date": "YYYY-MM-DD", "headline": "...", "summary": "1-2 sentences", "source": "Publisher", "source_url": "https://..." } ]
}`;
}

// Dedicated fetch for a followed storyline that got no tagged hit today.
export async function fallbackFetchStoryline(line: StorylineRow, today: string): Promise<number> {
  const since = line.last_event_at || getISTDate(-7);
  const prompt = `Search for the LATEST genuine development (published after ${since}, ideally in the last 24-48 hours) in this ongoing news storyline: "${line.title}".
Story so far: ${(line.story_so_far || '').slice(0, 400)}

Only report a REAL new development — a concrete event, decision, statement, or data point that moves the story forward. If nothing new has happened since ${since}, return {"stories": []} — an empty result is a correct result.

SOURCE WHITELIST — direct article URLs only from: Reuters, AP, Bloomberg, FT, WSJ, NYT, BBC, The Guardian, Al Jazeera, The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, NDTV, Times of India, The Print, PTI, ANI.

Return ONLY this JSON, no markdown:
{ "stories": [ { "headline": "...", "body": "2-3 factual sentences", "source": "Publisher", "source_url": "https://...", "published_at": "YYYY-MM-DD" } ] }`;

  const parsed = await callSearchModelJson(prompt, `fallback:${line.slug}`);
  const s = parsed?.stories?.[0];
  if (!s || typeof s.headline !== 'string' || !isWhitelistedSource(s.source_url)) return 0;
  const r = await insertStorylineEvent(line, {
    date: today,
    headline: s.headline,
    summary: typeof s.body === 'string' ? s.body : '',
    source: typeof s.source === 'string' ? s.source : '',
    source_url: s.source_url,
    origin: 'fallback',
  });
  return r === 'inserted' ? 1 : 0;
}

// Regenerate the living "story so far" from the event timeline. Pure
// synthesis on gpt-4o-mini — no web fetching, per the locked design.
export async function regenStorySoFar(line: StorylineRow): Promise<boolean> {
  const { data: events } = await supabase
    .from('storyline_events')
    .select('date, headline, summary')
    .eq('storyline_id', line.id)
    .order('date', { ascending: true })
    .limit(20);
  if (!events || events.length === 0) return false;

  const timeline = events
    .map((e: any) => `${e.date}: ${e.headline}${e.summary ? ' — ' + String(e.summary).slice(0, 160) : ''}`)
    .join('\n');

  const prompt = `Rewrite the "story so far" for the ongoing news storyline "${line.title}" using its event timeline below. 4-5 sentences, calm analytical register (Economist/FT). Open with the essential framing, carry the arc through to the MOST RECENT development, and close with what to watch next or why it matters for Indian readers. No bullet lists, no headers. Plain prose only — NO markdown links, NO URLs, NO citation brackets.

TIMELINE (oldest → newest):
${timeline}

Return ONLY this JSON, no markdown: { "story_so_far": "<4-5 sentences>" }`;

  const parsed = await callOpenAIChat('gpt-4o-mini', prompt, 700, `storyline-sofar:${line.slug}`, 'storyline');
  if (typeof parsed?.story_so_far !== 'string' || parsed.story_so_far.length < 40) return false;
  await supabase
    .from('storylines')
    .update({ story_so_far: parsed.story_so_far.slice(0, 1500), updated_at: new Date().toISOString() })
    .eq('id', line.id);
  return true;
}

