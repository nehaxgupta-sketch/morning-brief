// src/lib/generate-brief/writers.ts
//
// Modularization stage 6 - the edition writers + content assembly, moved verbatim:
// writeQuickEdition/writeDailyEdition/writeEditorialEdition (§16), chat transport +
// raw->story + backfill (§17), coherence/validate/repair (§18), and the final-brief
// invariant checker (§19). Only `export` added to top-level declarations.

import {
  getISTDate,
  isWeekend,
  sleep,
  extractJsonObject,
  normaliseUrlForCompare,
  significantWords,
  eventSignature,
  isSameEventPrefix,
} from '@/lib/generate-brief/utils';
import type {
  Edition,
  RawStories,
  FullStory,
  BriefQuick,
  BriefDaily,
  BriefEditorial,
  BriefContent,
} from '@/lib/generate-brief/types';
import {
  BriefQuickSchema,
  BriefDailySchema,
  BriefEditorialSchema,
  LensSchema,
} from '@/lib/generate-brief/types';
import {
  OPENAI_API_KEY,
  supabase,
} from '@/lib/generate-brief/env';
import {
  rawStoriesForWriter,
} from '@/lib/generate-brief/quality';
import {
  isWhitelistedSource,
} from '@/lib/whitelist';
import {
  logOpenAICost,
  extractUsageFromChatCompletion,
} from '@/lib/cost-log';

// ============================================================================
// SECTION 16:  EDITION WRITERS (5min / 10min / deep)
// ----------------------------------------------------------------------------
// The three edition writers that turn the subset into brief content:
// writeQuickEdition (5min micro-items), writeDailyEdition (10min full stories),
// writeEditorialEdition (deep synthesis). Plus the dek-restates-headline guard.
// Fns:   writeQuickEdition, writeDailyEdition, writeEditorialEdition, warnOnDekRestatesHeadline
// Flags: -
// ============================================================================
export function dekRestatesHeadline(headline: string, dek: string): boolean {
  const h = significantWords(headline || '');
  const d = significantWords(dek || '');
  if (h.size < 3 || d.size < 3) return false;
  let shared = 0;
  for (const w of Array.from(d)) if (h.has(w)) shared++;
  // ≥80% of the dek's significant words already appear in the headline ⇒ restated.
  return shared / d.size >= 0.8;
}
export function warnOnDekRestatesHeadline(brief: any): void {
  if (!brief || typeof brief !== 'object') return;
  let flagged = 0; const examples: string[] = [];
  for (const sec of ['major_events', 'world', 'india', 'topics']) {
    for (const s of (brief[sec] || [])) {
      if (dekRestatesHeadline(s?.headline, s?.what_happened)) {
        flagged++;
        if (examples.length < 3) examples.push(String(s?.headline || '').slice(0, 60));
      }
    }
  }
  if (flagged > 0) {
    console.warn(`[dek:5min] ${flagged} item(s) where what_happened restates the headline (should add a new fact). e.g. ${examples.join(' | ')}`);
  }
}

export async function writeQuickEdition(raw: RawStories): Promise<BriefQuick> {
  const today = getISTDate();

  // Sprint 23 — dek quality. The 5-min reader sees exactly two lines per item
  // (what_happened, why_it_matters), so a what_happened that paraphrases the
  // headline wastes half the item. Instruct the dek to ADD the single most
  // important NEW fact, and stop forcing a strained India angle onto every
  // why_it_matters. Revertible: DEK_ADD_INFO=off restores the prior wording.
  const DEK_ADD_INFO = (process.env.DEK_ADD_INFO || 'on').toLowerCase() !== 'off';
  const whatHappenedRule = DEK_ADD_INFO
    ? `- what_happened: ONE sentence (≤ 22 words) that ADDS to the headline — it must NOT restate it. Assume the reader has ALREADY read the headline; this line carries the single most important NEW fact the headline omits: a number, a name, a scale, a cause, a consequence, or what changed and when. If your sentence is a paraphrase of the headline, it has failed — rewrite it with new information. BAD — headline "Three Firefighters Killed in Colorado-Utah Border Wildfires" → "Wildfires in Colorado and Utah killed three firefighters." (adds nothing). GOOD → "The fire has burned 40,000 acres and forced 2,000 evacuations; the three died when winds turned." (new facts).`
    : `- what_happened: ONE sentence (≤ 22 words). State the news plainly. Use specific numbers, names, dates where they sharpen the story.`;
  const whyItMattersRule = DEK_ADD_INFO
    ? `- why_it_matters: ONE sentence (≤ 22 words) — REQUIRED, never omit. Where a GENUINE Indian angle exists (inflation, the rupee, food prices, RBI policy, EMIs, household budgets, jobs, urban life, India's strategic position, sector impact on Indian companies/markets), lead with it concretely. Where an India link would be tenuous, do NOT manufacture one — state the real-world significance plainly instead. A forced, vague India tie ("…which India must also consider", "…safety standards India must adhere to") is WORSE than an honest global takeaway.`
    : `- why_it_matters: ONE sentence (≤ 22 words) — REQUIRED, never omit. ANCHOR TO INDIA. Acceptable hooks: inflation, the rupee, food prices, RBI policy, EMIs, household budgets, jobs, urban life, India's strategic position, or sector impact on Indian companies/markets. A purely global takeaway is acceptable ONLY if no Indian angle exists; never drop the field. Example to emulate: "Higher oil prices directly affect India's inflation, rupee, and household budgets."`;

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
${whatHappenedRule}
${whyItMattersRule}

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

  const brief = await callOpenAIChat('gpt-4o', prompt, 6000, 'The Brief (5min)', '5min');
  if (DEK_ADD_INFO) warnOnDekRestatesHeadline(brief);
  return brief;
}

export async function writeDailyEdition(raw: RawStories): Promise<BriefDaily> {
  const today = getISTDate();
  // Sprint 19 — gpt-4o ignores the general "include EVERY story" instruction on
  // large inputs and collapses sections to ~1 story each. Give it an EXPLICIT
  // per-section count it must hit (models follow concrete numeric targets far
  // more reliably than prose). Computed from the raw subset handed to the writer.
  const reqCounts = ['major_events', 'world', 'india', 'business', 'markets_news', 'politics', 'technology', 'climate_health', 'sport', 'culture']
    .map((k) => `${k}=${Array.isArray((raw as any)[k]) ? (raw as any)[k].length : 0}`)
    .join(', ');
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

REQUIRED OUTPUT COUNTS (NON-NEGOTIABLE): ${reqCounts}. Your output array for each section MUST contain EXACTLY that many story objects — one per raw story, in the same order. Writing fewer (e.g. collapsing a 5-story section down to 1) DROPS content the reader paid for and is a FAILURE. Do not summarize, merge, or "pick the best"; rewrite every single raw story into its own object. Before you finish, verify each section array's length equals the count above.

POLITICS & MARKETS_NEWS (Sprint 14.2): raw stories may include "politics" and "markets_news" arrays — dedicated Indian-politics and market/finance article buckets. If present, output them as same-shape FullStory arrays under the "politics" and "markets_news" keys. If absent or empty, output empty arrays. Treat them like any other section: every field required, source_url verbatim, no fabrication.

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
  "markets_news":   [ /* same shape as a story; market/finance ARTICLES (not the indices widget). [] if none in raw */ ],
  "politics":       [ /* same shape as a story; Indian-politics articles. [] if none in raw */ ],
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

  // Sprint 14.5: upgraded gpt-4o-mini → gpt-4o. On 06-14 the mini writer was
  // handed a healthy, well-distributed subset (india 5, tech 2, sport 1,
  // culture 1, climate 1) and collapsed it to 7 stories, zeroing five sections
  // — scoring 37/70 with a -25 empty-section penalty. The 5min and deep
  // editions already run on gpt-4o and scored 52 and 59. gpt-4o follows the
  // "include EVERY story / no empty sections" instruction far more reliably.
  return callOpenAIChat('gpt-4o', prompt, 14000, 'The Daily (10min)', '10min');
}

export async function writeEditorialEdition(raw: RawStories): Promise<BriefEditorial> {
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
     - one_chart: a REAL renderable chart. title is the chart's subject (e.g. "Brent crude, last 30 days"). description is 1-2 sentences on what the chart shows and why it's the right cut today. data_points: 3-6 {label, value} pairs using ONLY numbers that actually appear in today's stories (quarters, years, index levels, prices). If today's stories contain no usable numeric series, OMIT data_points entirely — never invent numbers.
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
    "one_chart": { "title": "...", "description": "...", "data_points": [ { "label": "2024", "value": 36.8 }, { "label": "2025", "value": 37.4 } ] },
    "one_quote": { "quote": "...", "attribution": "...", "context": "..." }  // or null if no real quote available
  }
}

Raw stories:
${JSON.stringify(rawStoriesForWriter(raw))}`;

  return callOpenAIChat('gpt-4o', prompt, 12000, 'The Editorial (deep)', 'deep');
}

// Sprint 20.1 — parse OpenAI's suggested wait from a 429/5xx response so backoff
// matches the server's rolling-window hint. Falls back to a Retry-After header,
// then to a sane default. Returns milliseconds.
// ============================================================================
// SECTION 17:  CHAT TRANSPORT + RAW->STORY TEMPLATES + BACKFILL
// ----------------------------------------------------------------------------
// callOpenAIChat() (429/5xx-aware backoff), the raw-template constants and
// raw->Micro/Full converters, section backfill (backfillToSubsetCounts takes an
// exclude-set so a coherence-dropped story can't return), and template-why
// rewriting. The template constants here are the fingerprints Section 19 guards.
// Fns:   callOpenAIChat, rawToFullStory, rawToMicroStory, backfillToSubsetCounts, rewriteTemplateWhys
// Flags: REWRITE_TEMPLATE_WHYS  |  consts: BACKFILL_WHY_*, RAW_TEMPLATE_*
// ============================================================================
export function retryAfterMsFromBody(body: string, headerSeconds: number): number {
  if (!isNaN(headerSeconds) && headerSeconds > 0) return Math.round(headerSeconds * 1000);
  const ms = body.match(/try again in\s+([\d.]+)\s*ms/i);
  if (ms) return Math.max(0, Math.round(parseFloat(ms[1])));
  const s = body.match(/try again in\s+([\d.]+)\s*s/i);
  if (s) return Math.max(0, Math.round(parseFloat(s[1]) * 1000));
  return 6000;
}

export async function callOpenAIChat(
  model: string,
  prompt: string,
  maxTokens: number,
  label: string,
  costPhase?: '5min' | '10min' | 'deep' | 'score' | 'storyline',
): Promise<any> {
  // Sprint 20.1 — 429/5xx-aware backoff. The 5min/10min/deep writers are fired
  // as separate invocations by the run orchestrator; on the lowest OpenAI tier
  // (gpt-4o 30k TPM) their combined demand rate-limits whichever lands last
  // (usually deep), which previously failed BOTH writer attempts in the same
  // minute and shipped yesterday's brief (status=fallback). Each write has its
  // own ~60s function budget, so we wait out the rolling token window here and
  // recover. Bounded by BUDGET_MS so we never trip the Vercel 60s cap; if the
  // window can't clear in time we throw a tagged RATE_LIMITED error so the
  // caller skips its redundant retry and falls back cleanly.
  const MAX_ATTEMPTS = 5;
  const BUDGET_MS = 30000;
  const started = Date.now();
  let lastDetail = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    } catch (netErr: any) {
      lastDetail = `network: ${netErr?.message || netErr}`;
      const waitMs = Math.min(4000 + attempt * 2000, 10000);
      if (attempt >= MAX_ATTEMPTS || Date.now() - started + waitMs > BUDGET_MS) break;
      console.warn(`${label} ${lastDetail} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${Math.round(waitMs / 1000)}s.`);
      await sleep(waitMs);
      continue;
    }

    // Retryable: rate limit (429) and transient server errors (500/502/503).
    if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503) {
      const headerSeconds = parseFloat(response.headers.get('retry-after') || '');
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* ignore */ }
      lastDetail = `${response.status}: ${bodyText.slice(0, 200)}`;
      const waitMs = Math.min(Math.max(Math.round(retryAfterMsFromBody(bodyText, headerSeconds) * 1.5), 5000), 12000);
      console.warn(`${label} status: ${response.status} model: ${model} — rate-limited/transient (attempt ${attempt}/${MAX_ATTEMPTS}); backing off ${Math.round(waitMs / 1000)}s.`);
      if (attempt >= MAX_ATTEMPTS || Date.now() - started + waitMs > BUDGET_MS) break;
      await sleep(waitMs);
      continue;
    }

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

  // Retries/budget exhausted on a rate-limit/transient error. Tagged so the
  // writer's outer loop skips its redundant immediate retry and falls back.
  throw new Error(`RATE_LIMITED: ${label} could not complete after ${MAX_ATTEMPTS} attempt(s) within ${Math.round(BUDGET_MS / 1000)}s. Last: ${lastDetail}`);
}

// ─── Pre-validation repair ──────────────────────────────────────────────────
//
// gpt-4o-mini occasionally drops the `markets` object on the 10min edition
// when the story payload is large (~20+ stories). The writer is forbidden
// from modifying market indices anyway (must carry from raw verbatim), so
// re-attaching from raw when the writer omits it is safe and zero-risk.
// Without this, the brief fails validation and the whole 10min edition is
// lost, cascading to all personalised 10min editions being skipped.

// ─── Sprint 14.5: deterministic section backfill (safety net for #1) ─────────
// Even on gpt-4o the writer can occasionally drop a whole section. Rather than
// trust the model, we guarantee section presence: if the writer emitted ZERO
// stories for a topical section the subset actually supplied, we backfill that
// section from the raw subset. Backfilled stories are honest but lighter — the
// model upgrade should make this fire rarely; it exists so a section is never
// silently lost. Runs inside repairCommonOmissions (before validation+strip),
// so backfilled stories are schema-checked and whitelist-checked like any
// other (subset stories already passed the fetch-time quality gate).
// Sprint 19 — backfill template sentinels, extracted so the post-write rewrite
// pass (rewriteTemplateWhys) can detect exactly which "why it matters" fields
// were padded and replace them with real, story-specific analysis. Default ON;
// set REWRITE_TEMPLATE_WHYS=false to disable the rewrite (sentinels then ship).
export const BACKFILL_WHY_FULL = 'Relevant context for Indian readers; see the linked report for detail.';
export const BACKFILL_WHY_MICRO = 'Relevant context for Indian readers; see the linked report.';
// Sprint 26 (F7) — the exact static sentences rawToFullStory stamps on a padded
// story. Named here so the final-brief invariant checker can fingerprint a raw
// template that reached the reader, with zero drift risk. (why_it_matters is
// handled by BACKFILL_WHY_* above; rewriteTemplateWhys replaces it, but analysis
// and what_happens_next are NOT rewritten, so those two are the reliable tell.)
export const RAW_TEMPLATE_ANALYSIS = 'Included for completeness; see the linked source for the full account.';
export const RAW_TEMPLATE_WHATNEXT = 'Watch for follow-up coverage and official updates.';
export const REWRITE_TEMPLATE_WHYS = (process.env.REWRITE_TEMPLATE_WHYS || 'true').toLowerCase() !== 'false';

export function rawToFullStory(s: any): any {
  const body = String(s?.body || s?.facts || '').trim();
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  const facts = sentences.slice(0, 2).join(' ').trim();
  const why = sentences.slice(2).join(' ').trim();
  return {
    headline: String(s?.headline || '').trim() || 'Update',
    facts: facts || body || String(s?.headline || 'See the linked source for details.'),
    background: `Reported by ${s?.source || 'the source'}.`,
    why_it_matters: why || BACKFILL_WHY_FULL,
    what_happens_next: RAW_TEMPLATE_WHATNEXT,
    analysis: RAW_TEMPLATE_ANALYSIS,
    source: String(s?.source || '').trim(),
    source_url: String(s?.source_url || '').trim(),
    industries: Array.isArray(s?.industries) ? s.industries : [],
    interests: Array.isArray(s?.interests) ? s.interests : [],
    city_tags: Array.isArray(s?.city_tags) ? s.city_tags : [],
    topic_tags: Array.isArray(s?.topic_tags) ? s.topic_tags : [],
    must_include: !!s?.must_include,
  };
}

export const DAILY_BACKFILL_SECTIONS = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

export function backfillEmptyDailySections(content: any, subset: RawStories): number {
  let added = 0;
  for (const sec of DAILY_BACKFILL_SECTIONS) {
    const out = Array.isArray(content[sec]) ? content[sec] : [];
    const src = Array.isArray((subset as any)[sec]) ? (subset as any)[sec] : [];
    if (out.length === 0 && src.length > 0) {
      content[sec] = src.map(rawToFullStory);
      added += content[sec].length;
      console.warn(`[10min] Writer emitted 0 stories for "${sec}" though ${src.length} were supplied — backfilled ${content[sec].length} from raw.`);
    }
  }
  return added;
}

// ─── Sprint 14.8 — 5min (MicroStory) converter for top-up backfill ───────────
// Mirrors rawToFullStory but emits the 5min MicroStory shape. Pads short fields
// so the result always satisfies MicroStorySchema (what_happened/why >= 8).
export function rawToMicroStory(s: any): any {
  const ensure = (t: any, min: number, fallback: string): string => {
    const v = String(t || '').trim();
    return v.length >= min ? v : (v ? v + ' ' : '') + fallback;
  };
  const body = String(s?.body || '').trim();
  const headline = (String(s?.headline || '').trim() || 'Update').slice(0, 200);
  return {
    headline,
    what_happened: ensure(body || headline, 8, 'See the linked report for the full account.'),
    why_it_matters: ensure(s?.why_it_matters, 8, BACKFILL_WHY_MICRO),
    source: String(s?.source || '').trim() || 'Source',
    source_url: String(s?.source_url || '').trim(),
    industries: Array.isArray(s?.industries) ? s.industries : [],
    interests: Array.isArray(s?.interests) ? s.interests : [],
    city_tags: Array.isArray(s?.city_tags) ? s.city_tags : [],
    topic_tags: Array.isArray(s?.topic_tags) ? s.topic_tags : [],
    must_include: !!s?.must_include,
  };
}

// ─── Sprint 14.8 — top-up backfill (the real fix for "only 2 India items") ───
// The post-write strip (and, when enabled, the coherence drop) can leave a
// section SHORT — not empty, so backfillEmptyDailySections never fired. This
// tops each core section back up toward the count the subset supplied, pulling
// from the (already whitelisted, already tier-ranked) subset stories that
// aren't in the rendered section yet. Deduped by normalised source_url. The
// caller re-validates and only keeps the result if it still passes Zod, so a
// top-up can never ship invalid content.
// Sprint 18.3 — compact per-section story counts, for tracing what the writer
// produced vs what survived the whitelist strip vs what got padded. The reason
// major_events read as canned templates is invisible without this.
export function dailySectionCountsStr(content: any): string {
  const secs = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  return secs
    .map((s) => `${s}=${Array.isArray(content?.[s]) ? content[s].length : 0}`)
    .filter((x) => !x.endsWith('=0'))
    .join(' ') || '(none)';
}

export const TOPUP_SECTIONS_10MIN = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];
export const TOPUP_SECTIONS_5MIN  = ['major_events', 'india', 'world'];

export function backfillToSubsetCounts(content: any, edition: Edition, subset: RawStories, excludeKeys?: Set<string>): number {
  if (!content || typeof content !== 'object') return 0;
  const sections = edition === '5min' ? TOPUP_SECTIONS_5MIN
                 : edition === '10min' ? TOPUP_SECTIONS_10MIN
                 : [];
  if (sections.length === 0) return 0;
  const convert = edition === '5min' ? rawToMicroStory : rawToFullStory;
  // Sprint 26 (F1): stories the coherence pass just dropped (contradiction /
  // fabrication / duplication) must NOT be silently re-added here as raw
  // templates — that is exactly the "backfill resurrects a just-dropped Kyiv
  // story as boilerplate" defect. The caller passes their normalised source_url
  // keys; we skip any candidate matching one.
  const blocked = excludeKeys instanceof Set ? excludeKeys : null;
  let blockedSkips = 0;
  let added = 0;
  const padLog: string[] = [];
  for (const sec of sections) {
    const out = Array.isArray(content[sec]) ? content[sec] : [];
    const src = Array.isArray((subset as any)[sec]) ? ((subset as any)[sec] as any[]) : [];
    const target = src.length; // the subset already respects the per-section quota
    if (out.length >= target || target === 0) continue;
    const writerHad = out.length;
    const present = new Set(out.map((s: any) => normaliseUrlForCompare(s?.source_url)));
    let secAdded = 0;
    for (const raw of src) {
      if (out.length >= target) break;
      const key = normaliseUrlForCompare(raw?.source_url);
      if (key && present.has(key)) continue;
      if (blocked && key && blocked.has(key)) { blockedSkips++; continue; }
      out.push(convert(raw));
      present.add(key);
      added++; secAdded++;
    }
    content[sec] = out;
    if (secAdded > 0) padLog.push(`${sec}: had ${writerHad}/${target}, padded +${secAdded}`);
  }
  if (padLog.length > 0) {
    console.warn(`[backfill] ${edition} top-up padded under-filled sections with RAW TEMPLATES (these render as canned "why it matters"): ${padLog.join(' · ')}`);
  }
  if (blockedSkips > 0) {
    console.log(`[backfill] ${edition} skipped ${blockedSkips} candidate(s) the coherence pass had dropped (F1 guard — not re-adding removed stories).`);
  }
  return added;
}

// ─── Sprint 19 — real "why it matters" for backfilled stories ────────────────
// When the writer under-produces a section, the top-up backfill pads it from
// raw stories whose RSS summary is too short to derive a "why" from, so those
// stories shipped the canned BACKFILL_WHY_* sentinel — identical boilerplate the
// reader sees as a fake "why it matters" (the Sprint 18 regression). This pass
// finds those sentinels in the FINAL brief and rewrites each with a real,
// story-specific, India-anchored line via one cheap gpt-4o-mini call. Fail-safe:
// on any error each sentinel is replaced by a line derived from the story's OWN
// facts, so a padded story is never identical boilerplate and the field always
// stays present and schema-valid (length >= the edition's minimum).
export async function rewriteTemplateWhys(content: any, edition: Edition): Promise<number> {
  if (!REWRITE_TEMPLATE_WHYS || !content || typeof content !== 'object') return 0;
  const minLen = edition === '5min' ? 8 : 15;
  const isSentinel = (w: string): boolean => {
    const t = (w || '').trim();
    return t === BACKFILL_WHY_FULL || t === BACKFILL_WHY_MICRO
        || t.endsWith(BACKFILL_WHY_FULL) || t.endsWith(BACKFILL_WHY_MICRO);
  };
  // Collect every padded story (sentinel "why") across all array sections.
  const targets: any[] = [];
  for (const key of Object.keys(content)) {
    const arr = content[key];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (s && typeof s === 'object' && typeof s.why_it_matters === 'string' && isSentinel(s.why_it_matters)) {
        targets.push(s);
      }
    }
  }
  if (targets.length === 0) return 0;

  // Deterministic, story-specific fallback — leads with the story's own first
  // fact so it is never identical across stories; padded to the schema minimum.
  const fallbackWhy = (s: any): string => {
    const facts = String(s?.facts || s?.what_happened || '').trim();
    const first = (facts.split(/(?<=[.!?])\s+/).filter(Boolean)[0] || facts).trim();
    const line = first ? `For Indian readers: ${first}` : '';
    return line.length >= minLen
      ? line
      : 'A notable development for Indian readers; see the linked report for the full account and context.';
  };

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('no OPENAI_API_KEY');
    const numbered = targets
      .map((s, i) => `${i}: ${String(s.headline || '').trim().slice(0, 140)} — ${String(s.facts || s.what_happened || '').trim().slice(0, 220)}`)
      .join('\n');
    const prompt = `You are a wire editor for an India-focused daily news brief (urban professionals, 25-45). For each item write ONE "why it matters" line — the genuine consequence an Indian reader should take away. ANCHOR TO INDIA where possible: inflation, the rupee, food/fuel prices, RBI policy, jobs, urban life, India's strategic position, or sector impact on Indian companies/markets. A purely global takeaway is acceptable ONLY if no Indian angle exists. Do NOT restate the headline or facts — say why it matters. One sentence, 8-22 words.
Return ONLY a JSON array, one object per item: [{"i":0,"why":"..."}]. No prose, no code fences.
Items:
${numbered}`;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.BACKFILL_WHY_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    const txt: string = j?.choices?.[0]?.message?.content || '';
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no JSON array in response');
    const arr: any[] = JSON.parse(m[0]);
    const byIdx = new Map<number, string>();
    for (const o of arr) {
      const idx = parseInt(o?.i, 10);
      const why = String(o?.why || '').trim();
      if (Number.isInteger(idx) && idx >= 0 && idx < targets.length && why.length >= minLen) byIdx.set(idx, why);
    }
    targets.forEach((s, i) => { s.why_it_matters = byIdx.has(i) ? (byIdx.get(i) as string) : fallbackWhy(s); });
    console.log(`[backfill] ${edition} rewrote ${byIdx.size}/${targets.length} template "why it matters" via ${process.env.BACKFILL_WHY_MODEL || 'gpt-4o-mini'} (rest derived from own facts).`);
    return targets.length;
  } catch (e: any) {
    targets.forEach((s) => { s.why_it_matters = fallbackWhy(s); });
    console.warn(`[backfill] ${edition} template-why rewrite fell back to deterministic (${e?.message || e}); ${targets.length} derived from own facts.`);
    return targets.length;
  }
}


// Sprint 14.5 introduced this as a NON-BLOCKING copy-desk review. Sprint 14.8
// makes it BLOCKING (founder decision): high-severity contradictions and
// fabrications are removed from the brief before it ships, instead of only
// logged. It catches the trust-breaking classes the 06-14 / 16-Jun briefs
// showed: same-day contradictions (e.g. markets_news crediting a "US-Iran peace
// deal" that another section contradicts), fabricated-looking numbers,
// unattributed quotes, stale items written as today's news, and a story
// repeated across sections. Runs on 10min + deep, where synthesis/contradiction
// risk is highest.
//
// Enforcement is gated by COHERENCE_ENFORCE ('on' default; set 'off' to revert
// to log-only without a redeploy — same pattern as URL_LIVENESS). Only
// `contradiction` and `fabrication` at severity `high` are dropped, and ONLY
// when the issue names an exact headline that matches a story in the named
// section — so a drop is always precisely targeted, never a guess.

// ============================================================================
// SECTION 18:  COHERENCE CHECK, VALIDATION & REPAIR
// ----------------------------------------------------------------------------
// LLM coherence pass + drop (applyCoherenceDrops returns dropped URL keys for
// the backfill guard; a duplication flag resolves by keep-best, drops nothing
// with no partner), plus repairCommonOmissions, validateBrief / validateLens,
// the non-whitelisted strip, and fetchPreviousBrief (halt fallback source).
// Fns:   runCoherenceCheck, applyCoherenceDrops, repairCommonOmissions, validateBrief, stripNonWhitelistedFromContent, fetchPreviousBrief
// Flags: COHERENCE_ENFORCE, COHERENCE_BACKFILL_GUARD
// ============================================================================
export const COHERENCE_ENFORCE = (process.env.COHERENCE_ENFORCE || 'on').toLowerCase() !== 'off';

// Sprint 26 (F1) — default ON. Two independent guarantees on the coherence
// pass: (1) a story the pass drops can NOT be re-added by the subsequent
// backfill top-up (the defect where a coherence-dropped Kyiv story came back as
// a raw boilerplate template), and (2) a high-severity `duplication` flag is
// resolved by keep-best (drop the lower-corroboration twin) instead of the old
// behaviour of ignoring duplication entirely. Env-revertible:
// COHERENCE_BACKFILL_GUARD=false restores the pre-Sprint-26 wiring exactly.
export const COHERENCE_BACKFILL_GUARD = (process.env.COHERENCE_BACKFILL_GUARD || 'true').toLowerCase() !== 'false';

export type CoherenceIssue = {
  type: string;
  section: string;
  headline: string;
  severity: string;
  detail: string;
};

export async function runCoherenceCheck(edition: Edition, content: any): Promise<CoherenceIssue[]> {
  if (!OPENAI_API_KEY) return [];
  const compact = JSON.stringify(content).slice(0, 24000);
  const today = getISTDate();
  const prompt = `You are a copy-desk QA reviewer for an Indian daily brief (edition: ${edition}, date ${today}). Review the assembled brief JSON below and flag ONLY real problems a careful reader would catch. Be terse and precise.
Check for:
1) internal contradictions — e.g. one part says a conflict is escalating while another says peace was reached the same day; markets attributed to an event another section contradicts; oil up in one place and down in another.
2) numbers or charts that look fabricated or internally inconsistent (a too-perfect sequence, or values that contradict the prose).
3) quotes with no named, real attribution.
4) stale items written as if they are today's development.
5) the same story repeated across multiple sections.
For each issue, identify the SINGLE offending story and copy its EXACT "headline" verbatim from the JSON, name its "section", and set "severity" to "high" only if the problem makes the brief untrustworthy (a real same-day contradiction or an apparent fabrication) — otherwise "low".
Return ONLY JSON: {"issues":[{"type":"contradiction|fabrication|attribution|stale|duplication","section":"<section key>","headline":"<exact headline of the offending story, or empty if not attributable to one story>","severity":"high|low","detail":"one sentence"}],"summary":"one sentence overall"}. If nothing is wrong, return {"issues":[],"summary":"clean"}.

BRIEF JSON:
${compact}`;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1100,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await response.json();
    const usage = extractUsageFromChatCompletion(data);
    void logOpenAICost({
      phase: 'score',
      model: 'gpt-4o-mini',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      detail: `coherence:${edition}`,
    });
    const txt = data?.choices?.[0]?.message?.content;
    if (!txt) { console.warn(`[coherence:${edition}] empty response`); return []; }
    const parsed = extractJsonObject(txt);
    const rawIssues = Array.isArray(parsed?.issues) ? parsed.issues : [];
    const issues: CoherenceIssue[] = rawIssues.map((it: any) => ({
      type: String(it?.type || 'issue'),
      section: String(it?.section || it?.where || '').split('/')[0].trim(),
      headline: String(it?.headline || '').trim(),
      severity: String(it?.severity || 'low').toLowerCase(),
      detail: String(it?.detail || ''),
    }));
    if (issues.length === 0) {
      console.info(`[coherence:${edition}] clean — ${parsed?.summary || 'no issues'}`);
      return [];
    }
    console.warn(`[coherence:${edition}] ${issues.length} issue(s) — ${parsed?.summary || ''}`);
    for (const it of issues.slice(0, 12)) {
      console.warn(`[coherence:${edition}]  - ${it.type}/${it.severity} @ ${it.section || '?'}: ${it.detail}`);
    }
    return issues;
  } catch (e: any) {
    console.warn(`[coherence:${edition}] check failed: ${e?.message || e}`);
    return [];
  }
}

// Sprint 14.8 / 26 (F1) — apply blocking coherence. Historically this dropped
// only high-severity contradiction/fabrication and returned a count. It now:
//   (1) always returns the normalised source_url + headline keys of what it
//       dropped, so the caller can bar backfill from re-adding them (the Kyiv
//       resurrection defect); and
//   (2) when the F1 guard is on, also resolves a high-severity `duplication`
//       flag by KEEP-BEST — find the flagged story's in-section near-dup partner
//       (prefix-aware) and drop the LOWER-eventCorr member, NOT the flagged one
//       blindly. If no partner is found the flag is treated as a possible
//       mislabel and nothing is dropped (so a unique story is never lost to a
//       bad "duplication" call). eventCorr is looked up from the subset by
//       source_url; written stories that can't be resolved default to keep-first.
export interface CoherenceDropResult { removed: number; droppedUrlKeys: Set<string>; droppedHeadlineKeys: Set<string>; }
export function applyCoherenceDrops(
  content: any,
  edition: Edition,
  issues: CoherenceIssue[],
  opts?: { guard?: boolean; subset?: RawStories },
): CoherenceDropResult {
  const droppedUrlKeys = new Set<string>();
  const droppedHeadlineKeys = new Set<string>();
  if (!content || typeof content !== 'object' || !Array.isArray(issues)) {
    return { removed: 0, droppedUrlKeys, droppedHeadlineKeys };
  }
  const guard = !!opts?.guard;
  const ENFORCE_TYPES = new Set(['contradiction', 'fabrication']);
  const norm = (h: any) => String(h || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

  // source_url → eventCorr, from the subset (raw stories carry eventCorr).
  const corrByUrl = new Map<string, number>();
  if (opts?.subset && typeof opts.subset === 'object') {
    for (const key of Object.keys(opts.subset as any)) {
      const arr = (opts.subset as any)[key];
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        const u = normaliseUrlForCompare(s?.source_url);
        if (u && !corrByUrl.has(u)) corrByUrl.set(u, Number(s?.eventCorr || 0));
      }
    }
  }
  const corrOf = (s: any): number => {
    const u = normaliseUrlForCompare(s?.source_url);
    return u && corrByUrl.has(u) ? (corrByUrl.get(u) as number) : 0;
  };
  const recordDrop = (s: any) => {
    const u = normaliseUrlForCompare(s?.source_url);
    if (u) droppedUrlKeys.add(u);
    const h = norm(s?.headline);
    if (h) droppedHeadlineKeys.add(h);
  };

  let removed = 0;
  // Sprint 27.1 (N7) — every flagged issue now logs a DISPOSITION. The 07-05
  // run flagged contradiction/high @ markets and silently no-oped (the target
  // was the non-array markets object; the loop `continue`d without a word) —
  // the brief shipped carrying a flagged high-severity contradiction. Behaviour
  // is UNCHANGED here (what was dropped is still dropped, what wasn't still
  // isn't); the change is that "wasn't" is now a named, greppable reason, so a
  // high-severity flag can never disappear from the log again.
  const disposition = (it: CoherenceIssue, what: string) => {
    console.warn(`[coherence:${edition}] disposition — ${it.type}/${it.severity} @ ${it.section || '?'}: ${what}`);
  };
  for (const it of issues) {
    if (it.severity !== 'high') { disposition(it, 'below-severity (low) — logged only, nothing dropped'); continue; }
    const sec = it.section;
    const target = norm(it.headline);
    const attributable = !!(sec && target);
    const droppableSection = !!(sec && Array.isArray(content[sec]));

    if (ENFORCE_TYPES.has(it.type)) {
      if (!attributable) { disposition(it, 'NOT ATTRIBUTABLE to one story (no section/headline from the reviewer) — cannot drop; likely a cross-section issue, shipping with the flag on record'); continue; }
      if (!droppableSection) { disposition(it, `section "${sec}" is not a droppable story array (object/absent) — cannot drop; likely a cross-section issue, shipping with the flag on record`); continue; }
      const keep: any[] = [];
      for (const s of content[sec]) {
        if (norm(s?.headline) === target) { recordDrop(s); removed++; continue; }
        keep.push(s);
      }
      if (content[sec].length !== keep.length) {
        console.warn(`[coherence:${edition}] BLOCKED — dropped ${content[sec].length - keep.length} story from "${sec}" (${it.type}): "${String(it.headline).slice(0, 80)}"`);
        disposition(it, 'DROPPED (blocking enforcement)');
      } else {
        disposition(it, 'story-not-found in section (already removed by an earlier pass?) — nothing dropped');
      }
      content[sec] = keep;
      continue;
    }

    // duplication — keep-best, only under the F1 guard.
    if (it.type === 'duplication') {
      if (!guard) { disposition(it, 'duplication with F1 guard OFF — logged only, nothing dropped'); continue; }
      if (!attributable) { disposition(it, 'NOT ATTRIBUTABLE to one story — cannot resolve keep-best; nothing dropped'); continue; }
      if (!droppableSection) { disposition(it, `section "${sec}" is not a droppable story array — nothing dropped`); continue; }
      const arr = content[sec] as any[];
      const flaggedIdx = arr.findIndex((s) => norm(s?.headline) === target);
      if (flaggedIdx === -1) { disposition(it, 'story-not-found in section (already removed?) — nothing dropped'); continue; }
      const flaggedSig = eventSignature(arr[flaggedIdx]?.headline || '');
      let partnerIdx = -1;
      for (let i = 0; i < arr.length; i++) {
        if (i === flaggedIdx) continue;
        if (isSameEventPrefix(flaggedSig, eventSignature(arr[i]?.headline || ''))) { partnerIdx = i; break; }
      }
      if (partnerIdx === -1) {
        console.warn(`[coherence:${edition}] duplication flag on "${String(it.headline).slice(0, 70)}" in ${sec} has NO in-section partner — treating as possible mislabel, keeping story (F1).`);
        disposition(it, 'no-partner-found — possible mislabel, story KEPT (F1 safety)');
        continue;
      }
      const a = arr[flaggedIdx], b = arr[partnerIdx];
      const aCorr = corrOf(a), bCorr = corrOf(b);
      // Drop the lower-eventCorr member; tie → drop the later index (keep earlier).
      let dropIdx: number;
      if (aCorr < bCorr) dropIdx = flaggedIdx;
      else if (bCorr < aCorr) dropIdx = partnerIdx;
      else dropIdx = Math.max(flaggedIdx, partnerIdx);
      const keepIdx = dropIdx === flaggedIdx ? partnerIdx : flaggedIdx;
      recordDrop(arr[dropIdx]);
      console.warn(`[coherence:${edition}] BLOCKED(dup keep-best) — ${sec}: dropped "${String(arr[dropIdx]?.headline || '').slice(0, 60)}" (eventCorr=${Math.min(aCorr, bCorr)}), kept "${String(arr[keepIdx]?.headline || '').slice(0, 60)}" (eventCorr=${Math.max(aCorr, bCorr)}).`);
      disposition(it, 'RESOLVED keep-best (lower-eventCorr twin dropped)');
      arr.splice(dropIdx, 1);
      removed++;
      continue;
    }

    // High-severity but not an enforce class (attribution/stale/etc.).
    disposition(it, `type "${it.type}" is not an enforce class — logged only, nothing dropped`);
  }
  return { removed, droppedUrlKeys, droppedHeadlineKeys };
}


export function repairCommonOmissions(content: any, edition: Edition, raw: RawStories): any {
  if (!content || typeof content !== 'object') return content;

  // 10min: re-attach markets if dropped or malformed.
  if (edition === '10min') {
    // ── Sprint 27.1 (writer/validator contract; the open 10-min `facts` item) ──
    // The writer occasionally emits a required text field a few characters
    // short of its Zod minimum (`major_events.1.facts: expected ≥15 chars`),
    // failing the WHOLE brief and burning a full retry over one field. Repair
    // deterministically instead: extend a present-but-short field from the
    // story's own material (headline first, then a neutral pointer), logged per
    // field. MISSING/null fields still fail validation — those signal a deeper
    // writer failure a retry should handle; this only repairs "wrote it, but
    // too short". Env-revertible: WRITER_FIELD_REPAIR=false restores strict
    // fail-and-retry. Same contract-fix family as the deep one_chart null.
    const WRITER_FIELD_REPAIR = (process.env.WRITER_FIELD_REPAIR || 'true').toLowerCase() !== 'false';
    if (WRITER_FIELD_REPAIR) {
      const MIN = 15;
      const FIELDS = ['facts', 'background', 'why_it_matters', 'what_happens_next', 'analysis'];
      let padded = 0;
      const padField = (s: any, field: string) => {
        const val = s?.[field];
        if (typeof val !== 'string') return;           // missing/null → leave for Zod
        const trimmed = val.trim();
        if (trimmed.length === 0 || trimmed.length >= MIN) return;
        const head = String(s?.headline || '').trim();
        const extended = head && `${trimmed} — ${head}.`.length >= MIN
          ? `${trimmed} — ${head}.`
          : `${trimmed} — see the linked source for detail.`;
        s[field] = extended;
        padded++;
        console.warn(`[10min] field-repair: "${field}" was ${trimmed.length} chars (<${MIN}) on "${head.slice(0, 55)}" — extended deterministically.`);
      };
      for (const sec of ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news']) {
        const arr = (content as any)[sec];
        if (!Array.isArray(arr)) continue;
        for (const s of arr) for (const f of FIELDS) padField(s, f);
      }
      if (padded > 0) console.warn(`[10min] field-repair extended ${padded} short field(s) — brief saved from a whole-retry over sub-minimum text.`);
    }

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

    // Sprint 14.5: guarantee section presence — backfill any topical section
    // the writer dropped to zero despite raw supplying stories.
    const backfilled = backfillEmptyDailySections(content, raw);
    if (backfilled > 0) {
      console.warn(`[10min] repair backfilled ${backfilled} stor${backfilled === 1 ? 'y' : 'ies'} into empty sections.`);
    }
  }

  return content;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateBrief(content: any, edition: Edition):
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

export function validateLens(lens: any): boolean {
  return LensSchema.safeParse(lens).success;
}

// ─── Post-write source-URL guard ────────────────────────────────────────────
//
// The writers (LLMs) sometimes invent stories when raw is sparse, complete with
// plausible-looking headlines and homepage URLs. Zod can't catch this because
// any https URL passes the schema. This walks the WRITTEN brief and drops any
// story whose source_url isn't from a Tier-1 whitelisted publisher. Acts as a
// safety net on top of the fetch-time enforcement in enforceQualityRules.

export function stripNonWhitelistedFromContent(
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

export async function fetchPreviousBrief(edition: Edition): Promise<{ content: BriefContent; lens: any; status: string } | null> {
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

// ─── Sprint 26 (F7) — final-brief invariant checker ─────────────────────────
// The last line of defence, run on the exact object about to be saved. F1 and F2
// each fix a specific resurrection/split path, but both previously PASSED their
// own proof-lines while still shipping a wrong brief — so this checker verifies
// the OUTCOME independently of the flags that produced it. It runs on 5min/10min
// (deep has no story sections). Two severities:
//   • halt-class (a,c): a duplicate event in a section (repeat source_url, repeat
//     stamped eventId, or a prefix-aware near-dup headline) or an orphaned
//     front-page lead (a curated major_events event that appears nowhere in the
//     final brief). These are the trust-breaking defects.
//   • log-loud (b,d): a raw-template fingerprint that reached the reader, or a
//     supplied section that shipped empty / a total below the edition floor.
// BRIEF_INVARIANTS (default ON) is pure telemetry — it logs and never changes
// content. BRIEF_INVARIANTS_HALT (default OFF) additionally refuses to ship a
// brief with a halt-class violation (it falls back to the previous good brief).
// Enable HALT only after a run confirms zero halt-class violations.
// ============================================================================
// SECTION 19:  FINAL-BRIEF INVARIANT CHECKER  (Sprint 26 F7)
// ----------------------------------------------------------------------------
// Independent check on the EXACT object being saved (5/10min; deep no-op):
// no duplicate event in a section, no orphaned front-page lead (halt-class),
// no raw-template fingerprint, no floor miss (log-loud). Halting refuses to
// ship a violating brief and falls back to the previous good brief.
// Fns:   checkBriefInvariants
// Flags: BRIEF_INVARIANTS (on/log-only), BRIEF_INVARIANTS_HALT (off)
// ============================================================================
export const BRIEF_INVARIANTS = (process.env.BRIEF_INVARIANTS || 'true').toLowerCase() !== 'false';
export const BRIEF_INVARIANTS_HALT = (process.env.BRIEF_INVARIANTS_HALT || 'false').toLowerCase() === 'true';

// Sprint 27.1 (N5) — the checker must know each edition's ACTUAL schema. The
// 07-05 audit caught it schema-blind: the 5-min folds business…culture into a
// single `topics` array (the checker saw 0-story sections and cried a false
// floor violation on a healthy brief), and the 10-min's politics/markets_news
// were outside the check entirely (it said "20 stories" on a 29-story brief).
// A checker that cries wolf and misses real sections erodes the trust it was
// built to provide — these lists mirror BriefQuickSchema / BriefDailySchema.
export const INVARIANT_SECTIONS_BY_EDITION: Record<string, string[]> = {
  '5min':  ['major_events', 'world', 'india', 'topics'],
  '10min': ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news'],
};
// 5-min folding: these subset sections ship inside `topics`, not under their
// own keys — the floor check tests them collectively against topics.
export const FIVE_MIN_FOLDED_INTO_TOPICS = ['business', 'technology', 'climate_health', 'sport', 'culture'];

export interface InvariantResult { ok: boolean; violations: string[]; halted: boolean; }

export function checkBriefInvariants(content: any, subset: RawStories, edition: Edition, fullPool?: RawStories | null): InvariantResult {
  const violations: string[] = [];
  if (edition === 'deep' || !content || typeof content !== 'object') {
    console.log(`[invariants:${edition}] ok — no story sections to check.`);
    return { ok: true, violations, halted: false };
  }
  const sections = INVARIANT_SECTIONS_BY_EDITION[edition] || INVARIANT_SECTIONS_BY_EDITION['10min'];

  // source_url → eventId, from the subset AND the full pool (the pool also
  // covers curated leads that didn't make the subset — the delivery report
  // below needs to recognise them wherever they surface). Written stories
  // don't carry eventId, so we map by URL.
  const eventIdByUrl = new Map<string, number>();
  const shippedMajorEventIds = new Set<number>();     // the shipped front page (≤5) — halt-class promise
  const curatedLeads = new Map<number, { rank: number; headline: string }>(); // curated 1..12 — delivery report
  const harvest = (src: any, isSubset: boolean) => {
    if (!src || typeof src !== 'object') return;
    for (const key of Object.keys(src)) {
      const arr = (src as any)[key];
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        const u = normaliseUrlForCompare(s?.source_url);
        const eid = typeof s?.eventId === 'number' ? s.eventId : null;
        if (u && eid != null && !eventIdByUrl.has(u)) eventIdByUrl.set(u, eid);
        if (isSubset && key === 'major_events' && eid != null) {
          shippedMajorEventIds.add(eid);
          if (!curatedLeads.has(eid)) curatedLeads.set(eid, { rank: 0, headline: String(s?.headline || '') });
        }
        // Sprint 27.1 (N3) — cut curated leads are exLead-stamped by placement.
        if (eid != null && (s as any)?.exLead && !curatedLeads.has(eid)) {
          curatedLeads.set(eid, { rank: Number((s as any)?.leadRank || 0), headline: String(s?.headline || '') });
        }
      }
    }
  };
  harvest(subset, true);
  harvest(fullPool, false);

  const presentEventIds = new Set<number>();
  let totalStories = 0;
  let sectionsChecked = 0;

  // Sprint 27.1 (N1) — duplicate tracking is BRIEF-WIDE, not per-section. The
  // 07-05 Meta/CSAM pair shipped in major_events AND business; the per-section
  // checker blessed it ("ok — no duplicate events") — a false negative on the
  // exact defect class it exists for. URLs, eventIds and prefix-aware headline
  // signatures are now compared across every section, tagged with both homes.
  const seenUrls = new Map<string, string>();          // url → first section
  const seenEventIds = new Map<number, string>();      // eid → first section
  const keptSigs: { sig: Set<string>; sec: string; headline: string }[] = [];

  for (const sec of sections) {
    const arr = (content as any)[sec];
    if (!Array.isArray(arr)) continue;
    sectionsChecked++;
    for (const s of arr) {
      totalStories++;
      const url = normaliseUrlForCompare(s?.source_url);
      if (url) {
        const firstSec = seenUrls.get(url);
        if (firstSec === sec) violations.push(`[dup:${sec}] repeated source_url (${url.slice(0, 60)})`);
        else if (firstSec) violations.push(`[dup-xs:${firstSec}⟷${sec}] same source_url in both (${url.slice(0, 60)})`);
        else seenUrls.set(url, sec);
      }
      let eid: number | null = url && eventIdByUrl.has(url) ? (eventIdByUrl.get(url) as number) : null;
      if (eid == null && typeof s?.eventId === 'number') eid = s.eventId;
      if (eid != null) {
        presentEventIds.add(eid);
        const firstSec = seenEventIds.get(eid);
        if (firstSec === sec) violations.push(`[dup:${sec}] repeated eventId ${eid} ("${String(s?.headline || '').slice(0, 45)}")`);
        else if (firstSec) violations.push(`[dup-xs:${firstSec}⟷${sec}] same eventId ${eid} in both ("${String(s?.headline || '').slice(0, 45)}")`);
        else seenEventIds.set(eid, sec);
      }
      const sig = eventSignature(s?.headline || '');
      for (const ks of keptSigs) {
        if (isSameEventPrefix(sig, ks.sig)) {
          if (ks.sec === sec) violations.push(`[dup:${sec}] near-duplicate headline ("${String(s?.headline || '').slice(0, 45)}")`);
          else violations.push(`[dup-xs:${ks.sec}⟷${sec}] near-duplicate headlines ("${ks.headline.slice(0, 45)}" ⟷ "${String(s?.headline || '').slice(0, 45)}")`);
          break;
        }
      }
      keptSigs.push({ sig, sec, headline: String(s?.headline || '') });
      const analysis = String(s?.analysis || '');
      const wnext = String(s?.what_happens_next || '');
      const why = String(s?.why_it_matters || '');
      if (analysis === RAW_TEMPLATE_ANALYSIS || wnext === RAW_TEMPLATE_WHATNEXT || why === BACKFILL_WHY_FULL || why === BACKFILL_WHY_MICRO) {
        violations.push(`[template:${sec}] raw-template fingerprint reached reader ("${String(s?.headline || '').slice(0, 45)}")`);
      }
    }
  }

  // Orphaned SHIPPED front-page lead — halt-class. Sprint 27.1 (N3): this is
  // honestly labelled now. What placement guarantees — and what this asserts —
  // is that every event on the SHIPPED front page (major ≤5) appears in the
  // final brief. The curated 6-12 are NOT guaranteed to ship (they compete in
  // buildSubset like any story); their fate is reported below as log-loud
  // delivery telemetry, not asserted. Promoting the curated-12 to a shipped
  // guarantee is a deliberate future selection-policy decision, not a checker
  // default (see Sprint 27.1 summary — decision deferred, documented).
  for (const eid of Array.from(shippedMajorEventIds)) {
    if (!presentEventIds.has(eid)) violations.push(`[orphan] shipped front-page lead eventId ${eid} is absent from the final ${edition} brief`);
  }

  // Curated-lead delivery report (log-loud, never halts): which of the day's
  // curated front-page events — shipped 1-5 AND cut 6-12 — reached this brief.
  // The 07-05 audit found three curated leads (nw up to 7) that reached no
  // reader with no line anywhere saying so; this is that line.
  const curatedIds = Array.from(curatedLeads.keys());
  if (curatedIds.length > 0) {
    const missing = curatedIds.filter((eid) => !presentEventIds.has(eid));
    if (missing.length === 0) {
      console.log(`[invariants:${edition}] curated-lead delivery: ${curatedIds.length}/${curatedIds.length} curated front-page event(s) present in the final brief.`);
    } else {
      const detail = missing
        .map((eid) => { const m = curatedLeads.get(eid)!; return `rank ${m.rank || '?'} "${m.headline.slice(0, 55)}"`; })
        .join('; ');
      console.warn(`[invariants:${edition}] [lead-miss] curated-lead delivery: ${curatedIds.length - missing.length}/${curatedIds.length} present — MISSING: ${detail}. (Log-loud telemetry — curated 6-12 are not a shipped guarantee; see Sprint 27.1.)`);
    }
  }

  // Floor checks — edition-aware (N5). For the 5-min, business…culture ship
  // folded into `topics`; test them collectively. Per-section elsewhere.
  const flooredSections = edition === '5min' ? ['major_events', 'world', 'india'] : sections;
  for (const sec of flooredSections) {
    const sup = Array.isArray((subset as any)[sec]) ? (subset as any)[sec].length : 0;
    const got = Array.isArray((content as any)[sec]) ? (content as any)[sec].length : 0;
    if (sup > 0 && got === 0) violations.push(`[floor:${sec}] subset supplied ${sup} but final shipped 0`);
  }
  if (edition === '5min') {
    const foldedSupplied = FIVE_MIN_FOLDED_INTO_TOPICS.reduce((n, sec) => n + (Array.isArray((subset as any)[sec]) ? (subset as any)[sec].length : 0), 0);
    const topicsGot = Array.isArray((content as any).topics) ? (content as any).topics.length : 0;
    if (foldedSupplied > 0 && topicsGot === 0) violations.push(`[floor:topics] subset supplied ${foldedSupplied} folded topical stor(ies) but topics shipped 0`);
  }
  const target = edition === '5min' ? 15 : 20;
  if (totalStories < target) violations.push(`[floor] total ${totalStories} stories below ${edition} target ${target}`);

  const haltClass = violations.filter((v) => v.startsWith('[dup:') || v.startsWith('[dup-xs:') || v.startsWith('[orphan]'));
  if (violations.length === 0) {
    console.log(`[invariants:${edition}] ok — ${totalStories} stories across ${sectionsChecked} section(s), checked brief-wide: no duplicate events, no template fingerprints, all shipped front-page leads present.`);
    return { ok: true, violations, halted: false };
  }
  const halted = haltClass.length > 0;
  console.warn(`[invariants:${edition}] VIOLATION(S): ${violations.join(' | ')}${halted && BRIEF_INVARIANTS_HALT ? ' [HALT]' : ''}`);
  return { ok: false, violations, halted };
}

// ─── Save ────────────────────────────────────────────────────────────────────

