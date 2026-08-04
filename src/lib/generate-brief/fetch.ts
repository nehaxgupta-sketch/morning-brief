// src/lib/generate-brief/fetch.ts
//
// Modularization stage 5 - the fetch layer, moved verbatim from generate-brief.tsx:
// personalisation universe + prompt scaffolding (§4), OpenAI section helpers (§5),
// markets/lens (§6), the gpt-5 (§7) / perplexity + gpt-4o (§8) fetch paths,
// strategies (§9), and dispatch (§10). Runs enforceQualityRules + buildSubset
// (imported from ./quality) on the fetched pool. Only `export` was added to
// top-level declarations. NOTE: fetchNewsFromOpenAI_gpt5_legacy and
// fetchNewsFromOpenAI_legacy are exported but never called (kept for revert).

import {
  getISTDate,
  sleep,
  extractJsonObject,
} from '@/lib/generate-brief/utils';
import type {
  MarketIndex,
  RawStories,
} from '@/lib/generate-brief/types';
import {
  OPENAI_API_KEY,
  supabase,
} from '@/lib/generate-brief/env';
import {
  enforceQualityRules,
} from '@/lib/generate-brief/quality';
import {
  logOpenAICost,
  extractUsageFromResponses,
} from '@/lib/cost-log';
import {
  fetchStrategy_Rss,
} from '@/lib/rss-retrieval';

// ============================================================================
// SECTION  4:  PERSONALISATION UNIVERSE & PROMPT SCAFFOLDING
// ----------------------------------------------------------------------------
// Loads the cities/interests/industries universe from opted-in profiles and
// builds the reusable prompt fragments (source-whitelist block, tags block,
// story-shape spec) shared by every fetch prompt.
// Fns:   loadPersonalisationUniverse, sourceWhitelistBlock, tagsBlockFor, storyShape
// Flags: -
// ============================================================================
export interface Universe {
  industries: string[];
  interests: string[];
  cities: string[];
}

export async function loadPersonalisationUniverse(): Promise<Universe> {
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

export function sourceWhitelistBlock(): string {
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

export function tagsBlockFor(universe: Universe): string {
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

export function storyShape(today: string): string {
  return `{ "headline": "...", "body": "2-3 factual sentences", "source": "Publisher Name", "source_url": "https://...", "published_at": "ISO date or ${today}", "industries": [], "interests": [], "city_tags": [], "topic_tags": [], "must_include": false }`;
}

// ─── Generic per-section fetch ──────────────────────────────────────────────

// ============================================================================
// SECTION  5:  OPENAI SECTION-FETCH HELPERS
// ----------------------------------------------------------------------------
// Thin helpers that call OpenAI for a single section and coerce the result
// into list / single-object shapes. Used by the markets + lens fetchers.
// Fns:   callOpenAISection, fetchListSection, fetchSingleSection
// Flags: -
// ============================================================================
export async function callOpenAISection(prompt: string, sectionName: string, maxTokens = 4000): Promise<any> {
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

export async function fetchListSection(
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

export async function fetchSingleSection(
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

// ─── Sprint 23 — markets trading-day guard ──────────────────────────────────
// The markets prompts assume a weekday ~6:30 AM run ("use yesterday's close").
// On a weekend/holiday that silently became a fabricated "today" move (e.g.
// "Sensex and Nifty both up 0.1% today" on a Sunday, when the exchanges were
// shut). This computes whether NSE/BSE trade today and hands the writer an
// explicit instruction so it never asserts a move on a closed day — it leads
// with sentiment / global cues / what to watch on reopen instead.
// Revertible: MARKETS_TRADING_GUARD=off restores the prior prompt text.
// ============================================================================
// SECTION  6:  MARKETS & HOME-SCREEN LENS
// ----------------------------------------------------------------------------
// NSE trading-day guard (holidays + weekend), the markets summary/indices
// fetch, and fetchLens() — the four-line world/india/markets/watch lens the
// home flash-card shows. Markets are suppressed on non-trading days.
// Fns:   isIndianMarketOpen, marketsDayContext, fetchMarkets, fetchLens
// Flags: MARKETS_TRADING_GUARD, NSE_EXTRA_HOLIDAYS
// ============================================================================
export const MARKETS_TRADING_GUARD = (process.env.MARKETS_TRADING_GUARD || 'on').toLowerCase() !== 'off';
// Fixed-date NSE holidays (always closed). Movable holidays (Diwali, Holi, etc.)
// shift year to year — supply the current year's dates via NSE_EXTRA_HOLIDAYS as
// a comma-separated YYYY-MM-DD list (env only, no code change). The weekend check
// carries the common case; the fixed set below is unambiguous.
export const NSE_FIXED_HOLIDAYS = new Set(['01-26', '08-15', '10-02', '12-25']); // MM-DD
export function nseExtraHolidays(): Set<string> {
  return new Set((process.env.NSE_EXTRA_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean));
}
export function isIndianMarketOpen(istDateStr: string): boolean {
  // istDateStr is YYYY-MM-DD in IST. Noon-IST keeps the calendar date stable when
  // we read the UTC weekday.
  const d = new Date(`${istDateStr}T12:00:00+05:30`);
  const dow = d.getUTCDay(); // 0 = Sun … 6 = Sat
  if (dow === 0 || dow === 6) return false;
  const mmdd = istDateStr.slice(5);
  if (NSE_FIXED_HOLIDAYS.has(mmdd)) return false;
  if (nseExtraHolidays().has(istDateStr)) return false;
  return true;
}
export function marketsDayContext(today: string): string {
  if (!MARKETS_TRADING_GUARD) return '';
  if (isIndianMarketOpen(today)) {
    return `MARKET STATUS: Indian exchanges (NSE/BSE) trade today. Report the session's actual direction from real data; if Indian markets have not closed yet at the time of writing, use the most recent confirmed close and label it (e.g. "at yesterday's close"). Never invent a number.\n`;
  }
  return `MARKET STATUS: Indian exchanges (NSE/BSE) are CLOSED today (weekend or holiday). Do NOT state any "today" move for the Sensex or Nifty — no daily percentage, no "markets were flat/up/down today"; asserting one is a factual error. Instead lead with market SENTIMENT and positioning: the global cues (overnight US session, oil, the dollar, geopolitics) and the themes investors will weigh when trading resumes. You may reference the last trading session only if explicitly labelled (e.g. "at Friday's close"). Close on what to watch when markets reopen.\n`;
}

export async function fetchMarkets(today: string): Promise<{ summary: string; indices: MarketIndex[] }> {
  const prompt = `You are a markets desk reporter. Today is ${today}.
${marketsDayContext(today)}Use web_search_preview to fetch the most recent CONFIRMED closing values (do not fabricate; if Indian markets are closed today, use the last completed trading session and label it) for:
- Sensex (BSE)
- Nifty 50 (NSE)
- S&P 500
- Nasdaq Composite

Search multiple sources if needed. Return ONLY this JSON, no markdown:
{
  "summary": "2-3 sentences on market direction (or, if closed today, sentiment + global cues) and drivers, India-focused — follow MARKET STATUS above",
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

export async function fetchLens(rawStories: RawStories, today: string): Promise<{ world: string; india: string; markets: string; watch: string }> {
  // Synthesised once we have all sections back. Doesn't need its own web search;
  // the input is the already-fetched stories.
  const summary = {
    world: rawStories.world.slice(0, 5).map((s) => s.headline),
    india: rawStories.india.slice(0, 5).map((s) => s.headline),
    major_events: rawStories.major_events.slice(0, 5).map((s) => s.headline),
    markets_summary: rawStories.markets.summary,
  };

  const prompt = `You are writing the "lens" that appears on the home screen of an India daily brief on ${today}. It has four parts: world, india, markets, watch. Each part is a SHORT ANALYTICAL PARAGRAPH of 2-3 sentences in clear, neutral English.

Be analytical, NOT descriptive: synthesise the single biggest THEME and explain what today's news MEANS and why it matters — do not just restate one headline. Stay India-anchored. Ignore low-importance one-off stories (a single accident, a celebrity item); lead with the most consequential developments.

Stories fetched today:
${JSON.stringify(summary, null, 2)}

${marketsDayContext(today)}Return ONLY this JSON, no markdown:
{
  "world": "2-3 sentence analytical paragraph on the biggest global theme and what it means",
  "india": "2-3 sentence analytical paragraph on the biggest Indian theme and what it means",
  "markets": "2-3 sentence analytical paragraph on market direction or, if markets are closed today, the sentiment and global cues investors are weighing — follow MARKET STATUS above; never assert a 'today' index move on a closed day",
  "watch": "2-3 sentence analytical paragraph on the most important development(s) to watch in the days ahead"
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
      max_output_tokens: 900,
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

// ============================================================================
// SECTION  7:  GPT-5 REASONING FETCH PATH
// ----------------------------------------------------------------------------
// The gpt-5 reasoning + web_search fetch path and its (large) prompt builder.
// One of several selectable fetch engines; see Section 10 for dispatch.
// Fns:   callGpt5Reasoning, buildGpt5FetchPrompt
// Flags: -
// ============================================================================
export async function callGpt5Reasoning(
  prompt: string,
  reasoningEffort: 'low' | 'medium' | 'high' = 'low',
  costPhase: 'fetch' | 'lens' = 'fetch',
  timeoutMs: number = 180_000,
): Promise<string> {
  const t0 = Date.now();
  console.log(`[gpt-5] Starting reasoning fetch (effort=${reasoningEffort}, timeout=${Math.round(timeoutMs/1000)}s).`);

  // Sprint 12.2: AbortController prevents a single hung gpt-5 call from
  // consuming Vercel's full 300s budget. If this call times out, the catch
  // block in fetchNewsFromOpenAI converts it to empty text and the brief
  // still saves with whatever the other phase returned.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
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
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`gpt-5 ${reasoningEffort} call aborted after ${Math.round(timeoutMs/1000)}s timeout`);
    }
    throw err;
  }
  clearTimeout(timer);

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
export function buildGpt5FetchPrompt(today: string, universe: Universe, phase: 'universal' | 'topical' = 'universal'): string {
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

  // Sprint 12.1 (post-mortem fix): reverted to unified topical phase after
  // Vercel logs showed 429 rate-limiting when 3 parallel gpt-5 calls hit
  // OpenAI's per-org concurrency cap. Single topical call avoids that
  // entirely. Combined with sequential execution + reasoning_effort='medium'
  // in fetchNewsFromOpenAI, this restores Sprint 11.5's working baseline
  // and adds quality headroom from the higher reasoning effort.

  // phase === 'topical'
  return `${sharedHeader}

═══════════════════════════════════════════════
SECTIONS — TOPICAL PHASE (business + technology + climate_health + sport + culture + markets)
═══════════════════════════════════════════════

You are responsible for SIX sections (business, technology, climate_health, sport, culture, markets). Another fetcher handles major_events, world, india and the lens in parallel — do NOT include those.

OVER-FETCHING IS REQUIRED. Downstream filters will drop stories that fail the whitelist or recency check. Aim for the upper bound below.

EMPTY ARRAYS ARE A LAST RESORT. Business, technology, climate/health, sport, and culture news happen every single day globally. Returning an empty array signals that your search did not find the right angle — not that nothing happened. Before returning empty for any section, run AT LEAST 2 distinct searches for that section with different keywords. Examples: for sport, try "cricket news today", "IPL today", "tennis today", "football news today" — not just one generic "sport news" query.

- business: 5-6 stories. Corporate news, earnings, M&A, regulatory actions, major financial moves. Indian AND global. Skip pure markets summaries (markets is a separate section in this same response).

- technology: 4-5 stories. Significant product launches, major AI developments, big-tech regulation, cybersecurity events. Skip rumour/speculation. RECENCY: 24h preferred, 48h acceptable if no fresh 24h development exists today.

- climate_health: 4-5 stories. Climate disasters, environmental policy, major health stories (outbreaks, drug approvals, research with real implications). Concrete real-world impact.

- sport: 4-5 stories ACROSS DIFFERENT SPORTS. Cricket, football, tennis, F1, badminton, hockey, kabaddi, Olympics, athletics, golf, esports — pick the day's biggest from as many different sports as the day's news supports. Do NOT submit 4 cricket stories; aim for breadth. RECENCY: 24h preferred, 48h acceptable. Mid-week and off-season days often only have 24-48h-old developments — INCLUDE them rather than returning empty. Sport happens globally every single day; an empty sport array means the search failed, not that nothing happened.

- culture: 4-5 stories ACROSS DIFFERENT CULTURE TYPES. Films, OTT, music, books, theatre, visual arts, awards. Don't submit 4 film stories; aim for breadth. RECENCY: 24h preferred, 48h acceptable. Culture announcements aren't always daily — a 36h-old film release or award is fine if it's still the freshest available. Empty culture array signals search failure, not a quiet day.

- markets: ONE object with summary + indices. Find the MOST RECENT closing values for Sensex, Nifty 50, Dow Jones, Nasdaq Composite. IMPORTANT: This brief runs at ~6:38 AM IST. At that hour, Indian markets have NOT opened yet (they open 9:15 AM IST and close 3:30 PM IST) — so use YESTERDAY's close for Sensex and Nifty. US markets close around 1:30 AM IST — use the most recent US session close (which is the night just past). NEVER return empty indices because "today's close doesn't exist yet"; use the most recent available session close in every case. Write a 2-3 sentence India-anchored summary covering yesterday's Indian session and the overnight US session.

${sharedFooterRules}

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════

1. WHITELIST: every source_url MUST be from a whitelisted publisher. OMIT stories you can't source.
2. NO FABRICATION: never invent. If a section quota can't be filled from whitelisted sources, return fewer (but never zero unless truly nothing exists).
3. SEARCH DEPTH: at least 12 distinct searches across the six sections — 2 minimum per section.
4. PUBLISHER DIVERSITY: NO publisher may contribute more than 3 stories within this fetch.
5. DEDUP: each story in ONE section only (business > technology > climate_health > sport > culture).
6. SPORT AND CULTURE ARE ARRAYS of 3-5 story objects.
7. MARKETS INDICES: ARRAY of objects shaped [{"name":"Sensex","value":"74243","change":"-0.16%"}, ...]. Never a single object or string.
8. JSON ONLY: output ONE JSON object. No markdown, no preamble. Start with { and end with }.

═══════════════════════════════════════════════
OUTPUT SHAPE
═══════════════════════════════════════════════

{
  "business":       [ ${storyShape(today)}, ... ],
  "technology":     [ ${storyShape(today)}, ... ],
  "climate_health": [ ${storyShape(today)}, ... ],
  "sport":          [ ${storyShape(today)}, ... ],
  "culture":        [ ${storyShape(today)}, ... ],
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

// ──────────────────────────────────────────────────────────────────────────
// Sprint 12.4: PERPLEXITY SONAR PRO PRIMARY FETCH
// ──────────────────────────────────────────────────────────────────────────
//
// Why Perplexity: gpt-5 has a 500K TPM cap on Tier 1 that we kept hitting on
// every fetch (185s of reasoning → 429 → empty result). Perplexity Sonar Pro
// is purpose-built for current-events news synthesis with native citations,
// search-grounded by default, has its own quota pool (no contention with
// OpenAI), and is comparable cost (~$0.16/fetch vs ~$0.40/fetch with gpt-4o
// web_search_preview at $30/1K searches).
//
// Architecture: SINGLE call with all 10 sections in one prompt. Perplexity
// has 200K context — no concurrency, no TPM cliffs. Wall-clock 30-90s
// typical, 120s timeout safety net.
//
// Fallback chain: Perplexity → retry with simpler prompt → gpt-4o web_search
// → empty (brief saves with what it has). Quality threshold detection is
// not at fetch time (that's the scorer's job) — fallback fires only on
// technical failure (empty/error response).

// ============================================================================
// SECTION  8:  PERPLEXITY & GPT-4o WEB-SEARCH FETCH
// ----------------------------------------------------------------------------
// Perplexity (sonar-pro) transport with timeout, the gpt-4o web-search
// fallback, the Perplexity fetch-prompt builder, and the sleep() util.
// Fns:   callPerplexity, callGpt4oWebSearchFallback, buildPerplexityFetchPrompt, sleep
// Flags: PERPLEXITY_MODEL
// ============================================================================
export const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
export const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar-pro';

export async function callPerplexity(prompt: string, timeoutMs: number = 120_000): Promise<string> {
  if (!PERPLEXITY_API_KEY) {
    throw new Error('PERPLEXITY_API_KEY env var not set');
  }
  const t0 = Date.now();
  console.log(`[perplexity] Starting fetch (model=${PERPLEXITY_MODEL}, timeout=${Math.round(timeoutMs / 1000)}s).`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: 'You are a news synthesis engine. Return ONLY valid JSON. No markdown, no preamble.' },
          { role: 'user', content: prompt },
        ],
        // Search controls
        search_recency_filter: 'day',
        return_citations: true,
        // Output controls
        temperature: 0.2,
        max_tokens: 12000,
        // Sprint 12.5.1: response_format dropped — Perplexity tightened their
        // API and now rejects { type: 'json_object' } (only 'text', 'json_schema'
        // with a required schema, or 'regex' are accepted). The system prompt
        // above already enforces "Return ONLY valid JSON. No markdown, no
        // preamble." which sonar-pro complies with reliably. If JSON discipline
        // ever slips, revisit with a proper json_schema definition.
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Perplexity call aborted after ${Math.round(timeoutMs / 1000)}s timeout`);
    }
    throw err;
  }
  clearTimeout(timer);

  const dt = Math.round((Date.now() - t0) / 1000);
  if (response.status !== 200) {
    const body = await response.text().catch(() => '');
    throw new Error(`Perplexity returned status ${response.status} after ${dt}s. Body: ${body.slice(0, 400)}`);
  }

  const data: any = await response.json();
  console.log(`[perplexity] Response received in ${dt}s.`);

  // Cost capture — Perplexity returns usage in the standard OpenAI shape.
  const usage = data?.usage || {};
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  void logOpenAICost({
    phase: 'fetch',
    model: PERPLEXITY_MODEL,
    inputTokens,
    outputTokens,
    detail: `dt=${dt}s, citations=${(data?.citations || data?.choices?.[0]?.message?.citations || []).length}`,
  });

  const text = data?.choices?.[0]?.message?.content || '';
  // Citations are returned at top-level on Perplexity responses, sometimes also
  // on the message object. Both shapes are supported by this extractor.
  const citations: string[] = data?.citations || data?.choices?.[0]?.message?.citations || [];
  console.log(`[perplexity] content=${text.length} chars, citations=${citations.length}`);

  // Inject citations into the JSON so downstream parsing can attach them to
  // stories. Perplexity numbers citations [1], [2], etc inline in story text;
  // the stories themselves should already have source_url populated from the
  // prompt instructions. We append the citation list as a top-level field
  // for safety in case the model didn't.
  if (citations.length > 0 && text) {
    try {
      const parsed = JSON.parse(text);
      parsed._citations = citations;
      return JSON.stringify(parsed);
    } catch {
      // If parse fails here, return raw text — safeParse downstream will try again.
      return text;
    }
  }
  return text;
}

// gpt-4o web_search_preview fallback. Used only if Perplexity fails on both
// the primary attempt and the retry. Same prompt, different vendor.
export async function callGpt4oWebSearchFallback(prompt: string, timeoutMs: number = 180_000): Promise<string> {
  const t0 = Date.now();
  console.log(`[fallback:gpt-4o] Starting web_search fallback (timeout=${Math.round(timeoutMs / 1000)}s).`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: prompt,
        max_output_tokens: 8000,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`gpt-4o fallback aborted after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
  clearTimeout(timer);

  const dt = Math.round((Date.now() - t0) / 1000);
  if (response.status !== 200) {
    const body = await response.text().catch(() => '');
    throw new Error(`gpt-4o fallback status ${response.status} after ${dt}s. Body: ${body.slice(0, 400)}`);
  }
  const data: any = await response.json();
  console.log(`[fallback:gpt-4o] Response in ${dt}s.`);

  const usage = extractUsageFromResponses(data);
  void logOpenAICost({
    phase: 'fetch',
    model: 'gpt-4o',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    detail: 'fallback (Perplexity unavailable)',
  });

  return data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text || '';
}

// Unified single-call prompt for all 10 sections. Replaces the universal +
// topical split because Perplexity has 200K context, no TPM contention, and
// no parallel-call benefit (single call is fastest end-to-end).
export function buildPerplexityFetchPrompt(today: string, universe: Universe): string {
  const personalisationContext = (universe.cities.length || universe.interests.length || universe.industries.length)
    ? `\n\nPERSONALISATION CONTEXT (for industry/interest tagging on each story only — do NOT add personal sections):\n- Cities our readers care about: ${universe.cities.join(', ')}\n- Interests: ${universe.interests.join(', ')}\n- Industries: ${universe.industries.join(', ')}\n`
    : '';

  return `You are the news fetcher for Morning Brief, India's daily news digest for thoughtful urban professionals (25-45, English-reading). Today is ${today} (IST).

═══════════════════════════════════════════════
PRIMARY DIRECTIVE: OVER-FETCH REAL STORIES — VOLUME *AND* QUALITY
═══════════════════════════════════════════════

Downstream code filters by publisher whitelist, recency, and deduplication, TYPICALLY DROPPING 30-50% OF WHAT YOU RETURN. So you MUST OVER-FETCH: meet or exceed the MINIMUM for every section. Returning too few is the most common and most damaging failure — it leaves whole sections EMPTY after filtering. When in doubt, return MORE real stories, not fewer.

For EVERY section run MULTIPLE distinct searches with DIFFERENT angles (examples below). A single search per section is not enough.

QUALITY governs ORDER and what you drop LAST — never whether you hit the minimum. Within each section LEAD with the most consequential, specific, TODAY stories; if you must trim, drop the weakest first. A strong story ideally passes:
• SPECIFIC & DATED: a concrete development from the last 24-48h — something that HAPPENED (a decision, ruling, result, announcement, attack, release, data print, statement), with a date, named actors, and where relevant a number.
• FRONT-PAGE TEST: a well-informed Indian reader would be surprised to have missed it today.

PREFER specific dated stories over these weaker types — but a real, sourced story still COUNTS toward the minimum, so include it rather than fall short:
✗ "<sector> enters/poised for AI-led growth phase", "<market> seen reaching ₹X trillion by FY__" — trend/forecast.
✗ "demand for <thing> falls to <N>-month low", "experts say <generic>" with no dated event.
✗ evergreen explainers, listicles, anniversary look-backs with no fresh development.
Lead each section with hard news; let these weaker types fill the TAIL only when you're short of stronger stories. NEVER fabricate to reach a number — if a story isn't real, don't invent it; search harder instead.

═══════════════════════════════════════════════
SECTIONS — minimums are FLOORS (over-fetch above them); lead each section best-first
═══════════════════════════════════════════════

1. major_events — MINIMUM 5, target 6-8. The day's biggest news, India and world combined. Genuinely consequential — events with real second-order impact.
   Search angles: "top news today India", "world news today", "breaking news ${today}", "biggest story today"

2. world — MINIMUM 6, target 7-9. Significant developments OUTSIDE India. Geopolitics, foreign policy, conflicts, foreign elections, major institutions (UN/IMF/WB).
   Search angles: "world news today", "geopolitics ${today}", "international news today", "US news today", "China news today", "Europe news today", "Middle East today"

3. india — MINIMUM 6, target 7-9. Domestic India: politics, policy, Supreme Court, RBI, regulatory, major corporate India, civic, infrastructure, state-level major events, big-city civic news (water, transport, governance).
   Search angles: "India news today", "Modi government today", "Supreme Court India today", "RBI news ${today}", "India policy today", "Indian states news today", "Mumbai Delhi Bengaluru civic news today"

4. business — MINIMUM 5, target 6-8. Corporate news, earnings, M&A, IPO, regulatory, hires, sector moves. Indian and global. Exclude pure markets summaries (markets is section 9).
   Search angles: "business news today India", "corporate earnings today", "M&A deal today", "Indian company news today", "global business news today"

5. technology — MINIMUM 4, target 5-7. Product launches, AI developments, big-tech regulation, cybersecurity, infrastructure (chips, data centres). Skip rumour and speculation.
   Search angles: "tech news today", "AI news today", "OpenAI Google Meta today", "tech regulation today India", "cybersecurity news today"

6. climate_health — MINIMUM 4, target 5-7. Climate events, environmental policy, health news with real-world impact (outbreaks, approvals, major research, heatwave/monsoon developments).
   Search angles: "climate news today", "health news today India", "WHO news today", "disease outbreak today", "monsoon India today", "heatwave India today"

7. sport — MINIMUM 4 ACROSS DIFFERENT SPORTS, target 5-7. Cricket, football (incl. FIFA/club), tennis, F1, badminton, hockey, kabaddi, Olympics, athletics, golf, esports. NO more than 2 cricket stories — force breadth.
   Search angles: "cricket news today", "tennis news today", "football FIFA news today", "F1 news today", "badminton news today", "sports India today"

8. culture — MINIMUM 4 ACROSS DIFFERENT TYPES, target 5-7. Films, OTT, music, books, theatre, visual arts, awards, viral cultural phenomena.
   Search angles: "Bollywood news today", "OTT release today", "film news today", "music news India today", "book news today", "awards news today"

9. markets — ONE object with summary (2-3 sentences) + indices array (4 items: Sensex, Nifty 50, Dow Jones, Nasdaq). At 6:30 AM IST, Indian markets haven't opened — use YESTERDAY'S close. US markets closed overnight — use that close. NEVER return empty indices. If you don't find a number, search again — the data exists.
   Search angles: "Sensex Nifty close yesterday", "Dow Jones Nasdaq close ${today}", "India markets close yesterday"

10. lens — ONE object with 4 short analytical paragraphs (india / world / markets / watch). Each 2-3 sentences. Analytical, not descriptive — what does today's news MEAN?

═══════════════════════════════════════════════
OUTPUT SHAPE — exactly this, no markdown
═══════════════════════════════════════════════

{
  "major_events": [ { "headline":"...", "body":"2-3 sentence paraphrased summary", "source":"Publisher Name", "source_url":"https://direct-article-url", "published_at":"${today}", "industries":[], "interests":[], "must_include":false }, ... ],
  "world":        [ { ... same shape ... }, ... ],
  "india":        [ { ... same shape ... }, ... ],
  "business":     [ { ... same shape ... }, ... ],
  "technology":   [ { ... same shape ... }, ... ],
  "climate_health":[ { ... same shape ... }, ... ],
  "sport":        [ { ... same shape ... }, ... ],
  "culture":      [ { ... same shape ... }, ... ],
  "markets": {
    "summary": "2-3 sentences on yesterday's Indian session + overnight US",
    "indices": [
      { "name":"Sensex",   "value":"...", "change":"+0.5%" },
      { "name":"Nifty 50", "value":"...", "change":"+0.4%" },
      { "name":"Dow Jones","value":"...", "change":"-0.2%" },
      { "name":"Nasdaq",   "value":"...", "change":"+0.1%" }
    ]
  },
  "lens": {
    "india":   "2-3 analytical sentences on India today.",
    "world":   "2-3 analytical sentences on world today.",
    "markets": "2-3 analytical sentences on markets.",
    "watch":   "2-3 sentences on the next 24-48h."
  }
}

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════

1. MEET THE MINIMUM FOR EVERY SECTION. Below the minimum = failure — run more searches with new angles until you reach it. Over-fetching above the minimum is good (downstream filtering drops 30-50%). The only thing you must NOT do to hit a number is fabricate (see rule 4).

2. PARAPHRASE — your "body" is your own 2-3 sentence factual summary, not the article's prose. Headlines should also be your own factual summary, not the original article's verbatim title.

3. SOURCE: direct article URLs from reputable publishers (Reuters, AP, Bloomberg, FT, WSJ, NYT, BBC, Guardian, Economist, The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, The Print, Scroll, NDTV, Times of India, Deccan Herald, Telegraph India, Tribune India, Live Law, Bar and Bench, Down to Earth, ESPNCricinfo, ESPN, Variety, TechCrunch, The Verge, Wired, etc.). NO aggregators, NO social media, NO Google News redirects.

4. NEVER FABRICATE. Every story must be a real, published article you can cite. Do not invent stories, headlines, or URLs to pad a section. But "don't fabricate" is NOT licence to return few — exhaust the search angles to find enough REAL stories first; only return below the minimum if the genuine news truly isn't there.

5. PUBLISHER DIVERSITY: no publisher contributes more than 3 stories total across the brief.

6. DEDUPE: each story in ONE section only. If a story could fit two sections, pick by priority (major_events > india > world > business > technology > climate_health > sport > culture).

7. JSON ONLY: start with { and end with }. No markdown fences. No commentary. No "here is the JSON" preambles.${personalisationContext}

Begin now. Run MANY searches per section across different angles, meet or exceed every section's MINIMUM (over-fetching is good — downstream filtering drops 30-50%), and lead each section with the most consequential, specific, today stories. Return ONLY the JSON object.`;
}

// Strategy A: Perplexity Sonar Pro single call, all 10 sections.
// Fallback chain: Perplexity primary → Perplexity retry → gpt-4o web_search.
// Wall clock: 30-90s typical. Cost: ~$0.15/fetch.

// Sprint 14.8 — helpers for stub-aware fetch acceptance.
// sleep -> @/lib/generate-brief/utils

// Count how many real stories a raw fetch response actually parsed to, across
// the core sections. The old acceptance guard checked `text.length >= 1000`,
// but the 18-Jun Perplexity stub was 1155 chars (520 content + injected
// citations) yet carried ZERO stories — it passed the length gate and was
// accepted without a retry. Gating on story count instead catches that.
// ============================================================================
// SECTION  9:  FETCH STRATEGIES (single / 2-phase)
// ----------------------------------------------------------------------------
// The three active fetch strategies (perplexity-single, perplexity-2phase,
// gpt4o-2phase) and the per-phase (universal/topical) prompt builder.
// countCoreStories() gates a retry when a fetch comes back thin.
// Fns:   fetchStrategy_PerplexitySingle / _Perplexity2Phase / _Gpt4o2Phase, buildPerplexityFetchPromptByPhase
// Flags: -
// ============================================================================
export function countCoreStories(rawText: string): number {
  if (!rawText) return 0;
  let parsed: any;
  try { parsed = extractJsonObject(rawText); } catch { return 0; }
  const CORE = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  return CORE.reduce((n, s) => n + (Array.isArray(parsed?.[s]) ? parsed[s].length : 0), 0);
}

export async function fetchStrategy_PerplexitySingle(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  // Sprint 12.4: PERPLEXITY SONAR PRO primary, gpt-4o fallback.
  // See callPerplexity header for full rationale. Single-call architecture.

  console.log('[fetch] Starting Perplexity primary fetch (Sprint 12.4)...');
  const prompt = buildPerplexityFetchPrompt(today, universe);

  let text = '';
  let source: 'perplexity' | 'perplexity-retry' | 'gpt-4o-fallback' | 'none' = 'none';

  // A response is only "good" if it parses to real stories. A long stub with
  // zero stories (the 18-Jun failure) must NOT be accepted.
  const MIN_CORE_OK = 5;

  // Attempt 1: Perplexity Sonar Pro
  try {
    text = await callPerplexity(prompt, 120_000);
    const n = countCoreStories(text);
    if (text && n >= MIN_CORE_OK) {
      source = 'perplexity';
    } else {
      console.warn(`[fetch] Perplexity primary returned ${text.length} chars but only ${n} core stories (< ${MIN_CORE_OK}) — treating as a stub, will retry.`);
      text = '';
    }
  } catch (err: any) {
    console.error(`[fetch] Perplexity primary failed: ${err.message}`);
    text = '';
  }

  // Attempt 2: Perplexity with a reminder prompt, after a short backoff (a stub
  // is often a transient rate/load blip — retrying the GOOD engine beats falling
  // straight to the weaker gpt-4o fetcher).
  if (!text) {
    await sleep(4000);
    console.log('[fetch] Attempting Perplexity retry with reminder (after 4s backoff)...');
    try {
      const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY the JSON object described above, fully populated to each section MINIMUM. Do not include explanatory text. Begin with { and end with }.';
      text = await callPerplexity(retryPrompt, 120_000);
      const n = countCoreStories(text);
      if (text && n >= MIN_CORE_OK) {
        source = 'perplexity-retry';
      } else {
        console.warn(`[fetch] Perplexity retry still sparse (${n} core stories) — falling back to gpt-4o.`);
        text = '';
      }
    } catch (err: any) {
      console.error(`[fetch] Perplexity retry failed: ${err.message}`);
      text = '';
    }
  }

  // Attempt 3: gpt-4o web_search fallback (last resort; weaker fetcher)
  if (!text) {
    console.log('[fetch] Both Perplexity attempts failed/sparse. Falling back to gpt-4o + web_search.');
    try {
      text = await callGpt4oWebSearchFallback(prompt, 180_000);
      if (text && countCoreStories(text) >= 3) {
        source = 'gpt-4o-fallback';
      } else if (text && text.length < 1000) {
        text = '';
      }
    } catch (err: any) {
      console.error(`[fetch] gpt-4o fallback failed: ${err.message}`);
      text = '';
    }
  }

  if (!text) {
    console.error('[fetch] ALL FETCH ATTEMPTS FAILED. Returning empty brief.');
  } else {
    console.log(`[fetch] SUCCESS via ${source}. Text length: ${text.length} chars.`);
  }

  const safeParse = (raw: string, label: string): any => {
    if (!raw) {
      console.error(`[fetch:${label}] EMPTY response text.`);
      return {};
    }
    if (raw.length < 600) {
      console.warn(`[fetch:${label}] SHORT response (${raw.length} chars). Preview: ${raw.slice(0, 600)}`);
    }
    try {
      return extractJsonObject(raw);
    } catch (err: any) {
      console.error(`[fetch:${label}] JSON parse failed. First 800 chars:`, raw.slice(0, 800));
      console.error(`[fetch:${label}] JSON parse failed. Last 400 chars:`, raw.slice(-400));
      return {};
    }
  };

  const parsed = safeParse(text, source);

  // If Perplexity provided top-level citations array, attach to stories that
  // lack source_url. Most stories should have it from the prompt, but this
  // is a safety net.
  const citations: string[] = parsed?._citations || [];
  if (citations.length > 0) {
    const sectionKeys = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];
    for (const key of sectionKeys) {
      const arr = parsed[key];
      if (!Array.isArray(arr)) continue;
      arr.forEach((s: any, i: number) => {
        if (!s.source_url && citations[i]) {
          s.source_url = citations[i];
        }
      });
    }
  }

  const merged: any = {
    major_events:   parsed.major_events   || [],
    world:          parsed.world          || [],
    india:          parsed.india          || [],
    business:       parsed.business       || [],
    technology:     parsed.technology     || [],
    climate_health: parsed.climate_health || [],
    sport:          parsed.sport          || [],
    culture:        parsed.culture        || [],
    markets:        parsed.markets        || { summary: '', indices: [] },
    lens:           parsed.lens           || null,
    // Sprint 12.5.1: surface which engine actually produced this fetch so the
    // admin UI can flag silent fallbacks (e.g. Perplexity 400 → gpt-4o-fallback).
    _source:        source,
    _fetched_at:    new Date().toISOString(),
  };

  // Sprint 14.8 — STORY-SPARSE SAFETY NET. The 17-Jun run returned a long, valid
  // response (9.6k chars) carrying only ~8 stories total (major=3,world=3,
  // india=1). The existing retry only fires on a SHORT/empty response, so this
  // slipped through; the now-active fetch-time quality gate then emptied the
  // brief. Here we count core stories and, if the pool is thin, supplement it
  // with one gpt-4o web-search fetch, taking the richer set per section. This
  // never produces an empty brief from a single weak fetch. Gated by
  // FETCH_SPARSE_BACKSTOP ('on' default; 'off' disables).
  const CORE_SECTIONS = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  const coreCount = CORE_SECTIONS.reduce((n, s) => n + (Array.isArray(merged[s]) ? merged[s].length : 0), 0);
  const SPARSE_THRESHOLD = 12; // pre-filter floor; downstream drops 30-50%
  const sparseBackstopOn = (process.env.FETCH_SPARSE_BACKSTOP || 'on').toLowerCase() !== 'off';
  if (coreCount < SPARSE_THRESHOLD && source !== 'gpt-4o-fallback' && sparseBackstopOn) {
    console.warn(`[fetch] STORY-SPARSE (${coreCount} core stories < ${SPARSE_THRESHOLD}) from ${source} — supplementing via gpt-4o web search.`);
    try {
      const suppText = await callGpt4oWebSearchFallback(prompt, 180_000);
      const supp = safeParse(suppText, 'gpt-4o-supplement');
      let filled = 0;
      for (const s of CORE_SECTIONS) {
        const cur = Array.isArray(merged[s]) ? merged[s] : [];
        const alt = Array.isArray(supp?.[s]) ? supp[s] : [];
        if (alt.length > cur.length) { merged[s] = alt; filled += (alt.length - cur.length); }
      }
      // Take markets/lens from the supplement only if the primary lacked them.
      if ((!merged.markets?.indices || merged.markets.indices.length < 4) && supp?.markets?.indices?.length) {
        merged.markets = supp.markets;
      }
      if (!merged.lens && supp?.lens) merged.lens = supp.lens;
      merged._source = `${source}+gpt4o-supplement`;
      const newCore = CORE_SECTIONS.reduce((n, s) => n + (Array.isArray(merged[s]) ? merged[s].length : 0), 0);
      console.log(`[fetch] supplement added ${filled} stories; core now ${newCore}.`);
    } catch (e: any) {
      console.warn(`[fetch] sparse supplement failed (non-fatal): ${e?.message || e}`);
    }
  }

  console.log(`[fetch] (Sprint 12.4 ${merged._source}) merged section counts: ` +
    `major=${merged.major_events.length}, world=${merged.world.length}, india=${merged.india.length}, ` +
    `biz=${merged.business.length}, tech=${merged.technology.length}, climate=${merged.climate_health.length}, ` +
    `sport=${merged.sport.length}, culture=${merged.culture.length}, indices=${merged.markets?.indices?.length || 0}`);

  return merged as RawStories;
}

// Strategy B (HYBRID): Perplexity Sonar Pro 2-phase parallel.
// Universal phase (major_events + world + india + lens) and Topical phase
// (business + technology + climate_health + sport + culture + markets) run
// in parallel. Each call covers fewer sections, so quality-per-section is
// higher. Perplexity has its own quota pool — 2 parallel calls do not hit
// gpt-5-style TPM caps.
//
// Wall clock: max(uni, topical) ≈ 30-60s. Cost: ~$0.30/fetch (2 × $0.15).
export async function fetchStrategy_Perplexity2Phase(universe: Universe): Promise<RawStories> {
  const today = getISTDate();
  console.log('[fetch] STRATEGY: Perplexity 2-phase parallel (B/hybrid)');

  const universalPrompt = buildPerplexityFetchPromptByPhase(today, universe, 'universal');
  const topicalPrompt   = buildPerplexityFetchPromptByPhase(today, universe, 'topical');

  const tStart = Date.now();
  const [universalText, topicalText] = await Promise.all([
    callPerplexity(universalPrompt, 120_000).catch((err) => {
      console.error(`[fetch:perplexity-universal] failed: ${err.message}`);
      return '';
    }),
    callPerplexity(topicalPrompt, 120_000).catch((err) => {
      console.error(`[fetch:perplexity-topical] failed: ${err.message}`);
      return '';
    }),
  ]);
  console.log(`[fetch] both Perplexity phases complete in ${Math.round((Date.now() - tStart) / 1000)}s. uni=${universalText.length} chars, top=${topicalText.length} chars`);

  const safeParse = (raw: string, label: string): any => {
    if (!raw) {
      console.error(`[fetch:${label}] EMPTY response.`);
      return {};
    }
    try { return extractJsonObject(raw); }
    catch (err: any) {
      console.error(`[fetch:${label}] JSON parse failed: ${err.message}. First 400 chars: ${raw.slice(0, 400)}`);
      return {};
    }
  };

  const universalParsed = safeParse(universalText, 'perplexity-universal');
  const topicalParsed   = safeParse(topicalText,   'perplexity-topical');

  // Attach citations to stories that lack source_url (safety net).
  const attachCitations = (parsed: any, sectionKeys: string[]) => {
    const citations: string[] = parsed?._citations || [];
    if (citations.length === 0) return;
    for (const key of sectionKeys) {
      const arr = parsed[key];
      if (!Array.isArray(arr)) continue;
      arr.forEach((s: any, i: number) => {
        if (!s.source_url && citations[i]) s.source_url = citations[i];
      });
    }
  };
  attachCitations(universalParsed, ['major_events', 'world', 'india']);
  attachCitations(topicalParsed,   ['business', 'technology', 'climate_health', 'sport', 'culture']);

  const merged: any = {
    major_events:   universalParsed.major_events   || [],
    world:          universalParsed.world          || [],
    india:          universalParsed.india          || [],
    business:       topicalParsed.business         || [],
    technology:     topicalParsed.technology       || [],
    climate_health: topicalParsed.climate_health   || [],
    sport:          topicalParsed.sport            || [],
    culture:        topicalParsed.culture          || [],
    markets:        topicalParsed.markets          || { summary: '', indices: [] },
    lens:           universalParsed.lens           || null,
    _source:        'perplexity-2phase',
    _fetched_at:    new Date().toISOString(),
  };

  console.log(`[fetch] (Strategy B Perplexity 2-phase) merged section counts: ` +
    `major=${merged.major_events.length}, world=${merged.world.length}, india=${merged.india.length}, ` +
    `biz=${merged.business.length}, tech=${merged.technology.length}, climate=${merged.climate_health.length}, ` +
    `sport=${merged.sport.length}, culture=${merged.culture.length}, indices=${merged.markets?.indices?.length || 0}`);

  return merged as RawStories;
}

// Strategy C: gpt-4o + web_search_preview, 2-phase parallel.
// This was the Sprint 11.5 architecture (parallel two-phase) but with gpt-4o
// instead of gpt-5. gpt-4o has a 30M TPM cap vs gpt-5's 500K — no TPM cliffs.
// Uses the existing buildGpt5FetchPrompt prompts (gpt-4o follows them fine).
//
// Wall clock: max(uni, topical) ≈ 30-60s. Cost: ~$0.40-0.50/fetch (token costs
// + $30/1K search fees, ~8 searches per call).
export async function fetchStrategy_Gpt4o2Phase(universe: Universe): Promise<RawStories> {
  const today = getISTDate();
  console.log('[fetch] STRATEGY: gpt-4o web_search 2-phase parallel (C)');

  const universalPrompt = buildGpt5FetchPrompt(today, universe, 'universal');
  const topicalPrompt   = buildGpt5FetchPrompt(today, universe, 'topical');

  const tStart = Date.now();
  const [universalText, topicalText] = await Promise.all([
    callGpt4oWebSearchFallback(universalPrompt, 180_000).catch((err) => {
      console.error(`[fetch:gpt4o-universal] failed: ${err.message}`);
      return '';
    }),
    callGpt4oWebSearchFallback(topicalPrompt, 180_000).catch((err) => {
      console.error(`[fetch:gpt4o-topical] failed: ${err.message}`);
      return '';
    }),
  ]);
  console.log(`[fetch] both gpt-4o phases complete in ${Math.round((Date.now() - tStart) / 1000)}s. uni=${universalText.length} chars, top=${topicalText.length} chars`);

  const safeParse = (raw: string, label: string): any => {
    if (!raw) return {};
    try { return extractJsonObject(raw); }
    catch (err: any) {
      console.error(`[fetch:${label}] JSON parse failed: ${err.message}. First 400 chars: ${raw.slice(0, 400)}`);
      return {};
    }
  };

  const universalParsed = safeParse(universalText, 'gpt4o-universal');
  const topicalParsed   = safeParse(topicalText,   'gpt4o-topical');

  const merged: any = {
    major_events:   universalParsed.major_events   || [],
    world:          universalParsed.world          || [],
    india:          universalParsed.india          || [],
    business:       topicalParsed.business         || [],
    technology:     topicalParsed.technology       || [],
    climate_health: topicalParsed.climate_health   || [],
    sport:          topicalParsed.sport            || [],
    culture:        topicalParsed.culture          || [],
    markets:        topicalParsed.markets          || { summary: '', indices: [] },
    lens:           universalParsed.lens           || null,
    _source:        'gpt4o-2phase',
    _fetched_at:    new Date().toISOString(),
  };

  console.log(`[fetch] (Strategy C gpt-4o 2-phase) merged section counts: ` +
    `major=${merged.major_events.length}, world=${merged.world.length}, india=${merged.india.length}, ` +
    `biz=${merged.business.length}, tech=${merged.technology.length}, climate=${merged.climate_health.length}, ` +
    `sport=${merged.sport.length}, culture=${merged.culture.length}, indices=${merged.markets?.indices?.length || 0}`);

  return merged as RawStories;
}

// Per-phase Perplexity prompt builder for Strategy B (2-phase).
export function buildPerplexityFetchPromptByPhase(today: string, universe: Universe, phase: 'universal' | 'topical'): string {
  const personalisation = (universe.cities.length || universe.interests.length || universe.industries.length)
    ? `\n\nPERSONALISATION CONTEXT (for story tagging only — do NOT add personal sections):\n- Cities: ${universe.cities.join(', ')}\n- Interests: ${universe.interests.join(', ')}\n- Industries: ${universe.industries.join(', ')}\n`
    : '';

  const sourceList = 'Reuters, AP, Bloomberg, FT, WSJ, NYT, BBC, Guardian, Economist, The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, The Print, Scroll, NDTV, Times of India, Deccan Herald, Telegraph India, Tribune India, Live Law, Bar and Bench, Down to Earth, ESPNCricinfo, ESPN, Variety, TechCrunch, The Verge, Wired';

  const sharedHeader = `
═══════════════════════════════════════════════
PRIMARY DIRECTIVE: OVER-FETCH AGGRESSIVELY
═══════════════════════════════════════════════
Downstream code filters by whitelist, recency, and dedup — TYPICALLY DROPPING 30-50% of what you return. To deliver a useful brief you MUST return the UPPER BOUND of every section. Hitting the lower bound is a failure mode.

For EVERY section, run MULTIPLE distinct searches with DIFFERENT angles. A single generic search per section is not enough.
`;

  const sharedRules = `

═══════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════
1. MINIMUMS ARE NON-NEGOTIABLE. Below minimum = failure. Run more searches.
2. PARAPHRASE — your "body" is your 2-3 sentence factual summary, not the original prose. Headline is your own factual summary too.
3. SOURCE: direct article URLs from reputable publishers (${sourceList}). NO aggregators, NO social, NO Google News redirects.
4. NEVER FABRICATE.
5. PUBLISHER DIVERSITY: no publisher contributes more than 3 stories.
6. JSON ONLY: start with { and end with }. No markdown.${personalisation}`;

  if (phase === 'universal') {
    return `You are the UNIVERSAL news fetcher for Morning Brief, India's daily news digest for thoughtful urban professionals. Today is ${today} (IST).
${sharedHeader}
═══════════════════════════════════════════════
SECTIONS — minimums are floors, not ceilings
═══════════════════════════════════════════════

1. major_events — MINIMUM 5, target 6-8 stories. The day's biggest news, India + world. Genuinely consequential.
   Search angles: "top news today India", "world news today", "breaking news ${today}", "biggest story today"

2. world — MINIMUM 7, target 8-10 stories. Significant developments OUTSIDE India. Geopolitics, foreign policy, conflicts, foreign elections, major institutions.
   Search angles: "world news today", "geopolitics ${today}", "US news today", "China news today", "Europe news today", "Middle East today", "international news"

3. india — MINIMUM 7, target 8-10 stories. Domestic India: politics, Supreme Court, RBI, regulatory, corporate India, civic, infrastructure, states.
   Search angles: "India news today", "Modi government today", "Supreme Court India today", "RBI news ${today}", "India policy today", "Indian states news today"

4. lens — ONE object with 4 short analytical paragraphs (india / world / markets / watch). 2-3 sentences each. Analytical not descriptive.

═══════════════════════════════════════════════
OUTPUT SHAPE (no markdown, no preamble)
═══════════════════════════════════════════════
{
  "major_events": [ { "headline":"...", "body":"2-3 sentences", "source":"Publisher", "source_url":"https://direct-article-url", "published_at":"${today}", "industries":[], "interests":[], "must_include":false }, ... ],
  "world":        [ { ... same ... }, ... ],
  "india":        [ { ... same ... }, ... ],
  "lens": {
    "india":   "2-3 analytical sentences on India today.",
    "world":   "2-3 analytical sentences on world today.",
    "markets": "2-3 analytical sentences on markets.",
    "watch":   "2-3 sentences on the next 24-48h."
  }
}${sharedRules}

Begin now. Search aggressively across multiple angles per section. Return ONLY the JSON object.`;
  }

  // phase === 'topical'
  return `You are the TOPICAL news fetcher for Morning Brief, India's daily news digest. Today is ${today} (IST).
${sharedHeader}
═══════════════════════════════════════════════
SECTIONS — minimums are floors, not ceilings
═══════════════════════════════════════════════

1. business — MINIMUM 5, target 6-8 stories. Corporate news, earnings, M&A, IPO, regulatory, hires. India + global.
   Search angles: "business news today India", "corporate earnings today", "M&A deal today", "Indian company news today", "global business news today"

2. technology — MINIMUM 4, target 5-7 stories. Product launches, AI, big-tech regulation, cybersecurity, chips. Skip rumour.
   Search angles: "tech news today", "AI news today", "OpenAI Google Meta today", "tech regulation India", "cybersecurity news today"

3. climate_health — MINIMUM 4, target 5-7 stories. Climate events, environment policy, health (outbreaks, approvals, research).
   Search angles: "climate news today", "health news today India", "WHO news today", "disease outbreak today", "environment policy today"

4. sport — MINIMUM 4 ACROSS DIFFERENT SPORTS, target 5-7. Cricket, football, tennis, F1, badminton, hockey, kabaddi, Olympics, athletics, golf, esports. NO more than 2 cricket — force breadth.
   Search angles: "cricket news today", "tennis news today", "football news India today", "F1 news today", "badminton news today", "sports India today"

5. culture — MINIMUM 4 ACROSS DIFFERENT TYPES, target 5-7. Films, OTT, music, books, theatre, visual arts, awards, viral culture.
   Search angles: "Bollywood news today", "OTT release today", "film news today", "music news India today", "book news today", "awards news today"

6. markets — ONE object with summary (2-3 sentences) + indices (Sensex, Nifty 50, Dow Jones, Nasdaq). At 6:30 AM IST, Indian markets haven't opened — use YESTERDAY'S close. US markets closed overnight — use that close. NEVER return empty indices.
   Search angles: "Sensex Nifty close yesterday", "Dow Jones Nasdaq close ${today}"

═══════════════════════════════════════════════
OUTPUT SHAPE (no markdown, no preamble)
═══════════════════════════════════════════════
{
  "business":       [ { "headline":"...", "body":"2-3 sentences", "source":"Publisher", "source_url":"https://direct-article-url", "published_at":"${today}", "industries":[], "interests":[], "must_include":false }, ... ],
  "technology":     [ { ... same ... }, ... ],
  "climate_health": [ { ... same ... }, ... ],
  "sport":          [ { ... same ... }, ... ],
  "culture":        [ { ... same ... }, ... ],
  "markets": {
    "summary": "2-3 sentence India-anchored summary of yesterday's session + overnight US",
    "indices": [
      { "name":"Sensex",   "value":"...", "change":"+0.5%" },
      { "name":"Nifty 50", "value":"...", "change":"+0.4%" },
      { "name":"Dow Jones","value":"...", "change":"-0.2%" },
      { "name":"Nasdaq",   "value":"...", "change":"+0.1%" }
    ]
  }
}${sharedRules}

Begin now. Return ONLY the JSON object.`;
}

// ─── Fetch strategy router ──────────────────────────────────────────────────
// Switch strategies via FETCH_STRATEGY env var. Default: perplexity-single.
//
// Valid values:
//   'perplexity-single'  — Strategy A (default). Single Perplexity call, all
//                          10 sections. Cheapest, simplest, recommended.
//   'perplexity-2phase'  — Strategy B (hybrid). Two parallel Perplexity calls.
//                          Higher quality per section, 2x cost.
//   'gpt4o-2phase'       — Strategy C. Two parallel gpt-4o + web_search calls.
//                          Safety net if Perplexity has issues; ~3x cost.
// Sprint 15 — the on/off switch for the RSS engine. Default 'perplexity' keeps
// the existing engine; set RETRIEVAL=rss in Vercel to use feed-based retrieval.
// ============================================================================
// SECTION 10:  FETCH DISPATCH + LEGACY PATHS  [contains 2 DEAD functions]
// ----------------------------------------------------------------------------
// Chooses the engine (RETRIEVAL=rss uses rss-retrieval.ts; else FETCH_STRATEGY
// picks a strategy above) and runs enforceQualityRules on the result.
// NOTE: fetchNewsFromOpenAI_gpt5_legacy and fetchNewsFromOpenAI_legacy are
// defined here but NEVER CALLED (each has one self-reference only). ~232 dead
// lines kept for revert-safety — the single real shrink candidate in the file.
// Fns:   getFetchStrategy, fetchNewsFromOpenAI  |  DEAD: fetchNewsFromOpenAI_gpt5_legacy, fetchNewsFromOpenAI_legacy
// Flags: RETRIEVAL, FETCH_STRATEGY
// ============================================================================
export const RETRIEVAL = (process.env.RETRIEVAL || 'perplexity').toLowerCase();

export type FetchStrategy = 'perplexity-single' | 'perplexity-2phase' | 'gpt4o-2phase';

export function getFetchStrategy(): FetchStrategy {
  const raw = (process.env.FETCH_STRATEGY || '').trim().toLowerCase();
  if (raw === 'perplexity-2phase' || raw === 'gpt4o-2phase' || raw === 'perplexity-single') {
    return raw as FetchStrategy;
  }
  return 'perplexity-single';
}

export async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
  // Sprint 15 — when the switch is on, use the deterministic RSS engine. It
  // returns the same RawStories shape, so the quality gate + the entire
  // downstream pipeline run unchanged. The old path below is untouched.
  if (RETRIEVAL === 'rss') {
    console.log('[fetch] RETRIEVAL=rss — using the RSS engine.');
    const rss = await fetchStrategy_Rss(universe) as any;
    const cleanedRss = enforceQualityRules(rss) as any;
    cleanedRss._source = rss._source;
    cleanedRss._fetched_at = rss._fetched_at;
    // The RSS engine is deterministic (no LLM), so it only builds a mechanical
    // "top headline per section" lens — which repeated across world/watch and
    // surfaced low-importance items. Synthesise the proper analytical lens the
    // home screen expects, using the same writer the old path uses, from the
    // cleaned RSS stories. Falls back to the mechanical lens if synthesis fails.
    cleanedRss.lens = await fetchLens(cleanedRss, getISTDate()).catch((err: any) => {
      console.warn('[fetch:lens] RSS lens synthesis failed; keeping mechanical lens:', err?.message || err);
      return cleanedRss.lens;
    });
    return cleanedRss as RawStories;
  }

  const strategy = getFetchStrategy();
  console.log(`[fetch] FETCH_STRATEGY=${strategy}`);

  let raw: RawStories;
  if (strategy === 'perplexity-2phase')      raw = await fetchStrategy_Perplexity2Phase(universe);
  else if (strategy === 'gpt4o-2phase')      raw = await fetchStrategy_Gpt4o2Phase(universe);
  else                                       raw = await fetchStrategy_PerplexitySingle(universe);

  // Sprint 14.8 — apply the fetch-time quality gate to the active (non-legacy)
  // strategies. CRITICAL FIX: the Perplexity migration (Sprint 12) returned the
  // merged fetch WITHOUT running enforceQualityRules, so non-whitelisted, stale,
  // and duplicate stories survived into raw_stories. buildSubset() assumes raw
  // is already clean (its comment says "After enforceQualityRules drops …"), so
  // it ranked junk into the per-section quota; the only whitelist enforcement
  // left was the POST-WRITE strip, which deleted those stories after the writer
  // had used a slot on them — with no backfill. That silently gutted India
  // (8 pool → 2-3 rendered) on most days. Running the gate here, where
  // buildSubset expects it, makes the post-write strip a true no-op safety net.
  // (The two legacy fetchers already call enforceQualityRules internally and are
  // not routed through here, so this does not double-apply.)
  const cleaned = enforceQualityRules(raw) as any;
  // Preserve the diagnostic markers enforceQualityRules drops, so the admin
  // "fetch source" badge keeps showing the real engine / fetch time.
  cleaned._source = (raw as any)._source;
  cleaned._fetched_at = (raw as any)._fetched_at;
  return cleaned as RawStories;
}


export async function fetchNewsFromOpenAI_gpt5_legacy(universe: Universe): Promise<RawStories> {
  const today = getISTDate();

  // Sprint 12.3 (post-mortem of 12.2):
  //   - 12.2 ran universal/low sequential then topical/medium sequential
  //     with tight AbortController limits (90s, 180s). Result: both phases
  //     hit their AbortController limits in production and returned empty.
  //     This produced a briefs row with all 9 sections empty and only the
  //     generic fallback lens, causing writes to fail validation.
  //   - REVERTING to Sprint 11.5 architecture: PARALLEL 2-phase, both at
  //     'low' effort. This is the last known-working configuration — it
  //     consistently scored 60/60/61 across editions in early June.
  //   - AbortController is RETAINED but with generous 240s timeout per call,
  //     used only as a safety net against truly hung calls. With parallel
  //     'low' calls completing in 30-60s each, the timeout never fires in
  //     normal operation.
  //   - 2 parallel calls do NOT hit the 429 rate limit we saw at 3 parallel.
  //     Sprint 11 + 11.5 ran this exact pattern reliably for weeks.
  //
  // Wall-clock expectations:
  //   - universal at 'low': 30-60s typical
  //   - topical at 'low': 40-80s typical (more sections to cover)
  //   - PARALLEL total: max(uni, top) ≈ 50-80s wall clock
  //
  // Quality trade-off accepted: topical at 'low' undertfetches (2 stories
  // per section vs target 4-5). This is a known issue but acceptable —
  // 13 stories scoring 60+ beats 0 stories from a broken pipeline.
  // Quality optimisation is a Sprint 13 problem.

  console.log('[fetch] Starting PARALLEL two-phase fetch (Sprint 12.3 — both at low, revert to 11.5 baseline)...');
  const universalPrompt = buildGpt5FetchPrompt(today, universe, 'universal');
  const topicalPrompt   = buildGpt5FetchPrompt(today, universe, 'topical');

  const tStart = Date.now();
  const [universalText, topicalText] = await Promise.all([
    callGpt5Reasoning(universalPrompt, 'low', 'fetch', 240_000).catch((err) => {
      console.error('[fetch:universal] gpt-5 failed:', err.message);
      return '';
    }),
    callGpt5Reasoning(topicalPrompt, 'low', 'fetch', 240_000).catch((err) => {
      console.error('[fetch:topical] gpt-5 failed:', err.message);
      return '';
    }),
  ]);
  console.log(`[fetch] both phases complete in ${Math.round((Date.now() - tStart) / 1000)}s. universal=${universalText.length} chars, topical=${topicalText.length} chars`);

  const safeParse = (text: string, label: string): any => {
    if (!text) {
      console.error(`[fetch:${label}] EMPTY response text — call either errored (see prior log) or model returned no text. Returning {}.`);
      return {};
    }
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
  const topicalParsed   = safeParse(topicalText,   'topical');

  // Diagnostic: warn loudly if topical came back fully empty across all sections.
  const topicalStoryCount =
    (topicalParsed.business?.length || 0) +
    (topicalParsed.technology?.length || 0) +
    (topicalParsed.climate_health?.length || 0) +
    (topicalParsed.sport?.length || 0) +
    (topicalParsed.culture?.length || 0);
  const topicalIndicesCount = topicalParsed.markets?.indices?.length || 0;
  if (topicalStoryCount === 0 && topicalIndicesCount === 0) {
    console.error(`[fetch:topical] ALL TOPICAL SECTIONS EMPTY (0 stories, 0 indices). Raw text length=${topicalText.length}. Investigate.`);
  } else if (topicalStoryCount === 0) {
    console.warn(`[fetch:topical] All topical story sections empty (markets indices=${topicalIndicesCount}). Investigate.`);
  }

  // Merge into single RawStories shape. Empty arrays for missing sections.
  const merged: any = {
    major_events:   universalParsed.major_events || [],
    world:          universalParsed.world        || [],
    india:          universalParsed.india        || [],
    business:       topicalParsed.business       || [],
    technology:     topicalParsed.technology     || [],
    climate_health: topicalParsed.climate_health || [],
    sport:          topicalParsed.sport          || [],
    culture:        topicalParsed.culture        || [],
    markets:        topicalParsed.markets        || { summary: '', indices: [] },
    lens:           universalParsed.lens         || null,
  };

  console.log(`[fetch] gpt-5 merged raw section counts (Sprint 12.1 sequential medium): ` +
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

export async function fetchNewsFromOpenAI_legacy(universe: Universe): Promise<RawStories> {
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
