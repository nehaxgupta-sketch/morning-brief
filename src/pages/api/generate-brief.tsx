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
// Modularization stage 4: quality gate moved to ./quality.
import {
  PLACEMENT_V2,
  PLACEMENT_OVERLAY,
  enforceQualityRules,
  rawStoriesForWriter,
  buildSubset,
} from '@/lib/generate-brief/quality';
// Modularization stage 5: fetch layer moved to ./fetch.
import type {
  Universe,
} from '@/lib/generate-brief/fetch';
import {
  loadPersonalisationUniverse,
  fetchListSection,
  PERPLEXITY_API_KEY,
  callPerplexity,
  fetchNewsFromOpenAI,
} from '@/lib/generate-brief/fetch';
// Modularization stage 6: writers + assemble extracted.
import {
  callOpenAIChat,
  validateLens,
  fetchPreviousBrief,
} from '@/lib/generate-brief/writers';
import type {
  EditionOutcome,
} from '@/lib/generate-brief/assemble';
import {
  saveBriefToSupabase,
  sendPushNotification,
  LIVENESS_SECTIONS,
  runWriterForEdition,
} from '@/lib/generate-brief/assemble';

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
// SECTIONS 4-10 (universe/prompts, markets/lens, gpt5, perplexity/gpt4o,
// strategies, dispatch)  ->  @/lib/generate-brief/fetch  (imported at top).
// ============================================================================

// SECTION 11 (recency + event-dedup primitives) -> @/lib/generate-brief/utils

// ============================================================================
// SECTIONS 12-15 (placement, section-dedup, enforceQualityRules, ranking/subset)
// + MAJOR_DEDUP_DEPTH  ->  @/lib/generate-brief/quality  (imported at top).
// ============================================================================

// ============================================================================
// SECTIONS 16-19 -> @/lib/generate-brief/writers ; SECTIONS 20-22 ->
// @/lib/generate-brief/assemble  (both imported at top).
// ============================================================================

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
