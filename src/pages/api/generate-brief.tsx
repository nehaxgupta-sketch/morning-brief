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
//
// Sprint 13 — Follow a Story: new mode=storylines (runs after write), plus
// CRON_SECRET enforcement, URL liveness check, deterministic scorer
// penalties, material-relevance industry prompt, tail_used_urls cleanup.
//
// Sprint 27.1 (2026-07-05 audit) — this file's share of the deployment-audit
// fixes: cross-section split-event dedup (N1, SECTION_DEDUP_XS); placement
// cut-accounting + exLead stamping (N3); F7 invariant checker made schema-aware,
// brief-wide, and honest about its orphan promise (N5/N3); coherence disposition
// logging so no flagged issue can be silently ignored (N7); strict deep-coverage
// matching (N4, DEEP_COVERAGE_STRICT); writer/validator contract repairs —
// one_chart nullable + short-field padding (N10, WRITER_FIELD_REPAIR); and a
// shipped-count telemetry line (N6). Personalised-surface and admin-RCA fixes
// live in their own files (Sprint 27.2 / 27.3).

// ============================================================================
// SECTION INDEX  (generated navigation aid -- see companion
// generate-brief-section-map.md for the prose walkthrough)
// ----------------------------------------------------------------------------
// To edit cheaply: find the section below, grep '^// SECTION NN:' to jump
// to it, and load/replace only that banner-to-next-banner block instead of
// the whole file. Sections are contiguous and cover the file top to bottom.
//
//    1. IMPORTS, ENV, SUPABASE CLIENT & REQUEST AUTH
//    2. TYPES & INTERFACES
//    3. ZOD SCHEMAS & JSON EXTRACTION
//    4. PERSONALISATION UNIVERSE & PROMPT SCAFFOLDING
//    5. OPENAI SECTION-FETCH HELPERS
//    6. MARKETS & HOME-SCREEN LENS
//    7. GPT-5 REASONING FETCH PATH
//    8. PERPLEXITY & GPT-4o WEB-SEARCH FETCH
//    9. FETCH STRATEGIES (single / 2-phase)
//   10. FETCH DISPATCH + LEGACY PATHS  [contains 2 DEAD functions]
//   11. RECENCY & DEDUP PRIMITIVES
//   12. PLACEMENT ENGINE (PLACEMENT_V2)
//   13. SECTION-LEVEL DEDUP  (Sprint 26 F2 / 27.1 N1)
//   14. enforceQualityRules  --  THE QUALITY GATE  (~400 lines)
//   15. WRITER PREP, RANKING & SUBSET
//   16. EDITION WRITERS (5min / 10min / deep)
//   17. CHAT TRANSPORT + RAW->STORY TEMPLATES + BACKFILL
//   18. COHERENCE CHECK, VALIDATION & REPAIR
//   19. FINAL-BRIEF INVARIANT CHECKER  (Sprint 26 F7)
//   20. PERSIST & PUSH
//   21. CONTENT HYGIENE: LIVENESS, CROSS-SECTION DEDUP & SANITIZE
//   22. WRITER ORCHESTRATION  (runWriterForEdition)
//   23. CRON MODES: fetch / write / push
//   24. GROUND TRUTH & COVERAGE SCORING
//   25. LLM SCORER + score / full MODES
//   26. TAILS (city / interest / industry)
//   27. STORYLINES (Follow a Story)
//   28. MAIN HANDLER  (mode router)
// ============================================================================

// ============================================================================
// SECTION  1:  IMPORTS, ENV, SUPABASE CLIENT & REQUEST AUTH
// ----------------------------------------------------------------------------
// Module imports (whitelist, cost-log, log-capture, editorial-safety, RSS
// engine), maxDuration config, API/OneSignal env keys, the Supabase client,
// CRON_SECRET auth, and IST date / weekend helpers.
// Fns:   authoriseRequest, getISTDate, isWeekend
// Flags: CRON_SECRET (auth)
// ============================================================================
import type { NextApiRequest, NextApiResponse } from 'next';
// Sprint 11: shared whitelist module. Source-of-truth for all source-URL
// validation across generate-brief and personalise-briefs.
import {
  isWhitelistedSource,
  publisherKey,
  sourceTier,
} from '@/lib/whitelist';
// Sprint 11: per-call cost capture.
import {
  logOpenAICost,
  extractUsageFromChatCompletion,
  extractUsageFromResponses,
} from '@/lib/cost-log';
import { attachLogCapture } from '@/lib/log-capture';
import { applyCitySafety } from '@/lib/editorial-safety';
// Sprint 15: the RSS retrieval engine (used when RETRIEVAL=rss; old path otherwise).
import { fetchStrategy_Rss, fetchStoriesFromFeeds } from '@/lib/rss-retrieval';
// Modularization stage 1: shared env + Supabase client (declarations moved to ./env).
import {
  supabase,
  OPENAI_API_KEY,
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
} from '@/lib/generate-brief/env';
// Modularization stage 2: interfaces + schemas moved to ./types.
import type {
  Edition,
  RawStory,
  MarketIndex,
  RawStories,
  MicroStory,
  FullStory,
  BriefQuick,
  BriefDaily,
  BriefEditorial,
  BriefContent,
} from '@/lib/generate-brief/types';
import {
  MicroStorySchema,
  BriefQuickSchema,
  BriefDailySchema,
  BriefEditorialSchema,
  LensSchema,
} from '@/lib/generate-brief/types';
// Modularization stage 3: pure helpers moved to ./utils.
import {
  getISTDate,
  isWeekend,
  extractJsonObject,
  sleep,
  normaliseUrlForCompare,
  isWithinRecencyWindow,
  STOPWORDS,
  significantWords,
  SEMANTIC_DEDUP_THRESHOLD,
  semanticOverlap,
  eventSignature,
  isSameEvent,
  prefixTokenMatch,
  isSameEventPrefix,
} from '@/lib/generate-brief/utils';

// 300s = 5min. Vercel Pro caps at 300; Hobby with Fluid Compute enabled also
// reaches 300. gpt-5 with reasoning web_search at 'low' effort runs ~150-200s.
// REQUIRES Fluid Compute toggle in Vercel project settings → Functions.
export const config = { maxDuration: 300 };

// ─── Env / clients ──────────────────────────────────────────────────────────

// Env + Supabase client now live in @/lib/generate-brief/env (imported above).

// ─── Sprint 13: request authorisation (CRON_SECRET enforcement) ─────────────
//
// Accepts EITHER of:
//   1. Authorization: Bearer <CRON_SECRET>          → cron-job.org jobs
//   2. Authorization: Bearer <supabase access JWT>  → /admin buttons (the
//      admin page attaches the logged-in user's session token)
//
// Rollout safety: if the CRON_SECRET env var is NOT set, all requests pass
// (current open behaviour) and a warning is logged. Set CRON_SECRET in
// Vercel → add the Bearer header to all cron-job.org jobs → enforcement is
// live with zero downtime.

async function authoriseRequest(req: NextApiRequest): Promise<{ ok: boolean; via: string }> {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!secret) {
    console.warn('[auth] CRON_SECRET not set — endpoint is open. Set it in Vercel env to enforce.');
    return { ok: true, via: 'open' };
  }
  if (token && token === secret) return { ok: true, via: 'cron-secret' };
  if (token) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) return { ok: true, via: `user:${data.user.email || data.user.id}` };
    } catch { /* fall through */ }
  }
  return { ok: false, via: 'unauthorised' };
}

// Date helpers (getISTDate, isWeekend) -> @/lib/generate-brief/utils

// ─── Source whitelist ───────────────────────────────────────────────────────
// Sprint 11: moved to @/lib/whitelist (shared with personalise-briefs.tsx).
// TIER_1_DOMAINS, extractHostname, isWhitelistedSource, publisherKey are
// imported at the top of this file.

// ─── Types ───────────────────────────────────────────────────────────────────

// ============================================================================
// SECTIONS 2-3 (interfaces + Zod schemas) moved to @/lib/generate-brief/types
// (imported at top). The JSON-extraction helper now lives in ./utils too.
// ============================================================================



// ─── Phase 1: Personalisation universe ──────────────────────────────────────

// ============================================================================
// SECTION  4:  PERSONALISATION UNIVERSE & PROMPT SCAFFOLDING
// ----------------------------------------------------------------------------
// Loads the cities/interests/industries universe from opted-in profiles and
// builds the reusable prompt fragments (source-whitelist block, tags block,
// story-shape spec) shared by every fetch prompt.
// Fns:   loadPersonalisationUniverse, sourceWhitelistBlock, tagsBlockFor, storyShape
// Flags: -
// ============================================================================
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
//
// Architecture: parallel per-section fetches. One large prompt covering 8
// sections was unreliable — gpt-4o would do a single web search, land on a
// roundup page, and return 1-2 stories. Section-scoped prompts (each with
// one clear job) get the model to actually iterate searches per section.
// Trade-off: 8 API calls instead of 1, slightly higher cost. Wall-clock
// time stays similar because they run in parallel via Promise.allSettled.

// ─── Shared prompt fragments ────────────────────────────────────────────────

function sourceWhitelistBlock(): string {
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

function tagsBlockFor(universe: Universe): string {
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

function storyShape(today: string): string {
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
async function callOpenAISection(prompt: string, sectionName: string, maxTokens = 4000): Promise<any> {
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

async function fetchListSection(
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

async function fetchSingleSection(
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
const MARKETS_TRADING_GUARD = (process.env.MARKETS_TRADING_GUARD || 'on').toLowerCase() !== 'off';
// Fixed-date NSE holidays (always closed). Movable holidays (Diwali, Holi, etc.)
// shift year to year — supply the current year's dates via NSE_EXTRA_HOLIDAYS as
// a comma-separated YYYY-MM-DD list (env only, no code change). The weekend check
// carries the common case; the fixed set below is unambiguous.
const NSE_FIXED_HOLIDAYS = new Set(['01-26', '08-15', '10-02', '12-25']); // MM-DD
function nseExtraHolidays(): Set<string> {
  return new Set((process.env.NSE_EXTRA_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean));
}
function isIndianMarketOpen(istDateStr: string): boolean {
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
function marketsDayContext(today: string): string {
  if (!MARKETS_TRADING_GUARD) return '';
  if (isIndianMarketOpen(today)) {
    return `MARKET STATUS: Indian exchanges (NSE/BSE) trade today. Report the session's actual direction from real data; if Indian markets have not closed yet at the time of writing, use the most recent confirmed close and label it (e.g. "at yesterday's close"). Never invent a number.\n`;
  }
  return `MARKET STATUS: Indian exchanges (NSE/BSE) are CLOSED today (weekend or holiday). Do NOT state any "today" move for the Sensex or Nifty — no daily percentage, no "markets were flat/up/down today"; asserting one is a factual error. Instead lead with market SENTIMENT and positioning: the global cues (overnight US session, oil, the dollar, geopolitics) and the themes investors will weigh when trading resumes. You may reference the last trading session only if explicitly labelled (e.g. "at Friday's close"). Close on what to watch when markets reopen.\n`;
}

async function fetchMarkets(today: string): Promise<{ summary: string; indices: MarketIndex[] }> {
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

async function fetchLens(rawStories: RawStories, today: string): Promise<{ world: string; india: string; markets: string; watch: string }> {
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
async function callGpt5Reasoning(
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
function buildGpt5FetchPrompt(today: string, universe: Universe, phase: 'universal' | 'topical' = 'universal'): string {
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
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || 'sonar-pro';

async function callPerplexity(prompt: string, timeoutMs: number = 120_000): Promise<string> {
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
async function callGpt4oWebSearchFallback(prompt: string, timeoutMs: number = 180_000): Promise<string> {
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
function buildPerplexityFetchPrompt(today: string, universe: Universe): string {
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
function countCoreStories(rawText: string): number {
  if (!rawText) return 0;
  let parsed: any;
  try { parsed = extractJsonObject(rawText); } catch { return 0; }
  const CORE = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  return CORE.reduce((n, s) => n + (Array.isArray(parsed?.[s]) ? parsed[s].length : 0), 0);
}

async function fetchStrategy_PerplexitySingle(universe: Universe): Promise<RawStories> {
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
async function fetchStrategy_Perplexity2Phase(universe: Universe): Promise<RawStories> {
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
async function fetchStrategy_Gpt4o2Phase(universe: Universe): Promise<RawStories> {
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
function buildPerplexityFetchPromptByPhase(today: string, universe: Universe, phase: 'universal' | 'topical'): string {
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
const RETRIEVAL = (process.env.RETRIEVAL || 'perplexity').toLowerCase();

type FetchStrategy = 'perplexity-single' | 'perplexity-2phase' | 'gpt4o-2phase';

function getFetchStrategy(): FetchStrategy {
  const raw = (process.env.FETCH_STRATEGY || '').trim().toLowerCase();
  if (raw === 'perplexity-2phase' || raw === 'gpt4o-2phase' || raw === 'perplexity-single') {
    return raw as FetchStrategy;
  }
  return 'perplexity-single';
}

async function fetchNewsFromOpenAI(universe: Universe): Promise<RawStories> {
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


async function fetchNewsFromOpenAI_gpt5_legacy(universe: Universe): Promise<RawStories> {
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

async function fetchNewsFromOpenAI_legacy(universe: Universe): Promise<RawStories> {
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
// SECTION 11 (recency + event-dedup primitives) -> @/lib/generate-brief/utils

// Sprint 20.2 — the front page over-provisions to 12 leads for RANKING, but the
// writer takes only the top ~5 into major_events. Deduping india/world against
// all 12 ORPHANED the leads ranked 6-12: genuinely big India stories (a fatal
// building collapse, a passport-policy ruling, a new IB chief) were lifted onto
// the front page, deduped out of India, then never written because they didn't
// make the major top-5. Cap the dedup set to the written depth so those stories
// stay in their home section and get written. Default 6 (top-5 written + 1
// ordering buffer); MAJOR_DEDUP_DEPTH=12 restores the prior behaviour. The
// post-write cross-section dedup remains the backstop against any rare overlap.
const MAJOR_DEDUP_DEPTH = Math.max(1, parseInt(process.env.MAJOR_DEDUP_DEPTH || '6', 10));
// ─── Sprint 22 — PLACEMENT_V2: one event → one home, by the engine's eventId ──
//
// Replaces the four uncoordinated fuzzy matchers (semantic-vs-major, exact
// fingerprint, within-section eventSignature, post-write URL) with a single
// structural invariant: every story carries the engine's event-cluster id
// (rss-retrieval stamps it), so an event is placed in exactly ONE section and a
// duplicate becomes impossible by construction — not by tuning a threshold.
//
// Behind PLACEMENT_V2 (default off — ships dark; flip on, run on the shared
// brief, confirm the [placement-v2] log, then default it). When on, matcher 1
// (the over-aggressive false-dropper) is skipped; the exact/near-dup passes are
// left as harmless subsets; this pass is authoritative and runs last.
// ============================================================================
// SECTION 12:  PLACEMENT ENGINE (PLACEMENT_V2)
// ----------------------------------------------------------------------------
// One-event-one-home authority. placeByEventId() assigns each clustered event
// a single home section and removes the front-page repeat (re-injection
// fallback lives in the writer path). dropSemanticDuplicatesAgainstMajor()
// clears topical twins of a curated lead.
// Fns:   placeByEventId, dropSemanticDuplicatesAgainstMajor
// Flags: PLACEMENT_V2, PLACEMENT_OVERLAY, PLACEMENT_MAJOR_CAP(=5)
// ============================================================================
const PLACEMENT_V2 = (process.env.PLACEMENT_V2 || '').toLowerCase() === 'on';
const PLACEMENT_MAJOR_CAP = 5; // front-page capacity (Sprint 22 decision)
// Shared-brief precedence (decided): india above world for the audience.
const PLACEMENT_ORDER = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

// ─── Sprint 23 — front-page OVERLAY (one-event-one-home, minus the front page) ─
// PLACEMENT_V2 gives major_events the FIRST claim on every event, which lifts the
// day's biggest stories OUT of world/india — so the topical tabs lead with
// leftovers (a wildfire over Iran-US; a cricket record over a fatal flood). The
// RSS engine already keeps each lead in its topical pool (see rss-retrieval:
// "India and World keep their FULL pools"); only the downstream dedup drains
// them. PLACEMENT_OVERLAY treats major_events as a HIGHLIGHT LAYER, not an
// extraction: one-event-one-home still holds across the 7 topical sections (no
// topical duplication), but a front-page lead ALSO renders in its topical home.
// Effective only when PLACEMENT_V2 is on.
//
// ─── DECISION (2026-06-29) — suppress the repeat: EXTRACTION, not overlay ──────
// The overlay made a front-page lead ALSO appear in its topical home (the
// newspaper repeat). Product decision: an event must appear exactly ONCE. So
// PLACEMENT_OVERLAY now DEFAULTS OFF — major_events claims its events out of the
// topical sections (extraction). The orphaning bug that extraction historically
// risked ("event was on the front page → dropped from india → then the front
// page over-filled/under-wrote → it vanished from BOTH") is structurally
// impossible here, because:
//   (a) the front page is trimmed to capacity FIRST (below), so an event ranked
//       out of the top-5 is never claimed, and its topical twin survives; and
//   (b) the topical twin ALWAYS exists — rss-retrieval builds major_events by
//       SELECTING (copying) PoolItems that REMAIN in pool.india/world (see
//       rss-retrieval ~L1018: the lead is filled from indiaRanked/restRanked
//       without removing them). So "fallback to home" is automatic: dropping an
//       event from the front page cannot orphan it — the section copy is intact.
// Revert: PLACEMENT_OVERLAY=on restores the newspaper repeat exactly.
const PLACEMENT_OVERLAY = (process.env.PLACEMENT_OVERLAY || 'off').toLowerCase() === 'on';
// Topical precedence (front page excluded — it overlays, it does not claim).
const PLACEMENT_TOPICAL_ORDER = ['india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

function placeByEventId(cleaned: any, eventHomeSection?: Map<number, string>, curatedLeadCount?: number): void {
  // 1. Trim the front page to capacity FIRST. A lead ranked below the cut must
  //    NOT vanish: it falls back to its topical home. The original design only
  //    *checked* whether the topical twin still existed — but recency/cap/near-dup
  //    run before this and often drop the twin, so cut leads orphaned (proven live:
  //    "ASSERT FAILED — 7 event(s) … NO topical home"). Fix (Sprint 25.1): when a
  //    cut lead's twin is gone, RE-INJECT the cut story object itself into its home
  //    section (captured from the unfiltered pool in eventHomeSection). Guarantees
  //    fallback by construction instead of hoping the twin survived.
  let cutRehomed = 0;     // cut lead whose twin already survived in its section
  let cutReinjected = 0;  // cut lead we had to re-insert (twin was filtered away)
  let cutKeptOnFront = 0; // cut lead with no topical home in the pool — kept on the front page
  let orphaned = 0;       // cut lead with no recoverable home (should now be ~0)
  const atPlacement = Array.isArray(cleaned.major_events) ? cleaned.major_events.length : 0;
  if (Array.isArray(cleaned.major_events) && cleaned.major_events.length > PLACEMENT_MAJOR_CAP) {
    const cut = cleaned.major_events.slice(PLACEMENT_MAJOR_CAP);
    cleaned.major_events = cleaned.major_events.slice(0, PLACEMENT_MAJOR_CAP);

    // Which eventIds currently survive in some topical section?
    const topicalIds = new Set<number>();
    for (const sec of PLACEMENT_TOPICAL_ORDER) {
      for (const s of (cleaned[sec] || [])) {
        if (s && typeof s.eventId === 'number') topicalIds.add(s.eventId);
      }
    }

    // Sprint 27.1 (N3) — stamp every cut lead's surviving representation as an
    // ex-front-page lead (`exLead` + its curated rank). buildSubset ranks and
    // F7's delivery report read these stamps: the 07-05 audit found three
    // curated leads (nw up to 7) that never reached any reader, with no line
    // anywhere saying so. Stamping makes their fate trackable end-to-end.
    let cutIdx = 0;
    for (const story of cut) {
      cutIdx++;
      const leadRank = PLACEMENT_MAJOR_CAP + cutIdx; // curated rank 6..12
      const id = (story && typeof story.eventId === 'number') ? story.eventId : null;
      if (id == null) { orphaned++; continue; } // no id → cannot re-home; counted, logged below
      if (topicalIds.has(id)) {
        cutRehomed++;
        // Stamp the SURVIVING TWIN in its topical section.
        for (const sec of PLACEMENT_TOPICAL_ORDER) {
          const arr = cleaned[sec];
          if (!Array.isArray(arr)) continue;
          const twin = arr.find((s: any) => s && typeof s.eventId === 'number' && s.eventId === id);
          if (twin) { (twin as any).exLead = true; (twin as any).leadRank = leadRank; break; }
        }
        continue;
      }
      // Twin was filtered away → re-inject the cut story into its captured home.
      const home = eventHomeSection?.get(id);
      (story as any).exLead = true;
      (story as any).leadRank = leadRank;
      if (home && Array.isArray(cleaned[home])) {
        cleaned[home].push(story);
        topicalIds.add(id);
        cutReinjected++;
      } else if (home === undefined && eventHomeSection) {
        // Event never had a topical home in the unfiltered pool (e.g. a major-only
        // event). Keep it on the front page rather than lose it — the safe fallback.
        cleaned.major_events.push(story);
        cutKeptOnFront++;
      } else {
        orphaned++; // truly unrecoverable — should be ~0; named loudly below.
      }
    }
  }

  // 2. One event → one home: walk sections in precedence; the first section to
  //    carry an event keeps it, every later occurrence (cross- OR within-section)
  //    is dropped. Stories with no eventId can't be matched, so they're kept.
  const claimed = new Map<number, string>();
  let removed = 0;
  // OVERLAY: the front page is a highlight layer, not a claimant — walk the
  // TOPICAL sections only, so a lead stays in its topical home AND on the front
  // page. Non-overlay (legacy): major_events is first and claims events out of
  // the topical sections (extraction).
  const placementOrder = PLACEMENT_OVERLAY ? PLACEMENT_TOPICAL_ORDER : PLACEMENT_ORDER;
  for (const sec of placementOrder) {
    const arr = cleaned[sec];
    if (!Array.isArray(arr)) continue;
    const kept: any[] = [];
    for (const s of arr) {
      const id = (s && typeof s.eventId === 'number') ? s.eventId : null;
      if (id == null) { kept.push(s); continue; }
      if (claimed.has(id)) { removed++; continue; }
      claimed.set(id, sec);
      kept.push(s);
    }
    cleaned[sec] = kept;
  }

  // 3. Phase-D assert — holds by construction; log loudly if ever violated so a
  //    clustering regression is a single named line, not silent duplication.
  const homeOf = new Map<number, string>();
  let collisions = 0;
  for (const sec of placementOrder) {
    for (const s of (cleaned[sec] || [])) {
      const id = (s && typeof s.eventId === 'number') ? s.eventId : null;
      if (id == null) continue;
      const prev = homeOf.get(id);
      if (prev && prev !== sec) collisions++;
      else homeOf.set(id, sec);
    }
  }
  // Sprint 27.1 (N3) — full cut accounting. The 07-05 run logged "1 twin +
  // 5 re-injected" against 7 cuts because (a) leads lost to pre-placement
  // filters were invisible and (b) kept-on-front was folded into re-injected.
  // Every lead is now in exactly one bucket, and curated vs at-placement is
  // explicit, so cut = twin + re-injected + kept-on-front + orphaned holds
  // arithmetically on every run.
  const cutTotal = Math.max(0, atPlacement - PLACEMENT_MAJOR_CAP);
  const lostPre = typeof curatedLeadCount === 'number' && curatedLeadCount > 0
    ? Math.max(0, curatedLeadCount - atPlacement) : null;
  const acct = `curated=${curatedLeadCount ?? 'n/a'} at-placement=${atPlacement}${lostPre != null ? ` lost-to-pre-placement-filters=${lostPre}` : ''}, cut=${cutTotal} → twin-survived=${cutRehomed} + re-injected=${cutReinjected} + kept-on-front=${cutKeptOnFront} + orphaned=${orphaned}`;
  if (collisions > 0) {
    console.error(`[placement-v2] ASSERT FAILED — ${collisions} event(s) in >1 section after placement. (${acct})`);
  } else if (orphaned > 0) {
    console.error(`[placement-v2] ASSERT FAILED — ${orphaned} cut event(s) unrecoverable (no eventId/home; lost). (${acct})`);
  } else {
    console.log(`[placement-v2] ${PLACEMENT_OVERLAY ? 'overlay (front-page highlights also shown in their topical home)' : 'extraction (one home per event; front-page leads not repeated topically)'} — ${claimed.size} topical event(s) placed, ${removed} cross/within-section dupe(s) removed, major≤${PLACEMENT_MAJOR_CAP}. Accounting: ${acct}.`);
  }
}

function dropSemanticDuplicatesAgainstMajor(raw: any): { kept: any; droppedCount: number } {
  const majorSets = (raw.major_events || []).slice(0, MAJOR_DEDUP_DEPTH).map((s: any) => significantWords(s?.headline || ''));
  if (majorSets.length === 0) return { kept: raw, droppedCount: 0 };

  let droppedCount = 0;
  const filterSection = (arr: any[], sectionName: string): any[] => {
    if (!Array.isArray(arr)) return arr;
    return arr.filter((story) => {
      const set = significantWords(story?.headline || '');
      for (const mset of majorSets) {
        if (semanticOverlap(set, mset) >= SEMANTIC_DEDUP_THRESHOLD) {
          console.log(`[semantic-dedup] dropping ${sectionName} story (overlaps major_events): "${(story?.headline || '').slice(0, 80)}"`);
          droppedCount++;
          return false;
        }
      }
      return true;
    });
  };

  const kept = {
    ...raw,
    world: filterSection(raw.world, 'world'),
    india: filterSection(raw.india, 'india'),
  };
  return { kept, droppedCount };
}

// ─── Sprint 26 (F2) — within-section split-event guard ──────────────────────
// Default ON. The RCA's #1 reader-visible defect: two "massive Russian strike
// on Kyiv" stories shipped in world with DIFFERENT eventIds (the embeddings
// clustering split them at cosine < threshold), so neither placeByEventId
// (dedups by eventId) nor the exact-match near-dup pass (shared only 3 tokens,
// one short of the bar) collapsed them. This flag adds a SECOND near-dup pass
// AFTER placeByEventId using the prefix-aware bar (russia~russian ⇒ 4 shared ⇒
// merge), keeping the better-corroborated copy. It logs every collapse and is
// env-revertible (SECTION_DEDUP=false). It does NOT touch the engine's
// clustering threshold (RCA §10 #4).
// ============================================================================
// SECTION 13:  SECTION-LEVEL DEDUP  (Sprint 26 F2 / 27.1 N1)
// ----------------------------------------------------------------------------
// Prefix-aware within-section (and cross-section, _XS) collapse of split-event
// duplicates the exact-match pass misses (e.g. russia/russian), keeping the
// higher-eventCorr copy. Runs after placement so re-injection can't reintroduce.
// Fns:   prefixSharedTokens, inheritCollapsedEvidence
// Flags: SECTION_DEDUP, SECTION_DEDUP_XS
// ============================================================================
const SECTION_DEDUP = (process.env.SECTION_DEDUP || 'true').toLowerCase() !== 'false';

// ─── Sprint 27.1 (N1) — CROSS-section split-event guard ─────────────────────
// Default ON. The 2026-07-05 audit's worst reader-visible defect: the same
// Meta/Instagram-CSAM event shipped in BOTH major_events and business, in both
// editions — the same clustering-split root cause as the Kyiv pair, expressed
// ACROSS sections. F2's pass is within-section only, and placeByEventId dedups
// by eventId (the two copies had different ids), so nothing compared them.
// This pass extends the same prefix-aware collapse across section boundaries,
// walking sections in placement-priority order: the copy in the higher-priority
// section (major_events first) keeps its home; the later occurrence is dropped
// and its corroboration/newsworthiness/must_include are inherited by the kept
// copy (so a merged event ranks as the SUM of its evidence, not the survivor's
// alone). A must_include newcomer whose earlier twin is NOT must_include is
// kept-both + logged loud (mislabel safety — same principle as F1). Requires
// SECTION_DEDUP=on; independently revertible with SECTION_DEDUP_XS=false.
// Logs `[section-dedup:xs] …` per collapse, including the shared tokens, so an
// over-merge (the F2c caution) is diagnosable from the run log.
const SECTION_DEDUP_XS = (process.env.SECTION_DEDUP_XS || 'true').toLowerCase() !== 'false';

// The tokens two event-signatures actually share under the prefix-aware bar —
// logged with every collapse so over-merges on generic vocabularies (fifa/world/
// cup/prediction — the F2c caution) are visible, not inferred.
function prefixSharedTokens(a: Set<string>, b: Set<string>): string[] {
  const A = Array.from(a);
  const B = Array.from(b);
  const out: string[] = [];
  for (const x of A) {
    for (const y of B) {
      if (prefixTokenMatch(x, y)) { out.push(x === y ? x : `${x}~${y}`); break; }
    }
  }
  return out;
}

// Merge semantics when a split-event pair collapses (within- OR cross-section):
// the kept copy inherits the pair's best evidence — max eventCorr, max nw, and
// must_include if either had it. Sprint 27.1 (N3): the 07-05 run collapsed a
// front-page lead into its twin and the twin then lost the buildSubset cut —
// deleting the event's only shipped chance. Inheriting the evidence gives the
// survivor the rank the EVENT earned, not the rank one copy earned.
function inheritCollapsedEvidence(kept: any, dropped: any): void {
  if (!kept || !dropped) return;
  const kc = Number(kept.eventCorr || 0), dc = Number(dropped.eventCorr || 0);
  if (dc > kc) kept.eventCorr = dc;
  const kn = typeof kept.nw === 'number' ? kept.nw : null;
  const dn = typeof dropped.nw === 'number' ? dropped.nw : null;
  if (dn != null && (kn == null || dn > kn)) kept.nw = dn;
  if (dropped.must_include) kept.must_include = true;
  if (dropped.exLead && !kept.exLead) { kept.exLead = true; kept.leadRank = dropped.leadRank; }
}

// ============================================================================
// SECTION 14:  enforceQualityRules  --  THE QUALITY GATE  (~400 lines)
// ----------------------------------------------------------------------------
// The central fetch-time gate, run once on the pool: whitelist gate, recency
// window, cross-section dedup, publisher cap, within-section same-event
// collapse, then placeByEventId (when PLACEMENT_V2). Output becomes raw_stories;
// buildSubset (Section 15) derives per-edition subsets from it. EDIT WITH CARE.
// Fns:   enforceQualityRules
// Flags: PUBLISHER_CAP (+ consumes Sections 11-13 flags)
// ============================================================================
function enforceQualityRules(raw: any): RawStories {
  // Sprint 27.1 (N3) — census the CURATED front page before any filter runs.
  // The 07-05 audit found placement telemetry under-accounting (12 curated,
  // 7 cut, only 6 explained): leads lost to recency/whitelist/near-dup BEFORE
  // placeByEventId were invisible. Passing the curated count in lets the
  // placement line report curated vs at-placement vs cut explicitly.
  const curatedLeadCount = Array.isArray(raw?.major_events) ? raw.major_events.length : 0;

  // First pass: semantic dedup of world/india against major_events.
  // Sprint 22: PLACEMENT_V2's eventId one-home pass supersedes this word-overlap
  // matcher (more reliable, and it never false-drops a distinct story) — skip it
  // when the flag is on.
  if (!PLACEMENT_V2) {
    const { kept: rawAfterSemanticDedup, droppedCount: semanticDropped } =
      dropSemanticDuplicatesAgainstMajor(raw);
    if (semanticDropped > 0) {
      console.log(`[enforce] Semantic dedup dropped ${semanticDropped} world/india stories overlapping the top ${MAJOR_DEDUP_DEPTH} major_events leads.`);
    }
    raw = rawAfterSemanticDedup;
  }

  const dropped: { section: string; reason: string; headline?: string; url?: string }[] = [];
  const seenFingerprints = new Set<string>();

  function fingerprint(s: any): string {
    const h = (s?.headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const u = (s?.source_url || '').toLowerCase().split('?')[0];
    return `${h}|${u}`;
  }

  // Priority for dedup — earlier wins.
  const priority = ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture'];

  // ─── Sprint 25.1 — capture eventId → topical home BEFORE any filtering ───────
  // placeByEventId (end of this function) trims the front page to 5 and re-homes
  // the cut leads. The original design assumed each cut lead's topical twin would
  // still be present in its section at that point — but recency/cap/near-dup run
  // FIRST and frequently drop the twin, so the cut lead orphaned (proven live:
  // "[placement-v2] ASSERT FAILED — 7 event(s) … NO topical home"). Fix: snapshot
  // each event's home section from the UNFILTERED `raw` here, so placeByEventId can
  // RE-INJECT a cut lead into its home even when the twin was filtered away. We
  // record the FIRST topical section (in priority order) that carries each eventId;
  // major_events is skipped (it is the front page, not a home).
  const eventHomeSection = new Map<number, string>();
  for (const sec of priority) {
    if (sec === 'major_events') continue;
    const arr = (raw as any)[sec];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const id = (s && typeof s.eventId === 'number') ? s.eventId : null;
      if (id == null) continue;
      if (!eventHomeSection.has(id)) eventHomeSection.set(id, sec);
    }
  }

  function processList(section: string, list: any[]): RawStory[] {
    const kept: RawStory[] = [];
    // OVERLAY: major_events is a highlight layer — dedup it WITHIN itself, but
    // don't let its fingerprints block the identical topical copies (so a lead
    // survives in world/india too). Falls back to the shared set when overlay is
    // off, preserving the original cross-section "earlier-section-wins" dedup.
    const overlayMajor = PLACEMENT_V2 && PLACEMENT_OVERLAY && section === 'major_events';
    const seen = overlayMajor ? new Set<string>() : seenFingerprints;
    for (const story of list || []) {
      if (!story || typeof story !== 'object') continue;

      // Source whitelist check
      if (!isWhitelistedSource(story.source_url)) {
        dropped.push({ section, reason: 'non-whitelisted source', headline: story.headline, url: story.source_url });
        continue;
      }

      // Recency check — 24h default, 72h for major_events
      if (!isWithinRecencyWindow(story.published_at, section)) {
        console.log(`[recency] dropping ${section} story (older than window): "${(story.headline || '').slice(0, 80)}" published_at=${story.published_at}`);
        dropped.push({ section, reason: 'outside recency window', headline: story.headline });
        continue;
      }

      // Dedup
      const fp = fingerprint(story);
      if (seen.has(fp)) {
        dropped.push({ section, reason: 'duplicate of higher-priority section', headline: story.headline });
        continue;
      }
      seen.add(fp);

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
    if (!isWithinRecencyWindow(story.published_at, section)) {
      console.warn(`Single-section ${section} dropped (outside recency window): published_at=${story.published_at}`);
      dropped.push({ section, reason: 'outside recency window', headline: story.headline });
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
    sport: [],
    culture: [],
    markets: raw?.markets || { summary: '', indices: [] },
    lens: raw?.lens || { world: '', india: '', markets: '', watch: '' },
  };

  // Walk priority order so dedup picks the highest-priority section first.
  // All sections including sport/culture are arrays as of Sprint 9.
  for (const sec of priority) {
    const arr = raw?.[sec];
    (cleaned as any)[sec] = processList(sec, Array.isArray(arr) ? arr : []);
  }

  // Markets indices sanity
  if (!cleaned.markets.indices || cleaned.markets.indices.length !== 4) {
    console.warn('Markets indices count off — got', cleaned.markets.indices?.length);
  }

  // ─── Sprint 11 / 14.8: publisher diversity cap (now PER-SECTION) ─────────
  // Originally a GLOBAL cap of 3/publisher across the whole fetch. That proved
  // far too aggressive once enforceQualityRules began running on the Perplexity
  // pool: Indian news is dominated by a few big mastheads, so a healthy 42-story
  // retry pool (6/6/6/6/5/4/5/4 on the 18-Jun 11:25 run) collapsed to ~9 —
  // world/business/tech went to ZERO because indianexpress.com had spent its
  // GLOBAL budget of 3 on the higher-priority sections, leaving none for the
  // rest. A global cap also fights the source-tiering (we WANT national agencies
  // leading EVERY section). Fix: cap PER SECTION, tunable via PUBLISHER_CAP
  // (default 4). A single source can no longer monopolise one section, but
  // claiming slots in major/india no longer starves world/tech. must_include
  // stories remain exempt.
  const PUBLISHER_CAP = Math.max(1, parseInt(process.env.PUBLISHER_CAP || '4', 10) || 4);
  let publisherDropped = 0;
  const globalDistribution = new Map<string, number>();

  function applyPublisherCap(arr: any[], section: string): RawStory[] {
    const out: RawStory[] = [];
    const perSection = new Map<string, number>(); // reset for each section
    for (const story of arr) {
      const key = publisherKey(story?.source_url) || 'unknown';
      const used = perSection.get(key) || 0;
      if (!story?.must_include && used >= PUBLISHER_CAP) {
        console.log(`[publisher-cap] dropping ${section} story (publisher ${key} already at ${PUBLISHER_CAP} in this section): "${(story?.headline || '').slice(0, 70)}"`);
        publisherDropped++;
        dropped.push({
          section,
          reason: `publisher diversity cap (${key} at ${PUBLISHER_CAP}/section)`,
          headline: story.headline,
          url: story.source_url,
        });
        continue;
      }
      perSection.set(key, used + 1);
      globalDistribution.set(key, (globalDistribution.get(key) || 0) + 1);
      out.push(story);
    }
    return out;
  }

  // Sprint 20 Drop #5 — order the SPORT section by home-audience priority BEFORE
  // the publisher cap, so India's own results (cricket) aren't capped out by a
  // flooding foreign event (FIFA). Scoped to sport (that's where the flood is);
  // stable, so only India-cricket stories move and everything else keeps order.
  if (HOME_AUDIENCE_BOOST && Array.isArray((cleaned as any).sport) && (cleaned as any).sport.length > 1) {
    (cleaned as any).sport = ((cleaned as any).sport as any[])
      .map((s, i) => ({ s, i, hb: homeAudienceBonus(s), m: (s as any)?.must_include ? 1 : 0 }))
      .sort((x, y) => (y.m - x.m) || (y.hb - x.hb) || (x.i - y.i))
      .map((d) => d.s);
  }

  // Cap each section independently — no cross-section coupling.
  for (const sec of priority) {
    (cleaned as any)[sec] = applyPublisherCap((cleaned as any)[sec] || [], sec);
  }

  if (publisherDropped > 0) {
    const distribution = Array.from(globalDistribution.entries())
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    console.log(`[publisher-cap] dropped ${publisherDropped} stories (max ${PUBLISHER_CAP}/publisher/section). Final distribution: ${distribution}`);
  }

  // ─── Within-section same-event collapse (Sprint 18.2) ──────────────────────
  // The engine collapses the curated front page, but world/india/etc. can still
  // carry two reworded versions of one story (an oil-sanctions pair, a duplicate
  // fire report). Drop the later one — keep the first (already in importance
  // order). Per-section only: it never reaches across sections, so the worst
  // case is losing one of a true pair while its near-twin still covers the event.
  let nearDupDropped = 0;
  for (const sec of priority) {
    const arr = (cleaned as any)[sec] as RawStory[];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const keptSigs: Set<string>[] = [];
    const out: RawStory[] = [];
    for (const story of arr) {
      const sig = eventSignature(story?.headline || '');
      let dup = false;
      for (const ks of keptSigs) { if (isSameEvent(sig, ks)) { dup = true; break; } }
      if (dup && !story?.must_include) {
        console.log(`[near-dup] dropping ${sec} story (same event as an earlier one in section): "${(story?.headline || '').slice(0, 70)}"`);
        nearDupDropped++;
        continue;
      }
      keptSigs.push(sig);
      out.push(story);
    }
    (cleaned as any)[sec] = out;
  }
  if (nearDupDropped > 0) {
    console.log(`[near-dup] dropped ${nearDupDropped} within-section same-event duplicate(s).`);
  }

  // Final story-count check — warn if cap dropped us below 15 (the 5min cap).
  const totalKept = priority.reduce(
    (n, sec) => n + ((cleaned as any)[sec]?.length || 0), 0,
  );
  if (totalKept < 15) {
    console.warn(`[publisher-cap] post-cap story count ${totalKept} below the 15-story 5min target. Consider relaxing the cap if this recurs.`);
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
  // Sprint 22 (PLACEMENT_V2) — authoritative one-event-one-home placement by the
  // engine's eventId, run last so it operates on the final per-section lists
  // (after dedup, cap, and near-dup collapse). Guarantees no event appears in two
  // sections; trims the front page to capacity with fallback-to-home.
  if (PLACEMENT_V2) placeByEventId(cleaned, eventHomeSection, curatedLeadCount);

  // ─── Sprint 26 (F2) — split-event section dedup ────────────────────────────
  // Runs AFTER placeByEventId so it also catches any near-dup that re-injection
  // reintroduced. For each section, collapse stories whose event-signatures pass
  // the PREFIX-AWARE bar (isSameEventPrefix) — this is what the exact-match pass
  // above missed for the Kyiv pair (russia vs russian). When two collapse,
  // KEEP the higher eventCorr (more distinct publishers corroborated it); tie →
  // keep the earlier (already in importance order). must_include is never
  // dropped. Logs each collapse with both headlines so the split is visible in
  // the run log and the admin RCA.
  if (SECTION_DEDUP) {
    let sectionDedupCollapsed = 0;
    for (const sec of priority) {
      const arr = (cleaned as any)[sec] as RawStory[];
      if (!Array.isArray(arr) || arr.length < 2) continue;
      const kept: RawStory[] = [];
      const keptSigs: Set<string>[] = [];
      for (const story of arr) {
        const sig = eventSignature(story?.headline || '');
        let dupIdx = -1;
        for (let i = 0; i < keptSigs.length; i++) {
          if (isSameEventPrefix(sig, keptSigs[i])) { dupIdx = i; break; }
        }
        if (dupIdx === -1) {
          kept.push(story);
          keptSigs.push(sig);
          continue;
        }
        // Found a same-event partner already kept in this section.
        const incumbent = kept[dupIdx];
        const sharedToks = prefixSharedTokens(sig, keptSigs[dupIdx]); // BEFORE any swap
        const incCorr = Number((incumbent as any)?.eventCorr || 0);
        const newCorr = Number((story as any)?.eventCorr || 0);
        const incMust = !!(incumbent as any)?.must_include;
        const newMust = !!(story as any)?.must_include;
        // Never drop a must_include; if both must_include, keep both (skip merge).
        if (incMust && newMust) {
          kept.push(story);
          keptSigs.push(sig);
          continue;
        }
        let dropHeadline: string;
        let droppedStory: any;
        if (newMust && !incMust) {
          // Replace incumbent with the must_include newcomer.
          dropHeadline = incumbent?.headline || '';
          droppedStory = incumbent;
          kept[dupIdx] = story;
          keptSigs[dupIdx] = sig;
        } else if (incMust && !newMust) {
          dropHeadline = story?.headline || '';
          droppedStory = story;
          // keep incumbent, drop newcomer
        } else if (newCorr > incCorr) {
          dropHeadline = incumbent?.headline || '';
          droppedStory = incumbent;
          kept[dupIdx] = story;
          keptSigs[dupIdx] = sig;
        } else {
          dropHeadline = story?.headline || '';
          droppedStory = story;
          // tie or incumbent higher → keep incumbent (earlier)
        }
        // Sprint 27.1 (N3) — the survivor inherits the pair's best evidence
        // (max eventCorr/nw, must_include) so a collapse can't demote the event
        // below the buildSubset cut that one of its copies had earned.
        inheritCollapsedEvidence(kept[dupIdx], droppedStory);
        sectionDedupCollapsed++;
        console.log(`[section-dedup] collapsed same-event pair in ${sec} (kept eventCorr=${Number((kept[dupIdx] as any)?.eventCorr || 0)}): dropped "${(dropHeadline || '').slice(0, 70)}" — kept "${(kept[dupIdx]?.headline || '').slice(0, 70)}" | shared tokens: ${sharedToks.join(', ')}`);
      }
      (cleaned as any)[sec] = kept;
    }
    if (sectionDedupCollapsed > 0) {
      console.log(`[section-dedup] collapsed ${sectionDedupCollapsed} split-event duplicate(s) across sections.`);
    } else {
      console.log('[section-dedup] no split-event duplicates found.');
    }

    // ── Sprint 27.1 (N1) — cross-section pass ──────────────────────────────
    // Same prefix-aware bar, applied ACROSS section boundaries in placement-
    // priority order. The earlier (higher-priority) section keeps its copy —
    // this mirrors placeByEventId's own first-claim semantics, and it means a
    // front-page lead is never yanked off the front page by a topical twin.
    // The dropped copy's evidence is inherited by the kept copy. If the dropped
    // copy was BETTER corroborated, that is logged loudly (section precedence
    // won, but the trade-off is visible). A must_include newcomer whose earlier
    // twin is not must_include is kept-both + logged (mislabel safety) — F7's
    // brief-wide duplicate check will independently flag it if it ships.
    if (SECTION_DEDUP_XS) {
      type XsKept = { sig: Set<string>; sec: string; story: any };
      const registry: XsKept[] = [];
      let xsCollapsed = 0;
      let xsMustKeptBoth = 0;
      for (const sec of priority) {
        const arr = (cleaned as any)[sec] as RawStory[];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const survivors: RawStory[] = [];
        for (const story of arr) {
          const sig = eventSignature(story?.headline || '');
          let twin: XsKept | null = null;
          for (const r of registry) {
            if (r.sec !== sec && isSameEventPrefix(sig, r.sig)) { twin = r; break; }
          }
          if (!twin) {
            survivors.push(story);
            registry.push({ sig, sec, story });
            continue;
          }
          const newMust = !!(story as any)?.must_include;
          const twinMust = !!(twin.story as any)?.must_include;
          if (newMust && !twinMust) {
            // Mislabel safety: never drop a must_include, never yank the earlier
            // section's copy — keep both, loudly. F7 will flag it if both ship.
            xsMustKeptBoth++;
            console.warn(`[section-dedup:xs] must_include twin KEPT in ${sec} (earlier copy in ${twin.sec} is not must_include) — keeping both, F7 will verify: "${String(story?.headline || '').slice(0, 70)}"`);
            survivors.push(story);
            registry.push({ sig, sec, story });
            continue;
          }
          const sharedToks = prefixSharedTokens(sig, twin.sig);
          const dropCorr = Number((story as any)?.eventCorr || 0);
          const keptCorr = Number((twin.story as any)?.eventCorr || 0);
          inheritCollapsedEvidence(twin.story, story);
          xsCollapsed++;
          const corrNote = dropCorr > keptCorr
            ? ` ⚠ dropped copy was BETTER corroborated (${dropCorr}>${keptCorr}) — section precedence kept the ${twin.sec} copy; evidence inherited`
            : '';
          console.log(`[section-dedup:xs] collapsed cross-section same-event pair (${twin.sec} ⟷ ${sec}): dropped "${String(story?.headline || '').slice(0, 70)}" from ${sec} — kept "${String(twin.story?.headline || '').slice(0, 70)}" in ${twin.sec} (eventCorr now ${Number((twin.story as any)?.eventCorr || 0)}) | shared tokens: ${sharedToks.join(', ')}${corrNote}`);
        }
        (cleaned as any)[sec] = survivors;
      }
      if (xsCollapsed > 0 || xsMustKeptBoth > 0) {
        console.log(`[section-dedup:xs] collapsed ${xsCollapsed} cross-section split-event duplicate(s)${xsMustKeptBoth > 0 ? `; ${xsMustKeptBoth} must_include twin(s) kept-both (mislabel safety)` : ''}.`);
      } else {
        console.log('[section-dedup:xs] no cross-section split-event duplicates found.');
      }
    }
  }

  console.log(`Quality enforcement complete. Must-includes: ${mustCount}/5. Dropped: ${dropped.length}`);
  if (dropped.length > 0) console.log('Dropped:', JSON.stringify(dropped, null, 2).slice(0, 1500));

  return cleaned;
}

// ─── Phase 3: Edition writers (three different prompts) ─────────────────────

// ============================================================================
// SECTION 15:  WRITER PREP, RANKING & SUBSET
// ----------------------------------------------------------------------------
// Shapes the cleaned pool for the writer, ranks by source tier / newsworthiness
// / home-audience boost, and buildSubset() carves each edition's per-section
// quota from the shared pool at write time.
// Fns:   rankBySourceTier, rankByImportance, homeAudienceBonus, buildSubset
// Flags: RANK_BY_NEWSWORTHINESS, HOME_AUDIENCE_BOOST, HOME_BOOST_SPORT_ONLY
// ============================================================================
function rawStoriesForWriter(raw: RawStories) {
  // Strip `lens` — it's a four-line home-screen summary, not source material.
  // Previously the deep writer was treating lens lines as available headlines
  // and putting them in three_patterns.stories_connected. Writers see stories
  // and markets only.
  const { lens, ...storiesOnly } = raw;
  return storiesOnly;
}

// ─── Deterministic post-filter subset builder ───────────────────────────────
//
// After enforceQualityRules drops non-whitelisted, stale, and semantically-
// duplicate stories, we still typically have more raw stories than each
// edition wants. This builder picks a balanced subset.
//
// Sprint 12.5.1 — REWRITTEN. The previous version walked priority order with
// a single global cap (20 for 10min, 15 for 5min). After Sprint 12.5's prompt
// strengthening pushed Perplexity to over-fetch, the priority sections alone
// (major=7 + india=7 + world=7 = 21) exhausted the cap, leaving business,
// technology, climate_health, sport, and culture with ZERO stories in the
// subset. Result: 10min written brief had 5 empty topical sections; Daily
// scored 52/70 because of it.
//
// New design: per-section QUOTAS that guarantee breadth, then redistribute any
// slack to higher-priority sections. Topical sections (biz/tech/climate/sport/
// culture) are guaranteed at least 1-3 stories each.
//
// 5min set is no longer a strict subset of 10min (priority sections may differ
// by 1-2 stories), but the 5min writer concatenates topicals into a single
// 'topics' bucket, so breadth coverage matters more than strict subsetting.

// Sprint 14.8 — STABLE rank by source tier (national/record first), preserving
// the fetcher's relative order within a tier and always keeping must_include on
// top. Decorate-sort-undecorate so it's stable regardless of engine/target.
function rankBySourceTier(arr: RawStory[]): RawStory[] {
  if (!Array.isArray(arr) || arr.length < 2) return Array.isArray(arr) ? arr : [];
  return arr
    .map((s, i) => ({ s, i, t: sourceTier((s as any)?.source_url), m: (s as any)?.must_include ? 1 : 0 }))
    .sort((a, b) => (b.m - a.m) || (b.t - a.t) || (a.i - b.i))
    .map((d) => d.s);
}

// Sprint 20 — rank each section by NEWSWORTHINESS first (the nw score the RSS
// engine now stamps on every story), then must_include, then source tier, then
// the fetcher's order. This is the fix for "fluff led the section": a 50-year-
// old evergreen (nw low) now sinks below a M6.9 earthquake (nw high) even if the
// evergreen came from a higher-tier wire. Stories without a score (nw undefined,
// e.g. the unscored tail, or when scoring was unavailable) sort as -1 and fall
// back to the exact tier ordering above — so the change is fully fail-safe.
// Gated by RANK_BY_NEWSWORTHINESS (default on).
const RANK_BY_NW = (process.env.RANK_BY_NEWSWORTHINESS || 'on').toLowerCase() !== 'off';

// ─── Sprint 20 Drop #5 — home-audience priority for sport ───────────────────
// The FIFA World Cup floods every sport feed; the per-publisher section cap then
// keeps each masthead's first 4 (all FIFA football), capping out India's OWN
// cricket results before they can be selected. On the 2026-06-26 run "India beat
// Bangladesh in the T20 World Cup" was dropped 4× by the cap while a Turkey-US
// dead rubber took the single sport slot. This deterministic bonus lifts India
// national-team results in marquee cricket events so they (a) survive the
// publisher cap and (b) lead the sport slot in selection. It fires ~only on
// India cricket (returns 0 otherwise), so it reshuffles sport without disturbing
// any other section. Gated by HOME_AUDIENCE_BOOST (default on).
const HOME_AUDIENCE_BOOST = (process.env.HOME_AUDIENCE_BOOST || 'on').toLowerCase() !== 'off';
// Sprint 23 — scope the home-audience (India-cricket) lift to the SPORT section
// only. In rankByImportance the lift sat ABOVE newsworthiness for EVERY section,
// so a cricket milestone outranked a fatal flood in india/world. The lift was
// only ever meant to stop a foreign tournament flooding SPORT (see the dedicated
// sport pass in enforceQualityRules) — confine it there. Revertible:
// HOME_BOOST_SPORT_ONLY=off restores the all-section lift.
const HOME_BOOST_SPORT_ONLY = (process.env.HOME_BOOST_SPORT_ONLY || 'on').toLowerCase() !== 'off';
function homeAudienceBonus(story: any): number {
  if (!HOME_AUDIENCE_BOOST) return 0;
  const h = `${(story as any)?.headline || ''} ${(story as any)?.summary || (story as any)?.body || ''}`;
  if (!/\b(india|indian|team india)\b/i.test(h)) return 0;
  if (!/\b(cricket|t20i?|odi|test match|icc|bcci|world cup)\b/i.test(h)) return 0;
  const result = /\b(beat|beats|won|win|wins|defeat|defeats|thrash\w*|advance\w*|qualif\w*|knockout|semi-?final|final|clinch\w*|seal\w*|chase\w*)\b/i.test(h);
  let b = result ? 2 : 1;
  if (/\b(world cup|icc|champions trophy)\b/i.test(h)) b += 1;       // marquee event
  if (/\b(india a|under-?19|u-?19|ranji|domestic|maharaja trophy|tg20)\b/i.test(h)) b = Math.min(b, 1); // dampen minor cricket
  return Math.min(3, b);
}

function rankByImportance(arr: RawStory[], section?: string): RawStory[] {
  if (!Array.isArray(arr) || arr.length < 2) return Array.isArray(arr) ? arr : [];
  if (!RANK_BY_NW) return rankBySourceTier(arr);
  // Apply the India-cricket lift only where it belongs. When HOME_BOOST_SPORT_ONLY
  // is on, hb is non-zero only for the sport section; everywhere else
  // newsworthiness decides, so a fatal flood outranks a sports record in
  // india/world.
  const useBoost = !HOME_BOOST_SPORT_ONLY || section === 'sport';
  return arr
    .map((s, i) => ({
      s, i,
      nw: typeof (s as any)?.nw === 'number' ? (s as any).nw : -1,
      hb: useBoost ? homeAudienceBonus(s) : 0,
      t: sourceTier((s as any)?.source_url),
      m: (s as any)?.must_include ? 1 : 0,
    }))
    .sort((a, b) => (b.m - a.m) || (b.hb - a.hb) || (b.nw - a.nw) || (b.t - a.t) || (a.i - b.i))
    .map((d) => d.s);
}

function buildSubset(raw: RawStories, cap: number): RawStories {
  // Per-section base quotas. Sum equals cap; topical sections always get >=1.
  const QUOTAS: Record<number, Record<string, number>> = {
    15: { // 5min — leaner, but still touch every topical section
      major_events: 4, india: 4, world: 3,
      business: 1, technology: 1, climate_health: 1, sport: 0, culture: 1,
    },
    20: { // 10min + (Drop #4) 5min — broader coverage; world floored at 4
      major_events: 5, india: 4, world: 4,
      business: 2, technology: 2, climate_health: 1, sport: 1, culture: 1,
    },
  };

  // If an unfamiliar cap is passed, fall back to the 20-quota shape.
  const quota = QUOTAS[cap] || QUOTAS[20];

  // Priority for slack redistribution (best-section-first).
  const PRIORITY = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

  // Sprint 14.8 / 20 — rank each section by NEWSWORTHINESS first (Sprint 20),
  // then must_include, then source tier (national agencies / papers of record),
  // then the fetcher's order. Used by both passes. Falls back to pure tier order
  // for any section whose stories have no nw score (fail-safe).
  const ranked: Record<string, RawStory[]> = {};
  for (const sec of PRIORITY) {
    ranked[sec] = rankByImportance(((raw as any)[sec] || []) as RawStory[], sec);
  }

  // First pass: take min(quota, available) per section.
  const taken: Record<string, RawStory[]> = {};
  let used = 0;
  for (const sec of PRIORITY) {
    const want = quota[sec] || 0;
    const avail = ranked[sec];
    const take = avail.slice(0, want);
    taken[sec] = take;
    used += take.length;
  }

  // Second pass: if sections under-delivered (raw had fewer than quota), give
  // the unused slots to other sections that have surplus, walking priority.
  let slack = cap - used;
  if (slack > 0) {
    for (const sec of PRIORITY) {
      if (slack <= 0) break;
      const avail = ranked[sec];
      const room = avail.length - taken[sec].length;
      const more = Math.min(room, slack);
      if (more > 0) {
        taken[sec] = avail.slice(0, taken[sec].length + more);
        slack -= more;
      }
    }
  }

  const nwScored = PRIORITY.reduce((n, sec) => n + (taken[sec] || []).filter((s: any) => typeof s?.nw === 'number').length, 0);
  console.log(`[subset:cap=${cap}] picked ${cap - slack} stories (slack=${slack}, nw-ranked=${RANK_BY_NW}, nw-scored=${nwScored}/${cap - slack}) — ` +
    `major=${taken.major_events.length}, india=${taken.india.length}, world=${taken.world.length}, ` +
    `biz=${taken.business.length}, tech=${taken.technology.length}, climate=${taken.climate_health.length}, ` +
    `sport=${taken.sport.length}, culture=${taken.culture.length}`);

  return {
    major_events:   taken.major_events,
    india:          taken.india,
    world:          taken.world,
    business:       taken.business,
    technology:     taken.technology,
    climate_health: taken.climate_health,
    sport:          taken.sport,
    culture:        taken.culture,
    // Sprint 14.2: politics & markets_news pass through in full (NOT counted
    // against the cap) so the dedicated-section writer sees them. The brief
    // shows them only to opted-in users; everyone else's personalise step
    // drops them.
    politics:       rankBySourceTier(((raw as any).politics || []) as RawStory[]),
    markets_news:   rankBySourceTier(((raw as any).markets_news || []) as RawStory[]),
    markets:        raw.markets,
    lens:           raw.lens,
  };
}

// Deterministic visibility check (Sprint 23): flag 5-min items whose one-line
// what_happened merely restates the headline (high significant-word overlap). We
// LOG rather than regenerate — a per-story retry would add a second model call
// and latency for little gain; surfacing the count in the run log lets the
// prompt fix be verified and tuned. No content is changed.
// ============================================================================
// SECTION 16:  EDITION WRITERS (5min / 10min / deep)
// ----------------------------------------------------------------------------
// The three edition writers that turn the subset into brief content:
// writeQuickEdition (5min micro-items), writeDailyEdition (10min full stories),
// writeEditorialEdition (deep synthesis). Plus the dek-restates-headline guard.
// Fns:   writeQuickEdition, writeDailyEdition, writeEditorialEdition, warnOnDekRestatesHeadline
// Flags: -
// ============================================================================
function dekRestatesHeadline(headline: string, dek: string): boolean {
  const h = significantWords(headline || '');
  const d = significantWords(dek || '');
  if (h.size < 3 || d.size < 3) return false;
  let shared = 0;
  for (const w of Array.from(d)) if (h.has(w)) shared++;
  // ≥80% of the dek's significant words already appear in the headline ⇒ restated.
  return shared / d.size >= 0.8;
}
function warnOnDekRestatesHeadline(brief: any): void {
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

async function writeQuickEdition(raw: RawStories): Promise<BriefQuick> {
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

async function writeDailyEdition(raw: RawStories): Promise<BriefDaily> {
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
function retryAfterMsFromBody(body: string, headerSeconds: number): number {
  if (!isNaN(headerSeconds) && headerSeconds > 0) return Math.round(headerSeconds * 1000);
  const ms = body.match(/try again in\s+([\d.]+)\s*ms/i);
  if (ms) return Math.max(0, Math.round(parseFloat(ms[1])));
  const s = body.match(/try again in\s+([\d.]+)\s*s/i);
  if (s) return Math.max(0, Math.round(parseFloat(s[1]) * 1000));
  return 6000;
}

async function callOpenAIChat(
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
const BACKFILL_WHY_FULL = 'Relevant context for Indian readers; see the linked report for detail.';
const BACKFILL_WHY_MICRO = 'Relevant context for Indian readers; see the linked report.';
// Sprint 26 (F7) — the exact static sentences rawToFullStory stamps on a padded
// story. Named here so the final-brief invariant checker can fingerprint a raw
// template that reached the reader, with zero drift risk. (why_it_matters is
// handled by BACKFILL_WHY_* above; rewriteTemplateWhys replaces it, but analysis
// and what_happens_next are NOT rewritten, so those two are the reliable tell.)
const RAW_TEMPLATE_ANALYSIS = 'Included for completeness; see the linked source for the full account.';
const RAW_TEMPLATE_WHATNEXT = 'Watch for follow-up coverage and official updates.';
const REWRITE_TEMPLATE_WHYS = (process.env.REWRITE_TEMPLATE_WHYS || 'true').toLowerCase() !== 'false';

function rawToFullStory(s: any): any {
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

const DAILY_BACKFILL_SECTIONS = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];

function backfillEmptyDailySections(content: any, subset: RawStories): number {
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
function rawToMicroStory(s: any): any {
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
function dailySectionCountsStr(content: any): string {
  const secs = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];
  return secs
    .map((s) => `${s}=${Array.isArray(content?.[s]) ? content[s].length : 0}`)
    .filter((x) => !x.endsWith('=0'))
    .join(' ') || '(none)';
}

const TOPUP_SECTIONS_10MIN = ['major_events', 'india', 'world', 'business', 'technology', 'climate_health', 'sport', 'culture'];
const TOPUP_SECTIONS_5MIN  = ['major_events', 'india', 'world'];

function backfillToSubsetCounts(content: any, edition: Edition, subset: RawStories, excludeKeys?: Set<string>): number {
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
async function rewriteTemplateWhys(content: any, edition: Edition): Promise<number> {
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
const COHERENCE_ENFORCE = (process.env.COHERENCE_ENFORCE || 'on').toLowerCase() !== 'off';

// Sprint 26 (F1) — default ON. Two independent guarantees on the coherence
// pass: (1) a story the pass drops can NOT be re-added by the subsequent
// backfill top-up (the defect where a coherence-dropped Kyiv story came back as
// a raw boilerplate template), and (2) a high-severity `duplication` flag is
// resolved by keep-best (drop the lower-corroboration twin) instead of the old
// behaviour of ignoring duplication entirely. Env-revertible:
// COHERENCE_BACKFILL_GUARD=false restores the pre-Sprint-26 wiring exactly.
const COHERENCE_BACKFILL_GUARD = (process.env.COHERENCE_BACKFILL_GUARD || 'true').toLowerCase() !== 'false';

type CoherenceIssue = {
  type: string;
  section: string;
  headline: string;
  severity: string;
  detail: string;
};

async function runCoherenceCheck(edition: Edition, content: any): Promise<CoherenceIssue[]> {
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
interface CoherenceDropResult { removed: number; droppedUrlKeys: Set<string>; droppedHeadlineKeys: Set<string>; }
function applyCoherenceDrops(
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


function repairCommonOmissions(content: any, edition: Edition, raw: RawStories): any {
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

// ─── Post-write source-URL guard ────────────────────────────────────────────
//
// The writers (LLMs) sometimes invent stories when raw is sparse, complete with
// plausible-looking headlines and homepage URLs. Zod can't catch this because
// any https URL passes the schema. This walks the WRITTEN brief and drops any
// story whose source_url isn't from a Tier-1 whitelisted publisher. Acts as a
// safety net on top of the fetch-time enforcement in enforceQualityRules.

function stripNonWhitelistedFromContent(
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

async function fetchPreviousBrief(edition: Edition): Promise<{ content: BriefContent; lens: any; status: string } | null> {
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
const BRIEF_INVARIANTS = (process.env.BRIEF_INVARIANTS || 'true').toLowerCase() !== 'false';
const BRIEF_INVARIANTS_HALT = (process.env.BRIEF_INVARIANTS_HALT || 'false').toLowerCase() === 'true';

// Sprint 27.1 (N5) — the checker must know each edition's ACTUAL schema. The
// 07-05 audit caught it schema-blind: the 5-min folds business…culture into a
// single `topics` array (the checker saw 0-story sections and cried a false
// floor violation on a healthy brief), and the 10-min's politics/markets_news
// were outside the check entirely (it said "20 stories" on a 29-story brief).
// A checker that cries wolf and misses real sections erodes the trust it was
// built to provide — these lists mirror BriefQuickSchema / BriefDailySchema.
const INVARIANT_SECTIONS_BY_EDITION: Record<string, string[]> = {
  '5min':  ['major_events', 'world', 'india', 'topics'],
  '10min': ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news'],
};
// 5-min folding: these subset sections ship inside `topics`, not under their
// own keys — the floor check tests them collectively against topics.
const FIVE_MIN_FOLDED_INTO_TOPICS = ['business', 'technology', 'climate_health', 'sport', 'culture'];

interface InvariantResult { ok: boolean; violations: string[]; halted: boolean; }

function checkBriefInvariants(content: any, subset: RawStories, edition: Edition, fullPool?: RawStories | null): InvariantResult {
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

// ============================================================================
// SECTION 20:  PERSIST & PUSH
// ----------------------------------------------------------------------------
// Writes the validated brief to the briefs table and sends the OneSignal push
// for the top headline.
// Fns:   saveBriefToSupabase, sendPushNotification
// Flags: ONESIGNAL_* (env)
// ============================================================================
async function saveBriefToSupabase(
  edition: Edition,
  rawStories: RawStories | null,
  content: BriefContent | null,
  lens: any,
  status: 'ready' | 'fallback' | 'failed' | 'pending',
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

// ─── Mode-based architecture ────────────────────────────────────────────────
//
// Why modes exist: Vercel Hobby plan caps serverless functions at 60s. The
// original "do everything in one call" flow (fetch news + lens + 3 writers +
// save + push) couldn't fit. It would TIMEOUT (504 / FUNCTION_INVOCATION_TIMEOUT),
// which the admin page would then fail to parse as JSON. So we split:
//
//   mode='fetch' — fetch news (parallel sections) + synthesise lens, save raw
//                  to 3 'pending' brief rows. ~35-45s, fits in 60s.
//   mode='write' — needs `edition`. Read raw_stories from today's pending row,
//                  write that one edition, save as 'ready'. ~15-30s.
//   mode='push'  — send OneSignal push using today's top ready headline.
//   mode='full'  — LEGACY single-call flow. Kept only for emergencies on light
//                  news days; will timeout on busy days. Do not use from cron.
//
// Default when no mode is provided: 'fetch'. This makes the admin page and
// cron sensible: hit the endpoint with no body, you get the fetch phase,
// then chain writes from the caller.

// ─── Per-edition writer pipeline ────────────────────────────────────────────
//
// Pure function: takes raw stories, returns a saved result. Shared by 'write'
// mode and 'full' mode below.

// ============================================================================
// SECTION 21:  CONTENT HYGIENE: LIVENESS, CROSS-SECTION DEDUP & SANITIZE
// ----------------------------------------------------------------------------
// Pre-orchestration hygiene helpers: dead-link detection/drop, cross-section
// dedup of the daily edition, synthetic-chart detection, and signature/edition
// sanitisation. (EditionOutcome, the runWriterForEdition result type, is here.)
// Fns:   isUrlDead, dropDeadLinkStories, dedupeDailyAcrossSections, sanitizeEditionContent
// Flags: URL_LIVENESS
// ============================================================================
type EditionOutcome = {
  status: 'ready' | 'fallback' | 'failed';
  reason?: string;
  content?: BriefContent;
};

// ─── Sprint 13: URL liveness check ──────────────────────────────────────────
//
// Perplexity occasionally returns formulaic article URLs that 404. Before
// saving content, HEAD-check every story URL and drop stories whose links
// are definitively dead. CONSERVATIVE by design: only 404/410 count as dead.
// 403/405/timeouts/network errors are assumed ALIVE — many publishers block
// bot HEAD requests, and a false drop costs a real story. Set URL_LIVENESS=off
// in Vercel env to disable entirely. Adds ~3-6s to each write.

const URL_LIVENESS_ENABLED = (process.env.URL_LIVENESS || 'on').toLowerCase() !== 'off';

// Browser-like headers: many publishers return 404/403 to headerless
// datacenter requests (bot mitigation). Without these, real articles can
// test "dead" — see the 2026-06-12 midday incident (28/34 URLs dropped).
const LIVENESS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};

async function isUrlDead(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    let resp = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: LIVENESS_HEADERS });
    if (resp.status === 405 || resp.status === 501 || resp.status === 404 || resp.status === 410) {
      // HEAD blocked OR HEAD says dead — confirm with a tiny ranged GET.
      // Some servers 404 HEAD requests but serve GET fine.
      resp = await fetch(url, {
        method: 'GET', redirect: 'follow', signal: ctrl.signal,
        headers: { ...LIVENESS_HEADERS, Range: 'bytes=0-1024' },
      });
    }
    clearTimeout(timer);
    return resp.status === 404 || resp.status === 410;
  } catch {
    return false; // network error / timeout → assume alive
  }
}

const LIVENESS_SECTIONS: Record<string, string[]> = {
  '5min':  ['major_events', 'world', 'india', 'topics'],
  '10min': ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news'],
  // deep has no per-story source_urls in the same shape — skipped.
};

// Per-edition output schema for the writer diagnostic (Sprint 19 fix). The
// writer's output shape differs by edition, so the first cut — which counted the
// output against the raw INPUT section keys — logged false zeros for the
// editions whose output is NOT section-aligned: `deep` emits
// long_read/three_patterns/watching_this_week/signature, and `5min` folds
// business/technology/climate_health/sport/culture into a single `topics` array.
// Reporting each edition against the keys it actually emits keeps the log honest.
const WRITER_DIAG_SECTIONS: Record<string, string[]> = {
  '5min':  ['major_events', 'world', 'india', 'topics'],
  '10min': ['major_events', 'world', 'india', 'business', 'technology', 'climate_health', 'sport', 'culture', 'politics', 'markets_news'],
  'deep':  ['three_patterns', 'watching_this_week'],
};

async function dropDeadLinkStories(
  content: any,
  edition: Edition,
): Promise<{ content: any; dropped: number }> {
  const sections = LIVENESS_SECTIONS[edition];
  if (!URL_LIVENESS_ENABLED || !sections) return { content, dropped: 0 };

  const urls = new Set<string>();
  for (const sec of sections) {
    for (const s of (content?.[sec] || [])) if (s?.source_url) urls.add(s.source_url);
  }
  const urlList = Array.from(urls);
  if (urlList.length === 0) return { content, dropped: 0 };

  const dead = new Set<string>();
  let cursor = 0;
  const POOL = 8;
  await Promise.all(
    Array.from({ length: Math.min(POOL, urlList.length) }, async () => {
      while (cursor < urlList.length) {
        const u = urlList[cursor++];
        if (await isUrlDead(u)) dead.add(u);
      }
    }),
  );
  if (dead.size === 0) return { content, dropped: 0 };

  // CIRCUIT BREAKER (2026-06-12 incident): if more than 30% of a brief's
  // URLs test dead, something systemic is wrong — either the checker is
  // being bot-blocked, or the fetch fabricated most of its URLs. Dropping
  // them would gut the brief (Daily went to 3 stories, score 63→38).
  // Fail OPEN: drop nothing, log loudly, ship the brief intact. The log
  // line reveals which failure mode it was so it can be fixed at the
  // fetch-prompt level rather than by hollowing out the product.
  const deadShare = dead.size / urlList.length;
  if (deadShare > 0.3) {
    console.error(`[liveness] CIRCUIT BREAKER: ${dead.size}/${urlList.length} URLs (${Math.round(deadShare * 100)}%) tested dead for ${edition} — refusing to drop anything. Either the checker is blocked or the fetch hallucinated URLs. Sample: ${Array.from(dead).slice(0, 3).join(' , ')}`);
    return { content, dropped: 0 };
  }

  let dropped = 0;
  const out: any = { ...content };
  for (const sec of sections) {
    const before = (out[sec] || []).length;
    out[sec] = (out[sec] || []).filter((s: any) => !dead.has(s.source_url));
    dropped += before - out[sec].length;
  }
  for (const u of Array.from(dead)) console.log(`[liveness] dead link dropped: ${u}`);
  return { content: out, dropped };
}

// ─── Sprint 14.4: deterministic editorial guardrails ────────────────────────
// These run AFTER the writer, BEFORE save. The writer prompts already ask for
// the right behaviour, but gpt-4o / gpt-4o-mini occasionally ignore it — the
// 06-14 deep brief shipped a fabricated chart (values 150/200/250/300/350,
// labelled into 2027-2028) and a quote attributed to "Independent Commentary",
// and the 10min ran the same Anthropic story in three sections. We enforce the
// trust-critical rules in code rather than hope the model complies.

// normaliseUrlForCompare -> @/lib/generate-brief/utils

const DAILY_SECTION_PRIORITY = [
  'major_events', 'india', 'world', 'business', 'politics',
  'markets_news', 'technology', 'climate_health', 'sport', 'culture',
];

// Remove the same story (by URL) appearing in multiple sections. CONSERVATIVE:
// a duplicate is only dropped from a lower-priority section when that section
// keeps at least one story afterwards. We never blank a section — that would
// both hide content and (perversely) trigger the scorer's empty-section
// penalty. On thin days this is a no-op; on rich days it kills the triple-list.
function dedupeDailyAcrossSections(content: any): { content: any; dropped: number } {
  if (!content || typeof content !== 'object') return { content, dropped: 0 };
  const seen = new Set<string>();
  let dropped = 0;
  for (const sec of DAILY_SECTION_PRIORITY) {
    // OVERLAY: the front page is a highlight layer that intentionally repeats a
    // few topical leads — don't dedup it against the sections (that would delete
    // the overlay), and don't let it consume URLs the topical copies need.
    if (PLACEMENT_V2 && PLACEMENT_OVERLAY && sec === 'major_events') continue;
    const arr = content[sec];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const uniques: any[] = [];
    const dups: any[] = [];
    for (const story of arr) {
      const key = normaliseUrlForCompare(story?.source_url);
      if (key && seen.has(key)) dups.push(story);
      else uniques.push(story);
    }
    let kept: any[];
    if (uniques.length > 0) {
      kept = uniques;
      dropped += dups.length;
    } else {
      // Every story here duplicates a higher-priority section. Keep one so the
      // section isn't blanked; drop the rest.
      kept = arr.slice(0, 1);
      dropped += arr.length - 1;
    }
    for (const story of kept) {
      const key = normaliseUrlForCompare(story?.source_url);
      if (key) seen.add(key);
    }
    content[sec] = kept;
  }
  return { content, dropped };
}

// Attribution strings that aren't real attributions. A quote pinned to any of
// these (or to nothing) is dropped — better no quote than a fabricated one.
const GENERIC_ATTRIBUTIONS = new Set([
  'independent commentary', 'commentary', 'analyst', 'analysts', 'an analyst',
  'expert', 'experts', 'an expert', 'observer', 'observers', 'industry observer',
  'industry observers', 'industry sources', 'sources', 'a source', 'spokesperson',
  'a spokesperson', 'editorial', 'staff', 'correspondent', 'our correspondent',
  'unknown', 'n/a', 'na', 'anonymous', 'official', 'officials',
]);

// A chart's data is treated as synthetic (and dropped) when it can't be drawn
// from real numbers: too few points, any label projecting a future year, or a
// suspiciously perfect arithmetic sequence (the textbook hallucination shape,
// e.g. 150/200/250/300/350).
function looksSyntheticChart(dp: any[]): boolean {
  const pts = (dp || []).filter((p) => p && typeof p.value === 'number' && isFinite(p.value));
  if (pts.length < 2) return true;
  const year = new Date().getFullYear();
  for (const p of pts) {
    const yr = parseInt(String(p.label ?? ''), 10);
    if (!isNaN(yr) && yr > 1900 && yr > year) return true;
  }
  if (pts.length >= 4) {
    const deltas: number[] = [];
    for (let i = 1; i < pts.length; i++) deltas.push(pts[i].value - pts[i - 1].value);
    const allEqual = deltas.every((d) => Math.abs(d - deltas[0]) < 1e-9);
    if (allEqual && Math.abs(deltas[0]) > 0) return true;
  }
  return false;
}

function sanitizeSignature(sig: any): { sig: any; notes: string[] } {
  const notes: string[] = [];
  if (!sig || typeof sig !== 'object') return { sig, notes };
  if (sig.one_chart) {
    const dp = Array.isArray(sig.one_chart.data_points) ? sig.one_chart.data_points : [];
    if (dp.length === 0 || looksSyntheticChart(dp)) {
      sig.one_chart = null;
      notes.push('dropped one_chart (no real/usable data points)');
    }
  }
  if (sig.one_quote) {
    const attr = String(sig.one_quote.attribution || '').trim();
    const quote = String(sig.one_quote.quote || '').trim();
    const generic = !attr || GENERIC_ATTRIBUTIONS.has(attr.toLowerCase()) || !/[a-z]/i.test(attr);
    if (!quote || generic) {
      sig.one_quote = null;
      notes.push('dropped one_quote (missing or unattributed)');
    }
  }
  return { sig, notes };
}

// Per-edition post-write cleanup. Dispatches the guardrails relevant to each
// edition. Pure/deterministic — safe to run on every successful write.
function sanitizeEditionContent(ed: Edition, content: any): any {
  if (!content || typeof content !== 'object') return content;
  if (ed === '10min') {
    const { content: deduped, dropped } = dedupeDailyAcrossSections(content);
    if (dropped > 0) console.log(`[10min] cross-section dedupe removed ${dropped} duplicate listing(s).`);
    return deduped;
  }
  if (ed === 'deep') {
    const { sig, notes } = sanitizeSignature(content.signature);
    content.signature = sig;
    if (notes.length) console.log(`[deep] signature guardrails: ${notes.join('; ')}.`);
    return content;
  }
  return content;
}

// ============================================================================
// SECTION 22:  WRITER ORCHESTRATION  (runWriterForEdition)
// ----------------------------------------------------------------------------
// Per-edition conductor: write -> repair -> coherence drop (+ backfill guard)
// -> backfill -> dead-link drop -> validate -> invariant check -> outcome.
// This is where Sections 16-21 are wired together in order.
// Fns:   runWriterForEdition
// Flags: (orchestrates Sections 16-21 flags)
// ============================================================================
async function runWriterForEdition(
  ed: Edition,
  rawStories: RawStories,
  lens: any | null,
): Promise<EditionOutcome> {
  const writer =
    ed === '5min'  ? writeQuickEdition
  : ed === '10min' ? writeDailyEdition
  :                  writeEditorialEdition;

  // Per Sprint 9 spec: 5min capped at 15, 10min at 20. Sprint 20 Drop #4 raises
  // the 5-min shared provisioning to 20 (flag FIVE_MIN_FILL, default on; 'off'
  // restores 15) so the personalised 5-min edition can fill to its 20-story cap
  // instead of shipping thin (~13/20). Both are deterministic code subsets.
  const FIVE_MIN_FILL = (process.env.FIVE_MIN_FILL || 'on').toLowerCase() !== 'off';
  const writerInput =
    ed === '5min'  ? buildSubset(rawStories, FIVE_MIN_FILL ? 20 : 15)
  : ed === '10min' ? buildSubset(rawStories, 20)
  :                  rawStories;

  // Two attempts. gpt-4o-mini occasionally returns non-JSON or drops required
  // fields; one retry catches most of these. We only fall back to yesterday's
  // brief if BOTH attempts fail.
  let lastError: string = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`Writing ${ed}${attempt === 2 ? ' (retry)' : ''}...`);
      const content = await writer(writerInput);
      // Writer diagnostic (Sprint 18.3): what the model actually returned per
      // section BEFORE any repair or top-up backfill. This is how we confirm the
      // canned-"why it matters" symptom at its source — e.g. "major_events 1/5"
      // means the writer under-produced and the rest is raw-template padding.
      try {
        // Count the writer's output against the keys THIS edition actually emits
        // (Sprint 19 schema fix). Where an output key aligns with an input
        // section we show written/supplied; keys with no matching input array
        // (5min `topics`, deep's long-form arrays) show the written count only —
        // no more false `0/N` zeros for deep and the folded 5min sections.
        const diagKeys = WRITER_DIAG_SECTIONS[ed] || [];
        const counts = diagKeys
          .map((sec) => {
            const wrote = Array.isArray((content as any)?.[sec]) ? (content as any)[sec].length : 0;
            const supplied = (writerInput as any)?.[sec];
            return Array.isArray(supplied) ? `${sec} ${wrote}/${supplied.length}` : `${sec} ${wrote}`;
          })
          .join(' · ');
        console.log(`[writer] ${ed} returned (written/supplied): ${counts}`);
      } catch (e) { /* diagnostic only — never break the run */ }
      const repaired = repairCommonOmissions(content, ed, writerInput);
      const validation = validateBrief(repaired, ed);
      if (validation.ok) {
        // Post-write source-URL guard: drop any story whose source_url isn't
        // from a Tier-1 whitelisted publisher (catches writer hallucinations).
        let { content: stripped, dropped } = stripNonWhitelistedFromContent(validation.data, ed);
        if (dropped > 0) {
          console.log(`[${ed}] Post-write strip removed ${dropped} non-whitelisted stories.`);
          // Sprint 14.8 — top the stripped sections back up to the subset counts
          // (the real fix for "only 2 India items"). Re-validate; keep the
          // top-up only if it still passes Zod, so it can never ship bad content.
          const candidate = JSON.parse(JSON.stringify(stripped));
          const added = backfillToSubsetCounts(candidate, ed, writerInput);
          if (added > 0) {
            const reval = validateBrief(candidate, ed);
            if (reval.ok) {
              stripped = reval.data;
              console.log(`[${ed}] strip backfill restored ${added} story(ies) to subset counts.`);
            } else {
              console.warn(`[${ed}] strip backfill invalid; keeping stripped brief — ${reval.errors}`);
            }
          }
        }
        // Sprint 13: drop stories whose source_url is definitively dead (404/410).
        const live = await dropDeadLinkStories(stripped, ed);
        if (live.dropped > 0) {
          console.log(`[${ed}] URL liveness dropped ${live.dropped} dead-linked stories.`);
        }
        // Sprint 14.4: deterministic editorial guardrails (dedupe / signature)
        // run here — after validation/strip/liveness, before save — so they
        // apply to exactly the content the reader will see.
        let finalContent = sanitizeEditionContent(ed, live.content);
        // Sprint 14.5/14.8: copy-desk QA on the editions where contradiction /
        // synthesis risk is highest. BLOCKING (founder decision): high-severity
        // contradictions/fabrications are dropped, then we re-validate and top
        // up so a drop can't leave a section short or the brief invalid. Gated
        // by COHERENCE_ENFORCE ('off' reverts to log-only).
        if (ed === '10min' || ed === 'deep') {
          try {
            const issues = await runCoherenceCheck(ed, finalContent);
            if (COHERENCE_ENFORCE && issues.length > 0) {
              const candidate = JSON.parse(JSON.stringify(finalContent));
              const dropRes = applyCoherenceDrops(
                candidate, ed, issues,
                COHERENCE_BACKFILL_GUARD ? { guard: true, subset: writerInput } : undefined,
              );
              const removed = dropRes.removed;
              if (removed > 0) {
                // F1: bar the just-dropped stories from being re-added by backfill.
                backfillToSubsetCounts(
                  candidate, ed, writerInput,
                  COHERENCE_BACKFILL_GUARD ? dropRes.droppedUrlKeys : undefined,
                );
                const reval = validateBrief(candidate, ed);
                if (reval.ok) {
                  finalContent = reval.data;
                  console.log(`[${ed}] coherence enforcement removed ${removed} story(ies); brief re-validated.`);
                } else {
                  console.warn(`[${ed}] coherence-enforced brief invalid; shipping pre-enforcement content — ${reval.errors}`);
                }
              }
            }
          } catch (e: any) { console.warn(`[${ed}] coherence check skipped: ${e?.message || e}`); }
        }
        // Save the FULL rawStories (not the subset) into the brief row so
        // downstream consumers see the same raw for every edition.
        // Sprint 19 — replace any backfill template "why it matters" with real,
        // story-specific analysis before saving, so padded stories never render
        // as canned boilerplate (the Sprint 18 regression). Catches every
        // backfill path (empty-section, post-strip top-up, post-coherence top-up).
        await rewriteTemplateWhys(finalContent, ed);
        // Sprint 26 (F7) / 27.1 — final invariant check on the exact object being
        // saved; the full pool rides along so the curated-lead delivery report
        // can recognise cut leads that never made the subset.
        if (BRIEF_INVARIANTS) {
          const inv = checkBriefInvariants(finalContent, writerInput, ed, rawStories);
          if (!inv.ok && inv.halted && BRIEF_INVARIANTS_HALT) {
            throw new Error(`INVARIANTS_HALT: ${ed} — ${inv.violations.join(' | ')}`);
          }
        }
        // Sprint 27.1 (N6) — SHIPPED census on the exact object being saved.
        // The 07-05 run's writer diagnostic said "politics 5/5" while liveness
        // had dropped a fabricated URL and 4 shipped — written≠shipped was
        // invisible. This line is the shipped truth the RCA should reconcile
        // against the writer line.
        try {
          const shippedKeys = (WRITER_DIAG_SECTIONS[ed] || []).filter((k) => Array.isArray((finalContent as any)?.[k]));
          const parts = shippedKeys.map((k) => `${k} ${(finalContent as any)[k].length}`);
          const totalShipped = shippedKeys.reduce((n, k) => n + (finalContent as any)[k].length, 0);
          console.log(`[write:${ed}] shipped — ${parts.join(' · ')} · total ${totalShipped}`);
        } catch (e) { /* diagnostic only */ }
        await saveBriefToSupabase(ed, rawStories, finalContent, lens, 'ready');
        return { status: 'ready', content: finalContent };
      }
      // Narrowed: validation is the failure branch here.
      const errMsg = (validation as { ok: false; errors: string }).errors;
      lastError = errMsg;
      console.warn(`[${ed}] Attempt ${attempt} validation failed: ${errMsg}`);
    } catch (err: any) {
      lastError = err.message;
      console.warn(`[${ed}] Attempt ${attempt} threw: ${err.message}`);
      // Sprint 20.1 — callOpenAIChat now does its own bounded 429 backoff. A
      // tagged RATE_LIMITED error means the token window did not clear within the
      // function budget; an immediate second attempt would only fail again and
      // risk the 60s cap, so stop and fall back cleanly.
      if (typeof err?.message === 'string' && err.message.startsWith('RATE_LIMITED')) {
        console.warn(`[${ed}] rate limit persisted past in-call backoff — skipping redundant retry, using fallback.`);
        break;
      }
      // Sprint 26 (F7) — a halt-class invariant violation means the brief we
      // built is unshippable; a retry would likely reproduce it, so go straight
      // to the previous-good-brief fallback instead of burning the second attempt.
      if (typeof err?.message === 'string' && err.message.startsWith('INVARIANTS_HALT')) {
        console.error(`[${ed}] HALTED by final invariant checker — not shipping this brief; falling back to the previous good brief. ${err.message}`);
        break;
      }
    }
  }

  // Both attempts failed — fall back to yesterday's brief, but only if
  // yesterday's brief is itself fresh (status='ready'). If yesterday was
  // already a fallback, we'd be inheriting stale content from days ago — stop
  // the chain and mark today 'failed' so the UI shows "no fresh brief today"
  // instead of week-old stories.
  console.error(`[${ed}] Both attempts failed. Last error: ${lastError}`);
  const prev = await fetchPreviousBrief(ed);
  if (prev && prev.status === 'ready') {
    await saveBriefToSupabase(ed, rawStories, prev.content, prev.lens, 'fallback');
    return { status: 'fallback', reason: lastError, content: prev.content };
  }
  if (prev && prev.status !== 'ready') {
    console.warn(`[${ed}] Previous brief was status=${prev.status}, not 'ready'. Refusing to chain-fallback; marking today as failed.`);
  }
  await saveBriefToSupabase(ed, rawStories, null, lens, 'failed');
  return { status: 'failed', reason: lastError };
}

// ─── Mode: fetch ────────────────────────────────────────────────────────────
//
// Phase 1 of the daily flow. Loads personalisation universe, fetches news +
// lens from OpenAI, saves raw_stories to three pending brief rows (one per
// edition). Lens lives inside raw_stories.lens — the writers read it from
// there in the write phase.

// ============================================================================
// SECTION 23:  CRON MODES: fetch / write / push
// ----------------------------------------------------------------------------
// The mode entry points the cron hits: modeFetch (Stage 1 -> raw_stories),
// modeWrite (writes editions 5->10->deep sequentially), modePush (OneSignal).
// emptySectionCount() is a shared diagnostic.
// Fns:   modeFetch, modeWrite, modePush, emptySectionCount
// Flags: -
// ============================================================================
async function modeFetch() {
  const universe = await loadPersonalisationUniverse();
  console.log(`Universe — industries: ${universe.industries.length}, interests: ${universe.interests.length}, cities: ${universe.cities.length}`);

  let rawStories: RawStories;
  try {
    console.log('Fetching news from OpenAI...');
    rawStories = await fetchNewsFromOpenAI(universe);
    console.log('News fetched.');
  } catch (err: any) {
    console.error('OpenAI fetch failed:', err.message);
    return { ok: false as const, error: `OpenAI fetch failed: ${err.message}` };
  }

  // Sprint 14.2: dedicated politics + markets_news article buckets. Fetched
  // here as two self-contained list-section calls (NOT woven into the multi-
  // strategy core fetch, to keep blast radius small). Always fetched so the
  // Desks pool has genuine markets/politics depth; shown in the brief only to
  // opted-in users. Non-fatal — failure leaves the section empty.
  {
    const todayF = getISTDate();
    const politicsGuidance = `Focus: INDIAN POLITICS & GOVERNANCE. Parliament, central and state governments, parties, elections, the Supreme Court and high courts, key appointments, bills and policy decisions, major political developments. Strictly factual and non-partisan — report positions and actions, attribute claims. Prefer the last 24-48 hours.`;
    const marketsNewsGuidance = `Focus: MARKETS & FINANCE ARTICLES (not index levels). Equities, bonds, currencies, commodities, RBI/SEBI actions, IPOs, earnings that move markets, fund flows, what professional investors are watching — anchored to Indian portfolios where possible. Prefer the last 24-48 hours.`;
    const [politics, marketsNews] = await Promise.all([
      fetchListSection('politics', politicsGuidance, '6-8', universe, todayF).catch((e) => {
        console.warn('[fetch:politics] failed (non-fatal):', e?.message || e); return [];
      }),
      fetchListSection('markets_news', marketsNewsGuidance, '6-8', universe, todayF).catch((e) => {
        console.warn('[fetch:markets_news] failed (non-fatal):', e?.message || e); return [];
      }),
    ]);
    const wl = (arr: any) => (Array.isArray(arr) ? arr : []).filter((s: any) => s?.source_url && isWhitelistedSource(s.source_url));
    (rawStories as any).politics = wl(politics);
    (rawStories as any).markets_news = wl(marketsNews);
    console.log(`[fetch] sprint14.2 buckets — politics=${(rawStories as any).politics.length}, markets_news=${(rawStories as any).markets_news.length}`);
  }

  const lensOk = !!rawStories.lens && validateLens(rawStories.lens);
  if (!lensOk) console.warn('Lens missing or invalid in fetch response.');

  const today = getISTDate();
  const editions: Edition[] = ['5min', '10min', 'deep'];

  // Save 3 pending rows in parallel. raw_stories carries the lens, so write
  // mode can pick it up from there. content stays null until write runs.
  await Promise.all(editions.map(async (ed) => {
    const { error } = await supabase
      .from('briefs')
      .upsert(
        {
          date: today,
          edition: ed,
          status: 'pending',
          raw_stories: rawStories,
          content: null,
          generated_at: new Date().toISOString(),
        },
        { onConflict: 'date,edition' },
      );
    if (error) throw new Error(`Pending save failed (${ed}): ${error.message}`);
    console.log(`Saved pending raw for ${ed} on ${today}.`);
  }));

  return {
    ok: true as const,
    date: today,
    universe,
    lens_ok: lensOk,
    sections: {
      major_events:  rawStories.major_events.length,
      world:         rawStories.world.length,
      india:         rawStories.india.length,
      business:      rawStories.business.length,
      technology:    rawStories.technology.length,
      climate_health: rawStories.climate_health.length,
      sport:         rawStories.sport.length,
      culture:       rawStories.culture.length,
      markets_indices: rawStories.markets.indices.length,
    },
    next: "POST { mode: 'write', edition: '5min' | '10min' | 'deep' } in parallel for each edition.",
  };
}

// ─── Mode: write ────────────────────────────────────────────────────────────
//
// Phase 2. Read raw_stories from today's pending row for one edition, run
// the writer, validate, strip, save as 'ready'. If no pending row exists,
// fall back to yesterday's brief and mark 'fallback'.

async function modeWrite(edition: Edition) {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('briefs')
    .select('raw_stories, status')
    .eq('date', today)
    .eq('edition', edition)
    .maybeSingle();

  if (error) {
    console.warn(`modeWrite read failed (${edition}):`, error.message);
  }

  const raw = (data?.raw_stories ?? null) as RawStories | null;

  if (!raw) {
    console.warn(`modeWrite: no raw_stories for ${edition} on ${today}. Did fetch run?`);
    const prev = await fetchPreviousBrief(edition);
    if (prev && prev.status === 'ready') {
      await saveBriefToSupabase(edition, null, prev.content, prev.lens, 'fallback');
      return {
        ok: true as const,
        edition,
        status: 'fallback' as const,
        reason: 'No raw_stories for today; restored previous ready brief. Run mode=fetch first to get fresh news.',
      };
    }
    await saveBriefToSupabase(edition, null, null, null, 'failed');
    return {
      ok: false as const,
      edition,
      status: 'failed' as const,
      error: 'No raw_stories for today and no previous brief to fall back to. Run mode=fetch first.',
    };
  }

  const lens = raw.lens && validateLens(raw.lens) ? raw.lens : null;
  const outcome = await runWriterForEdition(edition, raw, lens);
  return {
    ok: outcome.status !== 'failed',
    edition,
    status: outcome.status,
    reason: outcome.reason,
  };
}

// ─── Mode: push ─────────────────────────────────────────────────────────────
//
// Phase 3 (optional). Picks today's best top headline across ready briefs
// and sends a OneSignal push. Idempotent-ish: safe to call again, but you'll
// get a second push.

async function modePush() {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('briefs')
    .select('content, edition')
    .eq('date', today)
    .eq('status', 'ready');

  if (error) {
    return { ok: false as const, error: `Read failed: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { ok: false as const, error: 'No ready briefs for today; not pushing.' };
  }

  // Prefer 5min → 10min top headline. major_events first, then world.
  const byEd: Record<string, any> = {};
  for (const row of data) byEd[row.edition] = row.content;

  const top =
    (byEd['5min']  as any)?.major_events?.[0]?.headline ??
    (byEd['10min'] as any)?.major_events?.[0]?.headline ??
    (byEd['5min']  as any)?.world?.[0]?.headline ??
    (byEd['10min'] as any)?.world?.[0]?.headline ??
    "Today's stories are waiting for you.";

  try {
    const result = await sendPushNotification(top);
    return { ok: true as const, headline: top, recipients: result?.recipients ?? null };
  } catch (err: any) {
    console.error('Push failed:', err.message);
    return { ok: false as const, error: err.message };
  }
}

// ─── Mode: score (Sprint 11) ────────────────────────────────────────────────
//
// LLM-based 7-dimension quality scoring against the Sprint 10 rubric.
// Reads all three ready briefs for today and writes one row per edition to
// brief_scores. Sprint 12.2: scorer model is gpt-4o (~$0.02/edition,
// ~$0.06/run for 3 editions). Was gpt-4o-mini at ~$0.005/run — bumped for
// stricter scoring after the gpt-4o-mini scorer gave 59/70 to a brief with
// 5 empty sections.
//
// Trigger: cron #7 at 6:50 IST (after writes finish ~6:41) OR manual button
// from /admin/ops. Re-running on the same day overwrites previous score
// (UNIQUE constraint on date+edition).
//
// Output: { date, perEdition: { '5min': {...scores}, '10min': {...}, 'deep': {...} } }

// ─── Sprint 13: deterministic empty-section penalty ─────────────────────────
//
// The LLM scorer historically under-penalised empty sections (gpt-4o-mini once
// gave 59/70 to a brief with 5 empty sections). Penalty is now computed in
// CODE, not left to the model: -5 on Coverage AND -5 on Field Completeness per
// empty section, floored at 0. deep has schema-enforced minimum counts, so no
// section can be empty there.

function emptySectionCount(edition: Edition, content: any): number {
  const sections = LIVENESS_SECTIONS[edition]; // same section lists apply
  if (!sections) return 0;
  let empty = 0;
  for (const sec of sections) {
    if (!Array.isArray(content?.[sec]) || content[sec].length === 0) empty++;
  }
  return empty;
}

// ─── Sprint 14.8 — OMISSION-AWARE SCORING (founder decision) ─────────────────
//
// The 7-dim scorer only ever saw the brief's OWN content, so it could not know
// what the day's actual top stories were — it scored currentness/relevance 9/9
// on a brief that missed Mumbai's water crisis, the Trump-Iran development, etc.
// (16-Jun run). Coverage's only real penalty was the empty-section check, which
// fires on a STRUCTURALLY empty section, never on one full of filler.
//
// ─── Sprint 20 Drop 4 — HYBRID, FAIL-LOUD GROUND TRUTH ──────────────────────
//
// The original design fetched the reference with ONE Perplexity call. On the
// 2026-06-26 run that call returned `{"india":[],"world":[]}` (24 chars, 9
// output tokens): sonar-pro complied with the JSON contract but returned EMPTY
// arrays, because the prompt's hard "MUST contain a proper noun / OMIT rather
// than pad" rules taught it to return nothing on a marginal day. fetch then
// returned null and the grader scored coverage ANYWAY — handing out dim_coverage
// 8/9/9 with no penalty. The gauge had flipped from false-0 (Sprint 20 open) to
// false-healthy. Both are lies.
//
// Drop 4 makes the gauge trustworthy in three layers:
//   1. PRIMARY  — Perplexity, hardened: a prompt that PREFERS (not forces)
//                 specific headlines and is told never to return an empty list;
//                 a usable-count check on PARSED headlines (not just non-empty);
//                 and one retry with a simpler prompt on a thin response.
//   2. FALLBACK — an independent top-headlines news API (vendor-agnostic:
//                 GNews / NewsData / NewsAPI, selected by two env vars). Truly
//                 independent of both the RSS pool and Perplexity, and named by
//                 nature. Fail-safe: unset or erroring ⇒ skipped, never throws.
//   3. BACKSTOP — fail LOUD. If both layers come back empty the orchestrator
//                 returns null and the grader WITHHOLDS coverage (see
//                 scoreBriefWithLLM) instead of inventing a number. The silent 8
//                 can never ship again.
//
// Gated by SCORE_GROUNDTRUTH ('off' skips the whole thing and the penalty).

// ============================================================================
// SECTION 24:  GROUND TRUTH & COVERAGE SCORING
// ----------------------------------------------------------------------------
// Independent ground-truth retrieval (Perplexity sonar-pro + news-API fallback,
// withheld loudly if neither), and coverage measurement: COVERAGE_V3 weighted
// miss for 5/10min, and DEEP_COVERAGE_V2 corpus-based scoring for the deep
// edition (flattens prose incl. three_patterns[].stories_connected).
// Fns:   fetchGroundTruthHeadlines, measureCoverageV3, measureDeepCoverage, collectDeepStrings
// Flags: SCORE_GROUNDTRUTH, COVERAGE_V2/V3, DEEP_COVERAGE_V2, DEEP_COVERAGE_STRICT, COVERAGE_ANCHOR_MATCH
// ============================================================================
const SCORE_GROUNDTRUTH = (process.env.SCORE_GROUNDTRUTH || 'on').toLowerCase() !== 'off';

// Minimum parsed headlines (India + world) for a reference to count as "usable".
// A response thinner than this triggers the Perplexity retry, then the fallback.
const GROUNDTRUTH_MIN_HEADLINES = Math.max(
  2,
  parseInt(process.env.GROUNDTRUTH_MIN_HEADLINES || '4', 10) || 4,
);

// Independent fallback source. BOTH must be set to enable it; otherwise the
// fallback layer is cleanly skipped (Perplexity → fail-loud). The provider name
// picks the adapter; the API key is the only other thing to set. One var to swap.
const GROUNDTRUTH_NEWS_PROVIDER = (process.env.GROUNDTRUTH_NEWS_PROVIDER || '').trim().toLowerCase();
const GROUNDTRUTH_NEWS_API_KEY = (process.env.GROUNDTRUTH_NEWS_API_KEY || '').trim();

type GroundTruth = { india: string[]; world: string[]; source?: string };

// Normalise a raw list of header-ish values into clean, deduped headline strings.
function cleanHeadlineList(a: any): string[] {
  if (!Array.isArray(a)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of a) {
    const h = String(x || '').replace(/\s+/g, ' ').trim();
    if (!h) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= 12) break;
  }
  return out;
}

// ── Layer 1: Perplexity (hardened) ──────────────────────────────────────────
function buildGroundTruthPrompt(today: string, simple: boolean): string {
  if (simple) {
    return `Return ONLY JSON: {"india":["headline", ...], "world":["headline", ...]}.
List the 8 biggest India news headlines and the 6 biggest world (non-India) news headlines for ${today} (IST).
Use real developments from today. Plain factual headlines. No commentary, no markdown, and never return empty arrays.`;
  }
  return `List the most important real news headlines for ${today} (IST). This is a neutral reference set used to audit a news brief's completeness.
Return ONLY JSON: {"india":["headline", ...], "world":["headline", ...]}.
- "india": the 8-10 biggest India stories today (politics, policy, economy, courts, RBI/markets, major civic or state events).
- "world": the 6-8 biggest non-India stories today (geopolitics, conflicts, foreign policy, major institutions).
Write each headline so it is specific and matchable:
- Prefer headlines that name the concrete actor and event — the person, body, company, court, place, scheme, bill, or number (e.g. "RBI holds repo rate at 5.5%", "Supreme Court strikes down X", "ED raids Y in Z case").
- Prefer a named proper noun or institution/acronym (RBI, SEBI, SC, NCERT, ISRO…) where you can, and avoid vague filler like "the government announces new measures" or "a court hears petitions".
- Each must be a real development from today, not a standing trend.
IMPORTANT: always return the day's biggest real stories — never return empty arrays, and aim for at least 5 India and 4 world headlines if any news exists today. If you cannot name the specific actor, body, place, scheme, or number behind an item, OMIT that one item (do not pad it with vague phrasing) — but still return all the other, specific headlines. Drop weak items, never the whole list.
No commentary, no markdown.`;
}

async function fetchGroundTruthFromPerplexity(today: string): Promise<GroundTruth | null> {
  const attempt = async (simple: boolean): Promise<GroundTruth | null> => {
    try {
      const text = await callPerplexity(buildGroundTruthPrompt(today, simple), 60_000);
      const parsed = extractJsonObject(text);
      return {
        india: cleanHeadlineList(parsed?.india),
        world: cleanHeadlineList(parsed?.world),
        source: 'perplexity',
      };
    } catch (e: any) {
      console.warn(`[score:groundtruth:perplexity] call failed (${simple ? 'retry' : 'primary'}): ${e?.message || e}`);
      return null;
    }
  };

  let gt = await attempt(false);
  let count = gt ? gt.india.length + gt.world.length : 0;
  if (count < GROUNDTRUTH_MIN_HEADLINES) {
    console.warn(`[score:groundtruth:perplexity] thin response (${count} headline(s) < ${GROUNDTRUTH_MIN_HEADLINES}) — retrying with a simpler prompt.`);
    const retry = await attempt(true);
    const retryCount = retry ? retry.india.length + retry.world.length : 0;
    if (retryCount > count) { gt = retry; count = retryCount; }
  }
  if (!gt || count < GROUNDTRUTH_MIN_HEADLINES) {
    console.warn(`[score:groundtruth:perplexity] still unusable (${count} headline(s)) — handing off to the news-API fallback.`);
    return null;
  }
  console.log(`[score:groundtruth:perplexity] reference: ${gt.india.length} India + ${gt.world.length} world headlines.`);
  return gt;
}

// ── Layer 2: independent news API (vendor-agnostic) ─────────────────────────
async function fetchJsonWithTimeout(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: controller.signal });
    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      throw new Error(`status ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Each adapter returns two endpoint calls (India + world) and a picker mapping
// the provider's JSON to a list of headline strings. To add a provider, add one
// entry here — nothing else in the grader changes.
type NewsApiAdapter = {
  india: (key: string) => { url: string; headers?: Record<string, string> };
  world: (key: string) => { url: string; headers?: Record<string, string> };
  pick: (data: any) => any[];
};

const NEWS_API_ADAPTERS: Record<string, NewsApiAdapter> = {
  // gnews.io — free tier allows server-side use. category=world for world feed.
  gnews: {
    india: (k) => ({ url: `https://gnews.io/api/v4/top-headlines?lang=en&country=in&category=general&max=10&apikey=${encodeURIComponent(k)}` }),
    world: (k) => ({ url: `https://gnews.io/api/v4/top-headlines?lang=en&category=world&max=10&apikey=${encodeURIComponent(k)}` }),
    pick: (d) => Array.isArray(d?.articles) ? d.articles.map((a: any) => a?.title) : [],
  },
  // newsdata.io — free tier allows server-side use.
  newsdata: {
    india: (k) => ({ url: `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(k)}&country=in&language=en&category=top` }),
    world: (k) => ({ url: `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(k)}&language=en&category=world` }),
    pick: (d) => Array.isArray(d?.results) ? d.results.map((a: any) => a?.title) : [],
  },
  // newsapi.org — NOTE: free tier is dev-only (blocks production hosts). Useful
  // for local testing; expect 426/429 from Vercel on the free plan.
  newsapi: {
    india: (k) => ({ url: `https://newsapi.org/v2/top-headlines?country=in&pageSize=10`, headers: { 'X-Api-Key': k } }),
    world: (k) => ({ url: `https://newsapi.org/v2/top-headlines?language=en&category=general&pageSize=10`, headers: { 'X-Api-Key': k } }),
    pick: (d) => Array.isArray(d?.articles) ? d.articles.map((a: any) => a?.title) : [],
  },
};

async function fetchGroundTruthFromNewsApi(_today: string): Promise<GroundTruth | null> {
  if (!GROUNDTRUTH_NEWS_PROVIDER || !GROUNDTRUTH_NEWS_API_KEY) {
    console.log('[score:groundtruth:newsapi] not configured (set GROUNDTRUTH_NEWS_PROVIDER + GROUNDTRUTH_NEWS_API_KEY) — skipping fallback.');
    return null;
  }
  const adapter = NEWS_API_ADAPTERS[GROUNDTRUTH_NEWS_PROVIDER];
  if (!adapter) {
    console.warn(`[score:groundtruth:newsapi] unknown provider "${GROUNDTRUTH_NEWS_PROVIDER}" (known: ${Object.keys(NEWS_API_ADAPTERS).join(', ')}) — skipping fallback.`);
    return null;
  }
  try {
    const indiaReq = adapter.india(GROUNDTRUTH_NEWS_API_KEY);
    const worldReq = adapter.world(GROUNDTRUTH_NEWS_API_KEY);
    const [indiaData, worldData] = await Promise.all([
      fetchJsonWithTimeout(indiaReq.url, 15_000, indiaReq.headers).catch((e) => { console.warn(`[score:groundtruth:newsapi] india fetch failed: ${e?.message || e}`); return null; }),
      fetchJsonWithTimeout(worldReq.url, 15_000, worldReq.headers).catch((e) => { console.warn(`[score:groundtruth:newsapi] world fetch failed: ${e?.message || e}`); return null; }),
    ]);
    const gt: GroundTruth = {
      india: cleanHeadlineList(indiaData ? adapter.pick(indiaData) : []).slice(0, 10),
      world: cleanHeadlineList(worldData ? adapter.pick(worldData) : []).slice(0, 8),
      source: `newsapi:${GROUNDTRUTH_NEWS_PROVIDER}`,
    };
    const count = gt.india.length + gt.world.length;
    if (count < GROUNDTRUTH_MIN_HEADLINES) {
      console.warn(`[score:groundtruth:newsapi] provider=${GROUNDTRUTH_NEWS_PROVIDER} returned only ${count} usable headline(s) — treating as no reference.`);
      return null;
    }
    console.log(`[score:groundtruth:newsapi] provider=${GROUNDTRUTH_NEWS_PROVIDER} reference: ${gt.india.length} India + ${gt.world.length} world headlines.`);
    return gt;
  } catch (e: any) {
    console.warn(`[score:groundtruth:newsapi] fallback failed (non-fatal): ${e?.message || e}`);
    return null;
  }
}

// ── Orchestrator: primary → fallback → fail-loud ────────────────────────────
async function fetchGroundTruthHeadlines(today: string): Promise<GroundTruth | null> {
  if (!SCORE_GROUNDTRUTH) return null;

  const primary = await fetchGroundTruthFromPerplexity(today);
  if (primary) return primary;

  const fallback = await fetchGroundTruthFromNewsApi(today);
  if (fallback) return fallback;

  // Backstop: neither source produced a usable reference. Return null so the
  // grader WITHHOLDS the coverage score instead of inventing one (see
  // scoreBriefWithLLM). This is the loud failure that replaces the silent 8.
  console.error('[score:groundtruth] NO usable reference from Perplexity OR the news-API fallback — coverage will be WITHHELD (unverified) this run, not scored. Check PERPLEXITY_API_KEY / GROUNDTRUTH_NEWS_PROVIDER + GROUNDTRUTH_NEWS_API_KEY.');
  return null;
}

// Collect every headline the brief actually rendered (across all story sections).
function collectBriefHeadlines(content: any): string[] {
  if (!content || typeof content !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(content)) {
    if (Array.isArray(v)) {
      for (const s of v) {
        const h = (s && typeof s === 'object') ? (s as any).headline : null;
        if (typeof h === 'string' && h.trim()) out.push(h);
      }
    }
  }
  return out;
}

// A reference headline is "covered" if it shares >=2 significant words with any
// rendered headline, OR (Sprint 20.3) shares a distinctive ANCHOR — an acronym
// (RBI, SEBI, NCERT, ISRO…) or salient number — with one. The word-overlap test
// alone was too strict for cross-source headlines: "RBI keeps repo rate steady"
// and "RBI holds policy meetings" share only {rbi} and were wrongly scored as a
// miss, pinning coverage at 0 even when the brief covered the beat heavily.
const COVERAGE_MATCH_THRESHOLD = 2;
const COVERAGE_ANCHOR_MATCH = (process.env.COVERAGE_ANCHOR_MATCH || 'on').toLowerCase() !== 'off';

// Sprint 20 Drop 4 — what dim_coverage becomes when there is NO ground-truth
// reference at all (Perplexity + news-API fallback both unavailable). Default
// `null` = withheld/unverified, which is the honest reading and what surfaces in
// the snapshot. If your `brief_scores.dim_coverage` column is NOT NULL, set
// COVERAGE_UNVERIFIED_VALUE to a number (e.g. 0) so the upsert still writes; the
// loud "⚠ COVERAGE UNVERIFIED" note is stamped either way.
const COVERAGE_UNVERIFIED_VALUE: number | null = (() => {
  const raw = (process.env.COVERAGE_UNVERIFIED_VALUE || 'null').trim().toLowerCase();
  if (raw === 'null' || raw === '') return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : Math.max(0, Math.min(10, n));
})();

// Distinctive tokens that strongly identify a specific story: 3-5 letter
// uppercase acronyms and multi-digit numbers (tolls, ₹ amounts, percentages),
// excluding bare years and a few non-distinctive words. 2-letter acronyms are
// left out as too ambiguous (AI, SC, ED) — those still match via word overlap.
const ANCHOR_STOP = new Set(['THE', 'AND', 'FOR', 'NEW', 'GOVT', 'WWW']);
function anchorTokens(headline: string): Set<string> {
  const out = new Set<string>();
  if (!headline || typeof headline !== 'string') return out;
  for (const a of headline.match(/\b[A-Z]{3,5}\b/g) || []) {
    if (!ANCHOR_STOP.has(a)) out.add('@' + a.toLowerCase());
  }
  for (const n of headline.match(/\d{2,}/g) || []) {
    if (!/^(19|20)\d{2}$/.test(n)) out.add('#' + n);
  }
  return out;
}

// ─── Sprint 20 Drop 4.1 — make coverage honest, not binary ──────────────────
// Drop 4 fixed the *supply* of a reference. Drop 4.1 fixes two things the
// 2026-06-26 18:08 run exposed once the reference was flowing:
//   (a) NOISY REFERENCE — a loose prompt let generic filler ("Centre announces
//       nationwide rollout plan", "raids across 16 states") into the reference.
//       Filler matches no specific brief headline, so it false-misses.
//       `looksSpecific` drops the clearly-unmatchable filler before scoring
//       (belt-and-suspenders behind the tightened prompt).
//   (b) SATURATING PENALTY — the old penalty (−1.5/miss, capped −6) zeroed
//       coverage at just 4 misses and scored 3-of-16 the same as 11-of-12. The
//       new penalty scales with the MISS RATE so coverage degrades proportionally
//       instead of cratering (see the penalty block in scoreBriefWithLLM).
// Both gated by COVERAGE_V2 (default on; 'off' restores Drop-4 behaviour).
const COVERAGE_V2 = (process.env.COVERAGE_V2 || 'on').toLowerCase() !== 'off';
const COVERAGE_MISS_SCALE = parseInt(process.env.COVERAGE_MISS_SCALE || '8', 10) || 8;
const COVERAGE_MISS_CAP = parseInt(process.env.COVERAGE_MISS_CAP || '7', 10) || 7;

// A reference headline is "specific" (matchable) if it carries an anchor token
// (acronym/number) OR names a proper noun beyond the first word. Pure templated
// filler with neither ("centre announces nationwide rollout plan") is dropped so
// it can't false-miss. Conservative — only drops the clearly unmatchable.
function looksSpecific(headline: string): boolean {
  if (!headline || typeof headline !== 'string') return false;
  if (anchorTokens(headline).size > 0) return true;
  const words = headline.trim().split(/\s+/);
  let propers = 0;
  for (let i = 1; i < words.length; i++) {
    if (/^[A-Z][a-z'’]+/.test(words[i])) propers++;
  }
  return propers >= 1;
}

// The reference list actually used for scoring. Under COVERAGE_V2, drop filler;
// if that would leave too little to be meaningful, keep the raw list (never
// inflate coverage by emptying the reference).
function effectiveRefs(gt: GroundTruth): string[] {
  const all = [...(gt.india || []), ...(gt.world || [])];
  if (!COVERAGE_V2) return all;
  const specific = all.filter(looksSpecific);
  return specific.length >= 2 ? specific : all;
}

// ─── Sprint 20.1 — COVERAGE_V3: honest, weighted, edition-scoped coverage ────
// The 2026-06-27 run shipped dim_coverage=0 on BOTH shared editions while the
// 10-min brief actually carried 15 India stories. Three compounding causes:
//   (1) every reference headline counted equally (a state-election schedule ==
//       "Delhi HC directs MCD");
//   (2) the SAME reference graded the 5-min, which structurally has no markets
//       desk — so RBI/SEBI were "missed" by format, not by omission;
//   (3) the LLM was shown the missed list AND told to "penalise heavily", then
//       a deterministic penalty subtracted again — double-counting to 0.
// V3 replaces the LLM coverage score (for the story editions) with a direct,
// deterministic measurement: of the day's IMPORTANCE-WEIGHTED, EDITION-SCOPED
// reference headlines, what share did the brief actually cover? Grounded in the
// independent reference (Principle IV — honest before flattering), free (no
// extra model call — deliberately, to avoid adding load to the very phase we
// just hardened against rate limits), reverts to V2 with COVERAGE_V3=off. Deep
// (a synthesis edition with no story headlines to match) always keeps V2.
const COVERAGE_V3 = (process.env.COVERAGE_V3 || 'on').toLowerCase() !== 'off';

// Sprint 26 (F3) — default ON. The deep edition has NO top-level story headlines
// (its content lives in title/body prose and three_patterns[].stories_connected),
// so collectBriefHeadlines returns [] for it and EVERY reference headline scored
// as missed → `[score:deep] N/N missed (100%)` every run, a false telemetry
// signal. This flag switches the deep edition to a CORPUS coverage test: flatten
// all of deep's strings into one word+anchor bag and count a reference covered if
// its significant words (or anchors) appear anywhere in that prose. Affects only
// the deep COVERAGE score (telemetry) — never reader content. Revert with
// DEEP_COVERAGE_V2=false (deep then falls back to the old headline path).
const DEEP_COVERAGE_V2 = (process.env.DEEP_COVERAGE_V2 || 'true').toLowerCase() !== 'false';

// Importance of a reference headline, 1 (minor/regional/process) to 3
// (day-defining national news). Deterministic + transparent; tune freely.
function referenceImportance(headline: string): number {
  if (!headline || typeof headline !== 'string') return 1;
  let w = 1;
  if (anchorTokens(headline).size > 0) w += 1; // names an acronym or salient number
  const t = headline.toLowerCase();
  const major = /\b(parliament|supreme court|election commission|cabinet|union (home|finance|cabinet)|home ministry|finance ministry|prime minister|\bpm\b|rbi|sebi|war|strikes?|killed|dead|earthquake|ceasefire|treaty|verdict|banned|nationwide|budget|gdp|repo rate|inflation|sensex|nifty)\b/;
  if (major.test(t)) w += 1;
  return Math.min(3, Math.max(1, w));
}

// The reference list a given edition should be graded against. 10-min/deep use
// the full (de-filler) list. The 5-min carries major/india/world + a folded
// topics bucket but no dedicated markets desk, so pure-corporate refs are
// dropped from its yardstick (macro — RBI/inflation/budget — stays, it belongs
// in any edition). Never empties the list (falls back to the full set).
function scopedRefs(gt: GroundTruth, edition: Edition): string[] {
  const base = effectiveRefs(gt);
  if (edition !== '5min') return base;
  const corporateOnly = /\b(ipo|shares?|stocks?|bourse|listing|circuit|brokerage|mutual fund|disclosure norms|q[1-4]\b|earnings)\b/i;
  const macro = /\b(rbi|repo rate|inflation|gdp|fiscal|budget)\b/i;
  const scoped = base.filter((h) => !(corporateOnly.test(h) && !macro.test(h)));
  return scoped.length >= 2 ? scoped : base;
}

type CoverageV3Result = { score: number; missed: string[]; totalScoped: number; weightedMissRate: number };

// Deterministic coverage: weighted share of the edition-scoped reference the
// brief covered, mapped to 0-10. Uses the SAME match test as V2 (word overlap
// OR a shared anchor) so a beat covered with different phrasing still counts.
function measureCoverageV3(content: any, gt: GroundTruth, edition: Edition): CoverageV3Result {
  const refs = scopedRefs(gt, edition);
  const briefHeads = collectBriefHeadlines(content);
  const briefSets = briefHeads.map(significantWords);
  const briefAnchors = COVERAGE_ANCHOR_MATCH ? briefHeads.map(anchorTokens) : [];
  let totalW = 0;
  let missedW = 0;
  const missed: string[] = [];
  for (const ref of refs) {
    const refSet = significantWords(ref);
    if (refSet.size === 0) continue;
    const w = referenceImportance(ref);
    totalW += w;
    let covered = briefSets.some((b) => semanticOverlap(refSet, b) >= COVERAGE_MATCH_THRESHOLD);
    if (!covered && COVERAGE_ANCHOR_MATCH) {
      const refAnchors = anchorTokens(ref);
      if (refAnchors.size > 0) {
        covered = briefAnchors.some((ba) => {
          for (const tok of Array.from(refAnchors)) if (ba.has(tok)) return true;
          return false;
        });
      }
    }
    if (!covered) { missedW += w; missed.push(ref); }
  }
  const weightedMissRate = totalW > 0 ? missedW / totalW : 0;
  const score = Math.max(0, Math.min(10, Math.round((1 - weightedMissRate) * 10)));
  return { score, missed, totalScoped: refs.length, weightedMissRate };
}

// ─── Sprint 26 (F3) — deep-edition corpus coverage ──────────────────────────
// Recursively flatten every string in the deep content (titles, bodies, and the
// nested three_patterns[].stories_connected arrays the headline collector can't
// see) so a reference can be matched against the full prose, not a headline list
// that is empty for this edition. Depth-guarded against pathological nesting.
function collectDeepStrings(node: any, out: string[], depth: number): void {
  if (node == null || depth > 8) return;
  if (typeof node === 'string') { if (node.trim()) out.push(node); return; }
  if (Array.isArray(node)) { for (const v of node) collectDeepStrings(v, out, depth + 1); return; }
  if (typeof node === 'object') { for (const k of Object.keys(node)) collectDeepStrings((node as any)[k], out, depth + 1); return; }
}

// ─── Sprint 27.1 (N4) — make deep coverage CREDIBLE, not just non-zero ──────
// F3 fixed the mechanical bug (headline matcher on a headline-less edition) but
// the 07-05 audit showed the replacement over-corrected: pooling EVERY word of
// deep prose into one bag meant "delhi" from one story + "threat" from another
// satisfied the 2-word bar — 16/16 covered, with provably absent topics (no
// "bomb", no "OPEC", no "Thackeray" anywhere in the corpus). A guaranteed 0
// became a near-guaranteed 10; both are false telemetry.
// Strict mode (default ON, revert with DEEP_COVERAGE_STRICT=false):
//   (1) PER-STRING matching — a reference's words must co-occur inside ONE deep
//       string (a title/body/connected-story line), not scattered corpus-wide;
//   (2) at least one matched word must be NON-GENERIC — everyday India-news
//       vocabulary (india, government, leader, security, threat, tensions…)
//       cannot carry a match on its own;
//   (3) anchor matches (acronyms/salient numbers) still count, also per-string;
//   (4) every COVERED reference logs its evidence (matched tokens + snippet),
//       so a suspicious score is auditable from the run log in seconds.
// Telemetry only — never touches reader content.
const DEEP_COVERAGE_STRICT = (process.env.DEEP_COVERAGE_STRICT || 'true').toLowerCase() !== 'false';

// Words too common in any Indian news corpus to identify a SPECIFIC story.
// They still count toward the 2-word bar — they just can't be the only
// evidence. Extends STOPWORDS (already excluded by significantWords).
const DEEP_GENERIC_WORDS = new Set([
  'india', 'indian', 'indias', 'delhi', 'mumbai', 'government', 'centre', 'central',
  'state', 'states', 'minister', 'ministry', 'court', 'courts', 'police', 'national',
  'official', 'officials', 'leader', 'leaders', 'opposition', 'party', 'political',
  'politics', 'security', 'threat', 'threats', 'crisis', 'talks', 'deal', 'report',
  'reports', 'plan', 'plans', 'policy', 'market', 'markets', 'economy', 'economic',
  'growth', 'prices', 'price', 'global', 'world', 'week', 'launch', 'launches',
  'major', 'debate', 'controversy', 'tensions', 'rise', 'rises', 'raise', 'fall',
  'falls', 'expected', 'announces', 'announced', 'says', 'said', 'amid', 'after',
  'against', 'people', 'country', 'nation', 'issue', 'issues', 'move', 'action',
]);

type DeepMatchEvidence = { ref: string; tokens: string[]; snippet: string };

// Deep coverage: same weighted, edition-scoped measurement as measureCoverageV3,
// but matched against deep's prose. STRICT (default): per-string co-occurrence
// with a non-generic requirement, evidence logged. Legacy (STRICT=false): the
// Sprint 26 corpus-bag behaviour.
function measureDeepCoverage(content: any, gt: GroundTruth, edition: Edition): CoverageV3Result {
  const refs = scopedRefs(gt, edition); // deep -> full de-filler list (scopedRefs returns base for non-5min)
  const strings: string[] = [];
  collectDeepStrings(content, strings, 0);

  if (DEEP_COVERAGE_STRICT) {
    // Pre-tokenise each deep string once.
    const stringWords: Set<string>[] = strings.map((s) => significantWords(s));
    const stringAnchors: Set<string>[] = COVERAGE_ANCHOR_MATCH ? strings.map((s) => anchorTokens(s)) : [];
    let totalW = 0;
    let missedW = 0;
    const missed: string[] = [];
    const evidence: DeepMatchEvidence[] = [];
    for (const ref of refs) {
      const refSet = significantWords(ref);
      if (refSet.size === 0) continue;
      const w = referenceImportance(ref);
      totalW += w;
      const refToks = Array.from(refSet);
      const refAnchors = COVERAGE_ANCHOR_MATCH ? anchorTokens(ref) : new Set<string>();
      let covered = false;
      for (let i = 0; i < strings.length && !covered; i++) {
        const sw = stringWords[i];
        const matchedToks = refToks.filter((t) => sw.has(t));
        const nonGeneric = matchedToks.filter((t) => !DEEP_GENERIC_WORDS.has(t));
        if (matchedToks.length >= COVERAGE_MATCH_THRESHOLD && nonGeneric.length >= 1) {
          covered = true;
          evidence.push({ ref, tokens: matchedToks, snippet: strings[i].slice(0, 60) });
          break;
        }
        if (COVERAGE_ANCHOR_MATCH && refAnchors.size > 0) {
          const sa = stringAnchors[i];
          const matchedAnchor = Array.from(refAnchors).find((t) => sa.has(t));
          if (matchedAnchor) {
            covered = true;
            evidence.push({ ref, tokens: [matchedAnchor], snippet: strings[i].slice(0, 60) });
            break;
          }
        }
      }
      if (!covered) { missedW += w; missed.push(ref); }
    }
    // Evidence block — one line per covered reference, so a 16/16 is verifiable
    // (or falsifiable) from the run log without re-deriving anything.
    for (const ev of evidence.slice(0, 20)) {
      console.log(`[score:deep] strict-evidence: "${ev.ref.slice(0, 55)}" ← [${ev.tokens.join(', ')}] in "${ev.snippet}…"`);
    }
    console.log(`[score:deep] strict deep-coverage — corpus ${strings.length} string(s); refs matched per-string with ≥${COVERAGE_MATCH_THRESHOLD} words incl. ≥1 non-generic, or an anchor.`);
    const weightedMissRate = totalW > 0 ? missedW / totalW : 0;
    const score = Math.max(0, Math.min(10, Math.round((1 - weightedMissRate) * 10)));
    if (score >= 9) {
      console.warn(`[score:deep] sanity — near-perfect deep coverage (${score}/10); verify the strict-evidence lines above before trusting (denominator: ${refs.length} scoped refs, ${strings.length} corpus strings).`);
    }
    return { score, missed, totalScoped: refs.length, weightedMissRate };
  }

  // Legacy Sprint-26 corpus-bag path (DEEP_COVERAGE_STRICT=false).
  const corpusWords = new Set<string>();
  const corpusAnchors = new Set<string>();
  for (const s of strings) {
    for (const w of Array.from(significantWords(s))) corpusWords.add(w);
    if (COVERAGE_ANCHOR_MATCH) for (const a of Array.from(anchorTokens(s))) corpusAnchors.add(a);
  }
  let totalW = 0;
  let missedW = 0;
  const missed: string[] = [];
  for (const ref of refs) {
    const refSet = significantWords(ref);
    if (refSet.size === 0) continue;
    const w = referenceImportance(ref);
    totalW += w;
    let overlap = 0;
    for (const t of Array.from(refSet)) if (corpusWords.has(t)) overlap++;
    let covered = overlap >= COVERAGE_MATCH_THRESHOLD;
    if (!covered && COVERAGE_ANCHOR_MATCH) {
      const refAnchors = anchorTokens(ref);
      for (const t of Array.from(refAnchors)) { if (corpusAnchors.has(t)) { covered = true; break; } }
    }
    if (!covered) { missedW += w; missed.push(ref); }
  }
  const weightedMissRate = totalW > 0 ? missedW / totalW : 0;
  const score = Math.max(0, Math.min(10, Math.round((1 - weightedMissRate) * 10)));
  return { score, missed, totalScoped: refs.length, weightedMissRate };
}

function missedReferenceHeadlines(content: any, gt: GroundTruth | null): string[] {
  if (!gt) return [];
  const briefHeads = collectBriefHeadlines(content);
  const briefSets = briefHeads.map(significantWords);
  const briefAnchors = COVERAGE_ANCHOR_MATCH ? briefHeads.map(anchorTokens) : [];
  const refs = effectiveRefs(gt);
  const missed: string[] = [];
  for (const ref of refs) {
    const refSet = significantWords(ref);
    if (refSet.size === 0) continue;
    let covered = briefSets.some((b) => semanticOverlap(refSet, b) >= COVERAGE_MATCH_THRESHOLD);
    if (!covered && COVERAGE_ANCHOR_MATCH) {
      const refAnchors = anchorTokens(ref);
      if (refAnchors.size > 0) {
        covered = briefAnchors.some((ba) => {
          for (const t of Array.from(refAnchors)) if (ba.has(t)) return true;
          return false;
        });
      }
    }
    if (!covered) missed.push(ref);
  }
  return missed;
}

// ============================================================================
// SECTION 25:  LLM SCORER + score / full MODES
// ----------------------------------------------------------------------------
// The gpt-4o 7-dimension rubric scorer (folds in the coverage number), plus
// modeScore and modeFull (the all-in-one run).
// Fns:   scoreBriefWithLLM, modeScore, modeFull
// Flags: -
// ============================================================================
async function scoreBriefWithLLM(
  edition: Edition,
  content: any,
  groundTruth?: GroundTruth | null,
): Promise<{
  dim_coverage: number | null;
  dim_field_completeness: number;
  dim_india_anchor: number;
  dim_source_quality: number;
  dim_editorial_sharpness: number;
  dim_currentness: number;
  dim_relevance: number;
  total: number;
  notes: string;
}> {
  // Prepare a compact representation of the brief for the scorer. Strip
  // fields the scorer doesn't need (tags, must_include flags) to keep input
  // tokens low. The scorer reads headlines, bodies, sources, and structure.
  const compact = JSON.stringify(content, null, 0).slice(0, 28000);

  // Sprint 14.8 — give the scorer the day's REAL top headlines so COVERAGE is
  // judged against what actually happened, not just against the brief itself.
  // Sprint 26 (F3): for deep, the missed list comes from the prose-corpus test,
  // not the (empty) headline list — so both the LLM prompt below and the
  // deterministic path use the correct missed set.
  const deepCov = (DEEP_COVERAGE_V2 && edition === 'deep' && groundTruth)
    ? measureDeepCoverage(content, groundTruth as GroundTruth, edition)
    : null;
  const missedRefs = deepCov ? deepCov.missed : missedReferenceHeadlines(content, groundTruth || null);
  const referenceBlock = groundTruth
    ? `\n\nCOVERAGE REFERENCE — the day's actual top headlines from major outlets (independently retrieved). Judge COVERAGE against THIS list; a brief that omits several of these has a real coverage gap, however polished the stories it did include:\nINDIA: ${groundTruth.india.map((h) => `• ${h}`).join('\n')}\nWORLD: ${groundTruth.world.map((h) => `• ${h}`).join('\n')}\n${missedRefs.length ? `Reference headlines this brief appears to MISS entirely: ${missedRefs.map((h) => `"${h}"`).join('; ')}.` : 'The brief appears to cover the reference headlines.'}`
    : '';

  const prompt = `You are the quality auditor for Morning Brief, a daily news digest for thoughtful urban Indian professionals (25-45). You score one edition against a 7-dimension rubric. Be honest and discerning. Most production briefs score 50-62/70. A score of 70/70 is rare and reserved for exceptional days.

EDITION SCORED: ${edition === '5min' ? 'The Brief (5min commute skim)' : edition === '10min' ? 'The Daily (10min full edition)' : 'The Editorial (deep synthesis)'}

RUBRIC — score each dimension 0-10:

1. COVERAGE: Does the brief cover the day's most consequential stories? Use the COVERAGE REFERENCE below (if provided) as the yardstick — penalise heavily for reference headlines the brief omits. Higher = more comprehensive.

2. FIELD COMPLETENESS: Are all required fields populated on every story? For 10min: headline, facts, background, why_it_matters, what_happens_next, analysis. For 5min: headline, what_happened, why_it_matters. For deep: title, body, stories_connected. Empty/null/placeholder text on any field reduces this score significantly.

3. INDIA ANCHOR: Do stories — even global ones — explicitly connect to India? "Oil prices spike" should mention rupee/CAD/inflation impact. "US Fed decision" should mention RBI implications. Higher = stronger Indian transmission channels named in every story.

4. SOURCE QUALITY: Are sources diverse (no single publisher dominating) and authoritative (Tier-1 wires, papers of record, specialist outlets)? Penalise heavy dependence on ONE publisher (e.g. >40% from Indian Express alone). Penalise weak sources (aggregators, blogs, press releases dressed as news).

5. EDITORIAL SHARPNESS: Is the voice intelligent and specific? Or does it read like rewritten wire copy? Sharp analysis, specific names/numbers/dates, calibrated uncertainty score high. Generic phrases ("amid rising tensions", "stay tuned for more") score low.

6. CURRENTNESS: Do headlines describe today's DEVELOPMENT, not the underlying narrative? "Tehran signals back-channel talks" (good) vs "Iran-US tensions continue" (bad). A story that merely describes a standing trend ("sector poised for growth", "demand at multi-month low") with no dated event is NOT current — drop this score for such filler.

7. RELEVANCE: Is the brief well-targeted at urban Indian professionals (25-45)? Is the mix of world/India/business/tech/sport/culture right for that audience? Or does it over-index on a niche topic, miss obvious appeal, or skew too foreign / too political?

BRIEF CONTENT:
${compact}${referenceBlock}

OUTPUT — return ONLY this JSON, no preamble, no markdown:
{
  "dim_coverage": <integer 0-10>,
  "dim_field_completeness": <integer 0-10>,
  "dim_india_anchor": <integer 0-10>,
  "dim_source_quality": <integer 0-10>,
  "dim_editorial_sharpness": <integer 0-10>,
  "dim_currentness": <integer 0-10>,
  "dim_relevance": <integer 0-10>,
  "notes": "<2-3 sentence overall assessment naming the brief's strongest dimension and its weakest>"
}`;

  // Sprint 12.2: scorer model upgraded from gpt-4o-mini to gpt-4o.
  // gpt-4o-mini was too lenient — it scored a brief with 5 empty sections at
  // 59/70 (Sprint 12 run on 2026-06-08). gpt-4o is more discerning on
  // section absence and editorial nuance. Per-call cost rises from ~$0.001
  // to ~$0.02; daily total stays under $0.10 for 3 editions. Worth it for
  // honest signal on whether the brief actually cleared the 60+ bar.
  const parsed = await callOpenAIChat(
    'gpt-4o',
    prompt,
    1500,
    `score-${edition}`,
    'score',
  );

  const clamp = (n: any) => {
    const v = typeof n === 'number' ? Math.round(n) : parseInt(String(n || 0), 10);
    if (isNaN(v)) return 0;
    return Math.max(0, Math.min(10, v));
  };

  const dim_coverage_raw        = clamp(parsed?.dim_coverage);
  const dim_field_raw           = clamp(parsed?.dim_field_completeness);
  const dim_india_anchor        = clamp(parsed?.dim_india_anchor);
  const dim_source_quality      = clamp(parsed?.dim_source_quality);
  const dim_editorial_sharpness = clamp(parsed?.dim_editorial_sharpness);
  const dim_currentness         = clamp(parsed?.dim_currentness);
  const dim_relevance           = clamp(parsed?.dim_relevance);

  // Sprint 13: deterministic -5 per empty section on Coverage + Field
  // Completeness, applied in code so the scorer model can't be lenient.
  const emptySections = emptySectionCount(edition, content);
  const penalty = emptySections * 5;

  // ── Coverage assembly ──────────────────────────────────────────────────────
  // dim_field_completeness keeps the deterministic empty-section penalty.
  const dim_field_completeness = Math.max(0, dim_field_raw - penalty);

  // Sprint 20 Drop 4 — fail LOUD when there is no reference at all. If neither
  // Perplexity nor the news-API fallback returned a usable ground truth then
  // `groundTruth` is null and coverage was NEVER checked against the day's real
  // headlines. We do NOT pass the LLM's coverage number through (that was the
  // silent-8 bug) — we WITHHOLD it and stamp the note so the gap shows honestly.
  const coverageVerified = !!groundTruth;
  // V3 (default) measures coverage deterministically for the story editions;
  // deep and COVERAGE_V3=off keep the V2 LLM-score-minus-penalty path.
  const useV3 = coverageVerified && COVERAGE_V3 && (edition === '5min' || edition === '10min');
  // F3: deep coverage measured against the prose corpus (deepCov computed above).
  const useDeep = !!deepCov;

  let dim_coverage: number | null;
  let unverifiedNote = '';

  // Logging/notes fields, populated by whichever path runs.
  let missCount = missedRefs.length;
  let totalRefs = 0;
  let missRate = 0;
  let missPenalty = 0; // V2 only; V3 measures coverage rather than penalising it
  let missedForNote: string[] = missedRefs;

  if (useV3) {
    const cov = measureCoverageV3(content, groundTruth as GroundTruth, edition);
    // An empty section is itself a coverage failure — keep that deterministic hit.
    dim_coverage = Math.max(0, cov.score - penalty);
    missCount = cov.missed.length;
    totalRefs = cov.totalScoped;
    missRate = cov.weightedMissRate;
    missedForNote = cov.missed;
  } else if (useDeep) {
    // Sprint 26 (F3) — deep edition scored against its prose corpus.
    const cov = deepCov as CoverageV3Result;
    dim_coverage = Math.max(0, cov.score - penalty);
    missCount = cov.missed.length;
    totalRefs = cov.totalScoped;
    missRate = cov.weightedMissRate;
    missedForNote = cov.missed;
  } else if (coverageVerified) {
    // Sprint 20 Drop 4.1 — proportional, non-saturating penalty over the full
    // reference (COVERAGE_V2='off' restores the old saturating −1.5/miss capped −6).
    totalRefs = effectiveRefs(groundTruth as GroundTruth).length;
    missRate = totalRefs > 0 ? missCount / totalRefs : 0;
    missPenalty = COVERAGE_V2
      ? Math.min(COVERAGE_MISS_CAP, Math.round(missRate * COVERAGE_MISS_SCALE))
      : Math.min(6, Math.round(missCount * 1.5));
    dim_coverage = Math.max(0, dim_coverage_raw - penalty - missPenalty);
  } else {
    dim_coverage = COVERAGE_UNVERIFIED_VALUE;
    unverifiedNote = `⚠ COVERAGE UNVERIFIED — no ground-truth reference was available this run (Perplexity + news-API fallback both unavailable), so coverage was NOT scored against the day's real headlines; treat this edition's coverage as unknown until the reference source is fixed.`;
    console.error(`[score:${edition}] ⚠ COVERAGE UNVERIFIED — no ground-truth reference; dim_coverage withheld (${dim_coverage === null ? 'null' : dim_coverage}). This is the loud-fail path, not a real coverage reading.`);
  }

  if (emptySections > 0) {
    console.warn(`[score:${edition}] ${emptySections} empty section(s) → -${penalty} on coverage and field_completeness.`);
  }
  if (useV3) {
    console.warn(`[score:${edition}] coverage v3 — covered ${totalRefs - missCount}/${totalRefs} scoped reference headline(s) (weighted miss ${Math.round(missRate * 100)}%) → dim_coverage ${typeof dim_coverage === 'number' ? dim_coverage : 'n/a'}${penalty > 0 ? ` (after -${penalty} empty-section)` : ''}.${missedForNote.length ? ` Missed: ${missedForNote.slice(0, 6).map((h) => `"${h.slice(0, 60)}"`).join('; ')}` : ''}`);
  } else if (useDeep) {
    console.warn(`[score:${edition}] deep-coverage v2 (strict=${DEEP_COVERAGE_STRICT}) — covered ${totalRefs - missCount}/${totalRefs} reference headline(s) in deep prose (weighted miss ${Math.round(missRate * 100)}%) → dim_coverage ${typeof dim_coverage === 'number' ? dim_coverage : 'n/a'}${penalty > 0 ? ` (after -${penalty} empty-section)` : ''}.${missedForNote.length ? ` Missed: ${missedForNote.slice(0, 6).map((h) => `"${h.slice(0, 60)}"`).join('; ')}` : ''}`);
  } else if (missPenalty > 0) {
    console.warn(`[score:${edition}] ${missCount}/${totalRefs} reference headline(s) missed (${Math.round(missRate * 100)}%) → -${missPenalty} on coverage. Missed: ${missedForNote.slice(0, 6).map((h) => `"${h.slice(0, 60)}"`).join('; ')}`);
  }

  const total =
    (typeof dim_coverage === 'number' ? dim_coverage : 0) +
    dim_field_completeness + dim_india_anchor +
    dim_source_quality + dim_editorial_sharpness + dim_currentness + dim_relevance;

  return {
    dim_coverage,
    dim_field_completeness,
    dim_india_anchor,
    dim_source_quality,
    dim_editorial_sharpness,
    dim_currentness,
    dim_relevance,
    total,
    notes: (unverifiedNote ? unverifiedNote + ' ' : '')
      + (typeof parsed?.notes === 'string' ? parsed.notes.slice(0, 800) : '')
      + (emptySections > 0 ? ` [auto-penalty: ${emptySections} empty section(s), -${penalty} on coverage & field completeness]` : '')
      + (useV3
          ? ` [coverage v3: covered ${totalRefs - missCount}/${totalRefs} of the day's scoped top headlines (importance-weighted); dim_coverage ${typeof dim_coverage === 'number' ? dim_coverage : 'n/a'}/10]`
          : useDeep
          ? ` [deep-coverage v2: covered ${totalRefs - missCount}/${totalRefs} of the day's scoped top headlines in deep prose (importance-weighted); dim_coverage ${typeof dim_coverage === 'number' ? dim_coverage : 'n/a'}/10]`
          : (missPenalty > 0 ? ` [coverage-gap: missed ${missCount} of the day's top headlines, -${missPenalty} on coverage]` : '')),
  };
}

async function modeScore() {
  const today = getISTDate();
  const { data, error } = await supabase
    .from('briefs')
    .select('edition, content, status')
    .eq('date', today)
    .eq('status', 'ready');

  if (error) {
    return { ok: false as const, error: `Read failed: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return { ok: false as const, error: 'No ready briefs for today; nothing to score.' };
  }

  const editions: Edition[] = ['5min', '10min', 'deep'];
  const results: Record<string, any> = {};

  // Sprint 14.8 — fetch the day's real top headlines ONCE (shared across all
  // three editions) so coverage is scored against what actually happened.
  const groundTruth = await fetchGroundTruthHeadlines(today);

  await Promise.all(
    editions.map(async (ed) => {
      const row = data.find((r) => r.edition === ed);
      if (!row || !row.content) {
        results[ed] = { status: 'skipped', reason: 'no ready brief' };
        return;
      }
      try {
        const scored = await scoreBriefWithLLM(ed, row.content, groundTruth);
        const { error: insErr } = await supabase
          .from('brief_scores')
          .upsert(
            {
              date: today,
              edition: ed,
              ...scored,
              max_score: 70,
            },
            { onConflict: 'date,edition' },
          );
        if (insErr) {
          results[ed] = { status: 'db_error', reason: insErr.message };
          return;
        }
        results[ed] = { status: 'ready', total: scored.total, notes: scored.notes };
      } catch (e: any) {
        results[ed] = { status: 'failed', reason: e?.message || String(e) };
      }
    }),
  );

  return { ok: true as const, date: today, results };
}

// ─── Mode: full (LEGACY) ────────────────────────────────────────────────────
//
// Old behaviour. Will TIMEOUT on Vercel Hobby (60s cap) on most days. Kept
// here only as an emergency single-call path. Production should use the
// fetch → write → push chain instead.

async function modeFull(skipPush: boolean | undefined) {
  console.warn('mode=full is deprecated and likely to timeout on Vercel Hobby (60s cap). Use mode=fetch → mode=write → mode=push instead.');

  const universe = await loadPersonalisationUniverse();
  console.log(`Universe — industries: ${universe.industries.length}, interests: ${universe.interests.length}, cities: ${universe.cities.length}`);

  let rawStories: RawStories | null = null;
  let lens: any = null;
  try {
    console.log('Fetching news from OpenAI...');
    rawStories = await fetchNewsFromOpenAI(universe);
    if (rawStories.lens && validateLens(rawStories.lens)) lens = rawStories.lens;
  } catch (err: any) {
    console.error('OpenAI fetch failed:', err.message);
  }

  const editions: Edition[] = ['5min', '10min', 'deep'];
  const results: Record<string, { status: string; reason?: string }> = {};
  const writtenBriefs: Record<string, BriefContent> = {};

  // Capture into a const so TypeScript narrows correctly inside the async map below.
  const raw = rawStories;

  const editionPairs = await Promise.all(
    editions.map(async (ed) => {
      let r: EditionOutcome;
      if (!raw) {
        const prev = await fetchPreviousBrief(ed);
        if (prev && prev.status === 'ready') {
          await saveBriefToSupabase(ed, null, prev.content, prev.lens, 'fallback');
          r = { status: 'fallback', reason: 'OpenAI fetch failed', content: prev.content };
        } else {
          await saveBriefToSupabase(ed, null, null, lens, 'failed');
          r = { status: 'failed', reason: 'OpenAI fetch failed and no previous ready brief' };
        }
      } else {
        r = await runWriterForEdition(ed, raw, lens);
      }
      if (r.content) writtenBriefs[ed] = r.content;
      const { content, ...rest } = r;
      return [ed, rest] as const;
    }),
  );
  for (const [ed, r] of editionPairs) results[ed] = r;

  if (!skipPush) {
    const anyFresh = Object.values(results).some((r) => r.status === 'ready');
    if (anyFresh) {
      try { await modePush(); } catch (err: any) { console.error('Push failed:', err.message); }
    }
  }

  return { ok: true as const, results, lens };
}

// ─── Sprint 12: Tail fetch (city / interest / industry) ─────────────────────
//
// New mode=tail-fetch. Fetches per-city, per-interest, per-industry stories
// using gpt-4o-mini-search-preview (cheap web-search-enabled model) and
// writes one row per (date, tail_type, tail_key) to the `tail_briefs` table.
// personalise-briefs.tsx reads from there instead of doing its own fetches.
//
// Key features:
//   - 7-day dedup: tail_used_urls tracks every URL surfaced; future fetches
//     receive the recent URLs as an exclude list (sent to the model in the
//     prompt). Prevents repeating the same thought piece within a week.
//   - City regional priority: REGIONAL_BY_CITY (in lib/whitelist) maps each
//     city to its preferred regional outlets; the prompt names them.
//   - Interest 7-day window: interest tail allows pieces up to 7 days old
//     when no fresh 24h development exists (per Q4-C decision).
//   - All tail fetches happen in parallel; cap per type is 3 stories.

import {
  isRegionalSource,
  REGIONAL_BY_CITY,
  TOPIC_SOURCES,
  publisherLabel as wlPublisherLabel,
} from '@/lib/whitelist';

// ============================================================================
// SECTION 26:  TAILS (city / interest / industry)
// ----------------------------------------------------------------------------
// Per-user tail fetches that top up the personalised surface: city, interest,
// and industry feeds (direct RSS + sonar-pro), recent-URL exclusion, and
// modeTailFetch. Distinct from the shared brief; consumed at personalise time.
// Fns:   fetchCityTail, fetchInterestTail, fetchIndustryTail, modeTailFetch
// Flags: TAIL_RSS, TAIL_RECENCY_HOURS, TAIL_MODEL
// ============================================================================
interface TailStory {
  headline: string;
  body: string;
  source: string;
  source_url: string;
  published_at?: string;
  why_it_matters?: string; // Sprint 14.5: real per-story relevance, not a template
}

// Sprint 14.7b: tails moved to Perplexity sonar-pro (recency filter +
// search_domain_filter) to escape gpt-4o-mini-search-preview's 6000 TPM wall,
// which 429'd most tail jobs and left ~15/22 sections empty on 06-16. Override
// via TAIL_FETCH_MODEL (e.g. 'gpt-4o' or 'gpt-4o-mini-search-preview').
const TAIL_MODEL = 'sonar-pro';

// Sprint 12 — exposed for admin override. Defaults to the cheap mini model;
// flip via env var TAIL_FETCH_MODEL='gpt-4o' to test the quality/cost trade-off.
function getTailModel(): string {
  const envModel = process.env.TAIL_FETCH_MODEL;
  return envModel && envModel.trim() ? envModel.trim() : TAIL_MODEL;
}

// ─── Sprint 19 — RSS personalization registries ─────────────────────────────
// City-edition and topical feeds from WHITELISTED publishers, retrieved via the
// engine (fetchStoriesFromFeeds), which whitelist-checks and freshness-filters
// every story exactly like the main pool. Keys MATCH the REGIONAL_BY_CITY /
// TOPIC_SOURCES keys (lowercased) so the tail finds them by the same costDetail.
// This is a SEED list — tune it from the `[tail:rss ...]` reachability log: a
// dead or wrong feed URL simply yields zero items (the section is then omitted),
// and can NEVER produce a fabricated story URL (the engine only emits links it
// actually pulled from a live feed). Confirmed URL patterns:
//   The Hindu      : https://www.thehindu.com/news/cities/<City>/feeder/default.rss
//   Indian Express : https://indianexpress.com/section/cities/<city>/feed/
const thCity = (c: string) => `https://www.thehindu.com/news/cities/${c}/feeder/default.rss`;
const ieCity = (c: string) => `https://indianexpress.com/section/cities/${c}/feed/`;
const CITY_FEEDS: Record<string, string[]> = {
  'mumbai':        [ieCity('mumbai'), thCity('mumbai')],
  'delhi':         [ieCity('delhi'), thCity('Delhi')],
  'delhi / ncr':   [ieCity('delhi'), thCity('Delhi')],
  'bengaluru':     [ieCity('bangalore'), thCity('bangalore')],
  'bangalore':     [ieCity('bangalore'), thCity('bangalore')],
  'chennai':       [ieCity('chennai'), thCity('chennai')],
  'hyderabad':     [ieCity('hyderabad'), thCity('Hyderabad')],
  'kolkata':       [ieCity('kolkata')],
  'pune':          [ieCity('pune')],
  'ahmedabad':     [ieCity('ahmedabad')],
  'jaipur':        [ieCity('jaipur')],
  'lucknow':       [ieCity('lucknow'), thCity('Lucknow')],
  'chandigarh':    [ieCity('chandigarh'), thCity('Chandigarh')],
  'kochi':         [thCity('Kochi'), ieCity('kochi')],
  'coimbatore':    [thCity('Coimbatore'), ieCity('coimbatore')],
  'visakhapatnam': [thCity('Visakhapatnam'), ieCity('visakhapatnam')],
  'indore':        [ieCity('indore')],
  'bhopal':        [ieCity('bhopal')],
  'nagpur':        [ieCity('nagpur')],
  'surat':         [ieCity('surat')],
  'vadodara':      [ieCity('vadodara')],
  'guwahati':      [ieCity('guwahati')],
};
// Non-standard interests only (interests mapped to a standard section in
// personalise-briefs.tsx are already served from the shared RSS brief and never
// reach this path). Topics with no confident whitelisted feed are omitted →
// that interest section is simply skipped rather than faked.
const INTEREST_FEEDS: Record<string, string[]> = {
  'food & travel':               ['https://www.thehindu.com/life-and-style/food/feeder/default.rss', 'https://indianexpress.com/section/lifestyle/food-wine/feed/'],
  'personal finance':            ['https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss', 'https://www.livemint.com/rss/money'],
  'education':                   ['https://indianexpress.com/section/education/feed/', 'https://www.thehindu.com/education/feeder/default.rss'],
  'law & policy':                ['https://www.barandbench.com/feed', 'https://www.livelaw.in/rss/top-stories'],
  'startups & entrepreneurship': ['https://yourstory.com/feed', 'https://inc42.com/feed/'],
  'climate':                     ['https://india.mongabay.com/feed/', 'https://www.downtoearth.org.in/rss/all'],
  'health':                      ['https://www.thehindu.com/sci-tech/health/feeder/default.rss'],
  'psychology':                  ['https://www.sciencedaily.com/rss/mind_brain/psychology.xml'],
};

// Default ON; set TAIL_RSS=false to revert the city/interest tails to Perplexity.
const TAIL_RSS = (process.env.TAIL_RSS || 'true').toLowerCase() !== 'false';

// Retrieve a tail section's candidates from real feeds. Returns up to `cap`
// candidates (the downstream Claude-select / finalise step then picks and caps
// to 3); why_it_matters is left for that step to derive, never fabricated here.
async function fetchTailFromFeeds(label: string, feeds: string[], cap: number = 12): Promise<TailStory[]> {
  try {
    const { stories, reachability } = await fetchStoriesFromFeeds(feeds, { concurrency: 4 });
    console.log(`[tail:rss ${label}] ${reachability}`);
    return stories.slice(0, cap).map((s) => ({
      headline: s.headline,
      body: s.body || '',
      source: s.source || wlPublisherLabel(s.source_url) || 'Source',
      source_url: s.source_url,
      published_at: s.published_at,
    }));
  } catch (e: any) {
    console.warn(`[tail:rss ${label}] feed retrieval failed (${e?.message || e}) — section will be empty.`);
    return [];
  }
}

async function callTailFetch(
  prompt: string,
  label: string,
  costPhase: 'city' | 'interest' | 'industry' | 'storyline',
  costDetail: string,
  skipDomainFilter: boolean = false,
): Promise<TailStory[]> {
  // Sprint 19 — RSS personalization. City and interest tails retrieve from real
  // feeds (whitelisted, freshness-filtered) instead of Perplexity (which
  // fabricated URLs). A key with no configured feed returns [] → the section is
  // omitted, never faked. Industry and storyline keep their existing path.
  if (TAIL_RSS && (costPhase === 'city' || costPhase === 'interest')) {
    const fKey = (costDetail || '').toLowerCase().trim();
    const feeds = costPhase === 'city' ? (CITY_FEEDS[fKey] || []) : (INTEREST_FEEDS[fKey] || []);
    if (feeds.length === 0) {
      console.log(`[tail:rss ${label}] no feed configured for "${fKey}" — omitting (no fabricated fallback).`);
      return [];
    }
    return fetchTailFromFeeds(label, feeds);
  }
  const model = getTailModel();

  // Sprint 14.7b: domain allowlist for this tail (city -> regional mastheads,
  // interest/industry -> topical sources). <= 20 per Perplexity's cap.
  // Sprint 14.7c: skipDomainFilter forces a broad search — used as a fallback
  // when the domain-restricted query returns nothing (Perplexity indexes some
  // local / vernacular sites thinly).
  const dKey = (costDetail || '').toLowerCase().trim();
  const tailDomains = skipDomainFilter ? [] : (costPhase === 'city'
    ? (REGIONAL_BY_CITY[dKey] || [])
    : (TOPIC_SOURCES[dKey] || [])).slice(0, 20);

  // gpt-4o-mini-search-preview uses /v1/chat/completions with web_search_options.
  // gpt-4o (fallback / override) uses /v1/responses with tools: [{type: 'web_search_preview'}].
  // We support both paths so TAIL_FETCH_MODEL can switch between them.

  let text = '';
  try {
    if (model.startsWith('sonar')) {
      // Perplexity path — recency filter + optional domain allowlist. Escapes
      // the search-preview TPM wall that caused the tail empties.
      if (!PERPLEXITY_API_KEY) {
        console.warn(`[tail:${label}] PERPLEXITY_API_KEY not set — cannot run Perplexity tail.`);
        return [];
      }
      const pplxBody: any = {
        model,
        messages: [
          { role: 'system', content: 'You are a news retrieval engine. Return ONLY valid JSON. No markdown, no preamble.' },
          { role: 'user', content: prompt },
        ],
        search_recency_filter: (costPhase === 'storyline') ? 'day' : 'week',
        return_citations: true,
        temperature: 0.2,
        max_tokens: 2500,
      };
      if (tailDomains.length) pplxBody.search_domain_filter = tailDomains;
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PERPLEXITY_API_KEY}` },
        body: JSON.stringify(pplxBody),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = data?.usage || {};
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        detail: costDetail,
      });
      text = data?.choices?.[0]?.message?.content || '';
    } else if (model === 'gpt-4o-mini-search-preview') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          web_search_options: {},
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2500,
        }),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = extractUsageFromChatCompletion(data);
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        detail: costDetail,
      });
      text = data?.choices?.[0]?.message?.content || '';
    } else {
      // gpt-4o via /v1/responses path (existing pattern from personalise-briefs).
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          tools: [{ type: 'web_search_preview' }],
          tool_choice: { type: 'web_search_preview' },
          input: prompt,
          max_output_tokens: 2500,
        }),
      });
      const data = await response.json();
      if (response.status !== 200) {
        console.warn(`[tail:${label}] ${model} returned ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
        return [];
      }
      const usage = extractUsageFromResponses(data);
      void logOpenAICost({
        phase: costPhase,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        detail: costDetail,
      });
      text = data.output?.find((o: any) => o.type === 'message')?.content?.[0]?.text || '';
    }
  } catch (err: any) {
    console.warn(`[tail:${label}] network/api error: ${err?.message || err}`);
    return [];
  }

  if (!text) {
    console.warn(`[tail:${label}] empty text in response`);
    return [];
  }

  let parsed: any;
  try {
    parsed = extractJsonObject(text);
  } catch (err: any) {
    console.warn(`[tail:${label}] JSON parse failed: ${err.message}. Preview: ${text.slice(0, 300)}`);
    return [];
  }

  const raw = Array.isArray(parsed?.stories) ? parsed.stories : [];
  const candidates: TailStory[] = [];
  for (const s of raw) {
    if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string' || typeof s.source !== 'string') continue;
    if (!isWhitelistedSource(s.source_url)) {
      console.warn(`[tail:${label}] dropping non-whitelisted source: ${s.source_url}`);
      continue;
    }
    candidates.push(s as TailStory);
  }
  // Sprint 14.5: editorial sensitivity for city tails — keep crime/tragedy out
  // of the lead and cap it, so a "your city" section isn't dominated by a
  // single murder/suicide item with light framing. (Reorder before the cap.)
  const ordered = costPhase === 'city' ? applyCitySafety(candidates) : candidates;
  if (costPhase === 'city' && ordered.length < candidates.length) {
    console.log(`[tail:${label}] city-safety dropped ${candidates.length - ordered.length} sensitive item(s) from the top set.`);
  }
  return ordered.slice(0, 3);
}

// 7-day used-URL lookup for cross-day dedup.
async function loadRecentUsedUrls(tailType: string, tailKey: string): Promise<string[]> {
  const today = getISTDate();
  const sevenDaysAgo = getISTDate(-7);
  const { data, error } = await supabase
    .from('tail_used_urls')
    .select('source_url')
    .eq('tail_type', tailType)
    .eq('tail_key', tailKey)
    .gte('date', sevenDaysAgo)
    .lte('date', today);
  if (error) {
    console.warn(`[tail:dedup] used-url lookup failed for ${tailType}/${tailKey}: ${error.message}`);
    return [];
  }
  return (data || []).map((r: any) => r.source_url).filter(Boolean);
}

function formatExcludeBlock(urls: string[]): string {
  if (urls.length === 0) return '';
  const trimmed = urls.slice(0, 30); // cap prompt size
  return `\nEXCLUDE — these URLs were already surfaced in the last 7 days; do NOT include them again:\n${trimmed.map((u) => `- ${u}`).join('\n')}\n`;
}

async function fetchCityTail(city: string): Promise<{ stories: TailStory[]; usedRegional: boolean }> {
  const today = getISTDate();
  const cityNormalised = city.toLowerCase().trim();
  const regional = REGIONAL_BY_CITY[cityNormalised] || [];
  const regionalLabels = regional
    .map((d) => wlPublisherLabel(`https://${d}/`) || d)
    .join(', ');

  const excludeUrls = await loadRecentUsedUrls('city', cityNormalised);

  const regionalBlock = regional.length > 0
    ? `\nPREFERRED REGIONAL SOURCES for ${city} — search these FIRST: ${regionalLabels}. These local outlets typically have stories that national papers' city editions miss.\n`
    : '';

  const prompt = `You are sourcing local news for ${city}, India. Today is ${today}.

Search the web for the 1-3 most consequential stories from ${city} in the last 24-36 hours. Civic and municipal news, major events in the city, notable incidents, local policy changes, transport, business openings/closures, urban issues, weather.

If nothing genuinely newsworthy happened, return an empty array. Do not pad with national stories.
${regionalBlock}${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from these publishers:
National: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Times of India, Deccan Herald, The Wire, NDTV, Moneycontrol, India Today, The Quint, Outlook India.
Regional: Telegraph India (East), Tribune India (North), The News Minute (South), New Indian Express, Mid-Day (Mumbai/Pune), Free Press Journal (Mumbai/MP), Bangalore Mirror, DT Next (Chennai), Telangana Today, Ahmedabad Mirror, Onmanorama (Kerala).
Wires: PTI, ANI.
No aggregators, no social media, no Google News redirects.

Return ONLY a JSON object — no markdown, no commentary:
{
  "stories": [
    {
      "headline": "clear factual headline (max 120 chars)",
      "body": "2-3 sentence factual summary — paraphrase, do not quote at length",
      "why_it_matters": "ONE concrete sentence on why this matters to a resident of ${city} (commute, costs, safety, civic services, local economy). No filler.",
      "source": "publication name",
      "source_url": "https://... direct article link",
      "published_at": "${today}"
    }
  ]
}`;

  let stories = await callTailFetch(prompt, `city:${city}`, 'city', city);
  if (stories.length === 0) {
    // Sprint 14.7c: broad fallback when the local-masthead filter returns nothing.
    stories = await callTailFetch(prompt, `city:${city}`, 'city', city, true);
  }
  const usedRegional = stories.some((s) => isRegionalSource(s.source_url));
  return { stories, usedRegional };
}

async function fetchInterestTail(interest: string): Promise<TailStory[]> {
  const today = getISTDate();
  const interestKey = interest.toLowerCase().trim();
  // Sprint 19 — with RSS tails on, only non-standard interests (those with a
  // configured feed) need a tail; standard interests are served from the shared
  // sections. Skip the rest entirely rather than calling callTailFetch twice
  // (the first returns [], triggering the retry) and logging "no feed configured"
  // for each attempt.
  if (TAIL_RSS && !INTEREST_FEEDS[interestKey]) return [];
  const excludeUrls = await loadRecentUsedUrls('interest', interestKey);

  // Q4-C: 7-day window for interest tails. Allow features, analyses, and
  // trend pieces from the last week when no fresh 24h news exists.
  const prompt = `You are sourcing content about "${interest}" for an India-focused daily brief. Today is ${today}.

Two-pass strategy:
1. FIRST PASS — search for 24-48h news developments on ${interest}. Major announcements, policy moves, milestones, events. India focus preferred but global if globally significant.
2. SECOND PASS (only if first pass yields fewer than 3 stories) — search for recent feature articles, analyses, trend pieces, or thoughtful explainers published in the LAST 7 DAYS on ${interest}. Recent developments, current trends, important shifts. Still from whitelisted publishers only.

Return 1-3 total stories combining both passes. Paraphrase content into 2-3 factual sentences — do NOT quote at length. Headlines should be your own factual summary, not the original article's title verbatim.
${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from these publishers:
Global: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist, Al Jazeera, ABC News Australia.
India national: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, The Print, Scroll, Deccan Herald, The Wire, NDTV, India Today, The Quint, Outlook India, Caravan, Moneycontrol, Financial Express, Business Today, Economic Times, New Indian Express, Telegraph India, Tribune India, The News Minute.
India wires: PTI, ANI.
India specialist: Live Law, Bar & Bench (law), Down To Earth (environment/health).
Government primary: PIB, RBI, SEBI, MoSPI.
Specialist (where general sources don't cover): Nature, Science, STAT, TechCrunch, The Verge, Wired, Variety, Hollywood Reporter, ESPNCricinfo, ESPN.

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "your factual summary headline", "body": "2-3 sentence paraphrased summary", "why_it_matters": "ONE concrete sentence on why a reader who follows ${interest} should care — name the specific stake. No filler.", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
  ]
}`;

  let stories = await callTailFetch(prompt, `interest:${interest}`, 'interest', interest);
  if (stories.length === 0) stories = await callTailFetch(prompt, `interest:${interest}`, 'interest', interest, true);
  return stories;
}

async function fetchIndustryTail(industry: string): Promise<TailStory[]> {
  const today = getISTDate();
  const industryKey = industry.toLowerCase().trim();
  const excludeUrls = await loadRecentUsedUrls('industry', industryKey);

  const prompt = `You are sourcing news with MATERIAL RELEVANCE to the "${industry}" sector for an India-focused daily brief targeting working professionals. Today is ${today}.

"Material relevance" means anything that moves the sector's economics or operations — NOT only stories about ${industry} companies. Include:
- Policy / regulatory changes that affect the sector (budgets, duties, compliance rules, court rulings)
- Macro moves that hit its cost base or demand (rates, rupee, commodity and energy prices, trade policy)
- Supply-chain, infrastructure, and technology shifts the sector must respond to
- The classics: earnings, deals, funding, leadership moves, sector-wide trends

Two-pass strategy:
1. FIRST PASS — search for 24-48h developments materially relevant to ${industry} (per the definition above). India focus preferred; include global moves that affect Indian operators.
2. SECOND PASS (only if first pass yields fewer than 3 stories) — search for feature articles, analyses, or trend pieces published in the LAST 7 DAYS on ${industry}. Industry shifts, regulatory trajectories, market shifts.

Return 1-3 total stories. Paraphrase into 2-3 factual sentences — do NOT quote at length. Every story's body MUST end with one sentence naming the specific transmission channel to ${industry} (e.g. "For pharma: imported API costs rise as the rupee weakens.").
${formatExcludeBlock(excludeUrls)}

SOURCE WHITELIST — direct article URLs only from:
Global wires/papers: Reuters, AP, Bloomberg, FT, WSJ, NYT, WaPo, BBC, The Guardian, The Economist.
India national & business: The Hindu, Indian Express, Hindustan Times, Mint, Business Standard, Economic Times, Financial Express, Moneycontrol, Business Today, The Hindu BusinessLine, NDTV, India Today.
India digital: The Print, Scroll, The Wire, Caravan.
India wires: PTI, ANI.
Government primary: RBI, SEBI, MoSPI, PIB.
Specialist: TechCrunch, The Verge, Wired (tech), Nature/Science/STAT (health/pharma), Variety/Hollywood Reporter (media), ESPN/ESPNCricinfo (sport).

Return ONLY a JSON object — no markdown:
{
  "stories": [
    { "headline": "your factual summary headline", "body": "2-3 sentence paraphrased summary", "why_it_matters": "ONE concrete sentence naming the transmission channel to the ${industry} sector (costs, demand, regulation, supply chain). No filler.", "source": "Publisher Name", "source_url": "https://...", "published_at": "${today}" }
  ]
}`;

  let stories = await callTailFetch(prompt, `industry:${industry}`, 'industry', industry);
  if (stories.length === 0) stories = await callTailFetch(prompt, `industry:${industry}`, 'industry', industry, true);
  return stories;
}

interface TailFetchResult {
  tail_type: 'city' | 'interest' | 'industry';
  tail_key: string;
  display_name: string;
  stories: TailStory[];
  status: 'ready' | 'empty' | 'failed';
  reason?: string;
  usedRegional?: boolean;
}

async function modeTailFetch() {
  const today = getISTDate();
  const universe = await loadPersonalisationUniverse();

  console.log(`[tail-fetch] Universe — cities: ${universe.cities.length}, interests: ${universe.interests.length}, industries: ${universe.industries.length}`);

  if (universe.cities.length + universe.interests.length + universe.industries.length === 0) {
    return {
      ok: true as const,
      date: today,
      summary: { cities: 0, interests: 0, industries: 0 },
      results: [],
      note: 'No personalised users; nothing to fetch.',
    };
  }

  // Sprint 12.1: bounded concurrency for tail fetches. The original Sprint 12
  // code ran all tail fetches in unbounded Promise.all, which would hit
  // OpenAI's per-org concurrent-request cap once the universe grew past
  // ~25-30 keys (the same failure mode that broke the base fetch). The fix:
  // run at most TAIL_CONCURRENCY at a time.
  //
  // Sprint 12.5.1: dropped from 6 → 3. Today's run (2026-06-10) sustained
  // 429s against gpt-4o-mini-search-preview's TPM=6000 cap at concurrency 6,
  // with retries piling up and the whole tail-fetch invocation timing out
  // at Vercel's 300s ceiling. At concurrency 3, peak TPM ~3000 stays safely
  // below the cap. Total wall clock for 20 jobs ≈ 60-80s, still well under
  // the 300s budget. If the universe grows past ~40 keys, revisit by either
  // moving to tier 2 (which raises TPM cap) or batching into multiple cron
  // invocations.

  const TAIL_CONCURRENCY = 3;

  type TailJob = {
    type: 'city' | 'interest' | 'industry';
    key: string;
    display: string;
  };

  const jobs: TailJob[] = [
    ...universe.cities.map((c)     => ({ type: 'city'     as const, key: c.toLowerCase().trim(), display: c })),
    ...universe.interests.map((i)  => ({ type: 'interest' as const, key: i.toLowerCase().trim(), display: i })),
    ...universe.industries.map((d) => ({ type: 'industry' as const, key: d.toLowerCase().trim(), display: d })),
  ];

  console.log(`[tail-fetch] Running ${jobs.length} tail jobs at concurrency=${TAIL_CONCURRENCY}...`);

  async function runOne(job: TailJob): Promise<TailFetchResult> {
    try {
      if (job.type === 'city') {
        const { stories, usedRegional } = await fetchCityTail(job.display);
        return {
          tail_type: 'city',
          tail_key: job.key,
          display_name: job.display,
          stories,
          status: stories.length > 0 ? 'ready' : 'empty',
          usedRegional,
        };
      }
      if (job.type === 'interest') {
        const stories = await fetchInterestTail(job.display);
        return {
          tail_type: 'interest',
          tail_key: job.key,
          display_name: job.display,
          stories,
          status: stories.length > 0 ? 'ready' : 'empty',
        };
      }
      const stories = await fetchIndustryTail(job.display);
      return {
        tail_type: 'industry',
        tail_key: job.key,
        display_name: job.display,
        stories,
        status: stories.length > 0 ? 'ready' : 'empty',
      };
    } catch (e: any) {
      return {
        tail_type: job.type,
        tail_key: job.key,
        display_name: job.display,
        stories: [],
        status: 'failed',
        reason: e?.message || String(e),
      };
    }
  }

  // Process jobs in fixed-size batches. Simple worker-pool pattern: pull from
  // the shared index until empty.
  const allResults: TailFetchResult[] = new Array(jobs.length);
  let cursor = 0;
  const workers = Array.from({ length: TAIL_CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      allResults[i] = await runOne(jobs[i]);
    }
  });
  await Promise.all(workers);

  // Write to tail_briefs (upsert per row).
  const upsertRows = allResults.map((r) => ({
    date: today,
    tail_type: r.tail_type,
    tail_key: r.tail_key,
    display_name: r.display_name,
    stories: r.stories,
    status: r.status,
    reason: r.reason || null,
    story_count: r.stories.length,
    used_regional: !!r.usedRegional,
  }));

  if (upsertRows.length > 0) {
    const { error } = await supabase
      .from('tail_briefs')
      .upsert(upsertRows, { onConflict: 'date,tail_type,tail_key' });
    if (error) {
      console.error(`[tail-fetch] tail_briefs upsert failed: ${error.message}`);
      return { ok: false as const, error: `tail_briefs upsert failed: ${error.message}` };
    }
  }

  // Append to tail_used_urls for dedup tracking on future runs.
  const usedUrlRows: any[] = [];
  for (const r of allResults) {
    for (const s of r.stories) {
      if (s.source_url) {
        usedUrlRows.push({
          date: today,
          tail_type: r.tail_type,
          tail_key: r.tail_key,
          source_url: s.source_url,
          headline: s.headline?.slice(0, 300) || null,
        });
      }
    }
  }

  if (usedUrlRows.length > 0) {
    // Sprint 13: same-day manual re-runs previously appended duplicate rows
    // forever (unbounded growth). Replace today's rows instead of appending.
    const { error: delErr } = await supabase.from('tail_used_urls').delete().eq('date', today);
    if (delErr) {
      console.warn(`[tail-fetch] tail_used_urls same-day cleanup failed (non-fatal): ${delErr.message}`);
    }
    const { error } = await supabase.from('tail_used_urls').insert(usedUrlRows);
    if (error) {
      console.warn(`[tail-fetch] tail_used_urls insert failed (non-fatal): ${error.message}`);
    } else {
      console.log(`[tail-fetch] Logged ${usedUrlRows.length} URLs to tail_used_urls.`);
    }
  }

  // Summary
  const summary = {
    cities: { total: universe.cities.length, ready: 0, empty: 0, failed: 0 },
    interests: { total: universe.interests.length, ready: 0, empty: 0, failed: 0 },
    industries: { total: universe.industries.length, ready: 0, empty: 0, failed: 0 },
  };
  for (const r of allResults) {
    const bucket =
      r.tail_type === 'city' ? summary.cities :
      r.tail_type === 'interest' ? summary.interests : summary.industries;
    (bucket as any)[r.status] = ((bucket as any)[r.status] || 0) + 1;
  }

  console.log(`[tail-fetch] Done. Cities: ${summary.cities.ready}/${summary.cities.total} ready. Interests: ${summary.interests.ready}/${summary.interests.total}. Industries: ${summary.industries.ready}/${summary.industries.total}.`);

  return {
    ok: true as const,
    date: today,
    model: getTailModel(),
    summary,
    results: allResults.map((r) => ({
      tail_type: r.tail_type,
      tail_key: r.tail_key,
      display_name: r.display_name,
      story_count: r.stories.length,
      status: r.status,
      used_regional: !!r.usedRegional,
      reason: r.reason,
    })),
  };
}

// ─── Sprint 13: Follow a Story (storylines) ─────────────────────────────────
//
// A "storyline" is a named, ongoing news narrative (e.g. "US–Iran nuclear
// standoff") that accumulates dated events over days/weeks. mode=storylines
// runs once per morning AFTER write (it reads today's ready 10min brief):
//
//   1. TAG + DETECT (one gpt-4o-mini call, ~free): match today's stories to
//      existing active/dormant storylines; propose new storylines that pass
//      the qualifying test (multi-day arc + expected future developments +
//      recurring named entities).
//   2. CREATE: up to 5 new storylines/day, hard cap 25 ACTIVE system-wide.
//      Each new storyline gets a ONE-TIME historical backfill (search call):
//      "how we got here" context + up to 4 past milestones. Never repeated.
//   3. FALLBACK FETCH: followed, active storylines with no tagged hit today
//      get a dedicated search call — cap 10/day, oldest-first, concurrency 3
//      (same TPM discipline as tail-fetch). A miss waits a day; tolerable.
//   4. STORY-SO-FAR REGEN: gpt-4o-mini synthesis from the event timeline for
//      every storyline that gained events. Pure synthesis — NO web fetching.
//   5. LIFECYCLE: active → dormant after 7 quiet days (tagging continues —
//      it's free — but paid fallback fetching stops; a tagged hit revives).
//      dormant/active → concluded after 30 quiet days.
//
// Dedup at event-write is two-layered: exact source_url per storyline, plus
// semantic-overlap vs the last 3 days of events (reuses significantWords /
// semanticOverlap from the fetch pipeline). A partial unique index in the DB
// is the final backstop.

// ============================================================================
// SECTION 27:  STORYLINES (Follow a Story)
// ----------------------------------------------------------------------------
// mode=storylines: flattens the daily brief, tags/detects storylines, inserts
// storyline events, backfills the 'story so far', and manages active/dormant/
// concluded lifecycle. Runs after write.
// Fns:   storylineTagAndDetect, insertStorylineEvent, fallbackFetchStoryline, regenStorySoFar, modeStorylines
// Flags: STORYLINE_MAX_* / _AFTER_DAYS consts
// ============================================================================
const STORYLINE_MAX_ACTIVE = 25;
const STORYLINE_MAX_NEW_PER_DAY = 5;
const STORYLINE_FALLBACK_CAP = 10;
const STORYLINE_FALLBACK_CONCURRENCY = 3;
const STORYLINE_DORMANT_AFTER_DAYS = 7;
const STORYLINE_CONCLUDE_AFTER_DAYS = 30;

interface StorylineRow {
  id: string;
  slug: string;
  title: string;
  story_so_far: string | null;
  confidence: string;
  status: string;
  origin: string;
  last_event_at: string | null;
}

interface FlatStory {
  idx: number;
  section: string;
  headline: string;
  summary: string;
  source: string;
  source_url: string;
}

function flattenDailyContent(content: any): FlatStory[] {
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

function slugifyTitle(t: string): string {
  const s = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || `storyline-${Date.now()}`;
}

// Generic search-model call returning parsed JSON. Mirrors callTailFetch's
// gpt-4o-mini-search-preview path but with a free-form JSON contract.
async function callSearchModelJson(prompt: string, label: string): Promise<any | null> {
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
async function storylineTagAndDetect(
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
async function insertStorylineEvent(
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

function buildBackfillPrompt(title: string, seed: FlatStory, today: string): string {
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
async function fallbackFetchStoryline(line: StorylineRow, today: string): Promise<number> {
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
async function regenStorySoFar(line: StorylineRow): Promise<boolean> {
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

async function modeStorylines() {
  const today = getISTDate();

  // 1. Tagging source: today's ready 10min base brief (richest section coverage).
  const { data: briefRow } = await supabase
    .from('briefs')
    .select('content, status')
    .eq('date', today)
    .eq('edition', '10min')
    .maybeSingle();
  const stories = briefRow?.status === 'ready' && briefRow?.content
    ? flattenDailyContent(briefRow.content)
    : [];

  // 2. Active + dormant storylines (dormant still matchable — a hit revives).
  const { data: lineRows, error: lineErr } = await supabase
    .from('storylines')
    .select('id, slug, title, story_so_far, confidence, status, origin, last_event_at')
    .in('status', ['active', 'dormant']);
  if (lineErr) return { ok: false as const, error: `storylines read failed: ${lineErr.message}` };
  const lines = (lineRows || []) as StorylineRow[];
  const byId = new Map<string, StorylineRow>(lines.map((l) => [l.id, l]));
  const activeCount = lines.filter((l) => l.status === 'active').length;

  const summary = {
    stories_considered: stories.length,
    tagged: 0, duplicates: 0, created: 0, skipped_creation: 0,
    fallback_checked: 0, fallback_hits: 0,
    regenerated: 0, dormant_marked: 0, concluded_marked: 0,
  };
  const touched = new Set<string>();

  // 3. Tag + detect (skipped gracefully if today's brief isn't ready).
  if (stories.length > 0) {
    let tagResult: { matches: any[]; proposals: any[] } = { matches: [], proposals: [] };
    try {
      tagResult = await storylineTagAndDetect(stories, lines, today);
    } catch (e: any) {
      console.warn(`[storylines] tag call failed: ${e?.message || e}`);
    }

    for (const m of tagResult.matches) {
      const line = byId.get(String(m?.storyline_id));
      const st = stories[Number(m?.story_idx)];
      if (!line || !st) continue;
      const r = await insertStorylineEvent(line, {
        date: today, headline: st.headline, summary: st.summary,
        source: st.source, source_url: st.source_url, origin: 'tag',
      });
      if (r === 'inserted') { summary.tagged++; touched.add(line.id); }
      if (r === 'duplicate') summary.duplicates++;
    }

    // 4. Create proposals — respect 25-active cap and 5/day cap. ONE-TIME
    //    historical backfill at creation; never repeated on later days.
    let canCreate = Math.min(STORYLINE_MAX_NEW_PER_DAY, Math.max(0, STORYLINE_MAX_ACTIVE - activeCount));
    for (const p of tagResult.proposals) {
      const st = stories[Number(p?.story_idx)];
      if (!st || typeof p?.title !== 'string' || p.title.trim().length < 4) continue;
      if (canCreate <= 0) { summary.skipped_creation++; continue; }
      const slug = slugifyTitle(p.title);
      const confidence = p.confidence === 'high' ? 'high' : 'normal';
      const { data: created, error: cErr } = await supabase
        .from('storylines')
        .insert({ slug, title: p.title.trim().slice(0, 140), confidence, status: 'active', origin: 'auto', last_event_at: today })
        .select('id')
        .single();
      if (cErr || !created) {
        console.warn(`[storylines] create failed (${slug}): ${cErr?.message || 'no row returned'}`);
        continue;
      }
      canCreate--;
      summary.created++;
      const newLine: StorylineRow = {
        id: created.id, slug, title: p.title.trim().slice(0, 140),
        story_so_far: null, confidence, status: 'active', origin: 'auto', last_event_at: today,
      };
      byId.set(created.id, newLine);
      touched.add(created.id);

      await insertStorylineEvent({ id: created.id }, {
        date: today, headline: st.headline, summary: st.summary,
        source: st.source, source_url: st.source_url, origin: 'tag',
      });

      try {
        const bf = await callSearchModelJson(buildBackfillPrompt(newLine.title, st, today), `backfill:${slug}`);
        if (bf) {
          const milestones = Array.isArray(bf.milestones) ? bf.milestones.slice(0, 4) : [];
          for (const ms of milestones) {
            if (!ms?.headline) continue;
            await insertStorylineEvent({ id: created.id }, {
              date: typeof ms.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ms.date) ? ms.date : today,
              headline: String(ms.headline),
              summary: typeof ms.summary === 'string' ? ms.summary : '',
              source: typeof ms.source === 'string' ? ms.source : '',
              source_url: isWhitelistedSource(ms.source_url) ? ms.source_url : '',
              origin: 'backfill',
            });
          }
          if (typeof bf.story_so_far === 'string' && bf.story_so_far.length > 40) {
            await supabase.from('storylines').update({ story_so_far: bf.story_so_far.slice(0, 1500) }).eq('id', created.id);
            newLine.story_so_far = bf.story_so_far;
            touched.delete(created.id); // fresh story_so_far already written
          }
        }
      } catch (e: any) {
        console.warn(`[storylines] backfill failed (${slug}): ${e?.message || e}`);
      }
    }
  } else {
    console.warn('[storylines] No ready 10min brief for today — tagging skipped; fallback + lifecycle still run.');
  }

  // 5. Fallback fetch — FOLLOWED, ACTIVE storylines with no event today.
  //    Cap 10/day, oldest-first, concurrency 3 (TPM discipline from tail-fetch).
  const { data: followRows } = await supabase.from('storyline_follows').select('storyline_id');
  const followedIds = new Set((followRows || []).map((r: any) => r.storyline_id));
  const { data: todayEvents } = await supabase.from('storyline_events').select('storyline_id').eq('date', today);
  const hitToday = new Set((todayEvents || []).map((r: any) => r.storyline_id));

  const candidates = lines
    .filter((l) => l.status === 'active' && followedIds.has(l.id) && !hitToday.has(l.id) && !touched.has(l.id))
    .sort((a, b) => String(a.last_event_at || '').localeCompare(String(b.last_event_at || '')))
    .slice(0, STORYLINE_FALLBACK_CAP);
  summary.fallback_checked = candidates.length;

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(STORYLINE_FALLBACK_CONCURRENCY, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const line = candidates[cursor++];
        try {
          const hits = await fallbackFetchStoryline(line, today);
          if (hits > 0) { summary.fallback_hits += hits; touched.add(line.id); }
        } catch (e: any) {
          console.warn(`[storylines] fallback failed (${line.slug}): ${e?.message || e}`);
        }
      }
    }),
  );

  // 6. Story-so-far regen for storylines that gained events, plus self-heal:
  //    any active storyline missing a story_so_far (e.g. interrupted backfill).
  const { data: missing } = await supabase
    .from('storylines')
    .select('id, slug, title, story_so_far, confidence, status, origin, last_event_at')
    .eq('status', 'active')
    .is('story_so_far', null);
  for (const l of (missing || []) as StorylineRow[]) {
    byId.set(l.id, l);
    touched.add(l.id);
  }
  for (const id of Array.from(touched)) {
    const line = byId.get(id);
    if (!line) continue;
    try {
      if (await regenStorySoFar(line)) summary.regenerated++;
    } catch (e: any) {
      console.warn(`[storylines] regen failed (${line.slug}): ${e?.message || e}`);
    }
  }

  // 7. Lifecycle — pure date math, no LLM.
  const dormantCutoff = getISTDate(-STORYLINE_DORMANT_AFTER_DAYS);
  const concludeCutoff = getISTDate(-STORYLINE_CONCLUDE_AFTER_DAYS);
  const { data: cm } = await supabase
    .from('storylines')
    .update({ status: 'concluded', updated_at: new Date().toISOString() })
    .in('status', ['active', 'dormant'])
    .lt('last_event_at', concludeCutoff)
    .select('id');
  summary.concluded_marked = cm?.length || 0;
  const { data: dm } = await supabase
    .from('storylines')
    .update({ status: 'dormant', updated_at: new Date().toISOString() })
    .eq('status', 'active')
    .lt('last_event_at', dormantCutoff)
    .select('id');
  summary.dormant_marked = dm?.length || 0;

  console.log(`[storylines] Done. tagged=${summary.tagged} created=${summary.created} fallback=${summary.fallback_hits}/${summary.fallback_checked} regen=${summary.regenerated} dormant=${summary.dormant_marked} concluded=${summary.concluded_marked}`);
  return { ok: true as const, date: today, ...summary };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

// ============================================================================
// SECTION 28:  MAIN HANDLER  (mode router)
// ----------------------------------------------------------------------------
// The API entry point. Authorises the request and dispatches ?mode= to the
// mode functions above (fetch / write / push / full / tail-fetch / storylines).
// Fns:   handler (export default)
// Flags: reads ?mode= ; CRON_SECRET via authoriseRequest
// ============================================================================
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  attachLogCapture(res); // Sprint 14.5: tee server logs into the JSON response
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Default mode is 'fetch'. This means a bare POST (e.g. legacy cron-job.org
  // hit with no body) does the fetch phase only — never the full thing, which
  // would timeout.
  const { mode = 'fetch', edition, skipPush } = req.body || {};

  // Sprint 13: CRON_SECRET enforcement (no-op until the env var is set).
  const auth = await authoriseRequest(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: 'Unauthorised. Provide Authorization: Bearer <CRON_SECRET> or a valid user session token.' });
  }

  try {
    if (mode === 'fetch') {
      const result = await modeFetch();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'storylines') {
      const result = await modeStorylines();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'tail-fetch') {
      const result = await modeTailFetch();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'write') {
      if (!edition || !['5min', '10min', 'deep'].includes(edition)) {
        return res.status(400).json({ ok: false, error: "mode=write requires edition: '5min' | '10min' | 'deep'" });
      }
      const result = await modeWrite(edition as Edition);
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'push') {
      const result = await modePush();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'score') {
      const result = await modeScore();
      return res.status(result.ok ? 200 : 500).json(result);
    }

    if (mode === 'full') {
      const result = await modeFull(skipPush);
      return res.status(200).json(result);
    }

    return res.status(400).json({
      ok: false,
      error: `Unknown mode: ${mode}. Use 'fetch', 'tail-fetch', 'write', 'storylines', 'push', 'score', or 'full'.`,
    });
  } catch (error: any) {
    console.error('Top-level error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
