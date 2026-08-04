// src/lib/generate-brief/scoring.ts
//
// Modularization stage 7 - scoring/telemetry logic, moved verbatim: ground-truth
// retrieval + coverage V3 / deep-coverage (§24) and the gpt-4o rubric scorer
// scoreBriefWithLLM (§25). Telemetry only - never touches reader content. The
// modeScore/modeFull entry points stay in the route and call this. `export` added.

import {
  extractJsonObject,
  significantWords,
  semanticOverlap,
} from '@/lib/generate-brief/utils';
import type {
  Edition,
} from '@/lib/generate-brief/types';
import {
  PERPLEXITY_API_KEY,
  callPerplexity,
} from '@/lib/generate-brief/fetch';
import {
  callOpenAIChat,
} from '@/lib/generate-brief/writers';

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
export const SCORE_GROUNDTRUTH = (process.env.SCORE_GROUNDTRUTH || 'on').toLowerCase() !== 'off';

// Minimum parsed headlines (India + world) for a reference to count as "usable".
// A response thinner than this triggers the Perplexity retry, then the fallback.
export const GROUNDTRUTH_MIN_HEADLINES = Math.max(
  2,
  parseInt(process.env.GROUNDTRUTH_MIN_HEADLINES || '4', 10) || 4,
);

// Independent fallback source. BOTH must be set to enable it; otherwise the
// fallback layer is cleanly skipped (Perplexity → fail-loud). The provider name
// picks the adapter; the API key is the only other thing to set. One var to swap.
export const GROUNDTRUTH_NEWS_PROVIDER = (process.env.GROUNDTRUTH_NEWS_PROVIDER || '').trim().toLowerCase();
export const GROUNDTRUTH_NEWS_API_KEY = (process.env.GROUNDTRUTH_NEWS_API_KEY || '').trim();

export type GroundTruth = { india: string[]; world: string[]; source?: string };

// Normalise a raw list of header-ish values into clean, deduped headline strings.
export function cleanHeadlineList(a: any): string[] {
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
export function buildGroundTruthPrompt(today: string, simple: boolean): string {
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

export async function fetchGroundTruthFromPerplexity(today: string): Promise<GroundTruth | null> {
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
export async function fetchJsonWithTimeout(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<any> {
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
export type NewsApiAdapter = {
  india: (key: string) => { url: string; headers?: Record<string, string> };
  world: (key: string) => { url: string; headers?: Record<string, string> };
  pick: (data: any) => any[];
};

export const NEWS_API_ADAPTERS: Record<string, NewsApiAdapter> = {
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

export async function fetchGroundTruthFromNewsApi(_today: string): Promise<GroundTruth | null> {
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
export async function fetchGroundTruthHeadlines(today: string): Promise<GroundTruth | null> {
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
export function collectBriefHeadlines(content: any): string[] {
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
export const COVERAGE_MATCH_THRESHOLD = 2;
export const COVERAGE_ANCHOR_MATCH = (process.env.COVERAGE_ANCHOR_MATCH || 'on').toLowerCase() !== 'off';

// Sprint 20 Drop 4 — what dim_coverage becomes when there is NO ground-truth
// reference at all (Perplexity + news-API fallback both unavailable). Default
// `null` = withheld/unverified, which is the honest reading and what surfaces in
// the snapshot. If your `brief_scores.dim_coverage` column is NOT NULL, set
// COVERAGE_UNVERIFIED_VALUE to a number (e.g. 0) so the upsert still writes; the
// loud "⚠ COVERAGE UNVERIFIED" note is stamped either way.
export const COVERAGE_UNVERIFIED_VALUE: number | null = (() => {
  const raw = (process.env.COVERAGE_UNVERIFIED_VALUE || 'null').trim().toLowerCase();
  if (raw === 'null' || raw === '') return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : Math.max(0, Math.min(10, n));
})();

// Distinctive tokens that strongly identify a specific story: 3-5 letter
// uppercase acronyms and multi-digit numbers (tolls, ₹ amounts, percentages),
// excluding bare years and a few non-distinctive words. 2-letter acronyms are
// left out as too ambiguous (AI, SC, ED) — those still match via word overlap.
export const ANCHOR_STOP = new Set(['THE', 'AND', 'FOR', 'NEW', 'GOVT', 'WWW']);
export function anchorTokens(headline: string): Set<string> {
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
export const COVERAGE_V2 = (process.env.COVERAGE_V2 || 'on').toLowerCase() !== 'off';
export const COVERAGE_MISS_SCALE = parseInt(process.env.COVERAGE_MISS_SCALE || '8', 10) || 8;
export const COVERAGE_MISS_CAP = parseInt(process.env.COVERAGE_MISS_CAP || '7', 10) || 7;

// A reference headline is "specific" (matchable) if it carries an anchor token
// (acronym/number) OR names a proper noun beyond the first word. Pure templated
// filler with neither ("centre announces nationwide rollout plan") is dropped so
// it can't false-miss. Conservative — only drops the clearly unmatchable.
export function looksSpecific(headline: string): boolean {
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
export function effectiveRefs(gt: GroundTruth): string[] {
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
export const COVERAGE_V3 = (process.env.COVERAGE_V3 || 'on').toLowerCase() !== 'off';

// Sprint 26 (F3) — default ON. The deep edition has NO top-level story headlines
// (its content lives in title/body prose and three_patterns[].stories_connected),
// so collectBriefHeadlines returns [] for it and EVERY reference headline scored
// as missed → `[score:deep] N/N missed (100%)` every run, a false telemetry
// signal. This flag switches the deep edition to a CORPUS coverage test: flatten
// all of deep's strings into one word+anchor bag and count a reference covered if
// its significant words (or anchors) appear anywhere in that prose. Affects only
// the deep COVERAGE score (telemetry) — never reader content. Revert with
// DEEP_COVERAGE_V2=false (deep then falls back to the old headline path).
export const DEEP_COVERAGE_V2 = (process.env.DEEP_COVERAGE_V2 || 'true').toLowerCase() !== 'false';

// Importance of a reference headline, 1 (minor/regional/process) to 3
// (day-defining national news). Deterministic + transparent; tune freely.
export function referenceImportance(headline: string): number {
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
export function scopedRefs(gt: GroundTruth, edition: Edition): string[] {
  const base = effectiveRefs(gt);
  if (edition !== '5min') return base;
  const corporateOnly = /\b(ipo|shares?|stocks?|bourse|listing|circuit|brokerage|mutual fund|disclosure norms|q[1-4]\b|earnings)\b/i;
  const macro = /\b(rbi|repo rate|inflation|gdp|fiscal|budget)\b/i;
  const scoped = base.filter((h) => !(corporateOnly.test(h) && !macro.test(h)));
  return scoped.length >= 2 ? scoped : base;
}

export type CoverageV3Result = { score: number; missed: string[]; totalScoped: number; weightedMissRate: number };

// Deterministic coverage: weighted share of the edition-scoped reference the
// brief covered, mapped to 0-10. Uses the SAME match test as V2 (word overlap
// OR a shared anchor) so a beat covered with different phrasing still counts.
export function measureCoverageV3(content: any, gt: GroundTruth, edition: Edition): CoverageV3Result {
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
export function collectDeepStrings(node: any, out: string[], depth: number): void {
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
export const DEEP_COVERAGE_STRICT = (process.env.DEEP_COVERAGE_STRICT || 'true').toLowerCase() !== 'false';

// Words too common in any Indian news corpus to identify a SPECIFIC story.
// They still count toward the 2-word bar — they just can't be the only
// evidence. Extends STOPWORDS (already excluded by significantWords).
export const DEEP_GENERIC_WORDS = new Set([
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

export type DeepMatchEvidence = { ref: string; tokens: string[]; snippet: string };

// Deep coverage: same weighted, edition-scoped measurement as measureCoverageV3,
// but matched against deep's prose. STRICT (default): per-string co-occurrence
// with a non-generic requirement, evidence logged. Legacy (STRICT=false): the
// Sprint 26 corpus-bag behaviour.
export function measureDeepCoverage(content: any, gt: GroundTruth, edition: Edition): CoverageV3Result {
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

export function missedReferenceHeadlines(content: any, gt: GroundTruth | null): string[] {
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
export async function scoreBriefWithLLM(
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

