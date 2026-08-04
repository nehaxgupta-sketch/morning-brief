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
// Modularization stage 7: scoring + tails logic extracted.
import {
  fetchGroundTruthHeadlines,
  scoreBriefWithLLM,
} from '@/lib/generate-brief/scoring';
import type {
  TailFetchResult,
} from '@/lib/generate-brief/tails';
import {
  getTailModel,
  fetchCityTail,
  fetchInterestTail,
  fetchIndustryTail,
} from '@/lib/generate-brief/tails';

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
// (emptySectionCount now lives in scoring.ts.)
// Fns:   modeFetch, modeWrite, modePush
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

// emptySectionCount() moved to @/lib/generate-brief/scoring (its only caller).

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
// SECTIONS 24-25 scoring LOGIC (ground truth, coverage, scoreBriefWithLLM) ->
// @/lib/generate-brief/scoring. modeScore/modeFull stay below and call it.
// ============================================================================

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
// SECTION 26 tail feeds LOGIC -> @/lib/generate-brief/tails.
// modeTailFetch stays below and calls it.
// ============================================================================

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
